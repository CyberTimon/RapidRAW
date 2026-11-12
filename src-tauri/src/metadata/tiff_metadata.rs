use image::{DynamicImage, GenericImageView};
use little_exif::endian::Endian;
use little_exif::exif_tag::ExifTag;
use little_exif::exif_tag_format::ExifTagFormat;
use little_exif::ifd::ExifTagGroup;
use little_exif::metadata::Metadata;
use std::borrow::Cow;
use std::io::{Cursor, Seek, Write};
use tiff::encoder::colortype::{RGB8, RGB16, RGB32Float};
use tiff::encoder::{DirectoryEncoder, Rational, SRational, TiffEncoder, TiffValue};
use tiff::tags::{ResolutionUnit, Tag, Type};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TiffSamples {
    Eight,
    Sixteen,
    ThirtyTwoFloat,
}

const TAG_EXIF_IFD: u16 = 0x8769;
const TAG_GPS_IFD: u16 = 0x8825;

pub fn is_structural_tag(tag: u16) -> bool {
    matches!(
        tag,
        0x00FE
            | 0x00FF
            | 0x0100
            | 0x0101
            | 0x0102
            | 0x0103
            | 0x0106
            | 0x0107
            | 0x010A
            | 0x0111
            | 0x0115
            | 0x0116
            | 0x0117
            | 0x011A
            | 0x011B
            | 0x011C
            | 0x0128
            | 0x013D
            | 0x0140
            | 0x0142
            | 0x0143
            | 0x0144
            | 0x0145
            | 0x014A
            | 0x0152
            | 0x0153
            | 0x0201
            | 0x0202
            | 0x8769
            | 0x8825
            | 0xA005
            | 0x927C
    )
}

pub fn encode_tiff_with_metadata(
    image: &DynamicImage,
    samples: TiffSamples,
    metadata: Option<&Metadata>,
    icc_profile: Option<&[u8]>,
    dpi: Option<u16>,
) -> Result<Vec<u8>, String> {
    let (width, height) = image.dimensions();
    let mut buffer = Cursor::new(Vec::new());
    let mut encoder = TiffEncoder::new(&mut buffer)
        .map_err(|e| format!("Failed to create TIFF encoder: {}", e))?;

    let exif_ifd = write_sub_ifd(&mut encoder, metadata, ExifTagGroup::EXIF)?;
    let gps_ifd = write_sub_ifd(&mut encoder, metadata, ExifTagGroup::GPS)?;

    match samples {
        TiffSamples::Eight => {
            let pixels = image
                .as_rgb8()
                .map_or_else(|| Cow::Owned(image.to_rgb8()), Cow::Borrowed);
            let mut image_encoder = encoder
                .new_image::<RGB8>(width, height)
                .map_err(|e| format!("Failed to start TIFF image: {}", e))?;
            write_main_ifd(
                image_encoder.encoder(),
                metadata,
                exif_ifd,
                gps_ifd,
                icc_profile,
            )?;
            set_resolution(&mut image_encoder, dpi);
            image_encoder
                .write_data(pixels.as_raw())
                .map_err(|e| format!("Failed to write TIFF pixel data: {}", e))?;
        }
        TiffSamples::Sixteen => {
            let pixels = image
                .as_rgb16()
                .map_or_else(|| Cow::Owned(image.to_rgb16()), Cow::Borrowed);
            let mut image_encoder = encoder
                .new_image::<RGB16>(width, height)
                .map_err(|e| format!("Failed to start TIFF image: {}", e))?;
            write_main_ifd(
                image_encoder.encoder(),
                metadata,
                exif_ifd,
                gps_ifd,
                icc_profile,
            )?;
            set_resolution(&mut image_encoder, dpi);
            image_encoder
                .write_data(pixels.as_raw())
                .map_err(|e| format!("Failed to write TIFF pixel data: {}", e))?;
        }
        TiffSamples::ThirtyTwoFloat => {
            let pixels = image
                .as_rgb32f()
                .map_or_else(|| Cow::Owned(image.to_rgb32f()), Cow::Borrowed);
            let mut image_encoder = encoder
                .new_image::<RGB32Float>(width, height)
                .map_err(|e| format!("Failed to start TIFF image: {}", e))?;
            write_main_ifd(
                image_encoder.encoder(),
                metadata,
                exif_ifd,
                gps_ifd,
                icc_profile,
            )?;
            set_resolution(&mut image_encoder, dpi);
            image_encoder
                .write_data(pixels.as_raw())
                .map_err(|e| format!("Failed to write TIFF pixel data: {}", e))?;
        }
    }

    Ok(buffer.into_inner())
}

