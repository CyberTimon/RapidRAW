use anyhow::{Result, ensure};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
pub fn folder_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .take(100)
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let clean = cleaned.trim().trim_matches('.').trim();
    let base = clean.split('.').next().unwrap_or("").to_ascii_uppercase();
    if clean.is_empty() {
        "Person".into()
    } else if [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ]
    .contains(&base.as_str())
    {
        format!("_{clean}")
    } else {
        clean.into()
    }
}

pub fn create_folder(parent: &Path, name: &str) -> Result<PathBuf> {
    for n in 0..10000 {
        let path = parent.join(if n == 0 {
            name.into()
        } else {
            format!("{name} ({n})")
        });
        match std::fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    anyhow::bail!("Too many folder name collisions")
}

pub fn copy_original(source: &Path, folder: &Path, cancel: &AtomicBool) -> Result<()> {
    let mut input = std::fs::File::open(source)?;
    let filename = source
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("Missing filename"))?
        .to_string_lossy();
    let stem = source.file_stem().unwrap_or_default().to_string_lossy();
    let ext = source
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for n in 0..10000 {
        let path = folder.join(if n == 0 {
            filename.to_string()
        } else {
            format!("{stem} ({n}){ext}")
        });
        let mut output = match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        };
        let result = (|| -> Result<()> {
            let mut buffer = vec![0; 1024 * 1024];
            loop {
                ensure!(!cancel.load(Ordering::Relaxed), "Export cancelled");
                let count = input.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                output.write_all(&buffer[..count])?;
            }
            output.flush()?;
            Ok(())
        })();
        drop(output);
        if result.is_err() {
            let _ = std::fs::remove_file(path);
        }
        return result;
    }
    anyhow::bail!("Too many filename collisions")
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;
    #[test]
    fn original_exports_deduplicate_names_and_clean_cancelled_output() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.jpg");
        std::fs::write(&source, b"photo").unwrap();
        let out = dir.path().join("out");
        std::fs::create_dir(&out).unwrap();
        for _ in 0..2 {
            super::copy_original(&source, &out, &AtomicBool::new(false)).unwrap();
        }
        assert_eq!(std::fs::read(out.join("source.jpg")).unwrap(), b"photo");
        assert_eq!(std::fs::read(out.join("source (1).jpg")).unwrap(), b"photo");
        assert!(super::copy_original(&source, &out, &AtomicBool::new(true)).is_err());
        assert!(!out.join("source (2).jpg").exists());
        assert_eq!(super::folder_name("../Alex/Smith"), "_Alex_Smith");
        assert!(
            super::copy_original(&dir.path().join("missing"), &out, &AtomicBool::new(false))
                .is_err()
        );
        let first = super::create_folder(&out, "Alex").unwrap();
        let second = super::create_folder(&out, "Alex").unwrap();
        assert_ne!(first, second);
        assert_eq!(super::folder_name("CON"), "_CON");
        assert_eq!(super::folder_name("..."), "Person");
    }
}
