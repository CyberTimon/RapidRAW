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

// Converted inputs are exposed only on platforms with a production decoder.
// Other platform adapters can be added behind `converted_input` without
// changing callers or falsely advertising formats that cannot be opened.
#[cfg(target_os = "macos")]
pub const CONVERTED_INPUT_EXTENSIONS: &[&str] = &["hif", "heic", "heif"];

#[cfg(not(target_os = "macos"))]
pub const CONVERTED_INPUT_EXTENSIONS: &[&str] = &[];

fn has_extension<P: AsRef<Path>>(path: P, extensions: &[&str]) -> bool {
    let Some(ext) = path.as_ref().extension().and_then(|s| s.to_str()) else {
        return false;
    };

    extensions
        .iter()
        .any(|supported_ext| supported_ext.eq_ignore_ascii_case(ext))
}

pub fn is_raw_file<P: AsRef<Path>>(path: P) -> bool {
    let Some(ext) = path.as_ref().extension().and_then(|s| s.to_str()) else {
        return false;
    };

    RAW_EXTENSIONS
        .iter()
        .any(|(raw_ext, _)| raw_ext.eq_ignore_ascii_case(ext))
}

pub fn is_converted_input_file<P: AsRef<Path>>(path: P) -> bool {
    has_extension(path, CONVERTED_INPUT_EXTENSIONS)
}

pub fn supported_non_raw_extensions() -> impl Iterator<Item = &'static str> {
    NON_RAW_EXTENSIONS
        .iter()
        .chain(CONVERTED_INPUT_EXTENSIONS.iter())
        .copied()
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

    is_raw_file(path) || has_extension(path, NON_RAW_EXTENSIONS) || is_converted_input_file(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn converted_input_detection_is_case_insensitive() {
        assert!(is_converted_input_file("photo.HEIC"));
        assert!(is_converted_input_file("photo.heif"));
        assert!(is_converted_input_file("photo.HiF"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn converted_inputs_are_in_shared_folder_discovery_registry() {
        for path in [
            "synced/IMG_0001.HEIC",
            "synced/IMG_0002.heif",
            "synced/IMG_0003.HiF",
        ] {
            assert!(
                is_supported_image_file(path),
                "folder discovery should include {path}"
            );
        }

        let advertised: Vec<_> = supported_non_raw_extensions().collect();
        for extension in CONVERTED_INPUT_EXTENSIONS {
            assert!(
                advertised.contains(extension),
                "file pickers and drop targets should advertise {extension}"
            );
        }
    }

    #[test]
    fn supported_images_reject_hidden_and_unknown_files() {
        assert!(!is_supported_image_file(".hidden.jpg"));
        assert!(!is_supported_image_file("photo.txt"));
        assert!(is_supported_image_file("photo.jpeg"));
    }
}
