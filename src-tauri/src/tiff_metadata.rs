//! Writes TIFF files with their EXIF metadata baked in at encode time.
//!
//! Every other output format gets its metadata patched in afterwards by
//! `little_exif` (see `exif_processing::write_image_with_metadata`), which is
//! safe there because EXIF lives in an independent segment or chunk. TIFF
//! references its pixel data through absolute `StripOffsets` stored in the IFD
//! itself, so inserting entries into a finished file shifts the pixel data out
//! from under those offsets and corrupts the image.
//!
//! Writing the tags through the `tiff` crate before `write_data()` avoids that:
//! the encoder lays out the strips once, after every tag is known. The EXIF
//! shooting tags go into a proper Exif sub-IFD (0x8769) and the GPS tags into a
//! GPS sub-IFD (0x8825), both written first so their file offsets are known by
//! the time the main IFD needs to point at them.

use image::{DynamicImage, GenericImageView};
use little_exif::endian::Endian;
use little_exif::exif_tag::ExifTag;
use little_exif::exif_tag_format::ExifTagFormat;
use little_exif::ifd::ExifTagGroup;
use little_exif::metadata::Metadata;
use std::borrow::Cow;
use std::io::{Cursor, Seek, Write};
use tiff::encoder::colortype::{RGB8, RGB16};
use tiff::encoder::{DirectoryEncoder, Rational, SRational, TiffEncoder, TiffValue};
use tiff::tags::{Tag, Type};

/// Sample format of the TIFF to write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TiffSamples {
    Eight,
    Sixteen,
}

const TAG_EXIF_IFD: u16 = 0x8769;
const TAG_GPS_IFD: u16 = 0x8825;

/// Tags that describe how the pixel data is laid out in the file. The encoder
/// writes these itself for the image it is encoding, so carrying them over from
/// the source would describe the wrong image at best and break readers at
/// worst. `MakerNote` is dropped for a related reason: it holds offsets into
/// the source file that mean nothing here.
pub fn is_structural_tag(tag: u16) -> bool {
    matches!(
        tag,
        0x00FE // NewSubfileType
            | 0x00FF // SubfileType
            | 0x0100 // ImageWidth
            | 0x0101 // ImageLength
            | 0x0102 // BitsPerSample
            | 0x0103 // Compression
            | 0x0106 // PhotometricInterpretation
            | 0x0107 // Thresholding
            | 0x010A // FillOrder
            | 0x0111 // StripOffsets
            | 0x0115 // SamplesPerPixel
            | 0x0116 // RowsPerStrip
            | 0x0117 // StripByteCounts
            | 0x011A // XResolution
            | 0x011B // YResolution
            | 0x011C // PlanarConfiguration
            | 0x0128 // ResolutionUnit
            | 0x013D // Predictor
            | 0x0140 // ColorMap
            | 0x0142 // TileWidth
            | 0x0143 // TileLength
            | 0x0144 // TileOffsets
            | 0x0145 // TileByteCounts
            | 0x014A // SubIFDs
            | 0x0152 // ExtraSamples
            | 0x0153 // SampleFormat
            | 0x0201 // ThumbnailOffset
            | 0x0202 // ThumbnailLength
            | 0x8769 // ExifIFDPointer
            | 0x8825 // GPSInfoIFDPointer
            | 0xA005 // InteroperabilityIFDPointer
            | 0x927C // MakerNote
    )
}

