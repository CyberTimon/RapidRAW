use crate::panorama_utils::message::PanoMessage;
use crate::panorama_utils::stitch::project::Projection;
use crate::panorama_utils::stitch::{Frame, PanoOptions, Registration};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize)]
pub struct DroppedImage {
    pub filename: String,
    pub reason: PanoMessage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedCrop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Default for NormalizedCrop {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        }
    }
}

pub struct PanoramaSession {
    pub source_paths: Vec<String>,
    pub dropped: Vec<DroppedImage>,
    pub preview_png: String,
    pub overlay_png: String,
    pub winner_map_png: String,
    pub recommended_projection: Projection,
    pub crop: NormalizedCrop,
    pub registration: Registration,
    pub preview_width: u32,
    pub preview_height: u32,
    pub composite_width: u32,
    pub composite_height: u32,
    pub frames: Arc<[Frame]>,
    pub focal_outliers: std::collections::HashMap<String, bool>,
    pub options: PanoOptions,
    pub gains: Vec<f64>,
}
