use serde::{Deserialize, Serialize};

pub const MODEL_VERSION: &str = "yunet-2023mar-sface-2021dec-v1";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceRecord {
    pub id: String,
    pub path: String,
    pub person_id: String,
    pub bounds: [f32; 4],
    pub landmarks: [[f32; 2]; 5],
    pub confidence: f32,
    pub quality: f32,
    pub ignored: bool,
}

#[derive(Clone, Debug)]
pub struct Detection {
    pub bounds: [f32; 4],
    pub landmarks: [[f32; 2]; 5],
    pub confidence: f32,
    pub embedding: Vec<f32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonSummary {
    pub id: String,
    pub name: Option<String>,
    pub representative_face: String,
    pub photo_count: u32,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeopleScanProgress {
    pub running: bool,
    pub total: usize,
    pub processed: usize,
    pub skipped: usize,
    pub failed: usize,
    pub detected_faces: usize,
    pub cancelled: bool,
    pub error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeopleScanScope {
    pub paths: Vec<String>,
    #[serde(default)]
    pub recursive: bool,
    #[serde(default)]
    pub force: bool,
}
