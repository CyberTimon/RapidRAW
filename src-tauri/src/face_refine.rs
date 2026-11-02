use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Cursor;
use std::sync::Arc;

use base64::{Engine as _, engine::general_purpose};
use image::{GrayImage, RgbImage, imageops};
use rayon::prelude::*;
use serde_json::Value;

use crate::ai_processing::get_or_init_face_models;
use crate::app_state::AppState;
use crate::face_parsing::{
    FaceRegion, ParsedFace, analyze_faces, keep_bright_neutral, render_region,
};
use crate::inpainting::{encode_patch_result, prepare_source_image};
use crate::skin_retouch::{
    FaceHints, FeatureEnhance, SkinRetouchParams, enhance_eyes_and_teeth, retouch_skin_scaled,
};

/// Everything needed to retouch one face again and again without going back to the
/// full image: its pixels and what the parsing model found in them.
pub struct FaceCrop {
    center: [f32; 2],
    width: f32,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    rgb: Vec<u8>,
    /// The skin that gets retouched.
    selection: Vec<u8>,
    skin: Vec<u8>,
    features: Vec<u8>,
    blemish_zone: Vec<u8>,
    eyes: Vec<u8>,
    eye_whites: Vec<u8>,
    teeth: Vec<u8>,
    thumbnail: String,
}

/// The face crops of the loaded image, valid while `key` matches.
pub struct FaceCropCache {
    pub key: String,
    is_raw: bool,
    crops: Vec<FaceCrop>,
}

pub struct FaceRefineSettings {
    pub skin: SkinRetouchParams,
    pub eyes: f32,
    pub teeth: f32,
}

fn to_u8(plane: &[f32]) -> Vec<u8> {
    plane
        .par_iter()
        .map(|&v| (v.clamp(0.0, 1.0) * 255.0).round() as u8)
        .collect()
}

fn build_face_crop(face: &ParsedFace, source: &RgbImage) -> Option<FaceCrop> {
    let (img_w, img_h) = source.dimensions();
    let face_slice = std::slice::from_ref(face);

    // First pass over everything the model looked at, to find where the skin actually is.
    let [min_x, min_y, max_x, max_y] = face.bounds();
    let bx = min_x.clamp(0.0, img_w as f32 - 1.0) as u32;
    let by = min_y.clamp(0.0, img_h as f32 - 1.0) as u32;
    let bw = (max_x.clamp(0.0, img_w as f32) as u32).saturating_sub(bx);
    let bh = (max_y.clamp(0.0, img_h as f32) as u32).saturating_sub(by);
    if bw == 0 || bh == 0 {
        return None;
    }
    let coarse = render_region(face_slice, FaceRegion::Skin, (bx, by), bw, bh);
    let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0, 0);
    for (i, &p) in coarse.iter().enumerate() {
        if p > 0.3 {
            let (px, py) = (i as u32 % bw, i as u32 / bw);
            x0 = x0.min(px);
            y0 = y0.min(py);
            x1 = x1.max(px);
            y1 = y1.max(py);
        }
    }
    if x0 > x1 || y0 > y1 {
        return None;
    }
    drop(coarse);

    let pad = (face.width * 0.1 + 16.0).ceil() as u32;
    let x = (bx + x0).saturating_sub(pad);
    let y = (by + y0).saturating_sub(pad);
    let w = (bx + x1 + pad + 1).min(img_w) - x;
    let h = (by + y1 + pad + 1).min(img_h) - y;
    let origin = (x, y);

    let rgb = imageops::crop_imm(source, x, y, w, h).to_image().into_raw();
    let skin = render_region(face_slice, FaceRegion::Skin, origin, w, h);
    let selection: Vec<u8> = skin
        .par_iter()
        .map(|&p| {
            let t = ((p - 0.3) / 0.4).clamp(0.0, 1.0);
            (t * t * (3.0 - 2.0 * t) * 255.0) as u8
        })
        .collect();
    let eyes = render_region(face_slice, FaceRegion::Eyes, origin, w, h);
    let mut eye_whites = eyes.clone();
    keep_bright_neutral(&mut eye_whites, &rgb, FaceRegion::EyeWhites);
    let mut teeth = render_region(face_slice, FaceRegion::Teeth, origin, w, h);
    keep_bright_neutral(&mut teeth, &rgb, FaceRegion::Teeth);

    let mut jpeg = Cursor::new(Vec::new());
    face.thumbnail(source, 96)
        .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(
            &mut jpeg, 85,
        ))
        .ok()?;

    Some(FaceCrop {
        center: face.center(),
        width: face.width,
        x,
        y,
        w,
        h,
        rgb,
        selection,
        skin: to_u8(&skin),
        features: to_u8(&render_region(
            face_slice,
            FaceRegion::Features,
            origin,
            w,
            h,
        )),
        blemish_zone: to_u8(&render_region(
            face_slice,
            FaceRegion::BlemishZone,
            origin,
            w,
            h,
        )),
        eyes: to_u8(&eyes),
        eye_whites: to_u8(&eye_whites),
        teeth: to_u8(&teeth),
        thumbnail: format!(
            "data:image/jpeg;base64,{}",
            general_purpose::STANDARD.encode(jpeg.get_ref())
        ),
    })
}

