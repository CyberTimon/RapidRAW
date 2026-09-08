use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};

const XMP_UUID: [u8; 16] = [
    0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac,
];

/// CR3 uses ISO BMFF boxes. Seek over compressed pixels and previews.
pub fn read(file: &mut File) -> io::Result<Option<u8>> {
    let end = file.metadata()?.len();
    let mut offset = 0u64;
    for _ in 0..4096 {
        if offset == end {
            return Ok(None);
        }
        if end - offset < 8 {
            return Err(io::Error::other("Truncated CR3 box"));
        }
        file.seek(SeekFrom::Start(offset))?;
        let mut header = [0; 8];
        file.read_exact(&mut header)?;
        let mut size = u32::from_be_bytes(header[..4].try_into().unwrap()) as u64;
        let mut header_size = 8;
        if size == 1 {
            let mut extended = [0; 8];
            file.read_exact(&mut extended)?;
            size = u64::from_be_bytes(extended);
            header_size = 16;
        } else if size == 0 {
            size = end - offset;
        }
        if size < header_size || size > end - offset {
            return Err(io::Error::other("Invalid CR3 box length"));
        }
        if &header[4..] == b"uuid" {
            if size < header_size + 16 {
                return Err(io::Error::other("Truncated CR3 UUID"));
            }
            let mut uuid = [0; 16];
            file.read_exact(&mut uuid)?;
            if uuid == XMP_UUID {
                let length = size - header_size - 16;
                if length > 1_048_576 {
                    return Err(io::Error::other("CR3 XMP packet is too large"));
                }
                let mut packet = vec![0; length as usize];
                file.read_exact(&mut packet)?;
                return Ok(crate::embedded_rating::extract_xmp_rating(
                    &String::from_utf8_lossy(&packet),
                ));
            }
        }
        offset += size;
    }
    Err(io::Error::other("Too many CR3 boxes"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn fixture(packet: &[u8], extended: bool) -> tempfile::NamedTempFile {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(&[
            0, 0, 0, 16, b'f', b't', b'y', b'p', b'c', b'r', b'x', b' ', 0, 0, 0, 0,
        ])
        .unwrap();
        let size = packet.len() as u64 + 16 + if extended { 16 } else { 8 };
        file.write_all(&(if extended { 1 } else { size as u32 }).to_be_bytes())
            .unwrap();
        file.write_all(b"uuid").unwrap();
        if extended {
            file.write_all(&size.to_be_bytes()).unwrap();
        }
        file.write_all(&XMP_UUID).unwrap();
        file.write_all(packet).unwrap();
        file
    }
    #[test]
    fn cr3_rating_packets_and_lengths() {
        for extended in [false, true] {
            let file = fixture(b"<xmp:Rating>1</xmp:Rating>", extended);
            assert_eq!(
                crate::embedded_rating::read_rating_checked(file.path()).unwrap(),
                Some(1)
            );
            file.as_file().set_len(30).unwrap();
            assert!(crate::embedded_rating::read_rating_checked(file.path()).is_err());
        }
        let file = fixture(b"<x:xmpmeta/>", false);
        assert_eq!(
            crate::embedded_rating::read_rating_checked(file.path()).unwrap(),
            None
        );
    }
    #[test]
    fn cr3_rating_rejects_invalid_box() {
        let mut file = fixture(b"", false);
        file.seek(SeekFrom::Start(16)).unwrap();
        file.write_all(&7u32.to_be_bytes()).unwrap();
        assert!(crate::embedded_rating::read_rating_checked(file.path()).is_err());
    }
}
