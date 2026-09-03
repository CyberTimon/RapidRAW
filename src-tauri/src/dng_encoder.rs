//! 32-Bit Floating-Point Linear DNG Encoder for RapidRAW
//!
//! Implements Adobe Digital Negative (DNG 1.4 / TIFF 6.0) LinearRaw specification.
//! Encodes uncompressed 32-bit IEEE-754 floating-point RGB radiance samples (SampleFormat = 3)
//! with full color matrix calibration, D65 illuminant, and Adobe/Capture One compatibility.

use std::fs::File;
use std::io::{BufWriter, Cursor, Write};
use std::path::Path;
use image::{DynamicImage, Rgb32FImage};

// TIFF Data Types
const TIFF_TYPE_BYTE: u16 = 1;
const TIFF_TYPE_ASCII: u16 = 2;
const TIFF_TYPE_SHORT: u16 = 3;
const TIFF_TYPE_LONG: u16 = 4;
const TIFF_TYPE_RATIONAL: u16 = 5;
const TIFF_TYPE_SRATIONAL: u16 = 10;

// TIFF & DNG Tag IDs
const TAG_NEW_SUBFILE_TYPE: u16 = 0x00FE; // 254
const TAG_IMAGE_WIDTH: u16 = 0x0100; // 256
const TAG_IMAGE_LENGTH: u16 = 0x0101; // 257
const TAG_BITS_PER_SAMPLE: u16 = 0x0102; // 258
const TAG_COMPRESSION: u16 = 0x0103; // 259 (1 = Uncompressed)
const TAG_PHOTOMETRIC_INTERP: u16 = 0x0106; // 262 (34892 = LinearRaw)
const TAG_IMAGE_DESCRIPTION: u16 = 0x010E; // 270
const TAG_MAKE: u16 = 0x010F; // 271
const TAG_MODEL: u16 = 0x0110; // 272
const TAG_STRIP_OFFSETS: u16 = 0x0111; // 273
const TAG_ORIENTATION: u16 = 0x0112; // 274
const TAG_SAMPLES_PER_PIXEL: u16 = 0x0115; // 277 (3 = RGB)
const TAG_ROWS_PER_STRIP: u16 = 0x0116; // 278
const TAG_STRIP_BYTE_COUNTS: u16 = 0x0117; // 279
const TAG_X_RESOLUTION: u16 = 0x011A; // 282
const TAG_Y_RESOLUTION: u16 = 0x011B; // 283
const TAG_PLANAR_CONFIG: u16 = 0x011C; // 284 (1 = Chunky)
const TAG_RESOLUTION_UNIT: u16 = 0x0128; // 296 (2 = Inch)
const TAG_SOFTWARE: u16 = 0x0131; // 305
const TAG_SAMPLE_FORMAT: u16 = 0x0153; // 339 (3 = IEEE Float)
const TAG_DNG_VERSION: u16 = 0xC612; // 50706 ([1, 4, 0, 0])
const TAG_DNG_BACKWARD_VERSION: u16 = 0xC613; // 50707 ([1, 3, 0, 0])
const TAG_UNIQUE_CAMERA_MODEL: u16 = 0xC614; // 50708
const TAG_BLACK_LEVEL: u16 = 0xC61A; // 50714
const TAG_WHITE_LEVEL: u16 = 0xC61D; // 50717
const TAG_COLOR_MATRIX_1: u16 = 0xC621; // 50721 (sRGB/D65 Matrix)
const TAG_AS_SHOT_NEUTRAL: u16 = 0xC628; // 50728 ([1, 1, 1])
const TAG_BASELINE_EXPOSURE: u16 = 0xC62A; // 50730 (0.0 EV)
const TAG_BASELINE_NOISE: u16 = 0xC62B; // 50731
const TAG_CALIBRATION_ILLUMINANT_1: u16 = 0xC65A; // 50778 (21 = D65)

