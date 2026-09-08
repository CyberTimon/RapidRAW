use super::{cached_thumbnail_paths, encode_thumbnail, write_thumbnail_atomic};

#[test]
#[ignore = "requires RAPIDRAW_PREVIEW_TEST_FILE"]
fn camera_embedded_preview_without_raw_decode() {
    let path = std::path::PathBuf::from(std::env::var("RAPIDRAW_PREVIEW_TEST_FILE").unwrap());
    let before = std::fs::metadata(&path).unwrap();
    println!(
        "Legacy EXIF preview available: {}",
        super::try_load_exif_preview(&path, 480).is_some()
    );
    for attempt in 0..3 {
        let start = std::time::Instant::now();
        let preview =
            super::try_load_embedded_raw_preview(&path, 480).expect("embedded camera preview");
        assert!(preview.width().max(preview.height()) >= 456);
        println!(
            "Embedded preview attempt {}: {} ms, {}x{}",
            attempt + 1,
            start.elapsed().as_millis(),
            preview.width(),
            preview.height()
        );
    }
    let after = std::fs::metadata(&path).unwrap();
    assert_eq!(before.len(), after.len());
    assert_eq!(before.modified().unwrap(), after.modified().unwrap());
}

#[test]
fn small_cache_is_usable_without_a_medium_preview() {
    let directory = tempfile::tempdir().unwrap();
    let small = directory.path().join("small.jpg");
    let medium = directory.path().join("medium.jpg");
    let image = image::DynamicImage::new_rgb8(40, 30);
    let bytes = encode_thumbnail(&image, 40).unwrap();
    write_thumbnail_atomic(&small, &bytes).unwrap();
    assert!(cached_thumbnail_paths(&small, &medium, false).is_some());
    assert!(cached_thumbnail_paths(&small, &medium, true).is_none());
    std::fs::write(&medium, b"interrupted JPEG").unwrap();
    assert_eq!(
        cached_thumbnail_paths(&small, &medium, false).unwrap().1,
        ""
    );
    assert!(cached_thumbnail_paths(&small, &medium, true).is_none());
    write_thumbnail_atomic(&medium, &bytes).unwrap();
    assert!(cached_thumbnail_paths(&small, &medium, true).is_some());
    write_thumbnail_atomic(&small, &bytes).unwrap();
    assert_eq!(image::image_dimensions(&small).unwrap(), (40, 30));
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 2);
}
