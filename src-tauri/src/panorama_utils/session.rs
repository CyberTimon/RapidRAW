use crate::panorama_utils::stitch::project::Projection;
use crate::panorama_utils::stitch::{FrameMeta, PanoOptions, Registration};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DroppedImage {
    pub filename: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedCrop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl NormalizedCrop {
    pub fn copy(&self) -> Self {
        Self {
            x: self.x,
            y: self.y,
            width: self.width,
            height: self.height,
        }
    }
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

pub struct WorkingFrame {
    pub name: String,
    pub width: usize,
    pub height: usize,
    pub native_width: usize,
    pub native_height: usize,
    pub rgb: Vec<f32>,
    pub clip: f32,
    pub exposure: Option<f64>,
    pub focal35: Option<f64>,
}

pub struct PanoramaSession {
    pub source_paths: Vec<String>,
    pub kept_indices: Vec<usize>,
    pub dropped: Vec<DroppedImage>,
    pub preview_png_base64: String,
    pub overlay_png_base64: String,
    pub winner_map_png_base64: String,
    pub filenames: Vec<String>,
    pub recommended_projection: Projection,
    pub selected_projection: Projection,
    pub crop: NormalizedCrop,
    pub crop_edited: bool,
    pub registration: Registration,
    pub preview_width: u32,
    pub preview_height: u32,
    pub temp_dir: Option<PathBuf>,
    pub composite: Vec<f32>,
    pub composite_width: u32,
    pub composite_height: u32,
    pub frames: Vec<WorkingFrame>,
    pub meta: std::collections::HashMap<String, FrameMeta>,
    pub focal_outliers: std::collections::HashMap<String, bool>,
    pub options: PanoOptions,
    pub half: bool,
    pub preview_scale: f64,
    pub quality: f64,
    pub log_origin: std::time::Instant,
}

impl PanoramaSession {
    pub fn clear_temps(&mut self) {
        if let Some(dir) = self.temp_dir.take() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

pub fn drop_session(session: &mut Option<PanoramaSession>) {
    if let Some(mut s) = session.take() {
        s.clear_temps();
    }
}
