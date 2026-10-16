use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::Result;
use image::imageops::{self, FilterType};
use image::{
    DynamicImage, GenericImageView, GrayImage, ImageBuffer, Luma, Rgb, Rgb32FImage, Rgba, RgbaImage,
};
use ndarray::{Array, Array4, IxDyn};
use ort::session::Session;
use ort::value::{DynValue, Tensor};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Emitter;
use tauri::Manager;
use tokenizers::Tokenizer;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex as TokioMutex;

const SAM3_IMAGE_URL: &str = "https://github.com/jamjamjon/assets/releases/download/sam3/vision-encoder-q4f16.onnx";
const SAM3_IMAGE_FILENAME: &str = "vision-encoder-q4f16.onnx";
const SAM3_IMAGE_SHA256: &str = "9c00c5db8739f4c0cd0158a916f0e9755e0240bb35abca2934ab308e72cb2d6e";

const SAM3_TEXT_URL: &str = "https://github.com/jamjamjon/assets/releases/download/sam3/text-encoder-q4f16.onnx";
const SAM3_TEXT_FILENAME: &str = "text-encoder-q4f16.onnx";
const SAM3_TEXT_SHA256: &str = "639ba5a9991b012d3290fbba27eb8dbcebdc86ed9f747572d7bea1678317d8d1";

const SAM3_DECODER_URL: &str = "https://github.com/jamjamjon/assets/releases/download/sam3/geo-encoder-mask-decoder-q4f16.onnx";
const SAM3_DECODER_FILENAME: &str = "geo-encoder-mask-decoder-q4f16.onnx";
const SAM3_DECODER_SHA256: &str = "e7eb624ba212f1e3f67a3e8000b79860b82fbe9dfaefab6e7816cf8f466c2bfd";

const SAM3_TOKENIZER_URL: &str = "https://github.com/jamjamjon/assets/releases/download/sam3/tokenizer.json";
const SAM3_TOKENIZER_FILENAME: &str = "sam3-tokenizer.json";
const SAM3_TOKENIZER_SHA256: &str = "6d9109cc838977f3ca94a379eec36aecc7c807e1785cd729660ca2fc0171fb35";
const SAM3_INPUT_SIZE: u32 = 1008;
const SAM3_TEXT_LENGTH: usize = 32;
const SAM3_PAD_TOKEN_ID: i64 = 49407;

const CLIP_MODEL_URL: &str =
    "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/clip_model.onnx?download=true";
const CLIP_MODEL_FILENAME: &str = "clip_model.onnx";
const CLIP_TOKENIZER_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/clip_tokenizer.json?download=true";
const CLIP_TOKENIZER_FILENAME: &str = "clip_tokenizer.json";
const CLIP_MODEL_SHA256: &str = "57879bb1c23cdeb350d23569dd251ed4b740a96d747c529e94a2bb8040ac5d00";

const DENOISE_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/nind_denoise_utnet_684.onnx?download=true";
const DENOISE_FILENAME: &str = "nind_denoise_utnet_684.onnx";
const DENOISE_SHA256: &str = "ee3586279d514df557ff3f7dec6df37fafc51ba5d3a3435b2cc9ac2d9017e7fe";

const LAMA_URL: &str =
    "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/lama_fp16.onnx?download=true";
const LAMA_FILENAME: &str = "lama_fp16.onnx";
const LAMA_SHA256: &str = "2d6be6277c400d6f1b91819737f7c3da935e5c63d1b521d393be1196a2bfa82c";

const DEPTH_URL: &str = "https://huggingface.co/zerochocobo/DepthAnything3_ONNX/resolve/main/da3_small.onnx?download=true";
const DEPTH_FILENAME: &str = "depth_anything_v3_small.onnx";
const DEPTH_INPUT_SIZE: u32 = 518;
const DEPTH_SHA256: &str = "d659ca25f1c665d5c064a64294d5fd0303e456aa94bf224a7777d9682cac7a39";

const NORMAL_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/moge-2-vits-normal-onnx.onnx?download=true";
const NORMAL_FILENAME: &str = "moge-2-vits-normal-onnx.onnx";
const NORMAL_MAX_SIZE: u32 = 768;
const NORMAL_NUM_TOKENS: i64 = 2500;
const NORMAL_SHA256: &str = "24eacb5dc7a2c54c7bc98f7de085ffbed79ad006ea5b664c2c2cdc02ff3a52f0";

pub struct AiModels {
    pub sam3_image_encoder: Mutex<Session>,
    pub sam3_text_encoder: Mutex<Session>,
    pub sam3_decoder: Mutex<Session>,
    pub sam3_tokenizer: Tokenizer,
    pub depth_anything: Mutex<Session>,
}

pub struct ClipModels {
    pub model: Mutex<Session>,
    pub tokenizer: Tokenizer,
}

#[derive(Clone)]
pub struct Sam3ImageEmbeddings {
    pub path_hash: String,
    pub features: Vec<Arc<DynValue>>,
    pub original_size: (u32, u32),
}

#[derive(Clone)]
pub struct CachedDepthMap {
    pub path_hash: String,
    pub depth_image: GrayImage,
    pub original_size: (u32, u32),
}

pub struct AiState {
    pub models: Option<Arc<AiModels>>,
    pub denoise_model: Option<Arc<Mutex<Session>>>,
    pub clip_models: Option<Arc<ClipModels>>,
    pub lama_model: Option<Arc<Mutex<Session>>>,
    pub normal_model: Option<Arc<Mutex<Session>>>,
    pub embeddings: Option<Sam3ImageEmbeddings>,
    pub depth_map: Option<CachedDepthMap>,
}

fn edt_1d(f: &mut [f32], v: &mut [usize], z: &mut [f32], d: &mut [f32]) {
    let n = f.len();
    if n == 0 {
        return;
    }
    let mut k = 0;
    v[0] = 0;
    z[0] = f32::NEG_INFINITY;
    z[1] = f32::INFINITY;
    for q in 1..n {
        let mut s = ((f[q] + (q * q) as f32) - (f[v[k]] + (v[k] * v[k]) as f32))
            / (2.0 * (q as f32 - v[k] as f32));
        while s <= z[k] {
            if k == 0 {
                break;
            }
            k -= 1;
            s = ((f[q] + (q * q) as f32) - (f[v[k]] + (v[k] * v[k]) as f32))
                / (2.0 * (q as f32 - v[k] as f32));
        }
        k += 1;
        v[k] = q;
        z[k] = s;
        z[k + 1] = f32::INFINITY;
    }
    k = 0;
    for (q, d_q) in d[..n].iter_mut().enumerate() {
        while z[k + 1] < q as f32 {
            k += 1;
        }
        let diff = q as f32 - v[k] as f32;
        *d_q = diff * diff + f[v[k]];
    }
    f.copy_from_slice(&d[..n]);
}

fn edt_2d(grid: &[bool], width: usize, height: usize) -> Vec<f32> {
    let area = width * height;
    let mut f = vec![0.0; area];
    for i in 0..area {
        f[i] = if grid[i] { 1e10 } else { 0.0 };
    }

    let max_dim = width.max(height);
    let mut v = vec![0; max_dim];
    let mut z = vec![0.0; max_dim + 1];
    let mut d = vec![0.0; max_dim];

    for y in 0..height {
        let start = y * width;
        let end = start + width;
        edt_1d(&mut f[start..end], &mut v, &mut z, &mut d);
    }

    let mut col = vec![0.0; height];
    for x in 0..width {
        for y in 0..height {
            col[y] = f[y * width + x];
        }
        edt_1d(&mut col, &mut v, &mut z, &mut d);
        for y in 0..height {
            f[y * width + x] = col[y];
        }
    }

    f.into_iter().map(|v| v.sqrt()).collect()
}

