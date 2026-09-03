use std::convert::AsRef;
use std::path::Path;

pub const RAW_EXTENSIONS: &[(&str, &str)] = &[
    // Adobe
    ("dng", "Adobe Digital Negative"),
    // Apple
    ("pro", "Apple ProRAW"),
    // Arri
    ("ari", "ARRI Raw"),
    // Canon
    ("crw", "Canon Raw"),
    ("cr2", "Canon Raw 2"),
    ("cr3", "Canon Raw 3"),
    // Casio
    ("bay", "Casio"),
    // Contax
    ("raw", "Contax"),
    // DJI
    // ("dng", "DJI (uses DNG)"), // Covered by Adobe

    // Epson
    ("erf", "Epson Raw"),
    // Fuji
    ("raf", "Fuji Raw"),
    // Hasselblad
    ("3fr", "Hasselblad"),
    ("fff", "Hasselblad"),
    // Imacon / Phase One
    ("iiq", "Imacon/Phase One"),
    // Kodak
    ("kdc", "Kodak"),
    ("k25", "Kodak"),
    ("dcs", "Kodak"),
    ("dcr", "Kodak"),
    // Leaf
    ("mos", "Leaf"),
    // Leica
    ("rwl", "Leica Raw"),
    // ("dng", "Leica (uses DNG)"), // Covered by Adobe

    // Mamiya
    ("mef", "Mamiya"),
    // Minolta
    ("mrw", "Minolta Raw"),
    // Nikon
    ("nef", "Nikon Electronic Format"),
    ("nrw", "Nikon Raw"),
    // Olympus
    ("orf", "Olympus Raw"),
    // Panasonic
    ("rw2", "Panasonic Raw 2"),
    ("raw", "Panasonic Raw"),
    // Pentax
    ("pef", "Pentax Electronic File"),
    ("ptx", "Pentax"),
    // Phase One
    // ("iiq", "Phase One (same as Imacon)"), // Covered by Imacon

    // Ricoh
    // ("dng", "Ricoh (uses DNG)"), // Covered by Adobe

    // Samsung
    ("srw", "Samsung Raw"),
    // Sigma
    ("x3f", "Sigma"),
    // Sony
    ("arw", "Sony Alpha Raw"),
    ("srf", "Sony Raw"),
    ("sr2", "Sony Raw 2"),
]; // Tell me if your's is missing.

pub const NON_RAW_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "bmp", "tiff", "tif", "webp", "jxl", // Standard formats
    "exr", "hdr", // High Dynamic Range / Wide Gamut
    "tga", "ico", "dds", // Graphics & Icons
    "qoi", "ff", // Simple/Specialist formats
    "pnm", "pbm", "pgm", "ppm", "pam", // Netpbm family
];

pub fn is_raw_file<P: AsRef<Path>>(path: P) -> bool {
    let ext = match path.as_ref().extension().and_then(|s| s.to_str()) {
        Some(e) => e,
        None => return false,
    };

    RAW_EXTENSIONS
        .iter()
        .any(|(raw_ext, _)| raw_ext.eq_ignore_ascii_case(ext))
}

pub fn is_supported_image_file<P: AsRef<Path>>(path: P) -> bool {
    let path = path.as_ref();

    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with('.'))
    {
        return false;
    }

    let ext = match path.extension().and_then(|s| s.to_str()) {
        Some(e) => e,
        None => return false,
    };

    if RAW_EXTENSIONS
        .iter()
        .any(|(raw_ext, _)| raw_ext.eq_ignore_ascii_case(ext))
    {
        return true;
    }

    NON_RAW_EXTENSIONS
        .iter()
        .any(|non_raw_ext| non_raw_ext.eq_ignore_ascii_case(ext))
}

/// Returns whether a path points to a supported image with locally readable content.
///
/// Zero-byte image entries cannot be decoded and commonly represent cloud-sync
/// placeholders whose contents have not been downloaded yet. Metadata is read on
/// every call so the image becomes discoverable on the next scan after hydration.
pub fn is_nonempty_supported_image_file<P: AsRef<Path>>(path: P) -> bool {
    let path = path.as_ref();

    is_supported_image_file(path)
        && std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
}

#[cfg(test)]
mod tests {
    use super::{is_nonempty_supported_image_file, is_supported_image_file};

    #[test]
    fn empty_supported_images_are_hidden_until_they_have_content() {
        let temp_dir = tempfile::tempdir().expect("create temp directory");
        let image_path = temp_dir.path().join("cloud-placeholder.jpg");

        std::fs::File::create(&image_path).expect("create empty image placeholder");
        assert!(is_supported_image_file(&image_path));
        assert!(!is_nonempty_supported_image_file(&image_path));

        std::fs::write(&image_path, b"hydrated").expect("hydrate image placeholder");
        assert!(is_nonempty_supported_image_file(&image_path));
    }

    #[test]
    fn missing_and_unsupported_files_are_not_discoverable() {
        let temp_dir = tempfile::tempdir().expect("create temp directory");
        let missing_image = temp_dir.path().join("missing.jpg");
        let unsupported_file = temp_dir.path().join("notes.txt");

        std::fs::write(&unsupported_file, b"content").expect("create unsupported file");

        assert!(!is_nonempty_supported_image_file(missing_image));
        assert!(!is_nonempty_supported_image_file(unsupported_file));
    }
}
