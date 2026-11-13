use crate::library::tagging::COLOR_TAG_PREFIX;

use crate::library::file_ops::write_file_atomic;
use crate::metadata::sidecar::{ImageFlag, ImageMetadata};
use crate::render::adjustment_utils::default_adjustments;
use quick_xml::escape::{escape, unescape};
use regex::{NoExpand, regex};
use std::borrow::Cow;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

pub fn extract_xmp_rating(content: &str) -> Option<i8> {
    if let Some(idx) = content.find("xmp:Rating=\"") {
        let start = idx + 12;
        let end = content[start..].find('"').map(|i| start + i)?;
        return content[start..end].parse().ok();
    }
    if let Some(idx) = content.find("<xmp:Rating>") {
        let start = idx + 12;
        let end = content[start..].find('<').map(|i| start + i)?;
        return content[start..end].parse().ok();
    }
    None
}

const XMP_REJECTED_RATING: i8 = -1;

pub fn xmp_rating(metadata: &ImageMetadata) -> String {
    if metadata.flag == Some(ImageFlag::Reject) {
        XMP_REJECTED_RATING.to_string()
    } else {
        metadata.rating.to_string()
    }
}

pub fn xmp_label(tags: &[String]) -> Option<String> {
    tags.iter()
        .rev()
        .find_map(|t| t.strip_prefix(COLOR_TAG_PREFIX))
        .map(|color| {
            let mut c = color.chars();
            match c.next() {
                None => String::new(),
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
            }
        })
}

pub fn xmp_subject_bag<S: AsRef<str>>(items: &[S]) -> String {
    let mut bag = String::from("<dc:subject>\n    <rdf:Bag>\n");
    for item in items {
        bag.push_str(&format!("     <rdf:li>{}</rdf:li>\n", item.as_ref()));
    }
    bag.push_str("    </rdf:Bag>\n   </dc:subject>");
    bag
}

pub fn extract_xmp_label(content: &str) -> Option<String> {
    if let Some(idx) = content.find("xmp:Label=\"") {
        let start = idx + 11;
        let end = content[start..].find('"').map(|i| start + i)?;
        return Some(content[start..end].to_string());
    }
    if let Some(idx) = content.find("<xmp:Label>") {
        let start = idx + 11;
        let end = content[start..].find('<').map(|i| start + i)?;
        return Some(content[start..end].to_string());
    }
    None
}

pub fn extract_xmp_tags(content: &str) -> Vec<String> {
    let mut tags = Vec::new();
    if let Some(start_idx) = content.find("<dc:subject>")
        && let Some(end_idx) = content[start_idx..].find("</dc:subject>")
    {
        let subject_block = &content[start_idx..start_idx + end_idx];
        let mut current_idx = 0;
        while let Some(li_start) = subject_block[current_idx..].find("<rdf:li>") {
            let val_start = current_idx + li_start + 8;
            if let Some(li_end) = subject_block[val_start..].find("</rdf:li>") {
                tags.push(subject_block[val_start..val_start + li_end].to_string());
                current_idx = val_start + li_end + 9;
            } else {
                break;
            }
        }
    }
    tags
}

pub fn resolve_xmp_path(image_path: &Path) -> Option<PathBuf> {
    let xmp_path = image_path.with_extension("xmp");
    let xmp_path_upper = image_path.with_extension("XMP");
    if xmp_path.exists() {
        Some(xmp_path)
    } else if xmp_path_upper.exists() {
        Some(xmp_path_upper)
    } else {
        None
    }
}

