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
    xmlns:dc="http://purl.org/dc/elements/1.1/">
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

        let _ = write_file_atomic(&xmp_file, content.as_bytes());
    }
}
