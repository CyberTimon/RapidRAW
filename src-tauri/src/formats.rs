/// List of recognized RAW file extensions, associated with their format name.
/// Used to identify RAW files from various camera manufacturers.
/// Currently supported formats include:
/// - Adobe (DNG)
/// - Apple (ProRAW)
/// - Arri (ARI)
/// - Canon (CRW, CR2, CR3)
/// - Casio (BAY)
/// - Contax (RAW)
/// - Epson (ERF)
/// - Fuji (RAF)
/// - Hasselblad (3FR, FFF)
/// - Imacon / Phase One (IIQ)
/// - Kodak (KDC, K25, DCS, DCR)
/// - Leaf (MOS)
/// - Leica (RWL)
/// - Mamiya (MEF)
/// - Minolta (MRW)
/// - Nikon (NEF, NRW)
/// - Olympus (ORF)
/// - Panasonic (RW2, RAW)
/// - Pentax (PEF, PTX)
/// - Samsung (SRW)
/// - Sigma (X3F)
/// - Sony (ARW, SRF, SR2)
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


/// List of supported non-RAW image file extensions.
/// Used to identify standard image files.
/// Currently supported formats include:
/// - JPEG (jpg, jpeg)
/// - PNG (png)
/// - GIF (gif)
/// - BMP (bmp)
/// - TIFF (tiff, tif)
pub const NON_RAW_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "bmp", "tiff", "tif"];


/// Checks if the given path corresponds to a recognized RAW file.
///
/// # Arguments
///
/// * `path` - The file path to check.
///
/// # Returns
///
/// * `true` if the file is a recognized RAW file, `false` otherwise.
pub fn is_raw_file(path: &str) -> bool {
    if let Some(ext) = std::path::Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
    {
        let lower_ext = ext.to_lowercase();
        RAW_EXTENSIONS
            .iter()
            .any(|(raw_ext, _)| *raw_ext == lower_ext)
    } else {
        false
    }
}


/// Checks if the given path corresponds to a supported image file (RAW or non-RAW).
///
/// # Arguments
///
/// * `path` - The file path to check.
///
/// # Returns
///
/// * `true` if the file is a supported image file, `false` otherwise.
pub fn is_supported_image_file(path: &str) -> bool {
    if let Some(ext) = std::path::Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
    {
        let lower_ext = ext.to_lowercase();
        RAW_EXTENSIONS
            .iter()
            .any(|(raw_ext, _)| *raw_ext == lower_ext)
            || NON_RAW_EXTENSIONS
                .iter()
                .any(|non_raw_ext| *non_raw_ext == lower_ext)
    } else {
        false
    }
}
