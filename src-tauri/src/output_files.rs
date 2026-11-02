use std::collections::HashSet;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Publish a complete generated image without replacing an image or reusing its edits.
pub fn write_unique_output(
    dir: &Path,
    stem: &str,
    extension: &str,
    contents: &[u8],
) -> io::Result<PathBuf> {
    let mut builder = tempfile::Builder::new();
    builder.prefix(".rr-output-").suffix(".tmp");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(fs::Permissions::from_mode(0o666));
    }
    let mut temporary = builder.tempfile_in(dir)?;
    temporary.write_all(contents)?;
    temporary.as_file().sync_all()?;

    let mut sidecar_sources = HashSet::new();
    for entry in fs::read_dir(dir)? {
        let name = entry?.file_name();
        if let Some(name) = name.to_str() {
            let name = name.to_lowercase();
            let source = crate::file_management::parse_sidecar_name(&name)
                .map(|(source, _)| source)
                .or_else(|| name.strip_suffix(".rrexif"));
            if let Some(source) = source {
                sidecar_sources.insert(source.to_owned());
            }
        }
    }

    let mut counter = 0_u64;
    loop {
        let name = if counter == 0 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem}_{counter}.{extension}")
        };
        let path = dir.join(&name);
        let mut has_sidecar = sidecar_sources.contains(&name.to_lowercase());
        // Direct checks also honor the filesystem's case and Unicode normalization rules.
        for suffix in [".rrdata", ".rrexif"] {
            if has_sidecar {
                break;
            }
            let mut sidecar = path.as_os_str().to_owned();
            sidecar.push(suffix);
            has_sidecar = Path::new(&sidecar).try_exists()?;
        }
        if !has_sidecar {
            // The no-clobber persist handles another save winning this name after our scan.
            match temporary.persist_noclobber(&path) {
                Ok(_) => return Ok(path),
                Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {
                    temporary = error.file;
                }
                Err(error) => return Err(error.error),
            }
        }
        counter = counter
            .checked_add(1)
            .ok_or_else(|| io::Error::other("No available output filename"))?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    #[test]
    fn writes_complete_contents_without_overwriting_existing_results() {
        let dir = tempfile::tempdir().unwrap();
        let original = write_unique_output(dir.path(), "IMG_Hdr", "tiff", b"first").unwrap();
        let second = write_unique_output(dir.path(), "IMG_Hdr", "tiff", b"second").unwrap();
        assert_eq!(original.file_name().unwrap(), "IMG_Hdr.tiff");
        assert_eq!(second.file_name().unwrap(), "IMG_Hdr_1.tiff");
        assert_eq!(fs::read(original).unwrap(), b"first");
        assert_eq!(fs::read(second).unwrap(), b"second");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[test]
    fn skips_orphaned_primary_virtual_copy_and_exif_sidecars() {
        let dir = tempfile::tempdir().unwrap();
        let sidecars = [
            "IMG_Pano.tiff.rrdata",
            "IMG_Pano_1.tiff.a1b2c3.rrdata",
            "IMG_Pano_2.tiff.rrexif",
        ];
        for name in sidecars {
            fs::write(dir.path().join(name), b"old metadata").unwrap();
        }
        let output = write_unique_output(dir.path(), "IMG_Pano", "tiff", b"new image").unwrap();
        assert_eq!(output.file_name().unwrap(), "IMG_Pano_3.tiff");
        for name in sidecars {
            assert_eq!(fs::read(dir.path().join(name)).unwrap(), b"old metadata");
        }
    }

    #[test]
    fn conservatively_reserves_case_variant_sidecar_names() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("img_hdr.TIFF.RRDATA"), b"edits").unwrap();
        fs::write(
            dir.path().join("img_hdr_1.TIFF.A1B2C3.rrdata"),
            b"copy edits",
        )
        .unwrap();
        let output = write_unique_output(dir.path(), "IMG_Hdr", "tiff", b"image").unwrap();
        assert_eq!(output.file_name().unwrap(), "IMG_Hdr_2.tiff");
    }

    #[test]
    fn another_images_sidecar_does_not_reserve_the_output_name() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("IMG_Stacked.tiff.jpg.rrdata"), b"edits").unwrap();
        let output = write_unique_output(dir.path(), "IMG_Stacked", "tiff", b"new image").unwrap();
        assert_eq!(output.file_name().unwrap(), "IMG_Stacked.tiff");
    }

    #[test]
    fn concurrent_saves_keep_every_result() {
        let dir = tempfile::tempdir().unwrap();
        let barrier = Arc::new(Barrier::new(8));
        let threads: Vec<_> = (0_u8..8)
            .map(|id| {
                let path = dir.path().to_owned();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    let output = write_unique_output(&path, "IMG_Collage", "png", &[id]).unwrap();
                    (output, id)
                })
            })
            .collect();
        let outputs: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert_eq!(
            outputs
                .iter()
                .map(|(path, _)| path)
                .collect::<HashSet<_>>()
                .len(),
            8
        );
        for (path, id) in outputs {
            assert_eq!(fs::read(path).unwrap(), [id]);
        }
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 8);
    }

    #[test]
    fn preserves_unicode_names() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("résultats_写真");
        fs::create_dir(&parent).unwrap();
        fs::write(parent.join("星空_Hdr.tiff.rrdata"), b"edits").unwrap();
        let output = write_unique_output(&parent, "星空_Hdr", "tiff", b"image").unwrap();
        assert_eq!(output, parent.join("星空_Hdr_1.tiff"));
    }

    #[test]
    fn failed_publish_removes_the_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(write_unique_output(dir.path(), "missing/IMG", "png", b"image").is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn output_permissions_follow_normal_file_creation_and_umask() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let control = dir.path().join("control");
        fs::write(&control, b"control").unwrap();
        let output = write_unique_output(dir.path(), "IMG_Hdr", "tiff", b"image").unwrap();
        assert_eq!(
            output.metadata().unwrap().permissions().mode() & 0o777,
            control.metadata().unwrap().permissions().mode() & 0o777,
        );
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_or_replace_a_dangling_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("missing-target");
        let link = dir.path().join("IMG_Hdr.tiff");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let output = write_unique_output(dir.path(), "IMG_Hdr", "tiff", b"image").unwrap();
        assert_eq!(output.file_name().unwrap(), "IMG_Hdr_1.tiff");
        assert_eq!(fs::read_link(link).unwrap(), target);
        assert!(!target.exists());
    }
}
