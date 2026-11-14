use crate::decode::formats::is_raw_file;
use crate::library::tagging::{COLOR_TAG_PREFIX, USER_TAG_PREFIX};
use crate::metadata::exif_processing::{
    format_creation_datetime, read_raw_metadata_from_path, read_rrexif_sidecar,
};
use crate::metadata::sidecar::{ImageFlag, ImageMetadata};
use crate::metadata::xmp;
use image::ImageDecoder;
use little_exif::exif_tag::ExifTag;
use little_exif::filetype::FileExtension;
use little_exif::ifd::ExifTagGroup;
use little_exif::metadata::Metadata;
use little_exif::rational::{iR64, uR64};
use quick_xml::escape::{escape, unescape};
use quick_xml::events::{BytesStart, BytesText, Event};
use quick_xml::{Reader, Writer};
use rawler::decoders::RawMetadata;
use rawler::exif::ExifGPS;
use std::borrow::Cow;
use std::collections::HashMap;
use std::io::Cursor;
use std::path::Path;

fn copy_full_exif_from_source(
    metadata: &mut Metadata,
    original_path: &Path,
    strip_gps: bool,
) -> bool {
    let Ok(source_metadata) = Metadata::new_from_path(original_path) else {
        return false;
    };

    let mut copied_any = false;
    for ifd in source_metadata.get_ifds() {
        if ifd.get_generic_ifd_nr() != 0 {
            continue;
        }
        if strip_gps && ifd.get_ifd_type() == ExifTagGroup::GPS {
            continue;
        }
        for tag in ifd.get_tags() {
            if !tag.is_writable() || crate::metadata::tiff_metadata::is_structural_tag(tag.as_u16())
            {
                continue;
            }
            metadata.set_tag(tag.clone());
            copied_any = true;
        }
    }
    copied_any
}

fn apply_sidecar_field_overrides(metadata: &mut Metadata, map: &HashMap<String, String>) {
    let clean_s = |s: &String| s.replace('"', "").trim().to_string();
    let is_user_edit = |s: &str| !s.is_empty() && s != "...";

    match map.get("Artist").map(clean_s) {
        Some(val) => {
            if is_user_edit(&val) {
                metadata.set_tag(ExifTag::Artist(val));
            }
        }
        None => {
            metadata.remove_tag(ExifTag::Artist(String::new()));
        }
    }
    match map.get("Copyright").map(clean_s) {
        Some(val) => {
            if is_user_edit(&val) {
                metadata.set_tag(ExifTag::Copyright(val));
            }
        }
        None => {
            metadata.remove_tag(ExifTag::Copyright(String::new()));
        }
    }
    match map.get("ImageDescription").map(clean_s) {
        Some(val) => {
            if is_user_edit(&val) {
                metadata.set_tag(ExifTag::ImageDescription(val));
            }
        }
        None => {
            metadata.remove_tag(ExifTag::ImageDescription(String::new()));
        }
    }
    match map.get("UserComment").map(clean_s) {
        Some(val) => {
            if is_user_edit(&val) && !val.starts_with("0x") {
                metadata.set_tag(ExifTag::UserComment(val.into_bytes()));
            }
        }
        None => {
            metadata.remove_tag(ExifTag::UserComment(Vec::new()));
        }
    }
}