pub fn parse_gps_components(coord: &str) -> Option<(u32, f64, f64)> {
    let trimmed = coord.trim();

    let re_dms = regex!(
        r#"(\d+)\s*(?:deg|°)\s*(\d+(?:\.\d+)?)\s*(?:min|'|’|′)(?:\s*(\d+(?:\.\d+)?)\s*(?:sec|"|”|″)?)?"#
    );
    if let Some(caps) = re_dms.captures(trimmed) {
        let deg: u32 = caps.get(1)?.as_str().parse().ok()?;
        let min_raw: f64 = caps.get(2)?.as_str().parse().ok()?;
        if let Some(sec_match) = caps.get(3) {
            let sec: f64 = sec_match.as_str().parse().unwrap_or(0.0);
            return Some((deg, min_raw, sec));
        } else {
            let min = min_raw.floor();
            let sec = (min_raw - min) * 60.0;
            return Some((deg, min, sec));
        }
    }

    let comma_parts: Vec<&str> = trimmed.split(',').map(|s| s.trim()).collect();
    let parse_frac = |s: &str| -> Option<f64> {
        if let Some((n, d)) = s.split_once('/') {
            let num: f64 = n.trim().parse().ok()?;
            let den: f64 = d.trim().parse().ok()?;
            if den != 0.0 { Some(num / den) } else { None }
        } else {
            s.parse().ok()
        }
    };
    if comma_parts.len() == 3 {
        if let (Some(d), Some(m), Some(s)) = (
            parse_frac(comma_parts[0]),
            parse_frac(comma_parts[1]),
            parse_frac(comma_parts[2]),
        ) {
            return Some((d as u32, m, s));
        }
    } else if comma_parts.len() == 2
        && let (Some(d), Some(m)) = (parse_frac(comma_parts[0]), parse_frac(comma_parts[1]))
    {
        let min = m.floor();
        let sec = (m - min) * 60.0;
        return Some((d as u32, min, sec));
    }

    if let Ok(dec) = trimmed.parse::<f64>() {
        let abs_val = dec.abs();
        let deg = abs_val.floor() as u32;
        let min_full = (abs_val - deg as f64) * 60.0;
        let min = min_full.floor();
        let sec = (min_full - min) * 60.0;
        return Some((deg, min, sec));
    }

    None
}

fn extract_xmp_tag_or_attr(content: &str, name: &str) -> Option<String> {
    let attr_pat = format!("{}=\"", name);
    if let Some(idx) = content.find(&attr_pat) {
        let start = idx + attr_pat.len();
        let end = content[start..].find('"').map(|i| start + i)?;
        let val = content[start..end].trim();
        if !val.is_empty() {
            return Some(val.to_string());
        }
    }
    let open_tag = format!("<{}>", name);
    let close_tag = format!("</{}>", name);
    if let Some(idx) = content.find(&open_tag) {
        let start = idx + open_tag.len();
        let end = content[start..].find(&close_tag).map(|i| start + i)?;
        let val = content[start..end].trim();
        if !val.is_empty() {
            return Some(val.to_string());
        }
    }
    None
}

fn parse_xmp_gps_coord(
    raw: &str,
    explicit_ref: Option<&str>,
    is_lat: bool,
) -> Option<(String, String)> {
    let mut s = raw.trim().to_string();
    let mut dir = explicit_ref
        .map(|r| r.trim().to_uppercase())
        .unwrap_or_default();

    if let Some(last_char) = s.chars().last() {
        let upper = last_char.to_ascii_uppercase();
        if matches!(upper, 'N' | 'S' | 'E' | 'W') {
            dir = upper.to_string();
            s.pop();
            s = s.trim().to_string();
        }
    }

    if s.starts_with('-') {
        dir = if is_lat {
            "S".to_string()
        } else {
            "W".to_string()
        };
        s = s.trim_start_matches('-').trim().to_string();
    } else if dir.is_empty() {
        dir = if is_lat {
            "N".to_string()
        } else {
            "E".to_string()
        };
    }

    let (deg, min, sec) = parse_gps_components(&s)?;
    let dms_str = format!("{} deg {} min {:.4} sec", deg, min.floor() as u32, sec);
    Some((dms_str, dir))
}

pub fn extract_xmp_gps(content: &str) -> Option<(String, String, String, String)> {
    let raw_lat = extract_xmp_tag_or_attr(content, "exif:GPSLatitude")?;
    let raw_lon = extract_xmp_tag_or_attr(content, "exif:GPSLongitude")?;
    let raw_lat_ref = extract_xmp_tag_or_attr(content, "exif:GPSLatitudeRef");
    let raw_lon_ref = extract_xmp_tag_or_attr(content, "exif:GPSLongitudeRef");

    let (lat_dms, lat_ref) = parse_xmp_gps_coord(&raw_lat, raw_lat_ref.as_deref(), true)?;
    let (lon_dms, lon_ref) = parse_xmp_gps_coord(&raw_lon, raw_lon_ref.as_deref(), false)?;
    Some((lat_dms, lat_ref, lon_dms, lon_ref))
}