fn box_filter_horiz(src: &[f32], dest: &mut [f32], w: usize, r: usize) {
    dest.par_chunks_exact_mut(w)
        .zip(src.par_chunks_exact(w))
        .for_each(|(dest_row, src_row)| {
            let mut prefix = vec![0.0; w + 1];
            for x in 0..w {
                prefix[x + 1] = prefix[x] + src_row[x];
            }
            for (x, dest_val) in dest_row.iter_mut().enumerate() {
                let x_min = x.saturating_sub(r);
                let x_max = (x + r).min(w - 1);
                let count = (x_max - x_min + 1) as f32;
                *dest_val = (prefix[x_max + 1] - prefix[x_min]) / count;
            }
        });
}

fn transpose(src: &[f32], dest: &mut [f32], w: usize, h: usize) {
    dest.par_chunks_exact_mut(h)
        .enumerate()
        .for_each(|(x, dest_col)| {
            for y in 0..h {
                dest_col[y] = src[y * w + x];
            }
        });
}

fn box_filter_opt(
    src: &[f32],
    dest: &mut [f32],
    temp1: &mut [f32],
    temp2: &mut [f32],
    w: usize,
    h: usize,
    r: usize,
) {
    box_filter_horiz(src, temp1, w, r);
    transpose(temp1, temp2, w, h);
    box_filter_horiz(temp2, temp1, h, r);
    transpose(temp1, dest, h, w);
}

pub fn fast_guided_filter(
    guide_hr: &GrayImage,
    mask_lr: &GrayImage,
    r: usize,
    eps: f32,
) -> GrayImage {
    let (hr_w, hr_h) = guide_hr.dimensions();
    let (lr_w, lr_h) = mask_lr.dimensions();

    let w = lr_w as usize;
    let h = lr_h as usize;
    let area = w * h;

    let guide_lr = imageops::resize(guide_hr, lr_w, lr_h, FilterType::Triangle);

    let mut i_lr = vec![0.0; area];
    let mut p_lr = vec![0.0; area];
    let mut ip_lr = vec![0.0; area];
    let mut ii_lr = vec![0.0; area];

    let guide_lr_raw = guide_lr.as_raw();
    let mask_lr_raw = mask_lr.as_raw();

    i_lr.par_iter_mut()
        .zip(p_lr.par_iter_mut())
        .zip(ip_lr.par_iter_mut())
        .zip(ii_lr.par_iter_mut())
        .zip(guide_lr_raw.par_iter())
        .zip(mask_lr_raw.par_iter())
        .for_each(|(((((i_out, p_out), ip_out), ii_out), &g_val), &m_val)| {
            let i_val = g_val as f32 / 255.0;
            let p_val = m_val as f32 / 255.0;
            *i_out = i_val;
            *p_out = p_val;
            *ip_out = i_val * p_val;
            *ii_out = i_val * i_val;
        });

    let mut temp1 = vec![0.0; area];
    let mut temp2 = vec![0.0; area];

    let mut mean_i = vec![0.0; area];
    let mut mean_p = vec![0.0; area];
    let mut mean_ip = vec![0.0; area];
    let mut mean_ii = vec![0.0; area];

    box_filter_opt(&i_lr, &mut mean_i, &mut temp1, &mut temp2, w, h, r);
    box_filter_opt(&p_lr, &mut mean_p, &mut temp1, &mut temp2, w, h, r);
    box_filter_opt(&ip_lr, &mut mean_ip, &mut temp1, &mut temp2, w, h, r);
    box_filter_opt(&ii_lr, &mut mean_ii, &mut temp1, &mut temp2, w, h, r);

    let mut a = vec![0.0; area];
    let mut b = vec![0.0; area];

    a.par_iter_mut()
        .zip(b.par_iter_mut())
        .zip(mean_i.par_iter())
        .zip(mean_p.par_iter())
        .zip(mean_ip.par_iter())
        .zip(mean_ii.par_iter())
        .for_each(|(((((a_out, b_out), &m_i), &m_p), &m_ip), &m_ii)| {
            let cov_ip = m_ip - m_i * m_p;
            let var_i = m_ii - m_i * m_i;
            let a_val = cov_ip / (var_i + eps);
            *a_out = a_val;
            *b_out = m_p - a_val * m_i;
        });

    let mut mean_a = vec![0.0; area];
    let mut mean_b = vec![0.0; area];

    box_filter_opt(&a, &mut mean_a, &mut temp1, &mut temp2, w, h, r);
    box_filter_opt(&b, &mut mean_b, &mut temp1, &mut temp2, w, h, r);

    let mean_a_img = ImageBuffer::<Luma<f32>, Vec<f32>>::from_raw(lr_w, lr_h, mean_a).unwrap();
    let mean_b_img = ImageBuffer::<Luma<f32>, Vec<f32>>::from_raw(lr_w, lr_h, mean_b).unwrap();

    let mean_a_hr = imageops::resize(&mean_a_img, hr_w, hr_h, FilterType::Triangle);
    let mean_b_hr = imageops::resize(&mean_b_img, hr_w, hr_h, FilterType::Triangle);

    let mean_a_hr_raw = mean_a_hr.as_raw();
    let mean_b_hr_raw = mean_b_hr.as_raw();
    let guide_hr_raw = guide_hr.as_raw();

    let mut final_mask_raw = vec![0u8; (hr_w * hr_h) as usize];

    final_mask_raw
        .par_iter_mut()
        .zip(mean_a_hr_raw.par_iter())
        .zip(mean_b_hr_raw.par_iter())
        .zip(guide_hr_raw.par_iter())
        .for_each(|(((out, &a_val), &b_val), &i_val)| {
            let i_v = i_val as f32 / 255.0;
            let q = a_val * i_v + b_val;
            *out = (q.clamp(0.0, 1.0) * 255.0).round() as u8;
        });

    GrayImage::from_raw(hr_w, hr_h, final_mask_raw).unwrap()
}

fn get_models_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf> {
    let models_dir = app_handle.path().app_data_dir()?.join("models");
    if !models_dir.exists() {
        fs::create_dir_all(&models_dir)?;
    }
    Ok(models_dir)
}

async fn download_model(url: &str, dest: &Path) -> Result<()> {
    use tokio::io::AsyncWriteExt as _;

    let mut response = reqwest::get(url).await?.error_for_status()?;
    let parent = dest.parent().ok_or_else(|| anyhow::anyhow!(
        "Cannot determine parent directory for downloaded asset {}",
        dest.display()
    ))?;
    fs::create_dir_all(parent)?;

    let file_name = dest.file_name().and_then(|name| name.to_str())
        .ok_or_else(|| anyhow::anyhow!("Invalid downloaded asset path {}", dest.display()))?;
    let temp_path = dest.with_file_name(format!(".{file_name}.download"));
    let mut file = tokio::fs::File::create(&temp_path).await?;

    while let Some(chunk) = response.chunk().await? {
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    file.sync_all().await?;
    drop(file);

    fs::rename(&temp_path, dest).or_else(|rename_error| -> std::io::Result<()> {
        if dest.exists() {
            fs::remove_file(dest)?;
            fs::rename(&temp_path, dest)?;
            Ok(())
        } else {
            Err(rename_error)
        }
    })?;
    Ok(())
}

fn verify_sha256(path: &Path, expected_hash: &str) -> Result<bool> {
    if !path.exists() {
        return Ok(false);
    }
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 8192];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    let hash = hasher.finalize();
    let hex_hash = hex::encode(hash);
    Ok(hex_hash == expected_hash)
}

