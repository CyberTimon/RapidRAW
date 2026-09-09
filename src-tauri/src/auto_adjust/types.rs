use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const VERSION: &str = "scene-auto-5-yunet-2023mar";
pub const KEYS: &[&str] = &[
    "exposure",
    "brightness",
    "contrast",
    "highlights",
    "shadows",
    "whites",
    "blacks",
    "temperature",
    "tint",
];

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Scene {
    Daylight,
    WarmIndoor,
    Night,
    Mixed,
    #[default]
    Uncertain,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Controls {
    pub strength: f64,
    pub subject_brightness: f64,
    pub warmth: f64,
    pub consistency: f64,
}
impl Default for Controls {
    fn default() -> Self {
        Self { strength: 1.0, subject_brightness: 0.0, warmth: 0.0, consistency: 0.5 }
    }
}
impl Controls {
    pub fn validate(&self) -> anyhow::Result<()> {
        for (v, lo, hi) in [
            (self.strength, 0., 1.5),
            (self.subject_brightness, -1., 1.),
            (self.warmth, -1., 1.),
            (self.consistency, 0., 1.),
        ] {
            anyhow::ensure!(v.is_finite() && v >= lo && v <= hi, "Invalid Auto control");
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupOverride {
    pub scene: Option<Scene>,
    pub controls: Option<Controls>,
    pub reference_path: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    pub controls: Controls,
    pub skip_edited: bool,
    pub groups: BTreeMap<String, GroupOverride>,
}
impl Default for Options {
    fn default() -> Self {
        Self { controls: Controls::default(), skip_edited: true, groups: BTreeMap::new() }
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Face {
    pub bounds: [f32; 4],
    pub confidence: f32,
    pub luma: f64,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub median: f64,
    pub p10: f64,
    pub p90: f64,
    pub p99: f64,
    pub clipped: f64,
    pub shadows: f64,
    pub noise: f64,
    pub warmth: f64,
    pub tint: f64,
    pub neutral_confidence: f64,
    pub saturation: f64,
    pub color_variance: f64,
    pub subject: f64,
    pub background: f64,
    pub scene: Scene,
    pub confidence: f64,
    pub captured: Option<i64>,
    pub iso: Option<u32>,
    pub faces: Vec<Face>,
    pub reduced: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub scene: Scene,
    pub confidence: f64,
    pub paths: Vec<String>,
    pub target: f64,
    pub warmth: f64,
    pub tint: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    pub fingerprint: String,
    pub baseline: Value,
    pub expected: Value,
    pub applied: bool,
    pub analysis: Analysis,
    pub group_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub id: String,
    pub version: String,
    pub options: Options,
    pub entries: Vec<Entry>,
    pub groups: Vec<Group>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub id: String,
    pub batch_id: String,
    pub phase: String,
    pub completed: usize,
    pub total: usize,
    pub changed: Vec<String>,
    pub skipped: Vec<String>,
    pub failures: BTreeMap<String, String>,
    pub warnings: BTreeMap<String, String>,
    pub groups: Vec<Group>,
    pub running: bool,
    pub cancelled: bool,
}
