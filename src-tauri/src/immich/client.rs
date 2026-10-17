use reqwest::{Client, Method, RequestBuilder, Response};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::Path;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub original_file_name: String,
    #[serde(default)]
    pub file_modified_at: Option<String>,
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
        let mut found = Vec::new();
        let mut page = 1u32;
        loop {
            let mut body = query.clone();
            body["page"] = json!(page);
            body["size"] = json!(1000);
            let result: SearchResponse = self
                .json(
                    self.request(Method::POST, "/search/metadata").json(&body),
                    "search",
                )
                .await?;
            found.extend(result.assets.items);
            match result.assets.next_page.and_then(|p| p.parse().ok()) {
                Some(next) if next > page => page = next,
                _ => return Ok(found),
            }
        }
    }

    pub async fn timeline_months(&self) -> Result<Vec<TimelineMonth>, String> {
        self.json(
            self.request(Method::GET, "/timeline/buckets?visibility=timeline"),
            "timeline",
        )
        .await
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