fn apply_exif_from_rawler(metadata: &mut Metadata, meta: &RawMetadata) {
    if !meta.make.is_empty() {
        metadata.set_tag(ExifTag::Make(meta.make.clone()));
    }
    if !meta.model.is_empty() {
        metadata.set_tag(ExifTag::Model(meta.model.clone()));
    }
    let exif = &meta.exif;
    if let Some(artist) = &exif.artist {
        metadata.set_tag(ExifTag::Artist(artist.clone()));
    }
    if let Some(copyright) = &exif.copyright {
        metadata.set_tag(ExifTag::Copyright(copyright.clone()));
    }
    if let Some(dt) = &exif.date_time_original {
        metadata.set_tag(ExifTag::DateTimeOriginal(dt.clone()));
    }
    if let Some(dt) = &exif.create_date {
        metadata.set_tag(ExifTag::CreateDate(dt.clone()));
    }
    if let Some(offset) = &exif.offset_time_original {
        metadata.set_tag(ExifTag::OffsetTimeOriginal(offset.clone()));
    }
    if let Some(offset) = &exif.offset_time_digitized {
        metadata.set_tag(ExifTag::OffsetTimeDigitized(offset.clone()));
    }
    if let Some(sub_sec) = &exif.sub_sec_time_original {
        metadata.set_tag(ExifTag::SubSecTimeOriginal(sub_sec.clone()));
    }
    if let Some(lens_make) = &exif.lens_make {
        metadata.set_tag(ExifTag::LensMake(lens_make.clone()));
    }
    if let Some(lens_model) = &exif.lens_model {
        metadata.set_tag(ExifTag::LensModel(lens_model.clone()));
    }
    if let Some(lens_spec) = exif.lens_spec {
        metadata.set_tag(ExifTag::LensInfo(lens_spec.map(rawler_to_ur64).to_vec()));
    }
    if let Some(f) = exif.fnumber {
        metadata.set_tag(ExifTag::FNumber(vec![rawler_to_ur64(f)]));
    }
    if let Some(a) = exif.aperture_value {
        metadata.set_tag(ExifTag::ApertureValue(vec![rawler_to_ur64(a)]));
    }
    if let Some(t) = exif.exposure_time {
        metadata.set_tag(ExifTag::ExposureTime(vec![rawler_to_ur64(t)]));
    }
    if let Some(s) = exif.shutter_speed_value {
        metadata.set_tag(ExifTag::ShutterSpeedValue(vec![rawler_to_ir64(s)]));
    }
    if let Some(fl) = exif.focal_length {
        metadata.set_tag(ExifTag::FocalLength(vec![rawler_to_ur64(fl)]));
    }
    if let Some(iso) = exif.iso_speed {
        metadata.set_tag(ExifTag::ISO(vec![iso as u16]));
    } else if let Some(iso) = exif.iso_speed_ratings {
        metadata.set_tag(ExifTag::ISO(vec![iso]));
    }
    if let Some(ev) = exif.exposure_bias {
        metadata.set_tag(ExifTag::ExposureCompensation(vec![rawler_to_ir64(ev)]));
    }
    if let Some(flash) = exif.flash {
        metadata.set_tag(ExifTag::Flash(vec![flash]));
    }
    if let Some(metering) = exif.metering_mode {
        metadata.set_tag(ExifTag::MeteringMode(vec![metering]));
    }
    if let Some(wb) = exif.white_balance {
        metadata.set_tag(ExifTag::WhiteBalance(vec![wb]));
    }
    if let Some(prog) = exif.exposure_program {
        metadata.set_tag(ExifTag::ExposureProgram(vec![prog]));
    }
}

fn apply_gps_from_kamadak(metadata: &mut Metadata, original_path: &Path) {
    let Ok(file) = std::fs::File::open(original_path) else {
        return;
    };
    let mut bufreader = std::io::BufReader::new(&file);
    let exifreader = exif::Reader::new();
    let Ok(exif_obj) = exifreader.read_from_container(&mut bufreader) else {
        return;
    };

    let get_string_val = |field: &exif::Field| -> String {
        match &field.value {
            exif::Value::Ascii(vec) => vec
                .iter()
                .map(|v| {
                    String::from_utf8_lossy(v)
                        .trim_matches(char::from(0))
                        .to_string()
                })
                .collect::<Vec<String>>()
                .join(" "),
            _ => field
                .display_value()
                .to_string()
                .replace("\"", "")
                .trim()
                .to_string(),
        }
    };

    if let Some(f) = exif_obj.get_field(exif::Tag::GPSLatitude, exif::In::PRIMARY)
        && let exif::Value::Rational(v) = &f.value
        && v.len() >= 3
    {
        metadata.set_tag(ExifTag::GPSLatitude(vec![
            to_ur64(&v[0]),
            to_ur64(&v[1]),
            to_ur64(&v[2]),
        ]));
    }
    if let Some(f) = exif_obj.get_field(exif::Tag::GPSLatitudeRef, exif::In::PRIMARY) {
        metadata.set_tag(ExifTag::GPSLatitudeRef(get_string_val(f)));
    }
    if let Some(f) = exif_obj.get_field(exif::Tag::GPSLongitude, exif::In::PRIMARY)
        && let exif::Value::Rational(v) = &f.value
        && v.len() >= 3
    {
        metadata.set_tag(ExifTag::GPSLongitude(vec![
            to_ur64(&v[0]),
            to_ur64(&v[1]),
            to_ur64(&v[2]),
        ]));
    }
    if let Some(f) = exif_obj.get_field(exif::Tag::GPSLongitudeRef, exif::In::PRIMARY) {
        metadata.set_tag(ExifTag::GPSLongitudeRef(get_string_val(f)));
    }
    if let Some(f) = exif_obj.get_field(exif::Tag::GPSAltitude, exif::In::PRIMARY)
        && let exif::Value::Rational(v) = &f.value
        && !v.is_empty()
    {
        metadata.set_tag(ExifTag::GPSAltitude(vec![to_ur64(&v[0])]));
    }
    if let Some(f) = exif_obj.get_field(exif::Tag::GPSAltitudeRef, exif::In::PRIMARY)
        && let Some(val) = f.value.get_uint(0)
    {
        metadata.set_tag(ExifTag::GPSAltitudeRef(vec![val as u8]));
    }
}