/// Encodes `image` as a TIFF with `metadata` written into the IFDs it belongs
/// in. Passing `None` produces a TIFF without any metadata, which is what
/// export does when the user turns metadata off.
pub fn encode_tiff_with_metadata(
    image: &DynamicImage,
    samples: TiffSamples,
    metadata: Option<&Metadata>,
) -> Result<Vec<u8>, String> {
    let (width, height) = image.dimensions();
    let mut buffer = Cursor::new(Vec::new());
    let mut encoder = TiffEncoder::new(&mut buffer)
        .map_err(|e| format!("Failed to create TIFF encoder: {}", e))?;

    // The sub-IFDs have to exist before the main IFD can point at them, so
    // they are written first and only their offsets are kept.
    let exif_ifd = write_sub_ifd(&mut encoder, metadata, ExifTagGroup::EXIF)?;
    let gps_ifd = write_sub_ifd(&mut encoder, metadata, ExifTagGroup::GPS)?;

    match samples {
        TiffSamples::Eight => {
            let pixels = image.to_rgb8();
            let mut image_encoder = encoder
                .new_image::<RGB8>(width, height)
                .map_err(|e| format!("Failed to start TIFF image: {}", e))?;
            write_main_ifd(image_encoder.encoder(), metadata, exif_ifd, gps_ifd)?;
            image_encoder
                .write_data(pixels.as_raw())
                .map_err(|e| format!("Failed to write TIFF pixel data: {}", e))?;
        }
        TiffSamples::Sixteen => {
            let pixels = image.to_rgb16();
            let mut image_encoder = encoder
                .new_image::<RGB16>(width, height)
                .map_err(|e| format!("Failed to start TIFF image: {}", e))?;
            write_main_ifd(image_encoder.encoder(), metadata, exif_ifd, gps_ifd)?;
            image_encoder
                .write_data(pixels.as_raw())
                .map_err(|e| format!("Failed to write TIFF pixel data: {}", e))?;
        }
    }

    Ok(buffer.into_inner())
}

/// Writes every tag of `group` into a directory of its own, unlinked from the
/// image IFD chain, and returns where it landed. Returns `None` when the group
/// holds no writable tag, so no empty sub-IFD is left behind.
fn write_sub_ifd<W: Write + Seek>(
    encoder: &mut TiffEncoder<W>,
    metadata: Option<&Metadata>,
    group: ExifTagGroup,
) -> Result<Option<u32>, String> {
    let Some(metadata) = metadata else {
        return Ok(None);
    };

    let mut directory = encoder
        .extra_directory()
        .map_err(|e| format!("Failed to create TIFF sub-IFD: {}", e))?;

    let mut wrote_any = false;
    for tag in tags_of_group(metadata, group) {
        wrote_any |= write_tag(&mut directory, tag)?;
    }

    if !wrote_any {
        drop(directory);
        return Ok(None);
    }

    let offset = directory
        .finish_with_offsets()
        .map_err(|e| format!("Failed to write TIFF sub-IFD: {}", e))?;

    // Written as LONG rather than the IFD type: the Exif specification asks
    // for LONG here, and readers reject a sub-IFD pointer of any other type.
    Ok(Some(offset.pointer.0 as u32))
}

/// Writes the descriptive tags of IFD0 plus the pointers to the sub-IFDs. This
/// runs on the directory of the image itself, so it has to stay clear of the
/// structural tags the encoder maintains.
fn write_main_ifd<W: Write + Seek>(
    directory: &mut DirectoryEncoder<'_, W, tiff::encoder::TiffKindStandard>,
    metadata: Option<&Metadata>,
    exif_ifd: Option<u32>,
    gps_ifd: Option<u32>,
) -> Result<(), String> {
    if let Some(offset) = exif_ifd {
        directory
            .write_tag(Tag::Unknown(TAG_EXIF_IFD), offset)
            .map_err(|e| format!("Failed to write Exif IFD pointer: {}", e))?;
    }
    if let Some(offset) = gps_ifd {
        directory
            .write_tag(Tag::Unknown(TAG_GPS_IFD), offset)
            .map_err(|e| format!("Failed to write GPS IFD pointer: {}", e))?;
    }

    let Some(metadata) = metadata else {
        return Ok(());
    };

    for tag in tags_of_group(metadata, ExifTagGroup::GENERIC) {
        write_tag(directory, tag)?;
    }

    Ok(())
}

/// Collects the tags of one IFD group that are worth carrying over. Only the
/// first generic IFD is considered; later ones describe thumbnails and other
/// sub-images that do not exist in the file being written.
fn tags_of_group(metadata: &Metadata, group: ExifTagGroup) -> impl Iterator<Item = &ExifTag> {
    metadata
        .get_ifds()
        .iter()
        .filter(move |ifd| ifd.get_generic_ifd_nr() == 0 && ifd.get_ifd_type() == group)
        .flat_map(|ifd| ifd.get_tags())
        .filter(|tag| tag.is_writable() && !is_structural_tag(tag.as_u16()))
}

