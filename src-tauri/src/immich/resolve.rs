use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use super::client::{Asset, ImmichClient, Stack};
use super::registry::{self, RemoteImage};

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

struct StackIndex {
    stacks: Vec<Stack>,
    by_asset: HashMap<String, usize>,
}

impl StackIndex {
    fn new(stacks: Vec<Stack>) -> Self {
        let by_asset = stacks
            .iter()
            .enumerate()
            .flat_map(|(i, s)| s.assets.iter().map(move |a| (a.id.clone(), i)))
            .collect();
        Self { stacks, by_asset }
    }

    fn primary_of(&self, asset: &Asset) -> Option<&str> {
        let stack = &self.stacks[*self.by_asset.get(&asset.id)?];
        (stack.primary_asset_id != asset.id).then_some(stack.primary_asset_id.as_str())
    }

    fn source<'a>(&'a self, listed: &'a Asset, cache_dir: &Path) -> &'a Asset {
        if is_raw(listed) {
            return listed;
        }
        self.by_asset
            .get(&listed.id)
            .map(|&i| self.stacks[i].assets.as_slice())
            .unwrap_or_default()
            .iter()
            .filter(|a| a.id != listed.id && !a.is_trashed && is_raw(a))
            .max_by_key(|raw| cache_path(raw, cache_dir).exists())
            .unwrap_or(listed)
    }
}

fn is_raw(asset: &Asset) -> bool {
    crate::formats::is_raw_file(&asset.original_file_name)
}

pub async fn listing(
    client: &ImmichClient,
    filter: &Filter,
    cache_dir: &Path,
) -> Result<Vec<Resolved>, String> {
    let mut query = filter.to_query();
    query["order"] = json!("desc");
    let assets: Vec<Asset> = client
        .search(query)
        .await?
        .into_iter()
        .filter(|asset| asset.kind == "IMAGE" && !registry::is_trashing(&asset.id))
        .collect();
    let stacks = StackIndex::new(client.stacks().await?);

    let listed_ids: HashSet<&str> = assets.iter().map(|a| a.id.as_str()).collect();
    let mut seen = HashSet::new();
    let mut resolved = Vec::with_capacity(assets.len());
    for listed in &assets {
        if stacks
            .primary_of(listed)
            .is_some_and(|primary| listed_ids.contains(primary))
        {
            continue;
        }
        let source = stacks.source(listed, cache_dir);
        let path = cache_path(source, cache_dir);
        if !crate::formats::is_supported_image_file(&path) || !seen.insert(path.clone()) {
            continue;
        }
        resolved.push(Resolved {
            path,
            file_modified_at: source.file_modified_at.clone(),
            image: RemoteImage {
                asset_id: source.id.clone(),
                listed_asset_id: listed.id.clone(),
                album_id: filter.album_id.clone(),
            },
        });
    }
    Ok(resolved)
}