pub fn sync_metadata_from_xmp(
    source_path: &Path,
    sidecar_path: &Path,
    metadata: &mut ImageMetadata,
) -> bool {
    if sidecar_path != crate::metadata::sidecar::get_primary_sidecar_path(source_path) {
        return false;
    }

    let actual_xmp = resolve_xmp_path(source_path);

    let mut changed = false;

    if let Some(xmp_file) = actual_xmp
        && let Ok(content) = fs::read_to_string(&xmp_file)
    {
        let xmp_rating = extract_xmp_rating(&content);

        if xmp_rating == Some(XMP_REJECTED_RATING) && metadata.flag.is_none() {
            metadata.flag = Some(ImageFlag::Reject);
            changed = true;
        }

        if metadata.rating == 0
            && let Some(rating) = xmp_rating.and_then(|r| u8::try_from(r).ok())
            && rating != 0
        {
            metadata.rating = rating;
            if !metadata.adjustments.is_object() {
                metadata.adjustments = default_adjustments();
            }
            if let Some(obj) = metadata.adjustments.as_object_mut() {
                obj.insert("rating".to_string(), serde_json::json!(rating));
            }
            changed = true;
        }

        let xmp_label = extract_xmp_label(&content);
        let xmp_tags = extract_xmp_tags(&content);

        let mut current_tags = metadata.tags.clone().unwrap_or_default();
        let original_len = current_tags.len();
        let had_no_tags = metadata.tags.is_none();

        for tag in xmp_tags {
            let tag = unescape(&tag).map_or(tag.clone(), Cow::into_owned);
            if !current_tags.contains(&tag) {
                current_tags.push(tag);
            }
        }

        if let Some(label) = xmp_label {
            let label = unescape(&label).map_or(label.clone(), Cow::into_owned);
            let label_tag = format!("{}{}", COLOR_TAG_PREFIX, label.to_lowercase());
            if !current_tags.contains(&label_tag) {
                current_tags.retain(|t| !t.starts_with(COLOR_TAG_PREFIX));
                current_tags.push(label_tag);
            }
        }

        if current_tags.len() != original_len || (had_no_tags && !current_tags.is_empty()) {
            metadata.tags = Some(current_tags);
            changed = true;
        }

        let xmp_gps = extract_xmp_gps(&content);
        if let Some((lat_s, lat_r, lon_s, lon_r)) = xmp_gps {
            let mut exif_map = metadata.exif.clone().unwrap_or_default();
            if !exif_map.contains_key("GPSLatitude") {
                exif_map.insert("GPSLatitude".to_string(), lat_s);
                exif_map.insert("GPSLatitudeRef".to_string(), lat_r);
                exif_map.insert("GPSLongitude".to_string(), lon_s);
                exif_map.insert("GPSLongitudeRef".to_string(), lon_r);
                metadata.exif = Some(exif_map);
                changed = true;
            }
        }
    }
    changed
}

static XMP_LOCK: Mutex<()> = Mutex::new(());

