use reqwest::multipart::{Form, Part};
use reqwest::{Client, Method, RequestBuilder, Response};
use serde::de::{DeserializeOwned, Deserializer, Error as _};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::Path;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

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
    pub is_trashed: bool,
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
    pub shared: bool,
}

#[derive(Deserialize, Debug, Clone)]
pub struct User {
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
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Stack {
    pub primary_asset_id: String,
    pub assets: Vec<Asset>,
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
            .map_err(|e| format!("Immich is not reachable ({what}): {e}"))?;
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

    pub async fn albums(&self) -> Result<Vec<Album>, String> {
        self.json(self.request(Method::GET, "/albums"), "albums")
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

    pub async fn stacks(&self) -> Result<Vec<Stack>, String> {
        self.json(self.request(Method::GET, "/stacks"), "stacks")
            .await
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
            .map_err(|e| format!("Immich is not reachable (edits): {e}"))?;
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
