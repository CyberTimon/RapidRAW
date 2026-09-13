use super::{
    cached_thumbnail_paths, encode_thumbnail, parse_virtual_path,
    write_adjustment_sidecar_preserving_source, write_thumbnail_atomic,
};

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

#[test]
fn adjustment_sync_outputs_preserve_the_original_image() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("photo.jpg");
    let cache = directory.path().join("cache");
    std::fs::create_dir(&cache).unwrap();

    let image = image::DynamicImage::new_rgb8(40, 30);
    let original_bytes = encode_thumbnail(&image, 40).unwrap();
    std::fs::write(&source, &original_bytes).unwrap();
    let original_metadata = std::fs::metadata(&source).unwrap();

    let (parsed_source, sidecar) = parse_virtual_path(source.to_str().unwrap());
    let adjustment_json = br#"{"adjustments":{"brightness":1.0}}"#;
    write_adjustment_sidecar_preserving_source(&parsed_source, &sidecar, adjustment_json).unwrap();

    let small = cache.join("small.jpg");
    let medium = cache.join("medium.jpg");
    write_thumbnail_atomic(&small, &original_bytes).unwrap();
    write_thumbnail_atomic(&medium, &original_bytes).unwrap();

    let current_metadata = std::fs::metadata(&source).unwrap();
    assert_eq!(std::fs::read(&source).unwrap(), original_bytes);
    assert_eq!(current_metadata.len(), original_metadata.len());
    assert_eq!(
        current_metadata.modified().unwrap(),
        original_metadata.modified().unwrap()
    );
    assert_eq!(std::fs::read(&sidecar).unwrap(), adjustment_json);
    assert_eq!(std::fs::read_dir(&cache).unwrap().count(), 2);
    assert!(small.starts_with(&cache));
    assert!(medium.starts_with(&cache));
}

#[test]
fn adjustment_sidecars_never_target_normal_or_virtual_copy_sources() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("photo.jpg");
    std::fs::write(&source, b"original").unwrap();

    let source_str = source.to_str().unwrap();
    let (normal_source, normal_sidecar) = parse_virtual_path(source_str);
    let virtual_path = format!("{source_str}?vc=alternate");
    let (virtual_source, virtual_sidecar) = parse_virtual_path(&virtual_path);

    assert_eq!(normal_source, source);
    assert_eq!(virtual_source, source);
    assert_ne!(normal_sidecar, source);
    assert_ne!(virtual_sidecar, source);
    assert_eq!(normal_sidecar.file_name().unwrap(), "photo.jpg.rrdata");
    assert_eq!(
        virtual_sidecar.file_name().unwrap(),
        "photo.jpg.alternate.rrdata"
    );

    let error = write_adjustment_sidecar_preserving_source(&source, &source, b"metadata")
        .expect_err("source path must never be accepted as a sidecar target");
    assert!(error.contains("Refusing to write adjustment metadata over source image"));
    assert_eq!(std::fs::read(&source).unwrap(), b"original");
}

#[test]
#[ignore = "requires RAPIDRAW_PREVIEW_TEST_FILE; measures real RAW decode and cached previews"]
fn real_raw_preview_benchmark() {
    let path = std::env::var("RAPIDRAW_PREVIEW_TEST_FILE").unwrap();
    let source = std::path::Path::new(&path);
    let directory = tempfile::tempdir().unwrap();
    let settings = crate::app_settings::AppSettings::default();
    let bytes = std::fs::read(source).unwrap();
    let digest = blake3::hash(&bytes);
    let start = std::time::Instant::now();
    let original = crate::image_loader::load_base_image_from_bytes(&bytes, &path, false, &settings, None).unwrap();
    println!("Original decode: {} ms, {}x{}, {} pixel bytes", start.elapsed().as_millis(), original.width(), original.height(), original.as_bytes().len());
    drop(original);
    for attempt in 0..3 {
        let small = directory.path().join("small.jpg");
        let medium = directory.path().join("medium.jpg");
        let start = std::time::Instant::now();
        let preview = super::try_load_embedded_raw_preview(source, 1280).unwrap();
        write_thumbnail_atomic(&small, &encode_thumbnail(&preview, 480).unwrap()).unwrap();
        write_thumbnail_atomic(&medium, &encode_thumbnail(&preview, 1280).unwrap()).unwrap();
        println!("Preview generation {}: {} ms", attempt + 1, start.elapsed().as_millis());
        let start = std::time::Instant::now();
        assert!(cached_thumbnail_paths(&small, &medium, true).is_some());
        let displayed = image::open(&medium).unwrap();
        println!("Warm preview {}: {} us, {}x{}, {} pixel bytes", attempt + 1, start.elapsed().as_micros(), displayed.width(), displayed.height(), displayed.as_bytes().len());
    }
    assert_eq!(digest, blake3::hash(&std::fs::read(source).unwrap()));
}