pub fn sync_metadata_to_xmp(
    source_path: &Path,
    sidecar_path: &Path,
    metadata: &ImageMetadata,
    create_if_missing: bool,
) {
    if sidecar_path != crate::metadata::sidecar::get_primary_sidecar_path(source_path) {
        return;
    }

    let _xmp = XMP_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    let xmp_path = source_path.with_extension("xmp");
    let mut actual_xmp = resolve_xmp_path(source_path);

    if actual_xmp.is_none() {
        if !create_if_missing {
            return;
        }
        let skeleton = r#"<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="RapidRAW">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:exif="http://ns.adobe.com/exif/1.0/">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>"#;
        if let Err(e) = write_file_atomic(&xmp_path, skeleton.as_bytes()) {
            log::error!("Failed to create skeleton XMP: {}", e);
            return;
        }
        actual_xmp = Some(xmp_path);
    }

    if let Some(xmp_file) = actual_xmp
        && let Ok(mut content) = fs::read_to_string(&xmp_file)
    {
        let rating_str = xmp_rating(metadata);
        let re_rating_attr = regex!(r#"xmp:Rating\s*=\s*"[^"]*""#);
        let re_rating_tag = regex!(r#"<xmp:Rating\s*>[^<]*</xmp:Rating>"#);

        if re_rating_attr.is_match(&content) {
            content = re_rating_attr
                .replace(&content, format!("xmp:Rating=\"{}\"", rating_str))
                .to_string();
        } else if re_rating_tag.is_match(&content) {
            content = re_rating_tag
                .replace(&content, format!("<xmp:Rating>{}</xmp:Rating>", rating_str))
                .to_string();
        } else if let Some(last_index) = content.rfind("</rdf:Description>") {
            let (start, end) = content.split_at(last_index);
            content = format!("{} <xmp:Rating>{}</xmp:Rating>\n{}", start, rating_str, end);
        }

        let current_tags = metadata.tags.clone().unwrap_or_default();
        let label = xmp_label(&current_tags);
        let normal_tags: Vec<String> = current_tags
            .into_iter()
            .filter(|t| !t.starts_with(COLOR_TAG_PREFIX))
            .collect();

        if let Some(lbl) = label {
            let lbl = escape(lbl.as_str());
            let re_label_attr = regex!(r#"xmp:Label\s*=\s*"[^"]*""#);
            let re_label_tag = regex!(r#"<xmp:Label\s*>[^<]*</xmp:Label>"#);

            if re_label_attr.is_match(&content) {
                content = re_label_attr
                    .replace(&content, NoExpand(&format!("xmp:Label=\"{}\"", lbl)))
                    .to_string();
            } else if re_label_tag.is_match(&content) {
                content = re_label_tag
                    .replace(
                        &content,
                        NoExpand(&format!("<xmp:Label>{}</xmp:Label>", lbl)),
                    )
                    .to_string();
            } else if let Some(last_index) = content.rfind("</rdf:Description>") {
                let (start, end) = content.split_at(last_index);
                content = format!("{} <xmp:Label>{}</xmp:Label>\n{}", start, lbl, end);
            }
        } else {
            let re_label_attr = regex!(r#"\s*xmp:Label\s*=\s*"[^"]*""#);
            let re_label_tag = regex!(r#"\s*<xmp:Label\s*>[^<]*</xmp:Label>"#);
            content = re_label_attr.replace_all(&content, "").to_string();
            content = re_label_tag.replace_all(&content, "").to_string();
        }

        let re_subject = regex!(r#"(?s)<dc:subject>\s*<rdf:Bag>.*?</rdf:Bag>\s*</dc:subject>"#);
        if normal_tags.is_empty() {
            content = re_subject.replace_all(&content, "").to_string();
        } else {
            let escaped: Vec<Cow<str>> = normal_tags.iter().map(|t| escape(t.as_str())).collect();
            let bag = xmp_subject_bag(&escaped);

            if re_subject.is_match(&content) {
                content = re_subject.replace(&content, NoExpand(&bag)).to_string();
            } else if let Some(last_index) = content.rfind("</rdf:Description>") {
                let (start, end) = content.split_at(last_index);
                content = format!("{} {}\n  {}", start, bag, end);
            }
        }

        let gps_data = metadata.exif.as_ref().and_then(|exif| {
            let lat = exif.get("GPSLatitude")?;
            let lat_ref = exif
                .get("GPSLatitudeRef")
                .map(|s| s.as_str())
                .unwrap_or("N");
            let lon = exif.get("GPSLongitude")?;
            let lon_ref = exif
                .get("GPSLongitudeRef")
                .map(|s| s.as_str())
                .unwrap_or("E");
            Some((
                lat.clone(),
                lat_ref.to_string(),
                lon.clone(),
                lon_ref.to_string(),
            ))
        });

        let re_lat_attr = regex!(r#"exif:GPSLatitude\s*=\s*"[^"]*""#);
        let re_lat_tag = regex!(r#"<exif:GPSLatitude\s*>[^<]*</exif:GPSLatitude>"#);
        let re_lat_ref_attr = regex!(r#"exif:GPSLatitudeRef\s*=\s*"[^"]*""#);
        let re_lat_ref_tag = regex!(r#"<exif:GPSLatitudeRef\s*>[^<]*</exif:GPSLatitudeRef>"#);
        let re_lon_attr = regex!(r#"exif:GPSLongitude\s*=\s*"[^"]*""#);
        let re_lon_tag = regex!(r#"<exif:GPSLongitude\s*>[^<]*</exif:GPSLongitude>"#);
        let re_lon_ref_attr = regex!(r#"exif:GPSLongitudeRef\s*=\s*"[^"]*""#);
        let re_lon_ref_tag = regex!(r#"<exif:GPSLongitudeRef\s*>[^<]*</exif:GPSLongitudeRef>"#);

        if let Some((lat_val, lat_ref_val, lon_val, lon_ref_val)) = gps_data {
            if !content.contains("xmlns:exif")
                && let Some(desc_idx) = content.find("<rdf:Description")
            {
                let insert_pos = desc_idx + "<rdf:Description".len();
                content.insert_str(
                    insert_pos,
                    "\n    xmlns:exif=\"http://ns.adobe.com/exif/1.0/\"",
                );
            }

            let format_for_xmp = |raw: &str, r: &str| -> String {
                if let Some(deg_min_sec) = parse_gps_components(raw) {
                    let min_total = deg_min_sec.1 + deg_min_sec.2 / 60.0;
                    format!("{},{:.4}{}", deg_min_sec.0, min_total, r)
                } else {
                    format!("{}{}", raw.trim(), r)
                }
            };

            let xmp_lat = format_for_xmp(&lat_val, &lat_ref_val);
            let xmp_lon = format_for_xmp(&lon_val, &lon_ref_val);

            if re_lat_attr.is_match(&content) {
                content = re_lat_attr
                    .replace(&content, format!("exif:GPSLatitude=\"{}\"", xmp_lat))
                    .to_string();
            } else if re_lat_tag.is_match(&content) {
                content = re_lat_tag
                    .replace(
                        &content,
                        format!("<exif:GPSLatitude>{}</exif:GPSLatitude>", xmp_lat),
                    )
                    .to_string();
            } else if let Some(last_index) = content.rfind("</rdf:Description>") {
                let (start, end) = content.split_at(last_index);
                content = format!(
                    "{} <exif:GPSLatitude>{}</exif:GPSLatitude>\n{}",
                    start, xmp_lat, end
                );
            }

            if re_lat_ref_attr.is_match(&content) {
                content = re_lat_ref_attr
                    .replace(&content, format!("exif:GPSLatitudeRef=\"{}\"", lat_ref_val))
                    .to_string();
            } else if re_lat_ref_tag.is_match(&content) {
                content = re_lat_ref_tag
                    .replace(
                        &content,
                        format!("<exif:GPSLatitudeRef>{}</exif:GPSLatitudeRef>", lat_ref_val),
                    )
                    .to_string();
            } else if let Some(last_index) = content.rfind("</rdf:Description>") {
                let (start, end) = content.split_at(last_index);
                content = format!(
                    "{} <exif:GPSLatitudeRef>{}</exif:GPSLatitudeRef>\n{}",
                    start, lat_ref_val, end
                );
            }

            if re_lon_attr.is_match(&content) {
                content = re_lon_attr
                    .replace(&content, format!("exif:GPSLongitude=\"{}\"", xmp_lon))
                    .to_string();
            } else if re_lon_tag.is_match(&content) {
                content = re_lon_tag
                    .replace(
                        &content,
                        format!("<exif:GPSLongitude>{}</exif:GPSLongitude>", xmp_lon),
                    )
                    .to_string();
            } else if let Some(last_index) = content.rfind("</rdf:Description>") {
                let (start, end) = content.split_at(last_index);
                content = format!(
                    "{} <exif:GPSLongitude>{}</exif:GPSLongitude>\n{}",
                    start, xmp_lon, end
                );
            }

            if re_lon_ref_attr.is_match(&content) {
                content = re_lon_ref_attr
                    .replace(
                        &content,
                        format!("exif:GPSLongitudeRef=\"{}\"", lon_ref_val),
                    )
                    .to_string();
            } else if re_lon_ref_tag.is_match(&content) {
                content = re_lon_ref_tag
                    .replace(
                        &content,
                        format!(
                            "<exif:GPSLongitudeRef>{}</exif:GPSLongitudeRef>",
                            lon_ref_val
                        ),
                    )
                    .to_string();
            } else if let Some(last_index) = content.rfind("</rdf:Description>") {
                let (start, end) = content.split_at(last_index);
                content = format!(
                    "{} <exif:GPSLongitudeRef>{}</exif:GPSLongitudeRef>\n{}",
                    start, lon_ref_val, end
                );
            }
        } else {
            content = re_lat_attr.replace_all(&content, "").to_string();
            content = re_lat_tag.replace_all(&content, "").to_string();
            content = re_lat_ref_attr.replace_all(&content, "").to_string();
            content = re_lat_ref_tag.replace_all(&content, "").to_string();
            content = re_lon_attr.replace_all(&content, "").to_string();
            content = re_lon_tag.replace_all(&content, "").to_string();
            content = re_lon_ref_attr.replace_all(&content, "").to_string();
            content = re_lon_ref_tag.replace_all(&content, "").to_string();
        }

        let _ = write_file_atomic(&xmp_file, content.as_bytes());
    }
}
