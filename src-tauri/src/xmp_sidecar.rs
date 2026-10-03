use std::fs;
use std::path::{Path, PathBuf};

use quick_xml::XmlVersion;
use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;
use regex::regex;
use serde::{Deserialize, Serialize};

use crate::image_processing::ImageMetadata;
use crate::tagging::{COLOR_TAG_PREFIX, USER_TAG_PREFIX};

const RAPIDRAW_COLORS: [&str; 5] = ["red", "yellow", "green", "blue", "purple"];

/// How metadata read from an XMP sidecar is merged into the `.rrdata` sidecar.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum XmpConflictPolicy {
    /// The XMP replaces rating, color label and user tags when it is newer than the `.rrdata`.
    NewestWins,
    /// The XMP always replaces rating, color label and user tags.
    XmpWins,
    /// Only fill a missing rating / color label and add missing tags.
    /// Also used for unknown values so a bad entry doesn't fail the whole settings file
    /// (`#[serde(other)]` must be on the last variant).
    #[default]
    #[serde(other)]
    FillEmpty,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct XmpData {
    /// `None` when absent or rejected (negative rating).
    pub rating: Option<u8>,
    /// A RapidRaw color label name (red, yellow, green, blue, purple).
    pub color: Option<String>,
    /// Flat tag names, without any `user:` prefix.
    pub tags: Vec<String>,
}

fn parse_rating(value: &str) -> Option<u8> {
    let rating = value.trim().parse::<f32>().ok()?.round();
    if rating < 0.0 {
        None
    } else {
        Some(rating.min(5.0) as u8)
    }
}

fn normalize_label(value: &str) -> Option<String> {
    let label = value.trim().to_lowercase();
    RAPIDRAW_COLORS.contains(&label.as_str()).then_some(label)
}

fn digikam_color_label(value: &str) -> Option<String> {
    // digiKam: 0 none, 1 red, 2 orange, 3 yellow, 4 green, 5 blue, 6 magenta, 7 gray, 8 black, 9 white
    let color = match value.trim() {
        "1" => "red",
        "3" => "yellow",
        "4" => "green",
        "5" => "blue",
        "6" => "purple",
        _ => return None,
    };
    Some(color.to_string())
}

fn darktable_color_label(value: &str) -> Option<String> {
    let index = value.trim().parse::<usize>().ok()?;
    RAPIDRAW_COLORS.get(index).map(|c| c.to_string())
}

fn leaf_tag(value: &str, separator: char) -> String {
    value
        .rsplit(separator)
        .next()
        .unwrap_or(value)
        .trim()
        .to_string()
}

fn qualified_name(e: &BytesStart) -> String {
    String::from_utf8_lossy(e.name().as_ref()).into_owned()
}

#[derive(Default)]
struct RawXmp {
    rating: Option<String>,
    label: Option<String>,
    digikam_color: Option<String>,
    darktable_colors: Vec<String>,
    subject: Vec<String>,
    digikam_tags: Vec<String>,
    lr_tags: Vec<String>,
}

impl RawXmp {
    fn set_property(&mut self, name: &str, value: String) {
        match name {
            "xmp:Rating" => self.rating = Some(value),
            "xmp:Label" => self.label = Some(value),
            "digiKam:ColorLabel" => self.digikam_color = Some(value),
            _ => {}
        }
    }

    fn push_list_item(&mut self, property: &str, value: String) {
        match property {
            "dc:subject" => self.subject.push(value),
            "digiKam:TagsList" => self.digikam_tags.push(value),
            "lr:hierarchicalSubject" => self.lr_tags.push(value),
            "darktable:colorlabels" => self.darktable_colors.push(value),
            _ => {}
        }
    }

    fn read_attributes(&mut self, e: &BytesStart) {
        for attr in e.attributes().flatten() {
            let key = String::from_utf8_lossy(attr.key.as_ref()).into_owned();
            if let Ok(value) = attr.normalized_value(XmlVersion::Implicit1_0) {
                self.set_property(&key, value.into_owned());
            }
        }
    }
}

