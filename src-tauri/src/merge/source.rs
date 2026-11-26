use crate::app::memory_budget::MemoryBudget;
use crate::app::settings::AppSettings;
use crate::decode::formats::is_raw_file;
use crate::library::sidecars::parse_virtual_path;
use crate::merge::raster::{Raster, srgb_decoded};
use crate::render::image_processing::apply_cpu_default_raw_processing;
use rayon::prelude::*;
use std::borrow::Cow;
use std::fs;
use std::path::Path;
use std::sync::Arc;

pub struct SourceLoader<'a> {
    settings: Cow<'a, AppSettings>,
    memory_budget: &'a Arc<MemoryBudget>,
    linear_raw: bool,
}

pub struct DecodedSource {
    pub file_bytes: Vec<u8>,
    pub image: Raster,
}

impl<'a> SourceLoader<'a> {
    pub fn new(
        settings: &'a AppSettings,
        memory_budget: &'a Arc<MemoryBudget>,
        linear_raw: bool,
    ) -> Self {
        let settings = if linear_raw {
            let mut unprocessed = settings.clone();
            unprocessed.raw_preprocessing_color_nr = Some(0.0);
            unprocessed.raw_preprocessing_sharpening = Some(0.0);
            Cow::Owned(unprocessed)
        } else {
            Cow::Borrowed(settings)
        };
        SourceLoader {
            settings,
            memory_budget,
            linear_raw,
        }
    }

    pub fn load_all<T: Send>(
        &self,
        paths: &[String],
        load: impl Fn(usize, &str) -> Result<T, String> + Sync,
    ) -> Result<Vec<T>, String> {
        let load = &load;
        std::thread::scope(|scope| {
            let workers: Vec<_> = paths
                .iter()
                .enumerate()
                .map(|(index, path)| {
                    let estimate = crate::export::tasks::estimate_export_memory(
                        path,
                        is_raw_file(path),
                        None,
                        1,
                        0,
                        "tiff",
                        0,
                    );
                    let reservation = self.memory_budget.reserve(estimate, None);
                    scope.spawn(move || {
                        let _reservation = reservation;
                        load(index, path)
                    })
                })
                .collect();
            workers
                .into_iter()
                .map(|worker| {
                    worker
                        .join()
                        .map_err(|_| "Loading an image failed unexpectedly.".to_string())?
                })
                .collect()
        })
    }

    pub fn decode(&self, path: &str) -> Result<DecodedSource, String> {
        let is_raw = is_raw_file(path);
        let file_bytes =
            fs::read(path).map_err(|e| format!("Failed to read image {}: {}", path, e))?;
        let mut dynamic_image = crate::decode::image_loader::load_base_image_from_bytes(
            &file_bytes,
            path,
            false,
            &self.settings,
            None,
        )
        .map_err(|e| format!("Failed to load image {}: {}", path, e))?;
        let linear_raw = is_raw && self.linear_raw;
        if is_raw && !linear_raw {
            apply_cpu_default_raw_processing(&mut dynamic_image);
        } else if !is_raw {
            crate::decode::hdr_source::roll_off_encoded(
                &mut dynamic_image,
                crate::decode::as_shot::as_shot_from_bytes(path, &file_bytes).source_peak,
            );
        }

        let rgb = dynamic_image.into_rgb32f();
        let (width, height) = (rgb.width() as usize, rgb.height() as usize);
        let mut image = Raster::from_data(width, height, 3, rgb.into_raw());
        if linear_raw {
            image.data.par_iter_mut().for_each(|v| *v = v.max(0.0));
        } else {
            image = srgb_decoded(image);
        }
        Ok(DecodedSource { file_bytes, image })
    }
}

pub fn source_paths(paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .map(|p| parse_virtual_path(p).0.to_string_lossy().into_owned())
        .collect()
}

pub fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

pub fn ensure_same_size<'a>(
    images: impl IntoIterator<Item = (&'a str, usize, usize)>,
) -> Result<(), String> {
    let mut images = images.into_iter();
    let Some((first, width, height)) = images.next() else {
        return Ok(());
    };
    match images.find(|&(_, w, h)| w != width || h != height) {
        Some((other, w, h)) => Err(format!(
            "All images must have the same size and orientation. '{}' is {}x{}, but '{}' is {}x{}.",
            file_name(first),
            width,
            height,
            file_name(other),
            w,
            h
        )),
        None => Ok(()),
    }
}