async fn download_and_verify_model(
    app_handle: &tauri::AppHandle,
    models_dir: &Path,
    filename: &str,
    url: &str,
    expected_hash: &str,
    model_name: &str,
) -> Result<()> {
    let dest_path = models_dir.join(filename);
    let is_valid = verify_sha256(&dest_path, expected_hash)?;

    if !is_valid {
        if dest_path.exists() {
            println!("Model {} has incorrect hash. Re-downloading.", model_name);
            fs::remove_file(&dest_path)?;
        }
        let _ = app_handle.emit("ai-model-download-start", model_name);
        let download_result = download_model(url, &dest_path).await;
        let _ = app_handle.emit("ai-model-download-finish", model_name);
        download_result?;

        if !verify_sha256(&dest_path, expected_hash)? {
            return Err(anyhow::anyhow!(
                "Failed to verify model {} after download. Hash mismatch.",
                model_name
            ));
        }
    }
    Ok(())
}

pub async fn get_or_init_ai_models(
    app_handle: &tauri::AppHandle,
    ai_state_mutex: &Mutex<Option<AiState>>,
    ai_init_lock: &TokioMutex<()>,
) -> Result<Arc<AiModels>> {
    if let Some(models) = ai_state_mutex
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|state| state.models.clone())
    {
        return Ok(models);
    }

    let _guard = ai_init_lock.lock().await;

    if let Some(models) = ai_state_mutex
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|state| state.models.clone())
    {
        return Ok(models);
    }

    let models_dir = get_models_dir(app_handle)?;

    // Keep model weights outside the application bundle. Streamed downloads and
    // SHA-256 verification avoid both a huge binary and a duplicate RAM copy.
    for (filename, url, hash, label) in [
        (SAM3_IMAGE_FILENAME, SAM3_IMAGE_URL, SAM3_IMAGE_SHA256, "SAM 3 vision encoder"),
        (SAM3_TEXT_FILENAME, SAM3_TEXT_URL, SAM3_TEXT_SHA256, "SAM 3 text encoder"),
        (SAM3_DECODER_FILENAME, SAM3_DECODER_URL, SAM3_DECODER_SHA256, "SAM 3 decoder"),
        (SAM3_TOKENIZER_FILENAME, SAM3_TOKENIZER_URL, SAM3_TOKENIZER_SHA256, "SAM 3 tokenizer"),
        (DEPTH_FILENAME, DEPTH_URL, DEPTH_SHA256, "Depth Anything 3 Small"),
    ] {
        download_and_verify_model(app_handle, &models_dir, filename, url, hash, label).await?;
    }

    let _ = ort::init().with_name("AI").commit();

    let sam3_image_encoder = Session::builder()?
        .commit_from_file(models_dir.join(SAM3_IMAGE_FILENAME))?;
    let sam3_text_encoder = Session::builder()?
        .commit_from_file(models_dir.join(SAM3_TEXT_FILENAME))?;
    let sam3_decoder = Session::builder()?
        .commit_from_file(models_dir.join(SAM3_DECODER_FILENAME))?;
    let depth_anything = Session::builder()?
        .commit_from_file(models_dir.join(DEPTH_FILENAME))?;
    let sam3_tokenizer = Tokenizer::from_file(models_dir.join(SAM3_TOKENIZER_FILENAME))
        .map_err(|e| anyhow::anyhow!("Failed to load SAM 3 tokenizer: {e}"))?;

    crate::register_exit_handler();

    let models = Arc::new(AiModels {
        sam3_image_encoder: Mutex::new(sam3_image_encoder),
        sam3_text_encoder: Mutex::new(sam3_text_encoder),
        sam3_decoder: Mutex::new(sam3_decoder),
        sam3_tokenizer,
        depth_anything: Mutex::new(depth_anything),
    });

    let mut ai_state_lock = ai_state_mutex.lock().unwrap();
    if let Some(state) = ai_state_lock.as_mut() {
        state.models = Some(models.clone());
    } else {
        *ai_state_lock = Some(AiState {
            models: Some(models.clone()),
            denoise_model: None,
            clip_models: None,
            lama_model: None,
            normal_model: None,
            embeddings: None,
            depth_map: None,
        });
    }

    Ok(models)
}

pub async fn get_or_init_denoise_model(
    app_handle: &tauri::AppHandle,
    ai_state_mutex: &Mutex<Option<AiState>>,
    ai_init_lock: &TokioMutex<()>,
) -> Result<Arc<Mutex<Session>>> {
    if let Some(denoise_model) = ai_state_mutex
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|state| state.denoise_model.clone())
    {
        return Ok(denoise_model);
    }

    let _guard = ai_init_lock.lock().await;

    if let Some(denoise_model) = ai_state_mutex
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|state| state.denoise_model.clone())
    {
        return Ok(denoise_model);
    }

    let models_dir = get_models_dir(app_handle)?;
    download_and_verify_model(
        app_handle,
        &models_dir,
        DENOISE_FILENAME,
        DENOISE_URL,
        DENOISE_SHA256,
        "NIND Denoise Model",
    )
    .await?;

    let _ = ort::init().with_name("AI-Denoise").commit();
    let model_path = models_dir.join(DENOISE_FILENAME);
    let session = Session::builder()?.commit_from_file(model_path)?;
    let denoise_model = Arc::new(Mutex::new(session));

    crate::register_exit_handler();

    let mut ai_state_lock = ai_state_mutex.lock().unwrap();
    if let Some(state) = ai_state_lock.as_mut() {
        state.denoise_model = Some(denoise_model.clone());
    } else {
        *ai_state_lock = Some(AiState {
            models: None,
            denoise_model: Some(denoise_model.clone()),
            clip_models: None,
            lama_model: None,
            normal_model: None,
            embeddings: None,
            depth_map: None,
        });
    }

    Ok(denoise_model)
}

pub async fn get_or_init_clip_models(
    app_handle: &tauri::AppHandle,
    ai_state_mutex: &Mutex<Option<AiState>>,
    ai_init_lock: &TokioMutex<()>,
) -> Result<Arc<ClipModels>> {
    if let Some(clip_models) = ai_state_mutex
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|state| state.clip_models.clone())
    {
        return Ok(clip_models);
    }

    let _guard = ai_init_lock.lock().await;

    if let Some(clip_models) = ai_state_mutex
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|state| state.clip_models.clone())
    {
        return Ok(clip_models);
    }

    let models_dir = get_models_dir(app_handle)?;

    download_and_verify_model(
        app_handle,
        &models_dir,
        CLIP_MODEL_FILENAME,
        CLIP_MODEL_URL,
        CLIP_MODEL_SHA256,
        "CLIP Model",
    )
    .await?;

    let clip_tokenizer_path = models_dir.join(CLIP_TOKENIZER_FILENAME);
    if !clip_tokenizer_path.exists() {
        let _ = app_handle.emit("ai-model-download-start", "CLIP Tokenizer");
        let download_result = download_model(CLIP_TOKENIZER_URL, &clip_tokenizer_path).await;
        let _ = app_handle.emit("ai-model-download-finish", "CLIP Tokenizer");
        download_result?;
    }

    let _ = ort::init().with_name("AI-Tagging").commit();
    let clip_model_path = models_dir.join(CLIP_MODEL_FILENAME);
    let model = Mutex::new(Session::builder()?.commit_from_file(clip_model_path)?);
    let tokenizer =
        Tokenizer::from_file(clip_tokenizer_path).map_err(|e| anyhow::anyhow!(e.to_string()))?;

    crate::register_exit_handler();

    let clip_models = Arc::new(ClipModels { model, tokenizer });

    let mut ai_state_lock = ai_state_mutex.lock().unwrap();
    if let Some(state) = ai_state_lock.as_mut() {
        state.clip_models = Some(clip_models.clone());
    } else {
        *ai_state_lock = Some(AiState {
            models: None,
            denoise_model: None,
            clip_models: Some(clip_models.clone()),
            lama_model: None,
            normal_model: None,
            embeddings: None,
            depth_map: None,
        });
    }

    Ok(clip_models)
}