fn apply_gps_from_rawler(metadata: &mut Metadata, gps: ExifGPS) {
    if let Some(lat) = gps.gps_latitude {
        metadata.set_tag(ExifTag::GPSLatitude(lat.map(rawler_to_ur64).to_vec()));
    }
    if let Some(lat_ref) = gps.gps_latitude_ref {
        metadata.set_tag(ExifTag::GPSLatitudeRef(lat_ref));
    }
    if let Some(lon) = gps.gps_longitude {
        metadata.set_tag(ExifTag::GPSLongitude(lon.map(rawler_to_ur64).to_vec()));
    }
    if let Some(lon_ref) = gps.gps_longitude_ref {
        metadata.set_tag(ExifTag::GPSLongitudeRef(lon_ref));
    }
    if let Some(alt) = gps.gps_altitude {
        metadata.set_tag(ExifTag::GPSAltitude(vec![rawler_to_ur64(alt)]));
    }
    if let Some(alt_ref) = gps.gps_altitude_ref {
        metadata.set_tag(ExifTag::GPSAltitudeRef(vec![alt_ref]));
    }
}

pub fn write_image_with_metadata(
    image_bytes: &mut Vec<u8>,
    original_path_str: &str,
    output_format: &str,
    keep_metadata: bool,
    strip_gps: bool,
    xmp: &ExportXmp,
    dpi: Option<u16>,
) -> Result<(), String> {
    if !keep_metadata {
        return Ok(());
    }

    let file_type = match output_format.to_lowercase().as_str() {
        "jpg" | "jpeg" => FileExtension::JPEG,
        "png" => FileExtension::PNG {
            as_zTXt_chunk: true,
        },
        "webp" => FileExtension::WEBP,
        _ => return Ok(()),
    };

    if file_type == FileExtension::WEBP {
        convert_webp_to_extended(image_bytes);
    }
    write_exif_metadata(image_bytes, original_path_str, file_type, strip_gps, dpi)?;
    embed_xmp(image_bytes, original_path_str, file_type, strip_gps, xmp);

    Ok(())
}

fn write_exif_metadata(
    image_bytes: &mut Vec<u8>,
    original_path_str: &str,
    file_type: FileExtension,
    strip_gps: bool,
    dpi: Option<u16>,
) -> Result<(), String> {
    let dimensions = image::ImageReader::new(Cursor::new(image_bytes.as_slice()))
        .with_guessed_format()
        .ok()
        .and_then(|reader| reader.into_dimensions().ok());

    let Some(mut metadata) = collect_metadata_from_source(original_path_str, strip_gps, dimensions)
    else {
        return Ok(());
    };

    if matches!(file_type, FileExtension::JPEG) {
        metadata.set_tag(ExifTag::ComponentsConfiguration(vec![1, 2, 3, 0]));
    }

    if let Some(dpi) = dpi {
        let resolution = vec![uR64 {
            nominator: dpi.into(),
            denominator: 1,
        }];
        metadata.set_tag(ExifTag::XResolution(resolution.clone()));
        metadata.set_tag(ExifTag::YResolution(resolution));
        metadata.set_tag(ExifTag::ResolutionUnit(vec![2u16]));
    }

    if let Err(e) = metadata.write_to_vec(image_bytes, file_type) {
        log::warn!("Failed to write metadata: {}", e);
    }

    Ok(())
}

