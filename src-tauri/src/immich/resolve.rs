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
    pub not_in_album: bool,
    pub taken_from: Option<String>,
    pub taken_until: Option<String>,
}

impl Filter {
    fn to_query(&self) -> Value {
        let mut query = json!({ "type": "IMAGE" });
        if let Some(album) = &self.album_id {
            query["albumIds"] = json!([album]);
        }
        if self.not_in_album {
            query["isNotInAlbum"] = json!(true);
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

    fn companions<'a>(&'a self, asset: &'a Asset) -> impl Iterator<Item = &'a Asset> {
        self.by_asset
            .get(&asset.id)
            .map(|&i| self.stacks[i].assets.as_slice())
            .unwrap_or_default()
            .iter()
            .filter(move |a| a.id != asset.id && !a.is_trashed)
    }

    fn source<'a>(&'a self, listed: &'a Asset, cache_dir: &Path) -> &'a Asset {
        if is_raw(listed) {
            return listed;
        }
        if let Some(raw) = self
            .companions(listed)
            .filter(|a| is_raw(a))
            .max_by_key(|raw| cache_path(raw, cache_dir).exists())
        {
            return raw;
        }
        let taken = instant(&listed.file_created_at);
        let uploaded = instant(&listed.created_at);
        self.companions(listed)
            .filter(|a| {
                taken.is_some()
                    && instant(&a.file_created_at) == taken
                    && instant(&a.created_at) < uploaded
            })
            .min_by_key(|a| instant(&a.created_at))
            .unwrap_or(listed)
    }
}

fn instant(time: &Option<String>) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    chrono::DateTime::parse_from_rfc3339(time.as_deref()?).ok()
}

fn is_raw(asset: &Asset) -> bool {
    crate::formats::is_raw_file(&asset.original_file_name)
}

fn month(day: Option<&str>) -> Option<&str> {
    day.map(str::trim).and_then(|day| day.get(..7))
}

/// The stacks that contain any of the listed assets, without asking Immich
/// for every stack of the library (`GET /stacks` is huge on big libraries).
///
/// The timeline with collapsed stacks gives, for the album or the months of
/// the filter, which assets are unstacked and the stack id of every primary
/// asset. Only those stacks are fetched. Listed assets the timeline did not
/// show and that are not in one of those stacks (non-primary assets whose
/// primary is not listed, assets near a month border) are looked up one by
/// one.
async fn stacks_for(
    client: &ImmichClient,
    filter: &Filter,
    assets: &[Asset],
) -> Result<Vec<Stack>, String> {
    let timeline = client
        .timeline_stacks(
            filter.album_id.as_deref(),
            month(filter.taken_from.as_deref()),
            month(filter.taken_until.as_deref()),
        )
        .await
        .unwrap_or_else(|e| {
            log::warn!("Immich timeline unavailable, looking up stacks per asset: {e}");
            HashMap::new()
        });

    let mut stack_ids: Vec<String> = assets
        .iter()
        .filter_map(|a| timeline.get(&a.id).cloned().flatten())
        .collect();
    stack_ids.sort();
    stack_ids.dedup();
    let mut stacks = client.stacks_by_id(stack_ids.iter().cloned()).await?;

    let known: HashSet<&str> = timeline
        .keys()
        .map(String::as_str)
        .chain(
            stacks
                .iter()
                .flat_map(|s| s.assets.iter().map(|a| a.id.as_str())),
        )
        .collect();
    let unknown: Vec<String> = assets
        .iter()
        .filter(|a| !known.contains(a.id.as_str()))
        .map(|a| a.id.clone())
        .collect();
    if !unknown.is_empty() {
        let more: Vec<String> = client
            .stack_ids_of(&unknown)
            .await?
            .into_iter()
            .filter(|id| !stack_ids.contains(id))
            .collect();
        stacks.extend(client.stacks_by_id(more).await?);
    }
    Ok(stacks)
}

async fn listed_assets(client: &ImmichClient, filter: &Filter) -> Result<Vec<Asset>, String> {
    let mut query = filter.to_query();
    query["order"] = json!("desc");
    Ok(client
        .search(query)
        .await?
        .into_iter()
        .filter(|asset| asset.kind == "IMAGE" && !registry::is_trashing(&asset.id))
        .collect())
}

pub async fn listing(
    client: &ImmichClient,
    filter: &Filter,
    cache_dir: &Path,
) -> Result<Vec<Resolved>, String> {
    let assets = listed_assets(client, filter).await?;
    let stacks = StackIndex::new(stacks_for(client, filter, &assets).await?);
    Ok(resolve(assets, &stacks, filter, cache_dir))
}

fn resolve(
    assets: Vec<Asset>,
    stacks: &StackIndex,
    filter: &Filter,
    cache_dir: &Path,
) -> Vec<Resolved> {
    let assets = if filter.not_in_album {
        without_sorted_stacks(assets, stacks)
    } else {
        assets
    };

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
    resolved
}

fn without_sorted_stacks(assets: Vec<Asset>, stacks: &StackIndex) -> Vec<Asset> {
    let unsorted: HashSet<&str> = assets.iter().map(|a| a.id.as_str()).collect();
    let sorted: HashSet<String> = assets
        .iter()
        .filter(|a| {
            stacks
                .companions(a)
                .any(|c| !unsorted.contains(c.id.as_str()))
        })
        .map(|a| a.id.clone())
        .collect();
    assets
        .into_iter()
        .filter(|a| !sorted.contains(&a.id))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn summary(resolved: &[Resolved]) -> Vec<(String, String, String)> {
        let mut rows: Vec<_> = resolved
            .iter()
            .map(|r| {
                (
                    r.image.listed_asset_id.clone(),
                    r.image.asset_id.clone(),
                    r.path.to_string_lossy().into_owned(),
                )
            })
            .collect();
        rows.sort();
        rows
    }

    fn uuid(n: u8) -> String {
        format!("00000000-0000-0000-0000-{n:012}")
    }

    fn asset(n: u8, name: &str) -> Asset {
        serde_json::from_value(json!({
            "id": uuid(n),
            "type": "IMAGE",
            "originalFileName": name,
        }))
        .unwrap()
    }

    fn stack(primary: &Asset, assets: &[&Asset]) -> Stack {
        serde_json::from_value(json!({
            "primaryAssetId": primary.id,
            "assets": assets.iter().map(|a| json!({
                "id": a.id,
                "type": "IMAGE",
                "originalFileName": a.original_file_name,
            })).collect::<Vec<_>>(),
        }))
        .unwrap()
    }

    fn listed_and_source(resolved: &[Resolved]) -> Vec<(String, String)> {
        resolved
            .iter()
            .map(|r| (r.image.listed_asset_id.clone(), r.image.asset_id.clone()))
            .collect()
    }

    #[test]
    fn unrelated_stacks_do_not_change_the_listing() {
        let cache_dir = std::env::temp_dir().join("rapidraw-immich-resolve-unit");
        let raw = asset(1, "a.CR3");
        let jpg = asset(2, "a.jpg");
        let single = asset(3, "b.jpg");
        let other_raw = asset(4, "c.CR3");
        let other_jpg = asset(5, "c.jpg");
        let listed = vec![jpg.clone(), raw.clone(), single.clone()];
        let needed = stack(&jpg, &[&jpg, &raw]);
        let unrelated = stack(&other_jpg, &[&other_jpg, &other_raw]);

        for filter in [
            Filter::default(),
            Filter {
                not_in_album: true,
                ..Default::default()
            },
        ] {
            let only_needed = resolve(
                listed.clone(),
                &StackIndex::new(vec![needed.clone()]),
                &filter,
                &cache_dir,
            );
            let all = resolve(
                listed.clone(),
                &StackIndex::new(vec![needed.clone(), unrelated.clone()]),
                &filter,
                &cache_dir,
            );
            assert_eq!(summary(&only_needed), summary(&all));
            assert_eq!(
                listed_and_source(&only_needed),
                vec![(uuid(2), uuid(1)), (uuid(3), uuid(3))]
            );
        }
    }

    #[test]
    fn not_in_album_drops_stacks_partly_in_an_album() {
        let cache_dir = std::env::temp_dir().join("rapidraw-immich-resolve-unit");
        let raw = asset(1, "a.CR3");
        let jpg = asset(2, "a.jpg");
        let single = asset(3, "b.jpg");
        let stacks = StackIndex::new(vec![stack(&jpg, &[&jpg, &raw])]);
        let filter = Filter {
            not_in_album: true,
            ..Default::default()
        };
        let resolved = resolve(vec![raw, single], &stacks, &filter, &cache_dir);
        assert_eq!(listed_and_source(&resolved), vec![(uuid(3), uuid(3))]);
    }

    #[test]
    fn month_of_a_day() {
        assert_eq!(month(Some(" 2019-11-30 ")), Some("2019-11"));
        assert_eq!(month(Some("2019")), None);
        assert_eq!(month(None), None);
    }

    /// Same listing as with the full `GET /stacks`, for an album
    /// (IMMICH_TEST_ALBUM), a month (IMMICH_TEST_MONTH, "YYYY-MM", also with
    /// only the images that are in no album) and/or every image in no album
    /// (IMMICH_TEST_UNASSIGNED=1).
    #[test]
    #[ignore = "needs IMMICH_TEST_URL and IMMICH_API_KEY"]
    fn live_listing_matches_full_stack_list() {
        let url = std::env::var("IMMICH_TEST_URL").expect("IMMICH_TEST_URL");
        let key = std::env::var("IMMICH_API_KEY").expect("IMMICH_API_KEY");
        let client = ImmichClient::new(&url, &key).unwrap();
        let cache_dir = std::env::temp_dir().join("rapidraw-immich-resolve-test");

        let mut filters = Vec::new();
        if let Ok(album) = std::env::var("IMMICH_TEST_ALBUM") {
            filters.push(Filter {
                album_id: Some(album),
                ..Default::default()
            });
        }
        if let Ok(month) = std::env::var("IMMICH_TEST_MONTH") {
            let first =
                chrono::NaiveDate::parse_from_str(&format!("{month}-01"), "%Y-%m-%d").unwrap();
            let last = first
                .checked_add_months(chrono::Months::new(1))
                .unwrap()
                .pred_opt()
                .unwrap();
            let month = Filter {
                taken_from: Some(first.to_string()),
                taken_until: Some(last.to_string()),
                ..Default::default()
            };
            filters.push(Filter {
                not_in_album: true,
                ..month.clone()
            });
            filters.push(month);
        }
        if std::env::var("IMMICH_TEST_UNASSIGNED").is_ok_and(|v| v == "1") {
            filters.push(Filter {
                not_in_album: true,
                ..Default::default()
            });
        }
        assert!(
            !filters.is_empty(),
            "set IMMICH_TEST_ALBUM, IMMICH_TEST_MONTH and/or IMMICH_TEST_UNASSIGNED"
        );

        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let started = Instant::now();
            let all = StackIndex::new(client.all_stacks().await.unwrap());
            println!(
                "full GET /stacks: {} stacks in {:?}",
                all.stacks.len(),
                started.elapsed()
            );
            for filter in &filters {
                let assets = listed_assets(&client, filter).await.unwrap();
                let started = Instant::now();
                let stacks = stacks_for(&client, filter, &assets).await.unwrap();
                let took = started.elapsed();
                let count = stacks.len();
                let new = resolve(assets.clone(), &StackIndex::new(stacks), filter, &cache_dir);
                let old = resolve(assets.clone(), &all, filter, &cache_dir);
                println!(
                    "{filter:?}: {} assets, {} listed, {count} stacks fetched in {took:?}",
                    assets.len(),
                    new.len()
                );
                assert_eq!(summary(&new), summary(&old));
            }
        });
    }
}