pub async fn get_or_init_lama_model(
    app_handle: &tauri::AppHandle,
    ai_state_mutex: &Mutex<Option<AiState>>,
    ai_init_lock: &TokioMutex<()>,
) -> Result<Arc<Mutex<Session>>> {
    if let Some(lama_model) = ai_state_mutex
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|state| state.lama_model.clone())
    {
        return Ok(lama_model);
    }

    let _guard = ai_init_lock.lock().await;

    if let Some(lama_model) = ai_state_mutex
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|state| state.lama_model.clone())
    {
        return Ok(lama_model);
    }

    let models_dir = get_models_dir(app_handle)?;
    download_and_verify_model(
        app_handle,
        &models_dir,
        LAMA_FILENAME,
        LAMA_URL,
        LAMA_SHA256,
        "Inpainting Model",
    )
    .await?;

    let _ = ort::init().with_name("AI-Inpainting").commit();
    let model_path = models_dir.join(LAMA_FILENAME);
    let session = Session::builder()?.commit_from_file(model_path)?;
    let lama_model = Arc::new(Mutex::new(session));

    crate::register_exit_handler();

    let mut ai_state_lock = ai_state_mutex.lock().unwrap();
    if let Some(state) = ai_state_lock.as_mut() {
        state.lama_model = Some(lama_model.clone());
    } else {
        *ai_state_lock = Some(AiState {
            models: None,
            denoise_model: None,
            clip_models: None,
            lama_model: Some(lama_model.clone()),
            normal_model: None,
            embeddings: None,
            depth_map: None,
        });
    }

    Ok(lama_model)
}

pub async fn get_or_init_normal_model(
    app_handle: &tauri::AppHandle,
    ai_state_mutex: &Mutex<Option<AiState>>,
    ai_init_lock: &TokioMutex<()>,
) -> Result<Arc<Mutex<Session>>> {
    if let Some(normal_model) = ai_state_mutex
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|state| state.normal_model.clone())
    {
        return Ok(normal_model);
    }

    let _guard = ai_init_lock.lock().await;

    if let Some(normal_model) = ai_state_mutex
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|state| state.normal_model.clone())
    {
        return Ok(normal_model);
    }

    let models_dir = get_models_dir(app_handle)?;
    download_and_verify_model(
        app_handle,
        &models_dir,
        NORMAL_FILENAME,
        NORMAL_URL,
        NORMAL_SHA256,
        "Normal Model",
    )
    .await?;

    let _ = ort::init().with_name("AI-Normal").commit();
    let model_path = models_dir.join(NORMAL_FILENAME);
    let session = Session::builder()?.commit_from_file(model_path)?;
    let normal_model = Arc::new(Mutex::new(session));

    crate::register_exit_handler();

    let mut ai_state_lock = ai_state_mutex.lock().unwrap();
    if let Some(state) = ai_state_lock.as_mut() {
        state.normal_model = Some(normal_model.clone());
    } else {
        *ai_state_lock = Some(AiState {
            models: None,
            denoise_model: None,
            clip_models: None,
            lama_model: None,
            normal_model: Some(normal_model.clone()),
            embeddings: None,
            depth_map: None,
        });
    }

    Ok(normal_model)
}

#[derive(Clone, Copy)]
struct TileParams {
    cs: usize,
    ucs: usize,
    overlap: usize,
    pad: usize,
}

impl TileParams {
    const fn new(cs: usize, ucs: usize, overlap: usize) -> Self {
        Self {
            cs,
            ucs,
            overlap,
            pad: (cs - ucs) / 2,
        }
    }
}

const TILE_BALANCED: TileParams = TileParams::new(504, 480, 6);
const TILE_FASTER: TileParams = TileParams::new(504, 504, 0);
const TILE_HIGHER_QUALITY: TileParams = TileParams::new(504, 448, 12);

fn select_tile_params(quality_0_1: f32) -> TileParams {
    let q = quality_0_1.clamp(0.0, 1.0);
    if q <= 0.25 {
        TILE_FASTER
    } else if q >= 0.75 {
        TILE_HIGHER_QUALITY
    } else {
        TILE_BALANCED
    }
}

#[inline]
fn mirror_coord(c: i32, size: i32) -> i32 {
    if c < 0 {
        (-c).min(size - 1)
    } else if c >= size {
        (2 * size - 1 - c).max(0)
    } else {
        c
    }
}

fn extract_tile_mirror(img: &Rgb32FImage, x0: i32, y0: i32, cs: usize) -> Array4<f32> {
    let (w, h) = (img.width() as i32, img.height() as i32);
    let mut arr = Array4::zeros((1, 3, cs, cs));
    for dy in 0..cs as i32 {
        for dx in 0..cs as i32 {
            let sx = mirror_coord(x0 + dx, w);
            let sy = mirror_coord(y0 + dy, h);
            let px = img.get_pixel(sx as u32, sy as u32);
            arr[[0, 0, dy as usize, dx as usize]] = px[0];
            arr[[0, 1, dy as usize, dx as usize]] = px[1];
            arr[[0, 2, dy as usize, dx as usize]] = px[2];
        }
    }
    arr
}

struct SeamlessBlend {
    ud0: usize,
    ud1: usize,
    ud2: usize,
    ud3: usize,
    absx0: usize,
    absy0: usize,
    fswidth: usize,
    fsheight: usize,
    overlap: usize,
}

fn apply_seamless(tile: &mut Array4<f32>, blend: &SeamlessBlend) {
    let SeamlessBlend {
        ud0,
        ud1,
        ud2,
        ud3,
        absx0,
        absy0,
        fswidth,
        fsheight,
        overlap,
    } = *blend;
    let ol = overlap;
    if absx0 > 0 {
        for c in 0..3 {
            for y in ud1..ud3 {
                for x in ud0..(ud0 + ol).min(ud2) {
                    tile[[0, c, y, x]] *= 0.5;
                }
            }
        }
    }
    if absy0 > 0 {
        for c in 0..3 {
            for y in ud1..(ud1 + ol).min(ud3) {
                for x in ud0..ud2 {
                    tile[[0, c, y, x]] *= 0.5;
                }
            }
        }
    }
    if absx0 + (ud2 - ud0) < fswidth && ol > 0 {
        let right_start = (ud2 as i32 - ol as i32).max(ud0 as i32) as usize;
        for c in 0..3 {
            for y in ud1..ud3 {
                for x in right_start..ud2 {
                    tile[[0, c, y, x]] *= 0.5;
                }
            }
        }
    }
    if absy0 + (ud3 - ud1) < fsheight && ol > 0 {
        let bottom_start = (ud3 as i32 - ol as i32).max(ud1 as i32) as usize;
        for c in 0..3 {
            for y in bottom_start..ud3 {
                for x in ud0..ud2 {
                    tile[[0, c, y, x]] *= 0.5;
                }
            }
        }
    }
}