pub fn collect_metadata_from_source(
    original_path_str: &str,
    strip_gps: bool,
    dimensions: Option<(u32, u32)>,
) -> Option<Metadata> {
    let original_path = Path::new(original_path_str);
    if !original_path.exists() {
        return None;
    }

    let mut metadata = Metadata::new();

    let full_exif_copied = !is_raw_file(original_path_str)
        && copy_full_exif_from_source(&mut metadata, original_path, strip_gps);
    let mut source_read_success = full_exif_copied;

    let raw_metadata = if is_raw_file(original_path_str) {
        read_raw_metadata_from_path(original_path_str)
    } else {
        None
    };
    if let Some(meta) = &raw_metadata {
        apply_exif_from_rawler(&mut metadata, meta);
    }

    if !source_read_success && let Some(map) = read_rrexif_sidecar(original_path) {
        source_read_success = true;

        let clean_s = |s: &String| s.replace('"', "").trim().to_string();

        let parse_ur64 = |s: &str| -> Option<uR64> {
            let cleaned_string = s
                .replace("f/", "")
                .replace(" s", "")
                .replace(" mm", "")
                .replace("\"", "");

            let val = cleaned_string.trim();

            if val.contains('/') {
                let parts: Vec<&str> = val.split('/').collect();
                if parts.len() == 2
                    && let (Ok(n), Ok(d)) = (parts[0].parse::<u32>(), parts[1].parse::<u32>())
                {
                    return Some(uR64 {
                        nominator: n,
                        denominator: d,
                    });
                }
            } else if let Ok(f) = val.parse::<f32>() {
                return Some(uR64 {
                    nominator: (f * 1000.0) as u32,
                    denominator: 1000,
                });
            }
            None
        };
        if let Some(val) = map.get("Make") {
            metadata.set_tag(ExifTag::Make(clean_s(val)));
        }
        if let Some(val) = map.get("Model") {
            metadata.set_tag(ExifTag::Model(clean_s(val)));
        }
        if let Some(val) = map.get("LensMake") {
            metadata.set_tag(ExifTag::LensMake(clean_s(val)));
        }
        if let Some(val) = map.get("LensModel") {
            metadata.set_tag(ExifTag::LensModel(clean_s(val)));
        }
        if let Some(val) = map.get("Artist") {
            metadata.set_tag(ExifTag::Artist(clean_s(val)));
        }
        if let Some(val) = map.get("Copyright") {
            metadata.set_tag(ExifTag::Copyright(clean_s(val)));
        }
        if let Some(val) = map.get("UserComment") {
            metadata.set_tag(ExifTag::UserComment(clean_s(val).into_bytes()));
        }
        if let Some(val) = map.get("ImageDescription") {
            metadata.set_tag(ExifTag::ImageDescription(clean_s(val)));
        }
        if let Some(val) = map.get("DateTimeOriginal") {
            metadata.set_tag(ExifTag::DateTimeOriginal(format_creation_datetime(
                val,
                EXIF_DATETIME_FORMAT,
            )));
        }
        if let Some(val) = map.get("CreateDate") {
            metadata.set_tag(ExifTag::CreateDate(format_creation_datetime(
                val,
                EXIF_DATETIME_FORMAT,
            )));
        }
        if let Some(val) = map.get("FNumber")
            && let Some(ur) = parse_ur64(val)
        {
            metadata.set_tag(ExifTag::FNumber(vec![ur]));
        }
        if let Some(val) = map.get("ExposureTime")
            && let Some(ur) = parse_ur64(val)
        {
            metadata.set_tag(ExifTag::ExposureTime(vec![ur]));
        }
        if let Some(val) = map.get("FocalLength")
            && let Some(ur) = parse_ur64(val)
        {
            metadata.set_tag(ExifTag::FocalLength(vec![ur]));
        }
        if let Some(val) = map.get("FocalLengthIn35mmFilm") {
            let cleaned = val.replace(" mm", "").replace("\"", "");
            let trimmed = cleaned.trim();
            if let Ok(f_val) = trimmed.parse::<f32>() {
                metadata.set_tag(ExifTag::FocalLengthIn35mmFormat(vec![f_val.round() as u16]));
            }
        }
        if let Some(val) = map.get("ISOSpeed").or(map.get("PhotographicSensitivity"))
            && let Ok(iso) = val.replace('"', "").trim().parse::<u16>()
        {
            metadata.set_tag(ExifTag::ISO(vec![iso]));
        }
    }

    if !source_read_success && let Ok(file) = std::fs::File::open(original_path) {
        let mut bufreader = std::io::BufReader::new(&file);
        let exifreader = exif::Reader::new();

        if let Ok(exif_obj) = exifreader.read_from_container(&mut bufreader) {
            let get_string_val = |field: &exif::Field| -> String {
                match &field.value {
                    exif::Value::Ascii(vec) => vec
                        .iter()
                        .map(|v| {
                            String::from_utf8_lossy(v)
                                .trim_matches(char::from(0))
                                .to_string()
                        })
                        .collect::<Vec<String>>()
                        .join(" "),
                    _ => field
                        .display_value()
                        .to_string()
                        .replace("\"", "")
                        .trim()
                        .to_string(),
                }
            };

            if let Some(f) = exif_obj.get_field(exif::Tag::Make, exif::In::PRIMARY) {
                metadata.set_tag(ExifTag::Make(get_string_val(f)));
            }
            if let Some(f) = exif_obj.get_field(exif::Tag::Model, exif::In::PRIMARY) {
                metadata.set_tag(ExifTag::Model(get_string_val(f)));
            }
            if let Some(f) = exif_obj.get_field(exif::Tag::LensMake, exif::In::PRIMARY) {
                metadata.set_tag(ExifTag::LensMake(get_string_val(f)));
            }
            if let Some(f) = exif_obj.get_field(exif::Tag::LensModel, exif::In::PRIMARY) {
                metadata.set_tag(ExifTag::LensModel(get_string_val(f)));
            }
            if let Some(f) = exif_obj.get_field(exif::Tag::Artist, exif::In::PRIMARY) {
                metadata.set_tag(ExifTag::Artist(get_string_val(f)));
            }
            if let Some(f) = exif_obj.get_field(exif::Tag::Copyright, exif::In::PRIMARY) {
                metadata.set_tag(ExifTag::Copyright(get_string_val(f)));
            }
            if let Some(f) = exif_obj.get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY) {
                metadata.set_tag(ExifTag::DateTimeOriginal(get_string_val(f)));
            }
            if let Some(f) = exif_obj.get_field(exif::Tag::DateTime, exif::In::PRIMARY) {
                metadata.set_tag(ExifTag::CreateDate(get_string_val(f)));
            }
            if let Some(f) = exif_obj.get_field(exif::Tag::FNumber, exif::In::PRIMARY)
                && let exif::Value::Rational(v) = &f.value
                && !v.is_empty()
            {
                metadata.set_tag(ExifTag::FNumber(vec![to_ur64(&v[0])]));
            }
            if let Some(f) = exif_obj.get_field(exif::Tag::ExposureTime, exif::In::PRIMARY)
                && let exif::Value::Rational(v) = &f.value
                && !v.is_empty()
            {
                metadata.set_tag(ExifTag::ExposureTime(vec![to_ur64(&v[0])]));
            }
            if let Some(f) = exif_obj.get_field(exif::Tag::FocalLength, exif::In::PRIMARY)
                && let exif::Value::Rational(v) = &f.value
                && !v.is_empty()
            {
                metadata.set_tag(ExifTag::FocalLength(vec![to_ur64(&v[0])]));
            }
            if let Some(f) = exif_obj.get_field(exif::Tag::ExposureBiasValue, exif::In::PRIMARY) {
                match &f.value {
                    exif::Value::SRational(v) if !v.is_empty() => {
                        metadata.set_tag(ExifTag::ExposureCompensation(vec![to_ir64(&v[0])]));
                    }
                    exif::Value::Rational(v) if !v.is_empty() => {
                        metadata.set_tag(ExifTag::ExposureCompensation(vec![iR64 {
                            nominator: v[0].num as i32,
                            denominator: v[0].denom as i32,
                        }]));
                    }
                    _ => {}
                }
            }
            if let Some(f) =
                exif_obj.get_field(exif::Tag::PhotographicSensitivity, exif::In::PRIMARY)
            {
                if let Some(val) = f.value.get_uint(0) {
                    metadata.set_tag(ExifTag::ISO(vec![val as u16]));
                }
            } else if let Some(f) = exif_obj.get_field(exif::Tag::ISOSpeed, exif::In::PRIMARY)
                && let Some(val) = f.value.get_uint(0)
            {
                metadata.set_tag(ExifTag::ISO(vec![val as u16]));
            }
            if let Some(f) = exif_obj.get_field(exif::Tag::FocalLengthIn35mmFilm, exif::In::PRIMARY)
                && let Some(val) = f.value.get_uint(0)
            {
                metadata.set_tag(ExifTag::FocalLengthIn35mmFormat(vec![val as u16]));
            }
        }
    }

    if !strip_gps {
        if is_raw_file(original_path_str) {
            if let Some(gps) = raw_metadata.and_then(|meta| meta.exif.gps) {
                apply_gps_from_rawler(&mut metadata, gps);
            }
        } else {
            apply_gps_from_kamadak(&mut metadata, original_path);
        }
    }

    if full_exif_copied && let Some(map) = read_rrexif_sidecar(original_path) {
        apply_sidecar_field_overrides(&mut metadata, &map);
    }

    metadata.set_tag(ExifTag::Software("RapidRAW".to_string()));
    metadata.set_tag(ExifTag::Orientation(vec![1u16]));
    metadata.set_tag(ExifTag::ColorSpace(vec![1u16]));
    metadata.set_tag(ExifTag::ExifVersion(b"0232".to_vec()));
    metadata.set_tag(ExifTag::FlashpixVersion(b"0100".to_vec()));

    if let Some((width, height)) = dimensions {
        metadata.set_tag(ExifTag::ExifImageWidth(vec![width]));
        metadata.set_tag(ExifTag::ExifImageHeight(vec![height]));
    }

    Some(metadata)
}

