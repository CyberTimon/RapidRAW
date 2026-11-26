use reqwest::header::{CONTENT_RANGE, RANGE};
use reqwest::multipart::{Form, Part};
use reqwest::{Body, Client, Method, RequestBuilder, Response, StatusCode};
use serde::de::{DeserializeOwned, Deserializer, Error as _};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn with_cause(error: &dyn std::error::Error) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        text.push_str(&format!(": {cause}"));
        source = cause.source();
    }
    text
}

fn range_start(response: &Response) -> Option<u64> {
    let range = response.headers().get(CONTENT_RANGE)?.to_str().ok()?;
    range
        .strip_prefix("bytes ")?
        .split('-')
        .next()?
        .trim()
        .parse()
        .ok()
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
    #[serde(default)]
    pub visibility: Option<String>,
    #[serde(default)]
    pub checksum: Option<String>,
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
const READ_TIMEOUT: Duration = Duration::from_secs(30);
const UPLOAD_CHUNK: usize = 64 * 1024;
const ANSWER_WAIT: Duration = Duration::from_secs(180);
const ANSWER_BYTES_PER_SECOND: u64 = 8 * 1024 * 1024;

struct Sending {
    at: Instant,
    done: bool,
}

pub struct ImmichClient {
    base: String,
    api_key: String,
    http: Client,
    uploads: Client,
}

impl ImmichClient {
    pub fn new(server_url: &str, api_key: &str) -> Result<Self, String> {
        let base = server_url.trim().trim_end_matches('/').to_string();
        if !base.starts_with("http://") && !base.starts_with("https://") {
            return Err("The server address must start with http:// or https://".to_string());
        }
        let builder = || Client::builder().connect_timeout(Duration::from_secs(10));
        let http = builder()
            .read_timeout(READ_TIMEOUT)
            .build()
            .map_err(|e| e.to_string())?;
        let uploads = builder().build().map_err(|e| e.to_string())?;
        Ok(Self {
            base,
            api_key: api_key.trim().to_string(),
            http,
            uploads,
        })
    }

    fn request(&self, method: Method, path: &str) -> RequestBuilder {
        self.request_on(&self.http, method, path)
    }

    fn request_on(&self, http: &Client, method: Method, path: &str) -> RequestBuilder {
        http.request(method, format!("{}/api{}", self.base, path))
            .header("x-api-key", &self.api_key)
            .header("Accept", "application/json")
    }

    async fn send(&self, builder: RequestBuilder, what: &str) -> Result<Response, String> {
        let response = builder
            .send()
            .await
            .map_err(|e| format!("Immich is not reachable ({what}): {}", with_cause(&e)))?;
        Self::accepted(response, what).await
    }

    async fn accepted(response: Response, what: &str) -> Result<Response, String> {
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

    pub async fn asset(&self, asset_id: &str) -> Result<Asset, String> {
        self.json(
            self.request(Method::GET, &format!("/assets/{asset_id}")),
            "asset",
        )
        .await
    }

    pub async fn owns(&self, asset_id: &str) -> Result<bool, String> {
        Ok(self.asset(asset_id).await?.owner_id == self.me().await?.id)
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

    fn original_request(&self, asset_id: &str, from: u64) -> RequestBuilder {
        let request = self.request(Method::GET, &format!("/assets/{asset_id}/original"));
        if from > 0 {
            request.header(RANGE, format!("bytes={from}-"))
        } else {
            request
        }
    }

    pub async fn download_original(
        &self,
        asset_id: &str,
        target: &Path,
        mut progress: impl FnMut(u64, Option<u64>),
    ) -> Result<(), String> {
        const WHAT: &str = "original download";
        let from = tokio::fs::metadata(target)
            .await
            .map_or(0, |meta| meta.len());
        let first = self
            .original_request(asset_id, from)
            .send()
            .await
            .map_err(|e| format!("Immich is not reachable ({WHAT}): {}", with_cause(&e)))?;
        let resumes =
            first.status() != StatusCode::PARTIAL_CONTENT || range_start(&first) == Some(from);
        let mut response =
            if from > 0 && (first.status() == StatusCode::RANGE_NOT_SATISFIABLE || !resumes) {
                self.send(self.original_request(asset_id, 0), WHAT).await?
            } else {
                Self::accepted(first, WHAT).await?
            };
        let start = match response.status() {
            StatusCode::PARTIAL_CONTENT => range_start(&response)
                .filter(|start| *start == from && from > 0)
                .ok_or("Immich sent an unexpected part of the file")?,
            _ => 0,
        };
        let total = response.content_length().map(|length| start + length);
        let mut file = if start > 0 {
            tokio::fs::OpenOptions::new()
                .append(true)
                .open(target)
                .await
        } else {
            tokio::fs::File::create(target).await
        }
        .map_err(|e| format!("Cannot write '{}': {e}", target.display()))?;
        let mut written = start;
        progress(written, total);
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("Download interrupted: {e}"))?
        {
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            written += chunk.len() as u64;
            progress(written, total);
        }
        file.flush().await.map_err(|e| e.to_string())?;
        let stored = file.metadata().await.map_err(|e| e.to_string())?.len();
        if stored != written {
            drop(file);
            let _ = tokio::fs::remove_file(target).await;
            return Err("The download was damaged and has to start over".to_string());
        }
        match total {
            Some(total) if total != written => Err(format!(
                "Download interrupted after {written} of {total} bytes"
            )),
            _ => Ok(()),
        }
    }

    pub async fn upload(
        &self,
        path: &Path,
        created_at: &str,
        modified_at: &str,
        progress: impl Fn(u64, u64) + Send + 'static,
    ) -> Result<UploadResult, String> {
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "export.jpg".to_string());
        let unreadable = |e: std::io::Error| format!("Cannot read '{}': {e}", path.display());
        let file = tokio::fs::File::open(path).await.map_err(unreadable)?;
        let length = file.metadata().await.map_err(unreadable)?.len();
        let sending = Arc::new(Mutex::new(Sending {
            at: Instant::now(),
            done: false,
        }));
        let touched = Arc::clone(&sending);
        let sent = move |sent: u64| {
            *touched.lock().unwrap_or_else(PoisonError::into_inner) = Sending {
                at: Instant::now(),
                done: sent >= length,
            };
            progress(sent, length);
        };
        let chunks =
            futures::stream::try_unfold((file, 0, sent), |(mut file, done, sent)| async move {
                let mut chunk = vec![0; UPLOAD_CHUNK];
                let read = file.read(&mut chunk).await?;
                if read == 0 {
                    return Ok::<_, std::io::Error>(None);
                }
                chunk.truncate(read);
                let done = done + read as u64;
                sent(done);
                Ok(Some((chunk, (file, done, sent))))
            });
        let part = Part::stream_with_length(Body::wrap_stream(chunks), length)
            .file_name(file_name.clone())
            .mime_str(mime_for(&file_name))
            .map_err(|e| e.to_string())?;
        let form = Form::new()
            .text("fileCreatedAt", created_at.to_string())
            .text("fileModifiedAt", modified_at.to_string())
            .text("filename", file_name)
            .part("assetData", part);
        let upload = self.json(
            self.request_on(&self.uploads, Method::POST, "/assets")
                .multipart(form),
            "upload",
        );
        tokio::select! {
            uploaded = upload => uploaded,
            () = stalled(&sending, ANSWER_WAIT + Duration::from_secs(length / ANSWER_BYTES_PER_SECOND)) => {
                Err("Immich stopped answering during the upload".to_string())
            }
        }
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
        "heic" | "heif" | "hif" => "image/heic",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

async fn stalled(sending: &Mutex<Sending>, answer: Duration) {
    loop {
        let (idle, limit) = {
            let sending = sending.lock().unwrap_or_else(PoisonError::into_inner);
            let limit = if sending.done { answer } else { READ_TIMEOUT };
            (sending.at.elapsed(), limit)
        };
        if idle >= limit {
            return;
        }
        tokio::time::sleep(limit - idle).await;
    }
}
