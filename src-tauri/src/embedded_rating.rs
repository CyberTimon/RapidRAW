//! Read rating metadata without decoding pixels or reading an entire RAW file.
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::OnceLock;

pub fn extract_xmp_rating(content: &str) -> Option<u8> {
    static RATING: OnceLock<regex::Regex> = OnceLock::new();
    let pattern = RATING.get_or_init(|| {
        regex::Regex::new(r#"xmp:Rating\s*=\s*["']\s*(-?\d+)\s*["']|<xmp:Rating\s*>\s*(-?\d+)\s*</xmp:Rating\s*>"#).unwrap()
    });
    let captures = pattern.captures(content)?;
    let rating = captures
        .get(1)
        .or_else(|| captures.get(2))?
        .as_str()
        .parse::<u8>()
        .ok()?;
    (rating <= 5).then_some(rating)
}

pub fn read_rating(path: &Path) -> Option<u8> {
    let mut file = File::open(path).ok()?;
    let mut header = [0; 8];
    file.read_exact(&mut header).ok()?;
    match &header[..4] {
        b"II*\0" => read_tiff_rating(&mut file, header, true),
        b"MM\0*" => read_tiff_rating(&mut file, header, false),
        _ if header[..2] == [0xff, 0xd8] => read_jpeg_rating(&mut file),
        _ => None,
    }
}

fn read_tiff_rating(file: &mut File, header: [u8; 8], little: bool) -> Option<u8> {
    let u16_at = |b: &[u8]| {
        let bytes = [b[0], b[1]];
        if little {
            u16::from_le_bytes(bytes)
        } else {
            u16::from_be_bytes(bytes)
        }
    };
    let u32_at = |b: &[u8]| {
        let bytes = [b[0], b[1], b[2], b[3]];
        if little {
            u32::from_le_bytes(bytes)
        } else {
            u32::from_be_bytes(bytes)
        }
    };
    let mut offset = u32_at(&header[4..]) as u64;
    let mut exif_rating = None;
    // A small bound also protects against cyclic or corrupt IFD chains.
    for _ in 0..8 {
        if offset == 0 {
            break;
        }
        file.seek(SeekFrom::Start(offset)).ok()?;
        let mut count = [0; 2];
        file.read_exact(&mut count).ok()?;
        let count = u16_at(&count) as usize;
        if count > 4096 {
            return exif_rating;
        }
        let mut entries = vec![0; count * 12 + 4];
        file.read_exact(&mut entries).ok()?;
        for entry in entries[..count * 12].chunks_exact(12) {
            let tag = u16_at(entry);
            let kind = u16_at(&entry[2..]);
            let size = u32_at(&entry[4..]) as usize;
            if tag == 0x4746 && kind == 3 && size == 1 {
                let value = u16_at(&entry[8..]);
                if value <= 5 {
                    exif_rating = Some(value as u8);
                }
            }
            // TIFF tag 700 stores the embedded XMP packet (including Canon CR2).
            if tag == 700 && matches!(kind, 1 | 7) && (5..=1_048_576).contains(&size) {
                file.seek(SeekFrom::Start(u32_at(&entry[8..]) as u64))
                    .ok()?;
                let mut packet = vec![0; size];
                file.read_exact(&mut packet).ok()?;
                if let Some(rating) = extract_xmp_rating(&String::from_utf8_lossy(&packet)) {
                    return Some(rating);
                }
            }
        }
        offset = u32_at(&entries[count * 12..]) as u64;
    }
    exif_rating
}

fn read_jpeg_rating(file: &mut File) -> Option<u8> {
    file.seek(SeekFrom::Start(2)).ok()?;
    for _ in 0..1024 {
        let mut marker = [0; 2];
        file.read_exact(&mut marker).ok()?;
        if marker[0] != 0xff || matches!(marker[1], 0xda | 0xd9) {
            return None;
        }
        if marker[1] == 0xff {
            file.seek(SeekFrom::Current(-1)).ok()?;
            continue;
        }
        if matches!(marker[1], 0x01 | 0xd0..=0xd8) {
            continue;
        }
        let mut length = [0; 2];
        file.read_exact(&mut length).ok()?;
        let length = u16::from_be_bytes(length).checked_sub(2)? as usize;
        if marker[1] == 0xe1 {
            let mut packet = vec![0; length];
            file.read_exact(&mut packet).ok()?;
            if packet.starts_with(b"http://ns.adobe.com/xap/1.0/\0")
                && let Some(rating) = extract_xmp_rating(&String::from_utf8_lossy(&packet))
            {
                return Some(rating);
            }
        } else {
            file.seek(SeekFrom::Current(length as i64)).ok()?;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn embedded_rating_xmp_forms_and_bounds() {
        for xmp in [
            "<xmp:Rating>1</xmp:Rating>",
            "xmp:Rating = ' 1 '",
            "xmp:Rating=\"1\"",
        ] {
            assert_eq!(extract_xmp_rating(xmp), Some(1));
        }
        for value in ["-1", "6", "255", "invalid"] {
            assert_eq!(
                extract_xmp_rating(&format!("<xmp:Rating>{value}</xmp:Rating>")),
                None
            );
        }
        assert_eq!(extract_xmp_rating("<xmp:Rating>0</xmp:Rating>"), Some(0));
    }

    #[test]
    fn embedded_rating_reads_tiff_both_byte_orders() {
        for little in [true, false] {
            let short = |v: u16| {
                if little {
                    v.to_le_bytes()
                } else {
                    v.to_be_bytes()
                }
            };
            let long = |v: u32| {
                if little {
                    v.to_le_bytes()
                } else {
                    v.to_be_bytes()
                }
            };
            let packet = b"<xmp:Rating>3</xmp:Rating>";
            let mut bytes = if little {
                b"II".to_vec()
            } else {
                b"MM".to_vec()
            };
            bytes.extend(short(42));
            bytes.extend(long(8));
            bytes.extend(short(1));
            bytes.extend(short(700));
            bytes.extend(short(1));
            bytes.extend(long(packet.len() as u32));
            bytes.extend(long(26));
            bytes.extend(long(0));
            bytes.extend(packet);
            let mut file = tempfile::NamedTempFile::new().unwrap();
            file.write_all(&bytes).unwrap();
            assert_eq!(read_rating(file.path()), Some(3));
            file.as_file_mut().set_len(20).unwrap();
            assert_eq!(read_rating(file.path()), None);
        }
    }

    #[test]
    fn embedded_rating_reads_jpeg_xmp() {
        let packet = b"http://ns.adobe.com/xap/1.0/\0<xmp:Rating>5</xmp:Rating>";
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(&[0xff, 0xd8, 0xff, 0xe1]).unwrap();
        file.write_all(&((packet.len() + 2) as u16).to_be_bytes())
            .unwrap();
        file.write_all(packet).unwrap();
        assert_eq!(read_rating(file.path()), Some(5));
    }

    #[test]
    #[ignore = "requires the user's camera photos; set RAPIDRAW_RATING_TEST_DIR"]
    fn embedded_rating_camera_photos() {
        let directory = std::env::var("RAPIDRAW_RATING_TEST_DIR").unwrap();
        for number in 10..=25 {
            let path = Path::new(&directory).join(format!("DMM_{number:04}.CR2"));
            let expected = u8::from(matches!(number, 10 | 13 | 19));
            assert_eq!(read_rating(&path), Some(expected), "{}", path.display());
            let directory = tempfile::tempdir().unwrap();
            let sidecar = directory.path().join("test.rrdata");
            let loaded = crate::exif_processing::load_image_metadata(&path, &sidecar);
            assert_eq!(loaded.rating, expected);
            assert!(
                !sidecar.exists(),
                "Reading camera ratings must not create sidecars"
            );
            let mut metadata = crate::image_processing::ImageMetadata::default();
            std::fs::write(&sidecar, serde_json::to_vec(&metadata).unwrap()).unwrap();
            assert_eq!(
                crate::exif_processing::load_image_metadata(&path, &sidecar).rating,
                expected
            );
            metadata.rating_is_explicit = true;
            std::fs::write(&sidecar, serde_json::to_vec(&metadata).unwrap()).unwrap();
            assert_eq!(
                crate::exif_processing::load_image_metadata(&path, &sidecar).rating,
                0
            );
            metadata.rating = 4;
            metadata.rating_is_explicit = false;
            std::fs::write(&sidecar, serde_json::to_vec(&metadata).unwrap()).unwrap();
            assert_eq!(
                crate::exif_processing::load_image_metadata(&path, &sidecar).rating,
                4
            );
        }
    }
}