pub struct ExportXmp {
    keywords: Vec<String>,
    rating: Option<String>,
    label: Option<String>,
}

impl ExportXmp {
    pub fn from_metadata(metadata: &ImageMetadata) -> Self {
        let tags = metadata.tags.as_deref().unwrap_or_default();
        let mut keywords = Vec::new();
        for tag in tags.iter().filter(|t| !t.starts_with(COLOR_TAG_PREFIX)) {
            push_keyword(
                &mut keywords,
                tag.strip_prefix(USER_TAG_PREFIX).unwrap_or(tag),
            );
        }
        Self {
            keywords,
            rating: (metadata.rating > 0 || metadata.flag == Some(ImageFlag::Reject))
                .then(|| xmp::xmp_rating(metadata)),
            label: xmp::xmp_label(tags),
        }
    }
}

fn push_keyword(keywords: &mut Vec<String>, keyword: &str) {
    let keyword = keyword.trim();
    if !keyword.is_empty() && !keywords.iter().any(|k| k == keyword) {
        keywords.push(keyword.to_string());
    }
}

fn embed_xmp(
    image_bytes: &mut Vec<u8>,
    original_path_str: &str,
    file_type: FileExtension,
    strip_gps: bool,
    xmp: &ExportXmp,
) {
    let source_xmp = if strip_gps || is_raw_file(original_path_str) {
        None
    } else {
        read_source_xmp(Path::new(original_path_str))
    };
    let Some(packet) = build_export_xmp(xmp, source_xmp.as_deref()) else {
        return;
    };

    match file_type {
        FileExtension::JPEG => embed_jpeg_xmp(image_bytes, &packet),
        FileExtension::PNG { .. } => embed_png_xmp(image_bytes, &packet),
        FileExtension::WEBP => embed_webp_xmp(image_bytes, &packet),
        _ => {}
    }
}

