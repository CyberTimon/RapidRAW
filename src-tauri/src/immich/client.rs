use reqwest::multipart::{Form, Part};
use reqwest::{Client, Method, RequestBuilder, Response};
use serde::de::{DeserializeOwned, Deserializer, Error as _};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

fn with_cause(error: &dyn std::error::Error) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        text.push_str(&format!(": {cause}"));
        source = cause.source();
    }
    text
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    #[serde(deserialize_with = "asset_id")]
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub original_file_name: String,
    #[serde(default)]
    pub file_modified_at: Option<String>,
    #[serde(default)]
    pub file_created_at: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub is_trashed: bool,
    #[serde(default)]
    pub owner_id: String,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Album {
    pub id: String,
    pub album_name: String,
    #[serde(default)]
    pub asset_count: u64,
    #[serde(default)]
    pub album_thumbnail_asset_id: Option<String>,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub end_date: Option<String>,
    #[serde(default)]
    pub shared: bool,
}

#[derive(Deserialize, Debug, Clone)]
pub struct User {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub email: String,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TimelineMonth {
    pub time_bucket: String,
    pub count: u64,
}

#[derive(Deserialize, Debug, Clone)]
pub struct UploadResult {
    #[serde(deserialize_with = "asset_id")]
    pub id: String,
    #[serde(default)]
    pub status: String,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Stack {
    pub primary_asset_id: String,
    pub assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct StackRef {
    id: String,
}

#[derive(Deserialize)]
struct AssetStack {
    #[serde(default)]
    stack: Option<StackRef>,
}

/// Column-oriented answer of `GET /timeline/bucket`: `stack[i]` is
/// `[stackId, assetCount]` when `id[i]` is the primary asset of a stack.
#[derive(Deserialize)]
struct TimelineBucket {
    id: Vec<String>,
    #[serde(default)]
    stack: Vec<Option<Vec<Value>>>,
}

impl TimelineBucket {
    /// Every asset of the bucket with the id of its stack, if any.
    fn stack_ids(self) -> impl Iterator<Item = (String, Option<String>)> {
        let stack = self.stack;
        self.id.into_iter().enumerate().map(move |(i, id)| {
            let stack_id = stack
                .get(i)
                .and_then(|s| s.as_ref())
                .and_then(|s| s.first())
                .and_then(|s| s.as_str())
                .map(str::to_string);
            (id, stack_id)
        })
    }
}

/// Whether a time bucket ("YYYY-MM-DD...") falls within the months `from`..=`until`
/// ("YYYY-MM", both optional).
fn in_months(bucket: &str, from: Option<&str>, until: Option<&str>) -> bool {
    let month = bucket.get(..7).unwrap_or(bucket);
    from.is_none_or(|from| month >= from) && until.is_none_or(|until| month <= until)
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MetadataEntry {
    pub key: String,
    pub value: Value,
    pub updated_at: String,
}

#[derive(Deserialize)]
struct Version {
    major: u32,
    minor: u32,
    patch: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchPage {
    items: Vec<Asset>,
    next_page: Option<String>,
}

#[derive(Deserialize)]
struct SearchResponse {
    assets: SearchPage,
}

pub fn is_asset_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok()
}

fn asset_id<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let id = String::deserialize(deserializer)?;
    if is_asset_id(&id) {
        Ok(id)
    } else {
        Err(D::Error::custom(format!("invalid asset id '{id}'")))
    }
}

const PAGE_SIZE: u32 = 1000;
const PARALLEL_PAGES: u32 = 4;
const PARALLEL_REQUESTS: usize = 16;

/// Runs the requests with at most `limit` of them in flight (answers come
/// back in any order).
async fn bounded<T, F>(requests: Vec<F>, limit: usize) -> Result<Vec<T>, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    use futures::{StreamExt, TryStreamExt};
    futures::stream::iter(requests)
        .buffer_unordered(limit)
        .try_collect()
        .await
}

pub struct ImmichClient {
    base: String,
    api_key: String,
    http: Client,
}

impl ImmichClient {
    pub fn new(server_url: &str, api_key: &str) -> Result<Self, String> {
        let base = server_url.trim().trim_end_matches('/').to_string();
        if !base.starts_with("http://") && !base.starts_with("https://") {
            return Err("The server address must start with http:// or https://".to_string());
        }
        let http = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            base,
            api_key: api_key.trim().to_string(),
            http,
        })
    }

