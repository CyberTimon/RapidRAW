#[cfg(target_os = "android")]
#[path = "ai_processing_android.rs"]
mod ai_processing;
#[cfg(not(target_os = "android"))]
mod ai_processing;

mod ai_connector;
mod culling;
mod denoising;
mod file_management;
mod formats;
mod gpu_processing;
mod image_loader;
mod image_processing;
mod inpainting;
mod lut_processing;
mod mask_generation;
mod panorama_stitching;
mod panorama_utils;
mod preset_converter;
mod raw_processing;

#[cfg(target_os = "android")]
#[path = "tagging_android.rs"]
mod tagging;
#[cfg(not(target_os = "android"))]
mod tagging;

mod tagging_utils;

mod app;

pub use app::GpuImageCache;
pub use app::GpuProcessorState;
pub use app::calculate_geometry_hash;
pub use app::get_cached_or_generate_mask;
pub use crate::file_management::load_settings;
pub use std::io::Cursor;

pub use app::AppState;
pub use app::run;