fn read_source_xmp(path: &Path) -> Option<String> {
    let mut decoder = image::ImageReader::open(path)
        .ok()?
        .with_guessed_format()
        .ok()?
        .into_decoder()
        .ok()?;
    String::from_utf8(decoder.xmp_metadata().ok()??).ok()
}

fn build_export_xmp(xmp: &ExportXmp, source_xmp: Option<&str>) -> Option<String> {
    let mut keywords = xmp.keywords.clone();
    for tag in source_xmp.map(xmp::extract_xmp_tags).unwrap_or_default() {
        push_keyword(
            &mut keywords,
            &unescape(&tag).unwrap_or(Cow::Borrowed(&tag)),
        );
    }

    let description = export_xmp_description(xmp, &keywords);
    if let Some(merged) = source_xmp.and_then(|source| merge_source_xmp(source, &description, xmp))
    {
        return Some(merged);
    }
    if description.is_empty() {
        return None;
    }

    Some(format!(
        "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n\
<x:xmpmeta xmlns:x=\"adobe:ns:meta/\" x:xmptk=\"RapidRAW\">\n \
<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n\
{} </rdf:RDF>\n\
</x:xmpmeta>\n\
<?xpacket end=\"w\"?>",
        description
    ))
}

fn export_xmp_description(xmp: &ExportXmp, keywords: &[String]) -> String {
    let mut properties = String::new();
    if let Some(rating) = &xmp.rating {
        properties.push_str(&format!("   <xmp:Rating>{}</xmp:Rating>\n", rating));
    }
    if let Some(label) = &xmp.label {
        properties.push_str(&format!(
            "   <xmp:Label>{}</xmp:Label>\n",
            escape(label.as_str())
        ));
    }
    if !keywords.is_empty() {
        let escaped: Vec<Cow<str>> = keywords.iter().map(|k| escape(k.as_str())).collect();
        properties.push_str(&format!("   {}\n", xmp::xmp_subject_bag(&escaped)));
    }
    if properties.is_empty() {
        return properties;
    }

    format!(
        "  <rdf:Description rdf:about=\"\"\n    xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"\n    xmlns:dc=\"http://purl.org/dc/elements/1.1/\">\n{}  </rdf:Description>\n",
        properties
    )
}