    fn request(&self, method: Method, path: &str) -> RequestBuilder {
        self.http
            .request(method, format!("{}/api{}", self.base, path))
            .header("x-api-key", &self.api_key)
            .header("Accept", "application/json")
    }

    async fn send(&self, builder: RequestBuilder, what: &str) -> Result<Response, String> {
        let response = builder
            .send()
            .await
            .map_err(|e| format!("Immich is not reachable ({what}): {}", with_cause(&e)))?;
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let detail = response.text().await.unwrap_or_default();
        let detail: String = detail.chars().take(300).collect();
        Err(format!(
            "Immich rejected {what} (HTTP {}): {detail}",
            status.as_u16()
        ))
    }

    async fn json<T: DeserializeOwned>(
        &self,
        builder: RequestBuilder,
        what: &str,
    ) -> Result<T, String> {
        self.send(builder, what)
            .await?
            .json::<T>()
            .await
            .map_err(|e| format!("Unexpected answer from Immich ({what}): {e}"))
    }

    pub async fn version_numbers(&self) -> Result<(u32, u32, u32), String> {
        let v: Version = self
            .json(
                self.request(Method::GET, "/server/version"),
                "server version",
            )
            .await?;
        Ok((v.major, v.minor, v.patch))
    }

    pub async fn me(&self) -> Result<User, String> {
        self.json(self.request(Method::GET, "/users/me"), "user")
            .await
    }

    pub async fn owns(&self, asset_id: &str) -> Result<bool, String> {
        let asset: Asset = self
            .json(
                self.request(Method::GET, &format!("/assets/{asset_id}")),
                "asset",
            )
            .await?;
        Ok(asset.owner_id == self.me().await?.id)
    }

    pub async fn albums(&self) -> Result<Vec<Album>, String> {
        self.json(self.request(Method::GET, "/albums"), "albums")
            .await
    }

    pub async fn create_album(&self, name: &str) -> Result<Album, String> {
        self.json(
            self.request(Method::POST, "/albums")
                .json(&json!({ "albumName": name })),
            "albums",
        )
        .await
    }

    pub async fn search(&self, query: Value) -> Result<Vec<Asset>, String> {
        let (mut found, mut more) = self.search_page(&query, 1).await?;
        let mut next = 2;
        while more {
            let pages = futures::future::try_join_all(
                (next..next + PARALLEL_PAGES).map(|page| self.search_page(&query, page)),
            )
            .await?;
            for (items, has_next) in pages {
                found.extend(items);
                more = has_next;
                if !more {
                    break;
                }
            }
            next += PARALLEL_PAGES;
        }
        Ok(found)
    }

    async fn search_page(&self, query: &Value, page: u32) -> Result<(Vec<Asset>, bool), String> {
        let mut body = query.clone();
        body["page"] = json!(page);
        body["size"] = json!(PAGE_SIZE);
        let result: SearchResponse = self
            .json(
                self.request(Method::POST, "/search/metadata").json(&body),
                "search",
            )
            .await?;
        Ok((result.assets.items, result.assets.next_page.is_some()))
    }

    /// Every stack of the library with all its assets. Only for tests: on a
    /// big library this is a huge answer (35k stacks = 116 MB), so the app
    /// asks for single stacks instead.
    #[cfg(test)]
    pub async fn all_stacks(&self) -> Result<Vec<Stack>, String> {
        self.json(self.request(Method::GET, "/stacks"), "stacks")
            .await
    }

    pub async fn stack(&self, stack_id: &str) -> Result<Stack, String> {
        self.json(
            self.request(Method::GET, &format!("/stacks/{stack_id}")),
            "stack",
        )
        .await
    }

    /// Fetches the given stacks, a few at a time.
    pub async fn stacks_by_id<I>(&self, stack_ids: I) -> Result<Vec<Stack>, String>
    where
        I: IntoIterator<Item = String>,
    {
        let stack_ids: Vec<String> = stack_ids.into_iter().collect();
        bounded(
            stack_ids.iter().map(|id| self.stack(id)).collect(),
            PARALLEL_REQUESTS,
        )
        .await
    }