fn run_native_denoise(
    img: &Rgb32FImage,
    session: &Mutex<Session>,
    accumulator: &mut [f32],
    width: usize,
    height: usize,
    app_handle: &tauri::AppHandle,
    params: TileParams,
) -> Result<()> {
    let w = width as i32;
    let h = height as i32;
    let step = params.ucs.saturating_sub(params.overlap).max(1);
    let iperhl = (width.saturating_sub(params.ucs) as f64 / step as f64).ceil() as usize;
    let ipervl = (height.saturating_sub(params.ucs) as f64 / step as f64).ceil() as usize;
    let total = (iperhl + 1) * (ipervl + 1);

    for i in 0..total {
        let yi = i / (iperhl + 1);
        let xi = i % (iperhl + 1);
        let x0 =
            params.ucs as i32 * xi as i32 - params.overlap as i32 * xi as i32 - params.pad as i32;
        let y0 =
            params.ucs as i32 * yi as i32 - params.overlap as i32 * yi as i32 - params.pad as i32;

        if i % 10 == 0 {
            let pct = (i as f32 / total as f32) * 100.0;
            let _ = app_handle.emit("denoise-progress", format!("Denoising… {:.0}%", pct));
        }

        let crop = extract_tile_mirror(img, x0, y0, params.cs);
        let input_values = crop.as_standard_layout().to_owned();
        let t_input = Tensor::from_array(input_values)?;

        let out = {
            let mut sess = session.lock().unwrap();
            let outputs = sess.run(ort::inputs![t_input])?;
            let arr = outputs[0].try_extract_array::<f32>()?.to_owned();
            arr.into_dimensionality::<ndarray::Ix4>()
                .map_err(|e| anyhow::anyhow!("Unexpected output shape: {}", e))?
        };

        let x1pad = (0i32).max(x0 + params.cs as i32 - w) as usize;
        let y1pad = (0i32).max(y0 + params.cs as i32 - h) as usize;
        let ud0 = params.pad;
        let ud1 = params.pad;
        let ud2 = params.cs - params.pad.max(x1pad);
        let ud3 = params.cs - params.pad.max(y1pad);
        let absx0 = (x0 + params.pad as i32).max(0) as usize;
        let absy0 = (y0 + params.pad as i32).max(0) as usize;

        let mut tile = out;
        apply_seamless(
            &mut tile,
            &SeamlessBlend {
                ud0,
                ud1,
                ud2,
                ud3,
                absx0,
                absy0,
                fswidth: width,
                fsheight: height,
                overlap: params.overlap,
            },
        );

        for cy in 0..(ud3 - ud1) {
            for cx in 0..(ud2 - ud0) {
                let gx = absx0 + cx;
                let gy = absy0 + cy;
                if gx < width && gy < height {
                    let base = (gy * width + gx) * 3;
                    accumulator[base] += tile[[0, 0, ud1 + cy, ud0 + cx]].clamp(0.0, 1.0);
                    accumulator[base + 1] += tile[[0, 1, ud1 + cy, ud0 + cx]].clamp(0.0, 1.0);
                    accumulator[base + 2] += tile[[0, 2, ud1 + cy, ud0 + cx]].clamp(0.0, 1.0);
                }
            }
        }
    }
    Ok(())
}

fn accumulator_to_rgb32f(acc: &[f32], width: u32, height: u32) -> Rgb32FImage {
    let mut out = Rgb32FImage::new(width, height);
    for (i, p) in out.pixels_mut().enumerate() {
        let i3 = i * 3;
        *p = Rgb([
            acc[i3].clamp(0.0, 1.0),
            acc[i3 + 1].clamp(0.0, 1.0),
            acc[i3 + 2].clamp(0.0, 1.0),
        ]);
    }
    out
}

pub fn run_ai_denoise(
    rgb_img: &Rgb32FImage,
    intensity: f32,
    session: &Mutex<Session>,
    app_handle: &tauri::AppHandle,
) -> Result<DynamicImage> {
    let (width, height) = rgb_img.dimensions();
    let params = select_tile_params(intensity);

    let _ = app_handle.emit("denoise-progress", "Denoising (AI NIND)...");
    let mut accumulator = vec![0.0f32; width as usize * height as usize * 3];
    run_native_denoise(
        rgb_img,
        session,
        &mut accumulator,
        width as usize,
        height as usize,
        app_handle,
        params,
    )?;

    let out_img_buffer = accumulator_to_rgb32f(&accumulator, width, height);
    Ok(DynamicImage::ImageRgb32F(out_img_buffer))
}

pub fn run_lama_inpainting(
    image: &DynamicImage,
    mask: &GrayImage,
    lama_session: &Mutex<Session>,
) -> Result<RgbaImage> {
    let (w, h) = image.dimensions();

    let (mut min_x, mut min_y) = (w, h);
    let (mut max_x, mut max_y) = (0u32, 0u32);
    let mut has_mask = false;

    for (x, y, p) in mask.enumerate_pixels() {
        if p[0] > 0 {
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
            has_mask = true;
        }
    }

    if !has_mask {
        return Ok(image.to_rgba8());
    }

    let mask_w = max_x - min_x + 1;
    let mask_h = max_y - min_y + 1;

    let pad_x = 128.max((mask_w as f32 * 1.5) as u32);
    let pad_y = 128.max((mask_h as f32 * 1.5) as u32);

    let x0 = min_x.saturating_sub(pad_x);
    let y0 = min_y.saturating_sub(pad_y);
    let x1 = (max_x + pad_x).min(w.saturating_sub(1));
    let y1 = (max_y + pad_y).min(h.saturating_sub(1));

    let crop_w = x1 - x0 + 1;
    let crop_h = y1 - y0 + 1;

    let rgba = image.to_rgba8();

    let cropped_img = imageops::crop_imm(&rgba, x0, y0, crop_w, crop_h).to_image();
    let cropped_mask = imageops::crop_imm(mask, x0, y0, crop_w, crop_h).to_image();

    let max_dim_limit: u32 = 768;
    let needs_downscale = crop_w > max_dim_limit || crop_h > max_dim_limit;

    let (fw, fh, inf_img, inf_mask) = if needs_downscale {
        let scale = max_dim_limit as f32 / crop_w.max(crop_h) as f32;

        let scaled_w = (crop_w as f32 * scale).round().max(1.0) as u32;
        let scaled_h = (crop_h as f32 * scale).round().max(1.0) as u32;

        (
            scaled_w,
            scaled_h,
            imageops::resize(&cropped_img, scaled_w, scaled_h, FilterType::Lanczos3),
            imageops::resize(&cropped_mask, scaled_w, scaled_h, FilterType::Triangle),
        )
    } else {
        (crop_w, crop_h, cropped_img.clone(), cropped_mask.clone())
    };

    let align = 64u32;
    let mut tensor_dim = fw.max(fh);
    if tensor_dim % align != 0 {
        tensor_dim += align - (tensor_dim % align);
    }
    let tensor_dim = tensor_dim.max(align) as usize;

    let mut img_tensor = Array::<f32, _>::zeros((1, 3, tensor_dim, tensor_dim));
    let mut msk_tensor = Array::<f32, _>::zeros((1, 1, tensor_dim, tensor_dim));

    for y in 0..tensor_dim {
        for x in 0..tensor_dim {
            let sx = (x as u32).min(fw.saturating_sub(1));
            let sy = (y as u32).min(fh.saturating_sub(1));

            let p = inf_img.get_pixel(sx, sy);
            let m = inf_mask.get_pixel(sx, sy)[0];

            img_tensor[[0, 0, y, x]] = p[0] as f32 / 255.0;
            img_tensor[[0, 1, y, x]] = p[1] as f32 / 255.0;
            img_tensor[[0, 2, y, x]] = p[2] as f32 / 255.0;
            msk_tensor[[0, 0, y, x]] = if m > 0 { 1.0 } else { 0.0 };
        }
    }

    let t_img = Tensor::from_array(img_tensor.into_dyn().as_standard_layout().into_owned())?;
    let t_msk = Tensor::from_array(msk_tensor.into_dyn().as_standard_layout().into_owned())?;

    let output_tensor = {
        let mut session = lama_session.lock().unwrap();
        let outputs = session.run(ort::inputs!["image" => t_img, "mask" => t_msk])?;
        outputs[0].try_extract_array::<f32>()?.to_owned()
    };

    let mut result_inf = RgbaImage::new(fw, fh);
    for y in 0..fh {
        for x in 0..fw {
            let r = output_tensor[[0, 0, y as usize, x as usize]].clamp(0.0, 255.0) as u8;
            let g = output_tensor[[0, 1, y as usize, x as usize]].clamp(0.0, 255.0) as u8;
            let b = output_tensor[[0, 2, y as usize, x as usize]].clamp(0.0, 255.0) as u8;
            result_inf.put_pixel(x, y, Rgba([r, g, b, 255]));
        }
    }

    let result_crop = if needs_downscale {
        imageops::resize(&result_inf, crop_w, crop_h, FilterType::Lanczos3)
    } else {
        result_inf
    };

    let mut final_image = image.to_rgba8();

    for y in 0..crop_h {
        for x in 0..crop_w {
            let m = cropped_mask.get_pixel(x, y)[0];
            if m > 0 {
                let alpha = m as f32 / 255.0;
                let p = result_crop.get_pixel(x, y);
                let gx = x0 + x;
                let gy = y0 + y;
                let orig = final_image.get_pixel(gx, gy);

                let r = (p[0] as f32 * alpha + orig[0] as f32 * (1.0 - alpha)) as u8;
                let g = (p[1] as f32 * alpha + orig[1] as f32 * (1.0 - alpha)) as u8;
                let b = (p[2] as f32 * alpha + orig[2] as f32 * (1.0 - alpha)) as u8;

                final_image.put_pixel(gx, gy, Rgba([r, g, b, 255]));
            }
        }
    }

    Ok(final_image)
}