fn is_replaced_xmp_property(name: &[u8], xmp: &ExportXmp) -> bool {
    name.starts_with(b"crs:")
        || matches!(
            name,
            b"dc:subject"
                | b"tiff:Orientation"
                | b"tiff:ImageWidth"
                | b"tiff:ImageLength"
                | b"exif:PixelXDimension"
                | b"exif:PixelYDimension"
                | b"xmpNote:HasExtendedXMP"
        )
        || (xmp.rating.is_some() && name == b"xmp:Rating")
        || (xmp.label.is_some() && name == b"xmp:Label")
}

fn without_replaced_attributes(element: &BytesStart, xmp: &ExportXmp) -> BytesStart<'static> {
    let mut kept = BytesStart::new(String::from_utf8_lossy(element.name().as_ref()).into_owned());
    for attribute in element.attributes().with_checks(false).flatten() {
        if !is_replaced_xmp_property(attribute.key.as_ref(), xmp) {
            kept.push_attribute(attribute);
        }
    }
    kept
}

fn merge_source_xmp(source: &str, description: &str, xmp: &ExportXmp) -> Option<String> {
    let mut reader = Reader::from_str(source);
    let mut writer = Writer::new(Vec::new());
    let mut inserted = false;

    loop {
        match reader.read_event().ok()? {
            Event::Eof => break,
            Event::Start(e) if is_replaced_xmp_property(e.name().as_ref(), xmp) => {
                reader.read_to_end(e.name()).ok()?;
            }
            Event::Empty(e) if is_replaced_xmp_property(e.name().as_ref(), xmp) => {}
            Event::Start(e) => writer
                .write_event(Event::Start(without_replaced_attributes(&e, xmp)))
                .ok()?,
            Event::Empty(e) => writer
                .write_event(Event::Empty(without_replaced_attributes(&e, xmp)))
                .ok()?,
            Event::End(e) if e.name().as_ref() == b"rdf:RDF" => {
                writer
                    .write_event(Event::Text(BytesText::from_escaped(description)))
                    .ok()?;
                writer.write_event(Event::End(e)).ok()?;
                inserted = true;
            }
            event => writer.write_event(event).ok()?,
        }
    }

    if !inserted {
        return None;
    }
    String::from_utf8(writer.into_inner()).ok()
}

fn embed_jpeg_xmp(image_bytes: &mut Vec<u8>, packet: &str) {
    const XMP_NAMESPACE: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";

    if !image_bytes.starts_with(&[0xFF, 0xD8]) {
        return;
    }
    let Ok(segment_len) = u16::try_from(2 + XMP_NAMESPACE.len() + packet.len()) else {
        log::warn!("Skipping XMP metadata: packet exceeds JPEG segment size");
        return;
    };

    let mut insert_at = 2;
    while insert_at + 4 <= image_bytes.len()
        && image_bytes[insert_at] == 0xFF
        && (0xE0..=0xEF).contains(&image_bytes[insert_at + 1])
    {
        let len = u16::from_be_bytes([image_bytes[insert_at + 2], image_bytes[insert_at + 3]]);
        insert_at += 2 + len as usize;
    }
    if insert_at > image_bytes.len() {
        return;
    }

    let mut segment = Vec::with_capacity(2 + segment_len as usize);
    segment.extend_from_slice(&[0xFF, 0xE1]);
    segment.extend_from_slice(&segment_len.to_be_bytes());
    segment.extend_from_slice(XMP_NAMESPACE);
    segment.extend_from_slice(packet.as_bytes());
    image_bytes.splice(insert_at..insert_at, segment);
}

fn embed_png_xmp(image_bytes: &mut Vec<u8>, packet: &str) {
    let mut data = b"XML:com.adobe.xmp\0\0\0\0\0".to_vec();
    data.extend_from_slice(packet.as_bytes());
    insert_png_chunk(image_bytes, b"iTXt", &data);
}

pub fn insert_png_chunk(image_bytes: &mut Vec<u8>, chunk_type: &[u8; 4], data: &[u8]) {
    const IHDR_END: usize = 33;

    if image_bytes.len() < IHDR_END || &image_bytes[12..16] != b"IHDR" {
        return;
    }

    let mut crc = crc32fast::Hasher::new();
    crc.update(chunk_type);
    crc.update(data);

    let mut chunk = Vec::with_capacity(data.len() + 12);
    chunk.extend_from_slice(&(data.len() as u32).to_be_bytes());
    chunk.extend_from_slice(chunk_type);
    chunk.extend_from_slice(data);
    chunk.extend_from_slice(&crc.finalize().to_be_bytes());
    image_bytes.splice(IHDR_END..IHDR_END, chunk);
}