/// Retouches one cached face. Returns the new pixels of the crop and where they apply.
fn refine_face_crop(crop: &FaceCrop, settings: &FaceRefineSettings) -> (Vec<u8>, Vec<u8>) {
    let (w, h) = (crop.w as usize, crop.h as usize);
    let scale = crop.width * 1.2;

    let mut color = retouch_skin_scaled(
        &crop.rgb,
        &crop.selection,
        w,
        h,
        scale,
        &settings.skin,
        Some(FaceHints {
            skin: &crop.skin,
            features: &crop.features,
            blemish_zone: Some(&crop.blemish_zone),
        }),
    );
    let mut mask = crop.selection.clone();

    if settings.eyes > 0.0 || settings.teeth > 0.0 {
        enhance_eyes_and_teeth(
            &mut color,
            w,
            h,
            scale,
            &FeatureEnhance {
                eyes: &crop.eyes,
                eye_whites: &crop.eye_whites,
                teeth: &crop.teeth,
                eye_amount: settings.eyes,
                teeth_amount: settings.teeth,
            },
        );
        // Eyes and teeth are outside the skin selection, so the patch has to cover them too.
        mask.par_iter_mut().enumerate().for_each(|(i, m)| {
            if settings.eyes > 0.0 {
                *m = (*m).max(crop.eyes[i]);
            }
            if settings.teeth > 0.0 {
                *m = (*m).max(crop.teeth[i]);
            }
        });
    }
    (color, mask)
}

/// The image the faces are read from must not contain Facial Refine's own patches.
fn without_face_patches(adjustments: &Value) -> Value {
    let mut stripped = adjustments.clone();
    if let Some(patches) = stripped.get_mut("aiPatches").and_then(|v| v.as_array_mut()) {
        patches.retain(|p| p.get("faceRefine").and_then(|v| v.as_bool()) != Some(true));
    }
    stripped
}

/// Changes whenever the image or any other patch painted on it changes.
fn source_key(path: &str, stripped_adjustments: &Value) -> String {
    let mut hasher = DefaultHasher::new();
    if let Some(patches) = stripped_adjustments
        .get("aiPatches")
        .and_then(|v| v.as_array())
    {
        for patch in patches {
            let text = |pointer: &str| {
                patch
                    .pointer(pointer)
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
            };
            text("/id").hash(&mut hasher);
            patch
                .get("visible")
                .and_then(|v| v.as_bool())
                .hash(&mut hasher);
            text("/patchData/color").len().hash(&mut hasher);
            text("/patchData/mask").len().hash(&mut hasher);
        }
    }
    format!("{}|{:x}", path, hasher.finish())
}

async fn face_crops(
    current_adjustments: &Value,
    state: &tauri::State<'_, AppState>,
    app_handle: &tauri::AppHandle,
) -> Result<Arc<FaceCropCache>, String> {
    let path = state
        .original_image
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|img| img.path.clone())
        .ok_or("No original image loaded")?;
    let stripped = without_face_patches(current_adjustments);
    let key = source_key(&path, &stripped);

    let cached = state
        .ai_state
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|ai_state| ai_state.face_crops.clone())
        .filter(|cache| cache.key == key);
    if let Some(cache) = cached {
        return Ok(cache);
    }

    let models = get_or_init_face_models(app_handle, &state.ai_state, &state.ai_init_lock)
        .await
        .map_err(|e| e.to_string())?;

    let (source, is_raw) = {
        let (source_dynamic, is_raw) = prepare_source_image("", &stripped, state)?;
        (source_dynamic.to_rgb8(), is_raw)
    };
    let faces = analyze_faces(&source, &models).map_err(|e| e.to_string())?;
    let mut crops: Vec<FaceCrop> = faces
        .iter()
        .filter_map(|face| build_face_crop(face, &source))
        .collect();
    crops.sort_by(|a, b| a.center[0].total_cmp(&b.center[0]));

    let cache = Arc::new(FaceCropCache { key, is_raw, crops });
    if let Some(ai_state) = state.ai_state.lock().unwrap().as_mut() {
        ai_state.face_crops = Some(cache.clone());
    }
    Ok(cache)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedFace {
    center_x: f32,
    center_y: f32,
    width: f32,
    thumbnail: String,
}