fn write_sub_ifd<W: Write + Seek>(
    encoder: &mut TiffEncoder<W>,
    metadata: Option<&Metadata>,
    group: ExifTagGroup,
) -> Result<Option<u32>, String> {
    let Some(metadata) = metadata else {
        return Ok(None);
    };

    if tags_of_group(metadata, group).next().is_none() {
        return Ok(None);
    }

    let mut directory = encoder
        .extra_directory()
        .map_err(|e| format!("Failed to create TIFF sub-IFD: {}", e))?;

    let mut wrote_any = false;
    for tag in tags_of_group(metadata, group) {
        wrote_any |= write_tag(&mut directory, tag)?;
    }

    if !wrote_any {
        return Ok(None);
    }

    let offset = directory
        .finish_with_offsets()
        .map_err(|e| format!("Failed to write TIFF sub-IFD: {}", e))?;

    Ok(Some(offset.pointer.0 as u32))
}

fn write_main_ifd<W: Write + Seek>(
    directory: &mut DirectoryEncoder<'_, W, tiff::encoder::TiffKindStandard>,
    metadata: Option<&Metadata>,
    exif_ifd: Option<u32>,
    gps_ifd: Option<u32>,
    icc_profile: Option<&[u8]>,
) -> Result<(), String> {
    if let Some(profile) = icc_profile {
        write_aligned(directory, Tag::IccProfile, Undefined(profile))
            .map_err(|e| format!("Failed to write ICC profile: {}", e))?;
    }

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

fn tags_of_group(metadata: &Metadata, group: ExifTagGroup) -> impl Iterator<Item = &ExifTag> {
    metadata
        .get_ifds()
        .iter()
        .filter(move |ifd| ifd.get_generic_ifd_nr() == 0 && ifd.get_ifd_type() == group)
        .flat_map(|ifd| ifd.get_tags())
        .filter(|tag| {
            tag.is_writable() && !is_structural_tag(tag.as_u16()) && !is_jpeg_only_tag(tag.as_u16())
        })
}

fn is_jpeg_only_tag(tag: u16) -> bool {
    matches!(tag, 0xA002 | 0xA003)
}

fn write_tag<W: Write + Seek>(
    directory: &mut DirectoryEncoder<'_, W, tiff::encoder::TiffKindStandard>,
    tag: &ExifTag,
) -> Result<bool, String> {
    let id = Tag::Unknown(tag.as_u16());
    let bytes = tag.value_as_u8_vec(&Endian::Little);

    let result = match tag.format() {
        ExifTagFormat::STRING => {
            let text = text_value(&bytes);
            if text.is_empty() {
                return Ok(false);
            }
            write_aligned(directory, id, Ascii::from(text))
        }
        ExifTagFormat::UNDEF => write_aligned(directory, id, Undefined(&bytes)),
        ExifTagFormat::INT8U => write_aligned(directory, id, bytes.as_slice()),
        ExifTagFormat::INT8S => {
            let values: Vec<i8> = bytes.iter().map(|&b| b as i8).collect();
            write_aligned(directory, id, values.as_slice())
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

fn write_aligned<W: Write + Seek, T: TiffValue>(
    directory: &mut DirectoryEncoder<'_, W, tiff::encoder::TiffKindStandard>,
    id: Tag,
    value: T,
) -> tiff::TiffResult<()> {
    let len = value.bytes();
    directory.write_tag(id, value)?;
    if len > 4 && len % 2 == 1 {
        directory.write_data(&[0u8][..])?;
    }
    Ok(())
}

fn convert<const N: usize, T>(bytes: &[u8], from_le_bytes: fn([u8; N]) -> T) -> Vec<T> {
    bytes
        .as_chunks::<N>()
        .0
        .iter()
        .map(|chunk| from_le_bytes(*chunk))
        .collect()
}

fn text_value(bytes: &[u8]) -> &[u8] {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    bytes[..end].trim_ascii()
}

struct Ascii(Vec<u8>);

impl From<&[u8]> for Ascii {
    fn from(text: &[u8]) -> Self {
        let mut bytes = text.to_vec();
        bytes.push(0);
        Ascii(bytes)
    }
}

impl TiffValue for Ascii {
    const BYTE_LEN: u8 = 1;
    const FIELD_TYPE: Type = Type::ASCII;

    fn count(&self) -> usize {
        self.0.len()
    }

    fn data(&self) -> Cow<'_, [u8]> {
        Cow::Borrowed(&self.0)
    }
}

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

fn set_resolution<W: Write + Seek, C: tiff::encoder::colortype::ColorType>(
    image_encoder: &mut tiff::encoder::ImageEncoder<'_, W, C, tiff::encoder::TiffKindStandard>,
    dpi: Option<u16>,
) {
    if let Some(dpi) = dpi {
        image_encoder.resolution(
            ResolutionUnit::Inch,
            Rational {
                n: dpi.into(),
                d: 1,
            },
        );
    }
}
