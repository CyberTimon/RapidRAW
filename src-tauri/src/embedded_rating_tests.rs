use crate::embedded_rating::*;
use std::io::Write;
use std::path::Path;

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