pub fn parse_xmp(content: &str) -> XmpData {
    let mut reader = Reader::from_str(content);
    let mut raw = RawXmp::default();
    let mut stack: Vec<String> = Vec::new();
    // Raw (still escaped) text of the innermost element; entity references arrive as
    // separate events, so they are re-assembled here and unescaped once at the end tag.
    let mut text = String::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                raw.read_attributes(&e);
                stack.push(qualified_name(&e));
                text.clear();
            }
            Ok(Event::Empty(e)) => raw.read_attributes(&e),
            Ok(Event::Text(e)) => {
                if let Ok(t) = e.decode() {
                    text.push_str(&t);
                }
            }
            Ok(Event::CData(e)) => {
                if let Ok(t) = e.decode() {
                    text.push_str(&quick_xml::escape::escape(t));
                }
            }
            Ok(Event::GeneralRef(e)) => {
                if let Ok(name) = e.decode() {
                    text.push('&');
                    text.push_str(&name);
                    text.push(';');
                }
            }
            Ok(Event::End(_)) => {
                let value = quick_xml::escape::unescape(&text)
                    .map(|v| v.trim().to_string())
                    .unwrap_or_default();
                text.clear();
                let Some(name) = stack.pop() else { continue };
                if value.is_empty() {
                    continue;
                }
                if name == "rdf:li" {
                    // property > rdf:Bag|rdf:Seq > rdf:li
                    if stack.len() >= 2 {
                        let property = stack[stack.len() - 2].clone();
                        raw.push_list_item(&property, value);
                    }
                } else {
                    raw.set_property(&name, value);
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                log::warn!("Failed to parse XMP sidecar: {}", e);
                break;
            }
            _ => {}
        }
    }

    let color = raw
        .label
        .as_deref()
        .and_then(normalize_label)
        .or_else(|| raw.digikam_color.as_deref().and_then(digikam_color_label))
        .or_else(|| {
            raw.darktable_colors
                .iter()
                .find_map(|c| darktable_color_label(c))
        });

    let candidates: Vec<String> = if !raw.subject.is_empty() {
        raw.subject
    } else if !raw.digikam_tags.is_empty() {
        raw.digikam_tags.iter().map(|t| leaf_tag(t, '/')).collect()
    } else {
        raw.lr_tags.iter().map(|t| leaf_tag(t, '|')).collect()
    };

    let mut tags: Vec<String> = Vec::new();
    for tag in candidates {
        let tag = tag
            .strip_prefix(USER_TAG_PREFIX)
            .unwrap_or(&tag)
            .trim()
            .to_string();
        if !tag.is_empty() && !tags.contains(&tag) {
            tags.push(tag);
        }
    }

    XmpData {
        rating: raw.rating.as_deref().and_then(parse_rating),
        color,
        tags,
    }
}

fn existing_file(candidates: [PathBuf; 2]) -> Option<PathBuf> {
    candidates.into_iter().find(|p| p.exists())
}

/// Finds the XMP sidecar of an image. The `IMG.CR2.xmp` scheme used by digiKam and
/// darktable takes precedence over the `IMG.xmp` scheme used by Lightroom and RapidRaw.
pub fn resolve_xmp_path(image_path: &Path) -> Option<PathBuf> {
    if let Some(file_name) = image_path.file_name() {
        let file_name = file_name.to_string_lossy();
        let found = existing_file([
            image_path.with_file_name(format!("{}.xmp", file_name)),
            image_path.with_file_name(format!("{}.XMP", file_name)),
        ]);
        if found.is_some() {
            return found;
        }
    }
    existing_file([
        image_path.with_extension("xmp"),
        image_path.with_extension("XMP"),
    ])
}

fn set_rating(metadata: &mut ImageMetadata, rating: u8) {
    metadata.rating = rating;
    if let Some(obj) = metadata.adjustments.as_object_mut() {
        obj.insert("rating".to_string(), serde_json::json!(rating));
    } else {
        metadata.adjustments = serde_json::json!({ "rating": rating });
    }
}

fn has_tag(tags: &[String], tag: &str) -> bool {
    tags.iter()
        .any(|t| t == tag || t.strip_prefix(USER_TAG_PREFIX) == Some(tag))
}

/// Merges `xmp` into `metadata`. With `replace`, the XMP is authoritative for the rating,
/// the color label and user tags; AI tags are never removed. Returns whether anything changed.
pub fn apply_xmp_data(metadata: &mut ImageMetadata, xmp: &XmpData, replace: bool) -> bool {
    let mut changed = false;

    if let Some(rating) = xmp.rating
        && metadata.rating != rating
        && (replace || metadata.rating == 0)
    {
        set_rating(metadata, rating);
        changed = true;
    }

    let original = metadata.tags.clone().unwrap_or_default();
    let mut tags = original.clone();

    let current_color = tags
        .iter()
        .find_map(|t| t.strip_prefix(COLOR_TAG_PREFIX))
        .map(str::to_string);
    if replace && current_color != xmp.color {
        tags.retain(|t| !t.starts_with(COLOR_TAG_PREFIX));
        if let Some(color) = &xmp.color {
            tags.push(format!("{}{}", COLOR_TAG_PREFIX, color));
        }
    } else if current_color.is_none()
        && let Some(color) = &xmp.color
    {
        tags.push(format!("{}{}", COLOR_TAG_PREFIX, color));
    }

    if replace {
        tags.retain(|t| match t.strip_prefix(USER_TAG_PREFIX) {
            Some(user_tag) => xmp.tags.iter().any(|x| x == user_tag),
            None => true,
        });
    }
    for tag in &xmp.tags {
        if !has_tag(&tags, tag) {
            tags.push(format!("{}{}", USER_TAG_PREFIX, tag));
        }
    }

    if tags != original {
        metadata.tags = if tags.is_empty() { None } else { Some(tags) };
        changed = true;
    }

    changed
}