/// Converts one `little_exif` tag into the matching TIFF value and writes it.
/// Returns whether the tag made it into the directory.
fn write_tag<W: Write + Seek>(
    directory: &mut DirectoryEncoder<'_, W, tiff::encoder::TiffKindStandard>,
    tag: &ExifTag,
) -> Result<bool, String> {
    let id = Tag::Unknown(tag.as_u16());
    let bytes = tag.value_as_u8_vec(&Endian::Little);

    let result = match tag.format() {
        ExifTagFormat::STRING => {
            let text = ascii_value(&bytes);
            if text.is_empty() {
                return Ok(false);
            }
            directory.write_tag(id, text.as_str())
        }
        ExifTagFormat::UNDEF => directory.write_tag(id, Undefined(&bytes)),
        ExifTagFormat::INT8U => directory.write_tag(id, bytes.as_slice()),
        ExifTagFormat::INT8S => {
            let values: Vec<i8> = bytes.iter().map(|&b| b as i8).collect();
            directory.write_tag(id, values.as_slice())
        }
        ExifTagFormat::INT16U => {
            let values = convert::<2, u16>(&bytes, u16::from_le_bytes);
            directory.write_tag(id, values.as_slice())
        }
        ExifTagFormat::INT16S => {
            let values = convert::<2, i16>(&bytes, i16::from_le_bytes);
            directory.write_tag(id, values.as_slice())
        }
        ExifTagFormat::INT32U => {
            let values = convert::<4, u32>(&bytes, u32::from_le_bytes);
            directory.write_tag(id, values.as_slice())
        }
        ExifTagFormat::INT32S => {
            let values = convert::<4, i32>(&bytes, i32::from_le_bytes);
            directory.write_tag(id, values.as_slice())
        }
        ExifTagFormat::FLOAT => {
            let values = convert::<4, f32>(&bytes, f32::from_le_bytes);
            directory.write_tag(id, values.as_slice())
        }
        ExifTagFormat::DOUBLE => {
            let values = convert::<8, f64>(&bytes, f64::from_le_bytes);
            directory.write_tag(id, values.as_slice())
        }
        ExifTagFormat::RATIONAL64U => {
            let parts = convert::<4, u32>(&bytes, u32::from_le_bytes);
            let values: Vec<Rational> = parts
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| Rational {
                    n: pair[0],
                    d: pair[1],
                })
                .collect();
            if values.is_empty() {
                return Ok(false);
            }
            directory.write_tag(id, values.as_slice())
        }
        ExifTagFormat::RATIONAL64S => {
            let parts = convert::<4, i32>(&bytes, i32::from_le_bytes);
            let values: Vec<SRational> = parts
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| SRational {
                    n: pair[0],
                    d: pair[1],
                })
                .collect();
            if values.is_empty() {
                return Ok(false);
            }
            directory.write_tag(id, values.as_slice())
        }
    };

    result
        .map(|_| true)
        .map_err(|e| format!("Failed to write TIFF tag {:#06x}: {}", tag.as_u16(), e))
}

/// Splits raw little-endian bytes into values. The `tiff` crate writes them out
/// in the host's byte order afterwards, so going through native values here
/// keeps this correct on big-endian machines too.
fn convert<const N: usize, T>(bytes: &[u8], from_le_bytes: fn([u8; N]) -> T) -> Vec<T> {
    bytes
        .as_chunks::<N>()
        .0
        .iter()
        .map(|chunk| from_le_bytes(*chunk))
        .collect()
}

/// EXIF strings arrive null-terminated, and the `tiff` crate rejects strings
/// that are not plain ASCII or that contain a null byte. Non-ASCII bytes are
/// dropped rather than replaced, so a name with an umlaut still comes through
/// readable instead of failing the whole export.
fn ascii_value(bytes: &[u8]) -> String {
    bytes
        .iter()
        .copied()
        .take_while(|&b| b != 0)
        .filter(|b| b.is_ascii() && *b != 0)
        .map(char::from)
        .collect::<String>()
        .trim()
        .to_string()
}

/// A byte string written with EXIF's `UNDEFINED` type, which `tiff` has no
/// value type for. Used for tags like `ExifVersion` and `UserComment`, where
/// writing plain bytes instead would make validators complain about the type.
struct Undefined<'a>(&'a [u8]);

impl TiffValue for Undefined<'_> {
    const BYTE_LEN: u8 = 1;
    const FIELD_TYPE: Type = Type::UNDEFINED;

    fn count(&self) -> usize {
        self.0.len()
    }

    fn data(&self) -> Cow<'_, [u8]> {
        Cow::Borrowed(self.0)
    }
}