/// Lists the faces of the loaded image, in source image coordinates, for Facial Refine.
#[tauri::command]
pub async fn detect_faces_for_refine(
    current_adjustments: Value,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<Vec<DetectedFace>, String> {
    let cache = face_crops(&current_adjustments, &state, &app_handle).await?;
    Ok(cache
        .crops
        .iter()
        .map(|crop| DetectedFace {
            center_x: crop.center[0],
            center_y: crop.center[1],
            width: crop.width,
            thumbnail: crop.thumbnail.clone(),
        })
        .collect())
}

/// Retouches the face at `face_center` and returns it as patch data.
#[tauri::command]
pub async fn generate_face_refine_patch(
    current_adjustments: Value,
    face_center: (f32, f32),
    parameters: Value,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let cache = face_crops(&current_adjustments, &state, &app_handle).await?;

    let distance =
        |crop: &FaceCrop| (crop.center[0] - face_center.0).hypot(crop.center[1] - face_center.1);
    let crop = cache
        .crops
        .iter()
        .filter(|crop| distance(crop) < crop.width)
        .min_by(|a, b| distance(a).total_cmp(&distance(b)))
        .ok_or("The selected face was not found in this image.")?;

    let percent = |key: &str, default: f32| {
        parameters
            .get(key)
            .and_then(|v| v.as_f64())
            .map_or(default, |v| (v as f32 / 100.0).clamp(0.0, 1.0))
    };
    let settings = FaceRefineSettings {
        skin: SkinRetouchParams {
            smoothing: percent("intensity", 0.4),
            texture: percent("texture", 0.75),
            blemish: percent("blemish", 0.5),
            shine: percent("shine", 0.4),
            even_tone: percent("evenTone", 0.35),
            skin_protection: 0.85,
        },
        eyes: percent("eyes", 0.0),
        teeth: percent("teeth", 0.0),
    };

    let started = std::time::Instant::now();
    let (color, mask) = refine_face_crop(crop, &settings);
    log::info!(
        "facial refine ({}x{} face crop) took {:.2?}",
        crop.w,
        crop.h,
        started.elapsed()
    );

    encode_patch_result(
        &RgbImage::from_raw(crop.w, crop.h, color).ok_or("Invalid face crop")?,
        &GrayImage::from_raw(crop.w, crop.h, mask).ok_or("Invalid face crop")?,
        crop.x,
        crop.y,
        crop.w,
        crop.h,
        cache.is_raw,
        100,
        false,
    )
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use ort::session::Session;

    use super::*;
    use crate::face_parsing::{FaceModels, load_face_parser_session};

    /// Runs the real models. Point `FACE_TEST_DIR` at a folder holding `yunet.onnx`,
    /// `parsing.onnx` and `face.jpg`; the results are written next to them.
    #[test]
    #[ignore]
    fn refines_a_real_portrait() {
        let dir = std::path::PathBuf::from(std::env::var("FACE_TEST_DIR").unwrap());
        let _ = ort::init().with_name("face-test").commit();
        let models = FaceModels {
            detector: Mutex::new(
                Session::builder()
                    .unwrap()
                    .commit_from_file(dir.join("yunet.onnx"))
                    .unwrap(),
            ),
            parser: Mutex::new(load_face_parser_session(&dir.join("parsing.onnx")).unwrap()),
        };
        let small = image::open(dir.join("face.jpg")).unwrap().to_rgb8();
        let settings = FaceRefineSettings {
            skin: SkinRetouchParams {
                smoothing: 0.4,
                texture: 0.75,
                blemish: 1.0,
                shine: 0.4,
                even_tone: 0.35,
                skin_protection: 0.85,
            },
            eyes: 0.6,
            teeth: 0.6,
        };

        // The same portrait as shot, and blown up to the size of a close-up on a 24MP frame.
        let large = imageops::resize(&small, 3072, 3072, imageops::FilterType::CatmullRom);
        for (name, image) in [("small", small), ("large", large)] {
            let faces = analyze_faces(&image, &models).unwrap();
            assert_eq!(faces.len(), 1, "{name}");
            let crop = build_face_crop(&faces[0], &image).unwrap();
            for (region, plane) in [
                ("selection", &crop.selection),
                ("blemish zone", &crop.blemish_zone),
                ("eyes", &crop.eyes),
                ("eye whites", &crop.eye_whites),
                ("teeth", &crop.teeth),
            ] {
                assert!(plane.iter().any(|&p| p > 127), "{name} {region}");
            }

            image::GrayImage::from_raw(crop.w, crop.h, crop.blemish_zone.clone())
                .unwrap()
                .save(dir.join(format!("{name}_blemish_zone.png")))
                .unwrap();

            let started = std::time::Instant::now();
            let (color, mask) = refine_face_crop(&crop, &settings);
            println!(
                "{name}: {}x{} crop refined in {:?}",
                crop.w,
                crop.h,
                started.elapsed()
            );
            assert_eq!(mask.len(), color.len() / 3);

            let mut result = image.clone();
            for (i, px) in color.chunks_exact(3).enumerate() {
                let (cx, cy) = (crop.x + i as u32 % crop.w, crop.y + i as u32 / crop.w);
                let alpha = mask[i] as f32 / 255.0;
                let dst = result.get_pixel_mut(cx, cy);
                for c in 0..3 {
                    dst[c] = (dst[c] as f32 * (1.0 - alpha) + px[c] as f32 * alpha) as u8;
                }
            }
            result
                .save(dir.join(format!("{name}_refined.png")))
                .unwrap();
        }
    }
}