#[derive(Debug, Clone)]
pub struct DngExportMetadata {
    pub make: Option<String>,
    pub model: Option<String>,
    pub software: Option<String>,
    pub description: Option<String>,
    pub as_shot_neutral: Option<[f32; 3]>,
    pub baseline_exposure: Option<f32>,
}

impl Default for DngExportMetadata {
    fn default() -> Self {
        Self {
            make: Some("RapidRAW".to_string()),
            model: Some("RapidRAW 32-Bit Linear DNG".to_string()),
            software: Some("RapidRAW Studio Engine".to_string()),
            description: Some("32-Bit Floating-Point Linear DNG Composite".to_string()),
            as_shot_neutral: Some([1.0, 1.0, 1.0]),
            baseline_exposure: Some(0.0),
        }
    }
}

struct TiffEntry {
    tag: u16,
    field_type: u16,
    count: u32,
    data_or_offset: u32,
    extra_bytes: Option<Vec<u8>>,
}

/// Encodes a 32-bit linear floating-point image into standard Adobe DNG (TIFF 6.0 LinearRaw) format
pub fn encode_linear_dng(image: &Rgb32FImage, metadata: Option<&DngExportMetadata>) -> Result<Vec<u8>, String> {
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return Err("Cannot encode empty image to DNG".to_string());
    }

    let default_meta = DngExportMetadata::default();
    let meta = metadata.unwrap_or(&default_meta);

    let mut cursor = Cursor::new(Vec::with_capacity((width * height * 12) as usize + 4096));

    // 1. TIFF Header (Little-Endian 'II', Magic 42, Offset to IFD0 = 8)
    cursor.write_all(b"II").map_err(|e| e.to_string())?; // Little-endian
    cursor.write_all(&42u16.to_le_bytes()).map_err(|e| e.to_string())?; // TIFF magic
    let ifd0_offset = 8u32;
    cursor.write_all(&ifd0_offset.to_le_bytes()).map_err(|e| e.to_string())?;

    // Prepare tags
    let mut entries: Vec<TiffEntry> = Vec::new();

    // Tag: NewSubfileType = 0 (Full resolution)
    entries.push(TiffEntry {
        tag: TAG_NEW_SUBFILE_TYPE,
        field_type: TIFF_TYPE_LONG,
        count: 1,
        data_or_offset: 0,
        extra_bytes: None,
    });

    // Tag: ImageWidth
    entries.push(TiffEntry {
        tag: TAG_IMAGE_WIDTH,
        field_type: TIFF_TYPE_LONG,
        count: 1,
        data_or_offset: width,
        extra_bytes: None,
    });

    // Tag: ImageLength
    entries.push(TiffEntry {
        tag: TAG_IMAGE_LENGTH,
        field_type: TIFF_TYPE_LONG,
        count: 1,
        data_or_offset: height,
        extra_bytes: None,
    });

    // Tag: BitsPerSample = [32, 32, 32]
    let mut bps_bytes = Vec::with_capacity(6);
    bps_bytes.extend_from_slice(&32u16.to_le_bytes());
    bps_bytes.extend_from_slice(&32u16.to_le_bytes());
    bps_bytes.extend_from_slice(&32u16.to_le_bytes());
    entries.push(TiffEntry {
        tag: TAG_BITS_PER_SAMPLE,
        field_type: TIFF_TYPE_SHORT,
        count: 3,
        data_or_offset: 0, // Assigned during serialization
        extra_bytes: Some(bps_bytes),
    });

    // Tag: Compression = 1 (Uncompressed)
    entries.push(TiffEntry {
        tag: TAG_COMPRESSION,
        field_type: TIFF_TYPE_SHORT,
        count: 1,
        data_or_offset: 1,
        extra_bytes: None,
    });

    // Tag: PhotometricInterpretation = 34892 (LinearRaw)
    entries.push(TiffEntry {
        tag: TAG_PHOTOMETRIC_INTERP,
        field_type: TIFF_TYPE_SHORT,
        count: 1,
        data_or_offset: 34892,
        extra_bytes: None,
    });

    // Tag: Orientation = 1 (Top-Left)
    entries.push(TiffEntry {
        tag: TAG_ORIENTATION,
        field_type: TIFF_TYPE_SHORT,
        count: 1,
        data_or_offset: 1,
        extra_bytes: None,
    });

    // Tag: SamplesPerPixel = 3 (RGB)
    entries.push(TiffEntry {
        tag: TAG_SAMPLES_PER_PIXEL,
        field_type: TIFF_TYPE_SHORT,
        count: 1,
        data_or_offset: 3,
        extra_bytes: None,
    });

    // Tag: PlanarConfiguration = 1 (Chunky RGBRGB...)
    entries.push(TiffEntry {
        tag: TAG_PLANAR_CONFIG,
        field_type: TIFF_TYPE_SHORT,
        count: 1,
        data_or_offset: 1,
        extra_bytes: None,
    });

    // Tag: SampleFormat = [3, 3, 3] (3 = IEEE Floating Point)
    let mut sf_bytes = Vec::with_capacity(6);
    sf_bytes.extend_from_slice(&3u16.to_le_bytes());
    sf_bytes.extend_from_slice(&3u16.to_le_bytes());
    sf_bytes.extend_from_slice(&3u16.to_le_bytes());
    entries.push(TiffEntry {
        tag: TAG_SAMPLE_FORMAT,
        field_type: TIFF_TYPE_SHORT,
        count: 3,
        data_or_offset: 0,
        extra_bytes: Some(sf_bytes),
    });

    // Tag: RowsPerStrip = height (Single contiguous full-frame strip)
    let rows_per_strip = height;
    entries.push(TiffEntry {
        tag: TAG_ROWS_PER_STRIP,
        field_type: TIFF_TYPE_LONG,
        count: 1,
        data_or_offset: rows_per_strip,
        extra_bytes: None,
    });

    // StripOffsets and StripByteCounts
    let strip_byte_count = width * height * 3 * 4; // width * height * 3 channels * 4 bytes/float
    entries.push(TiffEntry {
        tag: TAG_STRIP_OFFSETS,
        field_type: TIFF_TYPE_LONG,
        count: 1,
        data_or_offset: 0, // Placeholder, calculated later
        extra_bytes: None,
    });

    entries.push(TiffEntry {
        tag: TAG_STRIP_BYTE_COUNTS,
        field_type: TIFF_TYPE_LONG,
        count: 1,
        data_or_offset: strip_byte_count,
        extra_bytes: None,
    });

    // Tag: XResolution & YResolution = 300/1
    let mut res_bytes = Vec::with_capacity(8);
    res_bytes.extend_from_slice(&300u32.to_le_bytes());
    res_bytes.extend_from_slice(&1u32.to_le_bytes());
    entries.push(TiffEntry {
        tag: TAG_X_RESOLUTION,
        field_type: TIFF_TYPE_RATIONAL,
        count: 1,
        data_or_offset: 0,
        extra_bytes: Some(res_bytes.clone()),
    });
    entries.push(TiffEntry {
        tag: TAG_Y_RESOLUTION,
        field_type: TIFF_TYPE_RATIONAL,
        count: 1,
        data_or_offset: 0,
        extra_bytes: Some(res_bytes),
    });

    // Tag: ResolutionUnit = 2 (Inches)
    entries.push(TiffEntry {
        tag: TAG_RESOLUTION_UNIT,
        field_type: TIFF_TYPE_SHORT,
        count: 1,
        data_or_offset: 2,
        extra_bytes: None,
    });

    // Tag: Software
    if let Some(sw) = &meta.software {
        let mut b = sw.as_bytes().to_vec();
        b.push(0);
        let count = b.len() as u32;
        entries.push(TiffEntry {
            tag: TAG_SOFTWARE,
            field_type: TIFF_TYPE_ASCII,
            count,
            data_or_offset: 0,
            extra_bytes: Some(b),
        });
    }

    // Tag: ImageDescription
    if let Some(desc) = &meta.description {
        let mut b = desc.as_bytes().to_vec();
        b.push(0);
        let count = b.len() as u32;
        entries.push(TiffEntry {
            tag: TAG_IMAGE_DESCRIPTION,
            field_type: TIFF_TYPE_ASCII,
            count,
            data_or_offset: 0,
            extra_bytes: Some(b),
        });
    }

    // Tag: Make & Model
    if let Some(make) = &meta.make {
        let mut b = make.as_bytes().to_vec();
        b.push(0);
        let count = b.len() as u32;
        entries.push(TiffEntry {
            tag: TAG_MAKE,
            field_type: TIFF_TYPE_ASCII,
            count,
            data_or_offset: 0,
            extra_bytes: Some(b),
        });
    }
    if let Some(model) = &meta.model {
        let mut b = model.as_bytes().to_vec();
        b.push(0);
        let count = b.len() as u32;
        entries.push(TiffEntry {
            tag: TAG_MODEL,
            field_type: TIFF_TYPE_ASCII,
            count,
            data_or_offset: 0,
            extra_bytes: Some(b),
        });
    }

    // Tag: DNGVersion = [1, 4, 0, 0]
    let dng_ver: u32 = u32::from_le_bytes([1, 4, 0, 0]);
    entries.push(TiffEntry {
        tag: TAG_DNG_VERSION,
        field_type: TIFF_TYPE_BYTE,
        count: 4,
        data_or_offset: dng_ver,
        extra_bytes: None,
    });

    // Tag: DNGBackwardVersion = [1, 3, 0, 0]
    let dng_back_ver: u32 = u32::from_le_bytes([1, 3, 0, 0]);
    entries.push(TiffEntry {
        tag: TAG_DNG_BACKWARD_VERSION,
        field_type: TIFF_TYPE_BYTE,
        count: 4,
        data_or_offset: dng_back_ver,
        extra_bytes: None,
    });

    // Tag: UniqueCameraModel
    let model_str = meta.model.as_deref().unwrap_or("RapidRAW 32-Bit Linear HDR DNG");
    let mut model_bytes = model_str.as_bytes().to_vec();
    model_bytes.push(0);
    let model_count = model_bytes.len() as u32;
    entries.push(TiffEntry {
        tag: TAG_UNIQUE_CAMERA_MODEL,
        field_type: TIFF_TYPE_ASCII,
        count: model_count,
        data_or_offset: 0,
        extra_bytes: Some(model_bytes),
    });

    // Tag: ColorMatrix1 (sRGB D65 Matrix: 3x3 matrix in SRATIONAL format)
    // DNG Specification: Maps CIE XYZ (D65) to Camera Reference RGB
    // [ 3.2404542, -1.5371385, -0.4985314, -0.9692660, 1.8760108, 0.0415560, 0.0556434, -0.2040259, 1.0572252 ]
    let mut cm_bytes = Vec::with_capacity(72);
    let srgb_matrix_coeffs: [f64; 9] = [
        3.2404542, -1.5371385, -0.4985314,
        -0.9692660, 1.8760108, 0.0415560,
        0.0556434, -0.2040259, 1.0572252,
    ];
    for &coeff in &srgb_matrix_coeffs {
        let num = (coeff * 10000.0).round() as i32;
        let denom = 10000i32;
        cm_bytes.extend_from_slice(&num.to_le_bytes());
        cm_bytes.extend_from_slice(&denom.to_le_bytes());
    }
    entries.push(TiffEntry {
        tag: TAG_COLOR_MATRIX_1,
        field_type: TIFF_TYPE_SRATIONAL,
        count: 9,
        data_or_offset: 0,
        extra_bytes: Some(cm_bytes),
    });

    // Tag: AsShotNeutral (RATIONAL[3])
    let mut asn_bytes = Vec::with_capacity(24);
    let neutrals = meta.as_shot_neutral.unwrap_or([1.0, 1.0, 1.0]);
    for &n in &neutrals {
        let num = (n * 10000.0).round().max(1.0) as u32;
        let denom = 10000u32;
        asn_bytes.extend_from_slice(&num.to_le_bytes());
        asn_bytes.extend_from_slice(&denom.to_le_bytes());
    }
    entries.push(TiffEntry {
        tag: TAG_AS_SHOT_NEUTRAL,
        field_type: TIFF_TYPE_RATIONAL,
        count: 3,
        data_or_offset: 0,
        extra_bytes: Some(asn_bytes),
    });

    // Tag: CalibrationIlluminant1 = 21 (D65)
    entries.push(TiffEntry {
        tag: TAG_CALIBRATION_ILLUMINANT_1,
        field_type: TIFF_TYPE_SHORT,
        count: 1,
        data_or_offset: 21,
        extra_bytes: None,
    });

    // Tag: BlackLevel = 0/1 (RATIONAL[1])
    let mut bl_bytes = Vec::with_capacity(8);
    bl_bytes.extend_from_slice(&0u32.to_le_bytes());
    bl_bytes.extend_from_slice(&1u32.to_le_bytes());
    entries.push(TiffEntry {
        tag: TAG_BLACK_LEVEL,
        field_type: TIFF_TYPE_RATIONAL,
        count: 1,
        data_or_offset: 0,
        extra_bytes: Some(bl_bytes),
    });

    // Tag: WhiteLevel = 1 (LONG)
    entries.push(TiffEntry {
        tag: TAG_WHITE_LEVEL,
        field_type: TIFF_TYPE_LONG,
        count: 1,
        data_or_offset: 1,
        extra_bytes: None,
    });

    // Tag: BaselineExposure (SRATIONAL)
    // Computes dynamic baseline exposure so RAW editors (Lightroom/ACR) render midtones at Zone V (18%)
    let be_val = match meta.baseline_exposure {
        Some(val) if val.abs() > 0.001 => val,
        _ => {
            let raw = image.as_raw();
            let step = (raw.len() / 3 / 2000).max(1);
            let mut sample_lumas: Vec<f32> = raw
                .chunks_exact(3)
                .step_by(step)
                .map(|px| 0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2])
                .filter(|&l| l > 1e-5)
                .collect();
            if sample_lumas.is_empty() {
                0.0
            } else {
                let mid_idx = sample_lumas.len() / 2;
                sample_lumas.select_nth_unstable_by(mid_idx, |a, b| a.total_cmp(b));
                let p50 = sample_lumas[mid_idx].clamp(0.001, 1.0);
                (0.18 / p50).log2().clamp(-4.0, 4.0)
            }
        }
    };
    let mut be_bytes = Vec::with_capacity(8);
    let be_num = (be_val * 100.0).round() as i32;
    be_bytes.extend_from_slice(&be_num.to_le_bytes());
    be_bytes.extend_from_slice(&100i32.to_le_bytes());
    entries.push(TiffEntry {
        tag: TAG_BASELINE_EXPOSURE,
        field_type: TIFF_TYPE_SRATIONAL,
        count: 1,
        data_or_offset: 0,
        extra_bytes: Some(be_bytes),
    });

    // Tag: BaselineNoise = 1/1 (RATIONAL)
    let mut bn_bytes = Vec::with_capacity(8);
    bn_bytes.extend_from_slice(&1u32.to_le_bytes());
    bn_bytes.extend_from_slice(&1u32.to_le_bytes());
    entries.push(TiffEntry {
        tag: TAG_BASELINE_NOISE,
        field_type: TIFF_TYPE_RATIONAL,
        count: 1,
        data_or_offset: 0,
        extra_bytes: Some(bn_bytes),
    });

    // Sort entries strictly in ascending order of tag ID (TIFF standard requirement)
    entries.sort_by_key(|e| e.tag);

    // Calculate memory layout:
    // Header = 8 bytes
    // IFD0 Count = 2 bytes
    // Entries = entries.len() * 12 bytes
    // Next IFD Offset = 4 bytes
    let num_entries = entries.len() as u16;
    let ifd_size = 2 + (entries.len() * 12) + 4;
    let mut current_extra_offset = ifd0_offset + ifd_size as u32;

    // Allocate offsets for extra data blobs (> 4 bytes)
    for entry in entries.iter_mut() {
        if let Some(extra) = &entry.extra_bytes {
            if extra.len() > 4 {
                entry.data_or_offset = current_extra_offset;
                current_extra_offset += extra.len() as u32;
                // Pad to word boundary (even byte offset)
                if current_extra_offset % 2 != 0 {
                    current_extra_offset += 1;
                }
            } else {
                let mut val_bytes = [0u8; 4];
                val_bytes[..extra.len()].copy_from_slice(extra);
                entry.data_or_offset = u32::from_le_bytes(val_bytes);
            }
        }
    }

    // Set StripOffsets offset to start immediately after all IFD extra data
    let strip_data_offset = current_extra_offset;
    for entry in entries.iter_mut() {
        if entry.tag == TAG_STRIP_OFFSETS {
            entry.data_or_offset = strip_data_offset;
            break;
        }
    }

    // 2. Write IFD0
    cursor.write_all(&num_entries.to_le_bytes()).map_err(|e| e.to_string())?;

    for entry in &entries {
        cursor.write_all(&entry.tag.to_le_bytes()).map_err(|e| e.to_string())?;
        cursor.write_all(&entry.field_type.to_le_bytes()).map_err(|e| e.to_string())?;
        cursor.write_all(&entry.count.to_le_bytes()).map_err(|e| e.to_string())?;
        cursor.write_all(&entry.data_or_offset.to_le_bytes()).map_err(|e| e.to_string())?;
    }

    // Next IFD offset = 0 (No more IFDs)
    cursor.write_all(&0u32.to_le_bytes()).map_err(|e| e.to_string())?;

    // 3. Write Extra Value Blobs (> 4 bytes)
    for entry in &entries {
        if let Some(extra) = &entry.extra_bytes {
            if extra.len() > 4 {
                cursor.write_all(extra).map_err(|e| e.to_string())?;
                if extra.len() % 2 != 0 {
                    cursor.write_all(&[0u8]).map_err(|e| e.to_string())?;
                }
            }
        }
    }

    // Verify cursor is aligned at strip_data_offset
    let current_pos = cursor.position() as u32;
    if current_pos < strip_data_offset {
        let pad = strip_data_offset - current_pos;
        cursor.write_all(&vec![0u8; pad as usize]).map_err(|e| e.to_string())?;
    }

    // 4. Write 32-Bit IEEE Floating-Point RGB Radiance Raw Pixel Buffer
    let raw_floats = image.as_raw();
    let mut float_bytes = Vec::with_capacity(raw_floats.len() * 4);
    for &sample in raw_floats {
        float_bytes.extend_from_slice(&sample.to_le_bytes());
    }
    cursor.write_all(&float_bytes).map_err(|e| e.to_string())?;

    Ok(cursor.into_inner())
}

