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
    "avif", "exr", "hdr", // High Dynamic Range / Wide Gamut
    "tga", "ico", "dds", // Graphics & Icons
    "qoi", "ff", // Simple/Specialist formats
    "pnm", "pbm", "pgm", "ppm", "pam", // Netpbm family
];

#[cfg(any(target_os = "windows", target_os = "macos"))]
pub const OS_DECODED_EXTENSIONS: &[&str] = &["heic", "heif", "hif"];
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub const OS_DECODED_EXTENSIONS: &[&str] = &[];

pub const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mov", "m4v", "mkv", "webm", "avi", "mts", "m2ts", "mxf", "3gp", "wmv", "mpg", "mpeg",
];

pub const AUDIO_EXTENSIONS: &[&str] = &["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus"];

pub const VIDEO_PROJECT_EXTENSION: &str = "rrproj";

const ALPHA_EXTENSIONS: &[&str] = &[
    "png", "webp", "tif", "tiff", "gif", "bmp", "tga", "ico", "dds", "qoi", "ff", "pam", "exr",
    "avif",
];

fn has_extension_in(path: &Path, extensions: &[&str]) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|ext| extensions.iter().any(|e| e.eq_ignore_ascii_case(ext)))
}

pub fn is_raw_file<P: AsRef<Path>>(path: P) -> bool {
    let ext = match path.as_ref().extension().and_then(|s| s.to_str()) {
        Some(e) => e,
        None => return false,
    };

    RAW_EXTENSIONS
        .iter()
        .any(|(raw_ext, _)| raw_ext.eq_ignore_ascii_case(ext))
}

pub fn is_video_file<P: AsRef<Path>>(path: P) -> bool {
    let path = path.as_ref();
    let path = path
        .to_str()
        .and_then(|s| s.rsplit_once("?vc=").map(|(base, _)| Path::new(base)))
        .unwrap_or(path);
    has_extension_in(path, VIDEO_EXTENSIONS)
}

pub fn is_audio_file<P: AsRef<Path>>(path: P) -> bool {
    has_extension_in(path.as_ref(), AUDIO_EXTENSIONS)
}

pub fn is_video_project_file<P: AsRef<Path>>(path: P) -> bool {
    has_extension_in(path.as_ref(), &[VIDEO_PROJECT_EXTENSION])
}

pub fn may_have_alpha<P: AsRef<Path>>(path: P) -> bool {
    has_extension_in(path.as_ref(), ALPHA_EXTENSIONS)
}

pub fn is_supported_media_file<P: AsRef<Path>>(
    path: P,
    videos_supported: impl FnOnce() -> bool,
) -> bool {
    let path = path.as_ref();
    is_supported_image_file(path)
        || (!is_hidden(path)
            && (is_video_file(path) || is_video_project_file(path))
            && videos_supported())
}

fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with('.'))
}

pub fn is_supported_image_file<P: AsRef<Path>>(path: P) -> bool {
    let path = path.as_ref();

    if is_hidden(path) {
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
        .chain(OS_DECODED_EXTENSIONS)
        .any(|non_raw_ext| non_raw_ext.eq_ignore_ascii_case(ext))
}
