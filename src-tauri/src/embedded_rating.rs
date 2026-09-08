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
    crate::rating_cache::read(path).ok().flatten()
}

pub fn read_rating_checked(path: &Path) -> std::io::Result<Option<u8>> {
    let mut file = File::open(path)?;
    let mut header = [0; 8];
    file.read_exact(&mut header)?;
    match &header[..4] {
        b"II*\0" => read_tiff_rating(&mut file, header, true),
        b"MM\0*" => read_tiff_rating(&mut file, header, false),
        _ if header[..2] == [0xff, 0xd8] => read_jpeg_rating(&mut file),
        _ if &header[4..] == b"ftyp" => crate::cr3_rating::read(&mut file),
        _ => Ok(None),
    }
}

fn read_tiff_rating(file: &mut File, header: [u8; 8], little: bool) -> std::io::Result<Option<u8>> {
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
        file.seek(SeekFrom::Start(offset))?;
        let mut count = [0; 2];
        file.read_exact(&mut count)?;
        let count = u16_at(&count) as usize;
        if count > 4096 {
            return Err(std::io::Error::other("Too many TIFF fields"));
        }
        let mut entries = vec![0; count * 12 + 4];
        file.read_exact(&mut entries)?;
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
                file.seek(SeekFrom::Start(u32_at(&entry[8..]) as u64))?;
                let mut packet = vec![0; size];
                file.read_exact(&mut packet)?;
                if let Some(rating) = extract_xmp_rating(&String::from_utf8_lossy(&packet)) {
                    return Ok(Some(rating));
                }
            }
        }
        offset = u32_at(&entries[count * 12..]) as u64;
    }
    Ok(exif_rating)
}

fn read_jpeg_rating(file: &mut File) -> std::io::Result<Option<u8>> {
    file.seek(SeekFrom::Start(2))?;
    for _ in 0..1024 {
        let mut marker = [0; 2];
        file.read_exact(&mut marker)?;
        if marker[0] != 0xff || matches!(marker[1], 0xda | 0xd9) {
            return Ok(None);
        }
        if marker[1] == 0xff {
            file.seek(SeekFrom::Current(-1))?;
            continue;
        }
        if matches!(marker[1], 0x01 | 0xd0..=0xd8) {
            continue;
        }
        let mut length = [0; 2];
        file.read_exact(&mut length)?;
        let length = u16::from_be_bytes(length)
            .checked_sub(2)
            .ok_or_else(|| std::io::Error::other("Invalid JPEG segment"))?
            as usize;
        if marker[1] == 0xe1 {
            let mut packet = vec![0; length];
            file.read_exact(&mut packet)?;
            if packet.starts_with(b"http://ns.adobe.com/xap/1.0/\0")
                && let Some(rating) = extract_xmp_rating(&String::from_utf8_lossy(&packet))
            {
                return Ok(Some(rating));
            }
        } else {
            file.seek(SeekFrom::Current(length as i64))?;
        }
    }
    Ok(None)
}

#[cfg(test)]
#[path = "embedded_rating_tests.rs"]
mod tests;
