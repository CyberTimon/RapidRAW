use std::path::{Path, PathBuf};

/// Visit parents before children without following directory symlinks.
/// A failed child does not hide readable siblings; a failed root is fatal.
pub fn walk(
    root: &Path,
    recursive: bool,
    cancelled: impl Fn() -> bool,
    mut visit: impl FnMut(&Path) -> Result<(), String>,
) -> Result<Vec<String>, String> {
    let mut pending = vec![root.to_path_buf()];
    let mut warnings = Vec::new();
    while let Some(directory) = pending.pop() {
        if cancelled() {
            break;
        }
        if let Err(error) = visit(&directory) {
            if directory == root {
                return Err(error);
            }
            warnings.push(format!("{}: {error}", directory.display()));
        }
        if !recursive {
            continue;
        }
        let mut children: Vec<PathBuf> = Vec::new();
        match std::fs::read_dir(&directory) {
            Ok(entries) => {
                for entry in entries {
                    if cancelled() {
                        return Ok(warnings);
                    }
                    match entry.and_then(|entry| Ok((entry.file_type()?, entry.path()))) {
                        Ok((kind, path)) if kind.is_dir() => children.push(path),
                        Ok(_) => {}
                        Err(error) => warnings.push(error.to_string()),
                    }
                }
            }
            Err(error) => warnings.push(error.to_string()),
        }
        children.sort();
        pending.extend(children.into_iter().rev());
    }
    Ok(warnings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    #[test]
    fn ten_thousand_files_are_discovered_without_waiting_for_the_last_folder() {
        let root = tempfile::tempdir().unwrap();
        for folder in 0..40 {
            let directory = root.path().join(format!("{folder:02}"));
            std::fs::create_dir(&directory).unwrap();
            for file in 0..250 {
                std::fs::File::create(directory.join(format!("{file}.jpg"))).unwrap();
            }
        }
        let mut batches = Vec::new();
        walk(
            root.path(),
            true,
            || false,
            |directory| {
                let count = std::fs::read_dir(directory)
                    .unwrap()
                    .filter(|entry| entry.as_ref().unwrap().file_type().unwrap().is_file())
                    .count();
                batches.push(count);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(batches[1], 250);
        assert_eq!(batches.iter().sum::<usize>(), 10_000);
        assert_eq!(batches.len(), 41);
    }
    #[test]
    fn recursive_discovery_is_progressive_and_cancellable() {
        let root = tempfile::tempdir().unwrap();
        for path in ["a/one", "b/two", "c/three"] {
            std::fs::create_dir_all(root.path().join(path)).unwrap();
        }
        let count = Cell::new(0);
        walk(
            root.path(),
            true,
            || count.get() == 3,
            |_| {
                count.set(count.get() + 1);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(count.get(), 3);
        let mut visited = Vec::new();
        walk(
            root.path(),
            true,
            || false,
            |path| {
                visited.push(path.to_path_buf());
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(visited.len(), 7);
        assert_eq!(visited[0], root.path());
        assert_eq!(visited[1], root.path().join("a"));
        let mut flat = 0;
        walk(
            root.path(),
            false,
            || false,
            |_| {
                flat += 1;
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(flat, 1);
    }
    #[test]
    fn failed_children_do_not_hide_siblings() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("a")).unwrap();
        std::fs::create_dir(root.path().join("b")).unwrap();
        let mut seen_b = false;
        let warnings = walk(
            root.path(),
            true,
            || false,
            |path| {
                if path.ends_with("a") {
                    return Err("unreadable".into());
                }
                seen_b |= path.ends_with("b");
                Ok(())
            },
        )
        .unwrap();
        assert!(seen_b);
        assert_eq!(warnings.len(), 1);
    }
    #[cfg(unix)]
    #[test]
    fn symlink_cycles_are_not_followed() {
        let root = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(root.path(), root.path().join("cycle")).unwrap();
        let mut count = 0;
        walk(
            root.path(),
            true,
            || false,
            |_| {
                count += 1;
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(count, 1);
    }
}