fn is_newer(xmp_file: &Path, sidecar_path: &Path) -> bool {
    let modified = |p: &Path| fs::metadata(p).and_then(|m| m.modified()).ok();
    match (modified(xmp_file), modified(sidecar_path)) {
        (Some(xmp), Some(sidecar)) => xmp > sidecar,
        (_, None) => true,
        (None, Some(_)) => false,
    }
}

/// Reads the image's XMP sidecar (if any) into `metadata` according to `policy`.
/// Returns whether `metadata` changed and needs to be written back to `sidecar_path`.
pub fn sync_metadata_from_xmp(
    source_path: &Path,
    sidecar_path: &Path,
    metadata: &mut ImageMetadata,
    policy: XmpConflictPolicy,
) -> bool {
    let Some(xmp_file) = resolve_xmp_path(source_path) else {
        return false;
    };
    let replace = match policy {
        XmpConflictPolicy::FillEmpty => false,
        XmpConflictPolicy::XmpWins => true,
        XmpConflictPolicy::NewestWins => {
            if !is_newer(&xmp_file, sidecar_path) {
                return false;
            }
            true
        }
    };
    let Ok(content) = fs::read_to_string(&xmp_file) else {
        return false;
    };
    apply_xmp_data(metadata, &parse_xmp(&content), replace)
}

/// Writes rating, color label and tags to the `IMG.xmp` sidecar. Sidecars named
/// `IMG.CR2.xmp` (digiKam, darktable) are never written.
pub fn sync_metadata_to_xmp(source_path: &Path, metadata: &ImageMetadata, create_if_missing: bool) {
    let xmp_path = source_path.with_extension("xmp");
    let xmp_path_upper = source_path.with_extension("XMP");

    let mut actual_xmp = if xmp_path.exists() {
        Some(xmp_path.clone())
    } else if xmp_path_upper.exists() {
        Some(xmp_path_upper.clone())
    } else {
        None
    };

    if actual_xmp.is_none() {
        if !create_if_missing {
            return;
        }
        let skeleton = r#"<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="RapidRAW">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:dc="http://purl.org/dc/elements/1.1/">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>"#;
        if let Err(e) = fs::write(&xmp_path, skeleton) {
            log::error!("Failed to create skeleton XMP: {}", e);
            return;
        }
        actual_xmp = Some(xmp_path);
    }

    if let Some(xmp_file) = actual_xmp
        && let Ok(mut content) = fs::read_to_string(&xmp_file)
    {
        let rating_str = metadata.rating.to_string();
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
        let mut label = None;
        let mut normal_tags = Vec::new();

        for t in current_tags {
            if let Some(color) = t.strip_prefix(COLOR_TAG_PREFIX) {
                let mut c = color.chars();
                let cap_color = match c.next() {
                    None => String::new(),
                    Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                };
                label = Some(cap_color);
            } else {
                let tag = t.strip_prefix(USER_TAG_PREFIX).unwrap_or(&t).to_string();
                if !normal_tags.contains(&tag) {
                    normal_tags.push(tag);
                }
            }
        }

        if let Some(lbl) = label {
            let re_label_attr = regex!(r#"xmp:Label\s*=\s*"[^"]*""#);
            let re_label_tag = regex!(r#"<xmp:Label\s*>[^<]*</xmp:Label>"#);

            if re_label_attr.is_match(&content) {
                content = re_label_attr
                    .replace(&content, format!("xmp:Label=\"{}\"", lbl))
                    .to_string();
            } else if re_label_tag.is_match(&content) {
                content = re_label_tag
                    .replace(&content, format!("<xmp:Label>{}</xmp:Label>", lbl))
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
            let mut bag = String::from("<dc:subject>\n    <rdf:Bag>\n");
            for t in normal_tags {
                bag.push_str(&format!(
                    "     <rdf:li>{}</rdf:li>\n",
                    quick_xml::escape::escape(t.as_str())
                ));
            }
            bag.push_str("    </rdf:Bag>\n   </dc:subject>");

            if re_subject.is_match(&content) {
                content = re_subject
                    .replace(&content, regex::NoExpand(&bag))
                    .to_string();
            } else if let Some(last_index) = content.rfind("</rdf:Description>") {
                let (start, end) = content.split_at(last_index);
                content = format!("{} {}\n  {}", start, bag, end);
            }
        }

        let _ = fs::write(&xmp_file, content);
    }
}