    /// Id of the stack the asset belongs to, if any.
    pub async fn stack_id_of(&self, asset_id: &str) -> Result<Option<String>, String> {
        let asset: AssetStack = self
            .json(
                self.request(Method::GET, &format!("/assets/{asset_id}")),
                "asset",
            )
            .await?;
        Ok(asset.stack.map(|s| s.id))
    }

    /// Stack ids of several assets (one request per asset, a few at a time),
    /// without duplicates.
    pub async fn stack_ids_of(&self, asset_ids: &[String]) -> Result<Vec<String>, String> {
        let found = bounded(
            asset_ids.iter().map(|id| self.stack_id_of(id)).collect(),
            PARALLEL_REQUESTS,
        )
        .await?;
        let mut ids: Vec<String> = found.into_iter().flatten().collect();
        ids.sort();
        ids.dedup();
        Ok(ids)
    }

    /// The stack the asset belongs to, with all its assets.
    pub async fn stack_of(&self, asset_id: &str) -> Result<Option<Stack>, String> {
        match self.stack_id_of(asset_id).await? {
            Some(id) => self.stack(&id).await.map(Some),
            None => Ok(None),
        }
    }

    /// Stack of every asset shown in the timeline of an album (or of the whole
    /// library) with stacks collapsed, for the months `from`..=`until`
    /// ("YYYY-MM", both optional). Unstacked assets map to `None`; stacked
    /// ones appear only through their primary asset.
    pub async fn timeline_stacks(
        &self,
        album_id: Option<&str>,
        from: Option<&str>,
        until: Option<&str>,
    ) -> Result<HashMap<String, Option<String>>, String> {
        let album = album_id
            .map(|id| format!("&albumId={id}"))
            .unwrap_or_default();
        let buckets: Vec<TimelineMonth> = self
            .json(
                self.request(
                    Method::GET,
                    &format!("/timeline/buckets?withStacked=true{album}"),
                ),
                "timeline",
            )
            .await?;
        let months: Vec<String> = buckets
            .into_iter()
            .map(|b| b.time_bucket)
            .filter(|bucket| in_months(bucket, from, until))
            .collect();
        let mut stacks = HashMap::new();
        for chunk in months.chunks(PARALLEL_PAGES as usize) {
            let buckets = futures::future::try_join_all(chunk.iter().map(|bucket| {
                self.json::<TimelineBucket>(
                    self.request(
                        Method::GET,
                        &format!("/timeline/bucket?withStacked=true&timeBucket={bucket}{album}"),
                    ),
                    "timeline",
                )
            }))
            .await?;
            stacks.extend(buckets.into_iter().flat_map(TimelineBucket::stack_ids));
        }
        Ok(stacks)
    }

    pub async fn timeline_months(&self) -> Result<Vec<TimelineMonth>, String> {
        self.json(
            self.request(Method::GET, "/timeline/buckets?visibility=timeline"),
            "timeline",
        )
        .await
    }

    pub async fn metadata(
        &self,
        asset_id: &str,
        key: &str,
    ) -> Result<Option<MetadataEntry>, String> {
        let response = self
            .request(Method::GET, &format!("/assets/{asset_id}/metadata/{key}"))
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .map_err(|e| format!("Immich is not reachable (edits): {}", with_cause(&e)))?;
        let status = response.status();
        if status.is_success() {
            return response
                .json::<MetadataEntry>()
                .await
                .map(Some)
                .map_err(|e| format!("Unexpected answer from Immich (edits): {e}"));
        }
        let detail = response.text().await.unwrap_or_default();
        if status == reqwest::StatusCode::NOT_FOUND
            || (status == reqwest::StatusCode::BAD_REQUEST && detail.contains("not found"))
        {
            return Ok(None);
        }
        Err(format!(
            "Immich rejected reading edits (HTTP {})",
            status.as_u16()
        ))
    }

    pub async fn set_metadata(
        &self,
        asset_id: &str,
        key: &str,
        value: &Value,
    ) -> Result<String, String> {
        let entries: Vec<MetadataEntry> = self
            .json(
                self.request(Method::PUT, &format!("/assets/{asset_id}/metadata"))
                    .json(&json!({ "items": [{ "key": key, "value": value }] })),
                "saving edits",
            )
            .await?;
        entries
            .into_iter()
            .find(|e| e.key == key)
            .map(|e| e.updated_at)
            .ok_or_else(|| "Immich did not confirm the saved edits".to_string())
    }