pub fn generate_sam3_image_embeddings(
    image: &DynamicImage,
    encoder: &Mutex<Session>,
) -> Result<Sam3ImageEmbeddings> {
    let (original_width, original_height) = image.dimensions();
    if original_width == 0 || original_height == 0 {
        anyhow::bail!("Cannot segment an empty image");
    }

    // SAM 3 ONNX export expects an RGB NCHW tensor normalized to [-1, 1].
    // Keep one image per call to cap activation memory on 16 GB machines.
    let resized = image.resize_exact(
        SAM3_INPUT_SIZE,
        SAM3_INPUT_SIZE,
        FilterType::Triangle,
    ).into_rgb8();
    let raw = resized.as_raw();
    let area = (SAM3_INPUT_SIZE as usize) * (SAM3_INPUT_SIZE as usize);
    let mut chw = Vec::with_capacity(area * 3);
    for channel in 0..3 {
        for pixel in raw.chunks_exact(3) {
            chw.push(pixel[channel] as f32 / 127.5 - 1.0);
        }
    }
    let input = Array::from_shape_vec(
        (1, 3, SAM3_INPUT_SIZE as usize, SAM3_INPUT_SIZE as usize),
        chw,
    )?;
    let input = Tensor::from_array(input)?;

    let mut session = encoder.lock().unwrap();
    let outputs = session.run(ort::inputs!["images" => input])?;
    if outputs.len() < 4 {
        anyhow::bail!("SAM 3 vision encoder returned {} outputs; expected 4", outputs.len());
    }

    let mut features = Vec::with_capacity(4);
    for index in 0..4 {
        let owned = outputs[index].view().try_upgrade()?;
        features.push(Arc::new(owned));
    }

    Ok(Sam3ImageEmbeddings {
        path_hash: String::new(),
        features,
        original_size: (original_width, original_height),
    })
}

fn encode_sam3_text(
    prompt: &str,
    tokenizer: &Tokenizer,
    text_encoder: &Mutex<Session>,
) -> Result<(Arc<DynValue>, Arc<DynValue>)> {
    let encoded = tokenizer.encode(prompt, true)
        .map_err(|e| anyhow::anyhow!("SAM 3 tokenization failed: {e}"))?;
    let ids = encoded.get_ids();
    let mask = encoded.get_attention_mask();

    let mut input_ids = vec![SAM3_PAD_TOKEN_ID; SAM3_TEXT_LENGTH];
    let mut attention_mask = vec![0_i64; SAM3_TEXT_LENGTH];
    let copied = if ids.len() > SAM3_TEXT_LENGTH { SAM3_TEXT_LENGTH - 1 } else { ids.len() };
    for index in 0..copied {
        input_ids[index] = ids[index] as i64;
        attention_mask[index] = mask.get(index).copied().unwrap_or(1) as i64;
    }
    // When truncation was necessary, reserve the final slot for CLIP's end token.
    if ids.len() > SAM3_TEXT_LENGTH {
        input_ids[SAM3_TEXT_LENGTH - 1] = SAM3_PAD_TOKEN_ID;
        attention_mask[SAM3_TEXT_LENGTH - 1] = 1;
    }

    let ids_tensor = Tensor::from_array(Array::from_shape_vec((1, SAM3_TEXT_LENGTH), input_ids)?)?;
    let mask_tensor = Tensor::from_array(Array::from_shape_vec((1, SAM3_TEXT_LENGTH), attention_mask)?)?;

    let mut session = text_encoder.lock().unwrap();
    let outputs = session.run(ort::inputs![
        "input_ids" => ids_tensor,
        "attention_mask" => mask_tensor
    ])?;
    if outputs.len() < 2 {
        anyhow::bail!("SAM 3 text encoder returned {} outputs; expected 2", outputs.len());
    }

    Ok((
        Arc::new(outputs[0].view().try_upgrade()?),
        Arc::new(outputs[1].view().try_upgrade()?),
    ))
}

fn sam3_sigmoid(value: f32) -> f32 {
    1.0 / (1.0 + (-value.clamp(-80.0, 80.0)).exp())
}

