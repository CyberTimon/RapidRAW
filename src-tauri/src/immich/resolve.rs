use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::client::{Asset, ImmichClient};
use super::registry::RemoteImage;

#[derive(Debug, Clone)]
pub struct Resolved {
    pub path: PathBuf,
    pub image: RemoteImage,
    pub file_modified_at: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Filter {
    pub album_id: Option<String>,
    pub taken_from: Option<String>,
    pub taken_until: Option<String>,
}

impl Filter {
    fn to_query(&self) -> Value {
        let mut query = json!({ "type": "IMAGE" });
        if let Some(album) = &self.album_id {
            query["albumIds"] = json!([album]);
        }
        if let Some(from) = day_start(self.taken_from.as_deref(), 0) {
            query["takenAfter"] = json!(from);
        }
        if let Some(until) = day_start(self.taken_until.as_deref(), 1) {
            query["takenBefore"] = json!(until);
        }
        query
    }
}

fn day_start(day: Option<&str>, offset: i64) -> Option<String> {
    let date = chrono::NaiveDate::parse_from_str(day?.trim(), "%Y-%m-%d").ok()?;
    let date = date.checked_add_signed(chrono::Duration::days(offset))?;
    Some(format!("{}T00:00:00.000Z", date.format("%Y-%m-%d")))
}

fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim_start_matches('.');
    if trimmed.is_empty() {
        "image".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn cache_path(asset: &Asset, cache_dir: &Path) -> PathBuf {
    cache_dir
        .join(&asset.id)
        .join(safe_file_name(&asset.original_file_name))
}

pub async fn listing(
    client: &ImmichClient,
    filter: &Filter,
    cache_dir: &Path,
) -> Result<Vec<Resolved>, String> {
    let mut query = filter.to_query();
    query["order"] = json!("desc");
    let mut seen = HashSet::new();
    Ok(client
        .search(query)
        .await?
        .into_iter()
        .filter(|asset| asset.kind == "IMAGE")
        .filter_map(|asset| {
            let path = cache_path(&asset, cache_dir);
            if !crate::formats::is_supported_image_file(&path) || !seen.insert(path.clone()) {
                return None;
            }
            Some(Resolved {
                path,
                file_modified_at: asset.file_modified_at,
                image: RemoteImage { asset_id: asset.id },
            })
        })
        .collect())
}