/// Convenience function to write an Rgb32FImage directly to a DNG file on disk
pub fn write_linear_dng_file<P: AsRef<Path>>(
    path: P,
    image: &Rgb32FImage,
    metadata: Option<&DngExportMetadata>,
) -> Result<(), String> {
    let dng_bytes = encode_linear_dng(image, metadata)?;
    let file = File::create(path).map_err(|e| format!("Failed to create DNG file: {}", e))?;
    let mut writer = BufWriter::new(file);
    writer.write_all(&dng_bytes).map_err(|e| format!("Failed to write DNG data: {}", e))?;
    writer.flush().map_err(|e| format!("Failed to flush DNG file: {}", e))?;
    Ok(())
}

/// DynamicImage adapter for DNG encoding
pub fn encode_dynamic_image_to_linear_dng(
    image: &DynamicImage,
    metadata: Option<&DngExportMetadata>,
) -> Result<Vec<u8>, String> {
    let rgb32f = image.to_rgb32f();
    encode_linear_dng(&rgb32f, metadata)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    #[test]
    fn test_dng_header_and_magic() {
        let (w, h) = (8u32, 8u32);
        let mut img = Rgb32FImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                img.put_pixel(x, y, Rgb([0.5, 1.2, 3.4]));
            }
        }

        let dng_bytes = encode_linear_dng(&img, None).expect("DNG encoding must succeed");
        assert!(dng_bytes.len() > 8 + 8 * 8 * 12);

        // Check TIFF Little-Endian Header
        assert_eq!(&dng_bytes[0..2], b"II");
        // Check TIFF Magic 42
        assert_eq!(u16::from_le_bytes([dng_bytes[2], dng_bytes[3]]), 42);
        // Check IFD0 Offset = 8
        assert_eq!(u32::from_le_bytes([dng_bytes[4], dng_bytes[5], dng_bytes[6], dng_bytes[7]]), 8);
    }

    #[test]
    fn test_dng_tag_ordering_ascending() {
        let (w, h) = (4u32, 4u32);
        let img = Rgb32FImage::new(w, h);
        let dng_bytes = encode_linear_dng(&img, None).expect("DNG encoding must succeed");

        let num_tags = u16::from_le_bytes([dng_bytes[8], dng_bytes[9]]) as usize;
        assert!(num_tags >= 15, "DNG must have at least 15 required tags");

        let mut prev_tag = 0u16;
        for i in 0..num_tags {
            let offset = 10 + i * 12;
            let tag = u16::from_le_bytes([dng_bytes[offset], dng_bytes[offset + 1]]);
            assert!(tag > prev_tag, "DNG tags must be sorted in strictly ascending order: tag {} <= prev {}", tag, prev_tag);
            prev_tag = tag;
        }
    }

    #[test]
    fn test_dng_pixel_data_integrity() {
        let (w, h) = (2u32, 2u32);
        let mut img = Rgb32FImage::new(w, h);
        img.put_pixel(0, 0, Rgb([0.12345, 1.6789, 42.0]));
        img.put_pixel(1, 0, Rgb([0.0, 0.5, 1.0]));
        img.put_pixel(0, 1, Rgb([10.0, 20.0, 30.0]));
        img.put_pixel(1, 1, Rgb([0.0001, 0.0002, 0.0003]));

        let dng_bytes = encode_linear_dng(&img, None).expect("DNG encoding must succeed");

        // Find strip offset from tag 0x0111
        let num_tags = u16::from_le_bytes([dng_bytes[8], dng_bytes[9]]) as usize;
        let mut strip_offset = 0usize;
        for i in 0..num_tags {
            let offset = 10 + i * 12;
            let tag = u16::from_le_bytes([dng_bytes[offset], dng_bytes[offset + 1]]);
            if tag == TAG_STRIP_OFFSETS {
                strip_offset = u32::from_le_bytes([
                    dng_bytes[offset + 8],
                    dng_bytes[offset + 9],
                    dng_bytes[offset + 10],
                    dng_bytes[offset + 11],
                ]) as usize;
                break;
            }
        }

        assert!(strip_offset > 0, "Strip offset must be non-zero");

        // Read back pixel (0, 0) floats
        let r00 = f32::from_le_bytes([
            dng_bytes[strip_offset],
            dng_bytes[strip_offset + 1],
            dng_bytes[strip_offset + 2],
            dng_bytes[strip_offset + 3],
        ]);
        let g00 = f32::from_le_bytes([
            dng_bytes[strip_offset + 4],
            dng_bytes[strip_offset + 5],
            dng_bytes[strip_offset + 6],
            dng_bytes[strip_offset + 7],
        ]);
        let b00 = f32::from_le_bytes([
            dng_bytes[strip_offset + 8],
            dng_bytes[strip_offset + 9],
            dng_bytes[strip_offset + 10],
            dng_bytes[strip_offset + 11],
        ]);

        assert_eq!(r00, 0.12345);
        assert_eq!(g00, 1.6789);
        assert_eq!(b00, 42.0);
    }
}