pub fn run_sam3_decoder(
    embeddings: &Sam3ImageEmbeddings,
    text_prompt: &str,
    geometry: Option<((f64, f64), (f64, f64))>,
    text_encoder: &Mutex<Session>,
    decoder: &Mutex<Session>,
    tokenizer: &Tokenizer,
) -> Result<GrayImage> {
    let (orig_width, orig_height) = embeddings.original_size;
    if embeddings.features.len() != 4 {
        anyhow::bail!("SAM 3 image embeddings are incomplete");
    }

    let (box_values, label_value, normalized_box) = if let Some((start, end)) = geometry {
        let width = orig_width.max(1) as f64;
        let height = orig_height.max(1) as f64;
        let mut x1 = start.0.min(end.0).clamp(0.0, width);
        let mut y1 = start.1.min(end.1).clamp(0.0, height);
        let mut x2 = start.0.max(end.0).clamp(0.0, width);
        let mut y2 = start.1.max(end.1).clamp(0.0, height);
        let is_point = (x2 - x1).abs() < 1.0 && (y2 - y1).abs() < 1.0;
        if is_point {
            let cx = (x1 / width).clamp(0.0, 1.0);
            let cy = (y1 / height).clamp(0.0, 1.0);
            let box_width = 0.01_f64;
            let box_height = 0.01_f64;
            x1 = (cx - box_width / 2.0).max(0.0);
            y1 = (cy - box_height / 2.0).max(0.0);
            x2 = (cx + box_width / 2.0).min(1.0);
            y2 = (cy + box_height / 2.0).min(1.0);
            let box_values = vec![
                ((x1 + x2) / 2.0) as f32,
                ((y1 + y2) / 2.0) as f32,
                (x2 - x1) as f32,
                (y2 - y1) as f32,
            ];
            (box_values.clone(), 1_i64, Some((box_values, true)))
        } else {
            let nx1 = (x1 / width).clamp(0.0, 1.0);
            let ny1 = (y1 / height).clamp(0.0, 1.0);
            let nx2 = (x2 / width).clamp(0.0, 1.0);
            let ny2 = (y2 / height).clamp(0.0, 1.0);
            let values = vec![
                ((nx1 + nx2) / 2.0) as f32,
                ((ny1 + ny2) / 2.0) as f32,
                (nx2 - nx1) as f32,
                (ny2 - ny1) as f32,
            ];
            (values.clone(), 1_i64, Some((values, false)))
        }
    } else {
        (vec![0.0_f32, 0.0, 0.0, 0.0], -10_i64, None)
    };

    let boxes = Tensor::from_array(Array::from_shape_vec((1, 1, 4), box_values)?)?;
    let labels = Tensor::from_array(Array::from_shape_vec((1, 1), vec![label_value])?)?;
    let (text_features, text_mask) = encode_sam3_text(text_prompt, tokenizer, text_encoder)?;

    let mut session = decoder.lock().unwrap();
    let outputs = session.run(ort::inputs![
        "fpn_feat_0" => embeddings.features[0].as_ref(),
        "fpn_feat_1" => embeddings.features[1].as_ref(),
        "fpn_feat_2" => embeddings.features[2].as_ref(),
        "fpn_pos_2" => embeddings.features[3].as_ref(),
        "text_features" => text_features.as_ref(),
        "text_mask" => text_mask.as_ref(),
        "input_boxes" => boxes,
        "input_boxes_labels" => labels
    ])?;
    if outputs.len() < 4 {
        anyhow::bail!("SAM 3 decoder returned {} outputs; expected 4", outputs.len());
    }

    let pred_masks = outputs[0].try_extract_array::<f32>()?.to_owned();
    let pred_boxes = outputs[1].try_extract_array::<f32>()?.to_owned();
    let pred_logits = outputs[2].try_extract_array::<f32>()?.to_owned();
    let presence_logits = outputs[3].try_extract_array::<f32>()?.to_owned();

    let mask_shape = pred_masks.shape();
    let (count, mask_height, mask_width) = match mask_shape {
        [1, n, h, w] => (*n, *h, *w),
        [n, h, w] => (*n, *h, *w),
        _ => anyhow::bail!("Unexpected SAM 3 mask tensor shape: {mask_shape:?}"),
    };
    if count == 0 || mask_height == 0 || mask_width == 0 {
        return Ok(GrayImage::new(orig_width, orig_height));
    }
    let mask_values = pred_masks.as_slice().ok_or_else(|| anyhow::anyhow!("Non-contiguous SAM 3 masks"))?;
    let score_values = pred_logits.as_slice().ok_or_else(|| anyhow::anyhow!("Non-contiguous SAM 3 scores"))?;
    let box_values = pred_boxes.as_slice().ok_or_else(|| anyhow::anyhow!("Non-contiguous SAM 3 boxes"))?;
    let presence = presence_logits.as_slice().and_then(|v| v.first()).copied().unwrap_or(0.0);
    let presence_score = sam3_sigmoid(presence);
    let mask_area = mask_height * mask_width;

    let mut best_index = None;
    let mut best_rank = f32::NEG_INFINITY;
    for index in 0..count.min(score_values.len()) {
        let score = sam3_sigmoid(score_values[index]) * presence_score;
        if score < 0.15 {
            continue;
        }
        let mut rank = score;
        if let Some((box_norm, is_point)) = normalized_box.as_ref() {
            if *is_point {
                let cx = box_norm[0].clamp(0.0, 1.0);
                let cy = box_norm[1].clamp(0.0, 1.0);
                let px = ((cx * mask_width as f32).floor() as usize).min(mask_width - 1);
                let py = ((cy * mask_height as f32).floor() as usize).min(mask_height - 1);
                let value = mask_values[index * mask_area + py * mask_width + px];
                if value > 0.0 { rank += 2.0; }
            } else if box_values.len() >= index * 4 + 4 {
                let p = &box_values[index * 4..index * 4 + 4];
                let (cx, cy, bw, bh) = (p[0], p[1], p[2], p[3]);
                let px1 = box_norm[0] - box_norm[2] / 2.0;
                let py1 = box_norm[1] - box_norm[3] / 2.0;
                let px2 = box_norm[0] + box_norm[2] / 2.0;
                let py2 = box_norm[1] + box_norm[3] / 2.0;
                let x1 = (cx - bw / 2.0).max(px1);
                let y1 = (cy - bh / 2.0).max(py1);
                let x2 = (cx + bw / 2.0).min(px2);
                let y2 = (cy + bh / 2.0).min(py2);
                let intersection = (x2 - x1).max(0.0) * (y2 - y1).max(0.0);
                let area_a = bw.max(0.0) * bh.max(0.0);
                let area_b = box_norm[2].max(0.0) * box_norm[3].max(0.0);
                let union = area_a + area_b - intersection;
                if union > 0.0 { rank += 1.5 * intersection / union; }
            }
        }
        if rank > best_rank {
            best_rank = rank;
            best_index = Some(index);
        }
    }
    let Some(best_index) = best_index else {
        return Ok(GrayImage::new(orig_width, orig_height));
    };

    // Only upscale the winning mask. Upscaling all 200 proposals would multiply
    // memory use on large photographs without improving the chosen result.
    let offset = best_index * mask_area;
    let probabilities: Vec<f32> = mask_values[offset..offset + mask_area]
        .iter().map(|&v| sam3_sigmoid(v)).collect();
    let low_res = ImageBuffer::<Luma<f32>, Vec<f32>>::from_raw(
        mask_width as u32,
        mask_height as u32,
        probabilities,
    ).ok_or_else(|| anyhow::anyhow!("Invalid SAM 3 mask dimensions"))?;
    let resized = imageops::resize(&low_res, orig_width, orig_height, FilterType::Triangle);
    let binary = resized.as_raw().iter().map(|&value| if value >= 0.5 { 255 } else { 0 }).collect();
    GrayImage::from_raw(orig_width, orig_height, binary)
        .ok_or_else(|| anyhow::anyhow!("Failed to create full-resolution SAM 3 mask"))
}

pub fn run_sam3_text_mask(
    image: &DynamicImage,
    text_prompt: &str,
    image_encoder: &Mutex<Session>,
    text_encoder: &Mutex<Session>,
    decoder: &Mutex<Session>,
    tokenizer: &Tokenizer,
) -> Result<GrayImage> {
    let embeddings = generate_sam3_image_embeddings(image, image_encoder)?;
    run_sam3_decoder(&embeddings, text_prompt, None, text_encoder, decoder, tokenizer)
}

pub fn run_depth_anything3_model(
    image: &DynamicImage,
    depth_session: &Mutex<Session>,
) -> Result<GrayImage> {
    let (original_width, original_height) = image.dimensions();
    if original_width == 0 || original_height == 0 {
        anyhow::bail!("Cannot estimate depth for an empty image");
    }

    // DA3-Small ONNX expects square RGB ImageNet-normalized NCHW input.
    let resized = image.resize_exact(
        DEPTH_INPUT_SIZE,
        DEPTH_INPUT_SIZE,
        FilterType::Triangle,
    ).into_rgb8();
    let raw = resized.as_raw();
    let area = (DEPTH_INPUT_SIZE as usize) * (DEPTH_INPUT_SIZE as usize);
    let mean = [0.485_f32, 0.456, 0.406];
    let std = [0.229_f32, 0.224, 0.225];
    let mut chw = Vec::with_capacity(area * 3);
    for channel in 0..3 {
        for pixel in raw.chunks_exact(3) {
            chw.push((pixel[channel] as f32 / 255.0 - mean[channel]) / std[channel]);
        }
    }
    let input = Tensor::from_array(Array::from_shape_vec(
        (1, 3, DEPTH_INPUT_SIZE as usize, DEPTH_INPUT_SIZE as usize),
        chw,
    )?)?;

    let mut session = depth_session.lock().unwrap();
    let outputs = session.run(ort::inputs!["image" => input])?;
    if outputs.is_empty() {
        anyhow::bail!("Depth Anything 3 returned no output tensors");
    }
    let depth = outputs[0].try_extract_array::<f32>()?.to_owned();
    let values = depth.as_slice().ok_or_else(|| anyhow::anyhow!("Non-contiguous DA3 output"))?;
    if values.len() < area {
        anyhow::bail!("Depth Anything 3 returned too few depth values: {}", values.len());
    }

    let valid = &values[..area];
    let (min_value, max_value) = valid.iter().copied().filter(|v| v.is_finite())
        .fold((f32::INFINITY, f32::NEG_INFINITY), |(lo, hi), value| {
            (lo.min(value), hi.max(value))
        });
    if !min_value.is_finite() || !max_value.is_finite() || max_value - min_value <= f32::EPSILON {
        anyhow::bail!("Depth Anything 3 returned an invalid or constant depth map");
    }
    let scale = 255.0 / (max_value - min_value);
    let normalized = valid.iter().map(|&value| {
        if value.is_finite() { ((value - min_value) * scale).clamp(0.0, 255.0) as u8 } else { 0 }
    }).collect::<Vec<u8>>();
    let low_res = GrayImage::from_raw(DEPTH_INPUT_SIZE, DEPTH_INPUT_SIZE, normalized)
        .ok_or_else(|| anyhow::anyhow!("Failed to create DA3 depth image"))?;
    Ok(imageops::resize(&low_res, original_width, original_height, FilterType::Triangle))
}