fn embed_webp_xmp(image_bytes: &mut Vec<u8>, packet: &str) {
    const VP8X_FLAGS: usize = 20;
    const XMP_FLAG: u8 = 0x04;

    if image_bytes.len() <= VP8X_FLAGS
        || &image_bytes[0..4] != b"RIFF"
        || &image_bytes[12..16] != b"VP8X"
    {
        return;
    }

    image_bytes[VP8X_FLAGS] |= XMP_FLAG;
    image_bytes.extend_from_slice(b"XMP ");
    image_bytes.extend_from_slice(&(packet.len() as u32).to_le_bytes());
    image_bytes.extend_from_slice(packet.as_bytes());
    if !packet.len().is_multiple_of(2) {
        image_bytes.push(0);
    }
    update_riff_size(image_bytes);
}

fn convert_webp_to_extended(image_bytes: &mut Vec<u8>) {
    const VP8_FRAME: usize = 20;

    if image_bytes.len() < VP8_FRAME + 10
        || &image_bytes[0..4] != b"RIFF"
        || &image_bytes[12..16] != b"VP8 "
        || image_bytes[VP8_FRAME + 3..VP8_FRAME + 6] != [0x9D, 0x01, 0x2A]
    {
        return;
    }

    let dimension = |offset: usize| {
        u32::from(u16::from_le_bytes([image_bytes[offset], image_bytes[offset + 1]]) & 0x3FFF)
            .saturating_sub(1)
    };
    let width = dimension(VP8_FRAME + 6);
    let height = dimension(VP8_FRAME + 8);

    let mut vp8x = Vec::with_capacity(18);
    vp8x.extend_from_slice(b"VP8X");
    vp8x.extend_from_slice(&10u32.to_le_bytes());
    vp8x.extend_from_slice(&[0; 4]);
    vp8x.extend_from_slice(&width.to_le_bytes()[..3]);
    vp8x.extend_from_slice(&height.to_le_bytes()[..3]);
    image_bytes.splice(12..12, vp8x);
    update_riff_size(image_bytes);
}

fn update_riff_size(image_bytes: &mut [u8]) {
    let riff_size = (image_bytes.len() - 8) as u32;
    image_bytes[4..8].copy_from_slice(&riff_size.to_le_bytes());
}

pub fn encode_converted_image(
    image: &image::DynamicImage,
    extension: &str,
    source_path_str: &str,
) -> Result<Vec<u8>, String> {
    let dimensions = image::GenericImageView::dimensions(image);
    let metadata = collect_metadata_from_source(source_path_str, false, Some(dimensions));

    match extension.to_lowercase().as_str() {
        "tif" | "tiff" => {
            let samples = match image {
                image::DynamicImage::ImageRgb32F(_) | image::DynamicImage::ImageRgba32F(_) => {
                    crate::metadata::tiff_metadata::TiffSamples::ThirtyTwoFloat
                }
                image::DynamicImage::ImageRgb16(_)
                | image::DynamicImage::ImageRgba16(_)
                | image::DynamicImage::ImageLuma16(_)
                | image::DynamicImage::ImageLumaA16(_) => {
                    crate::metadata::tiff_metadata::TiffSamples::Sixteen
                }
                _ => crate::metadata::tiff_metadata::TiffSamples::Eight,
            };
            crate::metadata::tiff_metadata::encode_tiff_with_metadata(
                image,
                samples,
                metadata.as_ref(),
                Some(crate::export::encode::SRGB_ICC_PROFILE),
                None,
            )
        }
        "png" => {
            let mut bytes = Vec::new();
            image
                .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
                .map_err(|e| format!("Failed to encode image: {}", e))?;

            if let Some(metadata) = metadata
                && let Err(e) = metadata.write_to_vec(
                    &mut bytes,
                    FileExtension::PNG {
                        as_zTXt_chunk: true,
                    },
                )
            {
                log::warn!("Failed to write metadata: {}", e);
            }
            Ok(bytes)
        }
        other => Err(format!(
            "Unsupported format for a converted image: '{}'",
            other
        )),
    }
}

fn to_ur64(val: &exif::Rational) -> uR64 {
    uR64 {
        nominator: val.num,
        denominator: val.denom,
    }
}

fn to_ir64(val: &exif::SRational) -> iR64 {
    iR64 {
        nominator: val.num,
        denominator: val.denom,
    }
}

fn rawler_to_ur64(val: rawler::formats::tiff::Rational) -> uR64 {
    uR64 {
        nominator: val.n,
        denominator: val.d,
    }
}

fn rawler_to_ir64(val: rawler::formats::tiff::SRational) -> iR64 {
    iR64 {
        nominator: val.n,
        denominator: val.d,
    }
}

const EXIF_DATETIME_FORMAT: &str = "%Y:%m:%d %H:%M:%S";