    pub async fn download_original(&self, asset_id: &str, target: &Path) -> Result<(), String> {
        let mut response = self
            .send(
                self.request(Method::GET, &format!("/assets/{asset_id}/original")),
                "original download",
            )
            .await?;
        let mut file = tokio::fs::File::create(target)
            .await
            .map_err(|e| format!("Cannot write '{}': {e}", target.display()))?;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("Download interrupted: {e}"))?
        {
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        }
        file.flush().await.map_err(|e| e.to_string())
    }

    pub async fn upload(
        &self,
        path: &Path,
        created_at: &str,
        modified_at: &str,
    ) -> Result<UploadResult, String> {
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "export.jpg".to_string());
        let bytes = tokio::fs::read(path)
            .await
            .map_err(|e| format!("Cannot read '{}': {e}", path.display()))?;
        let part = Part::bytes(bytes)
            .file_name(file_name.clone())
            .mime_str(mime_for(&file_name))
            .map_err(|e| e.to_string())?;
        let form = Form::new()
            .text("fileCreatedAt", created_at.to_string())
            .text("fileModifiedAt", modified_at.to_string())
            .text("filename", file_name)
            .part("assetData", part);
        self.json(
            self.request(Method::POST, "/assets").multipart(form),
            "upload",
        )
        .await
    }

    pub async fn add_to_album(&self, album_id: &str, asset_ids: &[String]) -> Result<(), String> {
        self.send(
            self.request(Method::PUT, &format!("/albums/{album_id}/assets"))
                .json(&json!({ "ids": asset_ids })),
            "adding to album",
        )
        .await
        .map(|_| ())
    }

    pub async fn remove_from_album(
        &self,
        album_id: &str,
        asset_ids: &[String],
    ) -> Result<(), String> {
        self.send(
            self.request(Method::DELETE, &format!("/albums/{album_id}/assets"))
                .json(&json!({ "ids": asset_ids })),
            "removing from album",
        )
        .await
        .map(|_| ())
    }

    pub async fn create_stack(&self, asset_ids: &[String]) -> Result<(), String> {
        self.send(
            self.request(Method::POST, "/stacks")
                .json(&json!({ "assetIds": asset_ids })),
            "stacking",
        )
        .await
        .map(|_| ())
    }

    pub async fn trash(&self, asset_ids: &[String]) -> Result<(), String> {
        self.send(
            self.request(Method::DELETE, "/assets")
                .json(&json!({ "ids": asset_ids, "force": false })),
            "moving to trash",
        )
        .await
        .map(|_| ())
    }

    pub async fn thumbnail(&self, asset_id: &str, size: &str) -> Result<Vec<u8>, String> {
        let response = self
            .send(
                self.request(
                    Method::GET,
                    &format!("/assets/{asset_id}/thumbnail?size={size}"),
                ),
                "thumbnail",
            )
            .await?;
        response
            .bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|e| e.to_string())
    }
}

fn mime_for(file_name: &str) -> &'static str {
    let ext = Path::new(file_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "tif" | "tiff" => "image/tiff",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "jxl" => "image/jxl",
        "heic" | "heif" => "image/heic",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeline_bucket_gives_stack_of_primaries() {
        let bucket: TimelineBucket = serde_json::from_value(json!({
            "id": ["a", "b", "c"],
            "stack": [null, ["s1", "3"], null],
            "isImage": [true, true, true],
        }))
        .unwrap();
        let ids: Vec<_> = bucket.stack_ids().collect();
        assert_eq!(
            ids,
            vec![
                ("a".to_string(), None),
                ("b".to_string(), Some("s1".to_string())),
                ("c".to_string(), None),
            ]
        );
    }

    #[test]
    fn timeline_bucket_without_stack_column() {
        let bucket: TimelineBucket = serde_json::from_value(json!({ "id": ["a"] })).unwrap();
        assert_eq!(
            bucket.stack_ids().collect::<Vec<_>>(),
            vec![("a".to_string(), None)]
        );
    }

    #[test]
    fn time_buckets_are_filtered_by_month() {
        let bucket = "2019-11-01";
        assert!(in_months(bucket, None, None));
        assert!(in_months(bucket, Some("2019-11"), Some("2019-11")));
        assert!(in_months(bucket, Some("2019-01"), None));
        assert!(!in_months(bucket, Some("2019-12"), None));
        assert!(!in_months(bucket, None, Some("2019-10")));
    }
}