fn build_normal_depth(points: &[f32], mask: &[f32]) -> Vec<u8> {
    let valid = |point: &[f32; 3], m: f32| {
        m >= 0.5 && point.iter().all(|v| v.is_finite()) && point[2] > 0.0
    };

    let mut depths: Vec<f32> = points
        .as_chunks::<3>()
        .0
        .iter()
        .zip(mask)
        .filter(|(point, m)| valid(point, **m))
        .map(|(point, _)| point[2])
        .collect();

    if depths.len() < 16 {
        return vec![255; mask.len()];
    }

    depths.sort_unstable_by(|a, b| a.total_cmp(b));
    let percentile = |p: f32| depths[((depths.len() - 1) as f32 * p) as usize];
    let near = percentile(0.005);
    let range = (percentile(0.995) - near).max(1e-6);

    points
        .as_chunks::<3>()
        .0
        .iter()
        .zip(mask)
        .map(|(point, m)| {
            if valid(point, *m) {
                (((point[2] - near) / range).clamp(0.0, 1.0) * 255.0).round() as u8
            } else {
                255
            }
        })
        .collect()
}

pub fn run_normal_model(
    image: &DynamicImage,
    normal_session: &Mutex<Session>,
) -> Result<RgbaImage> {
    let resized_image = if image.width().max(image.height()) > NORMAL_MAX_SIZE {
        image.resize(NORMAL_MAX_SIZE, NORMAL_MAX_SIZE, FilterType::Triangle)
    } else {
        image.clone()
    };
    let (resized_w, resized_h) = resized_image.dimensions();
    let resized_rgb = resized_image.into_rgb8();
    let raw_pixels = resized_rgb.as_raw();

    let rw = resized_w as usize;
    let rh = resized_h as usize;

    let mut input_tensor: Array<f32, _> = Array::zeros((1, 3, rh, rw));
    for y in 0..rh {
        for x in 0..rw {
            let idx = (y * rw + x) * 3;
            input_tensor[[0, 0, y, x]] = raw_pixels[idx] as f32 / 255.0;
            input_tensor[[0, 1, y, x]] = raw_pixels[idx + 1] as f32 / 255.0;
            input_tensor[[0, 2, y, x]] = raw_pixels[idx + 2] as f32 / 255.0;
        }
    }

    let t_image = Tensor::from_array(input_tensor.into_dyn())?;
    let t_num_tokens = Tensor::from_array(ndarray::arr0(NORMAL_NUM_TOKENS))?;

    let mut session = normal_session.lock().unwrap();
    let outputs = session.run(ort::inputs![
        "image" => t_image,
        "num_tokens" => t_num_tokens,
    ])?;

    let normal_tensor = outputs["normal"].try_extract_array::<f32>()?;
    let mask_tensor = outputs["mask"].try_extract_array::<f32>()?;
    let points_tensor = outputs["points"].try_extract_array::<f32>()?;

    if normal_tensor.shape() != [1, rh, rw, 3]
        || mask_tensor.shape() != [1, rh, rw]
        || points_tensor.shape() != [1, rh, rw, 3]
    {
        return Err(anyhow::anyhow!(
            "Unexpected normal model output shape: {:?} / {:?} / {:?}",
            normal_tensor.shape(),
            mask_tensor.shape(),
            points_tensor.shape()
        ));
    }

    let normals = normal_tensor.as_standard_layout();
    let normals = normals.as_slice().unwrap();
    let mask = mask_tensor.as_standard_layout();
    let mask = mask.as_slice().unwrap();
    let points = points_tensor.as_standard_layout();
    let depth = build_normal_depth(points.as_slice().unwrap(), mask);

    let pack = |v: f32| ((v * 0.5 + 0.5).clamp(0.0, 1.0) * 255.0).round() as u8;

    let mut normal_data = Vec::with_capacity(rw * rh * 4);
    for (n, d) in normals.as_chunks::<3>().0.iter().zip(depth) {
        let (nx, ny, nz) = (n[0], -n[1], -n[2]);
        let len = (nx * nx + ny * ny + nz * nz).sqrt();
        if len.is_finite() && len > 1e-6 {
            normal_data.extend_from_slice(&[pack(nx / len), pack(ny / len), pack(nz / len)]);
        } else {
            normal_data.extend_from_slice(&[128, 128, 255]);
        }
        normal_data.push(d);
    }

    RgbaImage::from_raw(resized_w, resized_h, normal_data)
        .ok_or_else(|| anyhow::anyhow!("Failed to create normal map from model output"))
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiSubjectMaskParameters {
    pub start_x: f64,
    pub start_y: f64,
    pub end_x: f64,
    pub end_y: f64,
    #[serde(default)]
    pub mask_data_base64: Option<String>,
    #[serde(default)]
    pub rotation: Option<f32>,
    #[serde(default)]
    pub flip_horizontal: Option<bool>,
    #[serde(default)]
    pub flip_vertical: Option<bool>,
    #[serde(default)]
    pub orientation_steps: Option<u8>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiSkyMaskParameters {
    #[serde(default)]
    pub mask_data_base64: Option<String>,
    #[serde(default)]
    pub rotation: Option<f32>,
    #[serde(default)]
    pub flip_horizontal: Option<bool>,
    #[serde(default)]
    pub flip_vertical: Option<bool>,
    #[serde(default)]
    pub orientation_steps: Option<u8>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiForegroundMaskParameters {
    #[serde(default)]
    pub mask_data_base64: Option<String>,
    #[serde(default)]
    pub rotation: Option<f32>,
    #[serde(default)]
    pub flip_horizontal: Option<bool>,
    #[serde(default)]
    pub flip_vertical: Option<bool>,
    #[serde(default)]
    pub orientation_steps: Option<u8>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiDepthMaskParameters {
    #[serde(default)]
    pub min_depth: f32,
    #[serde(default)]
    pub max_depth: f32,
    #[serde(default)]
    pub min_fade: f32,
    #[serde(default)]
    pub max_fade: f32,
    #[serde(default)]
    pub feather: f32,
    #[serde(default)]
    pub mask_data_base64: Option<String>,
    #[serde(default)]
    pub rotation: Option<f32>,
    #[serde(default)]
    pub flip_horizontal: Option<bool>,
    #[serde(default)]
    pub flip_vertical: Option<bool>,
    #[serde(default)]
    pub orientation_steps: Option<u8>,
}
