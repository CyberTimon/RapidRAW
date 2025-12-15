use std::fs;
use std::io::{self, Cursor};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::Result;
use image::imageops::{self, FilterType};
use image::{DynamicImage, GenericImageView, GrayImage};
use ndarray::{Array, IxDyn};
use ort::session::Session;
use ort::value::Tensor;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Emitter;
use tauri::Manager;
use tokenizers::Tokenizer;
use tokio::sync::Mutex as TokioMutex;

use crate::file_management;

const ENCODER_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/vit_t_encoder.onnx?download=true";
const DECODER_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/vit_t_decoder.onnx?download=true";
const ENCODER_FILENAME: &str = "vit_t_encoder.onnx";
const DECODER_FILENAME: &str = "vit_t_decoder.onnx";
const SAM_INPUT_SIZE: u32 = 1024;
const ENCODER_SHA256: &str = "8b8168033ea6687bb55ba242222b67a301ac9da30fd5cbfd04dcebbb180ec2a8";
const DECODER_SHA256: &str = "1b216fb3b8ceeee00a65f89670c01e4c0d823fcacec39dd9accc233f85341dc4";

const U2NETP_URL: &str =
    "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/u2net.onnx?download=true";
const U2NETP_FILENAME: &str = "u2net.onnx";
const U2NETP_INPUT_SIZE: u32 = 320;
const U2NETP_SHA256: &str = "8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491";

const SKYSEG_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/skyseg-u2net.onnx?download=true";
const SKYSEG_FILENAME: &str = "skyseg_u2net.onnx";
const SKYSEG_INPUT_SIZE: u32 = 320;
const SKYSEG_SHA256: &str = "ab9c34c64c3d821220a2886a4a06da4642ffa14d5b30e8d5339056a089aa1d39";

const CLIP_MODEL_URL: &str =
    "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/clip_model.onnx?download=true";
const CLIP_MODEL_FILENAME: &str = "clip_model.onnx";
const CLIP_TOKENIZER_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/clip_tokenizer.json?download=true";
const CLIP_TOKENIZER_FILENAME: &str = "clip_tokenizer.json";
const CLIP_MODEL_SHA256: &str = "57879bb1c23cdeb350d23569dd251ed4b740a96d747c529e94a2bb8040ac5d00";

pub struct AiModels {
    pub sam_encoder: Mutex<Session>,
    pub sam_decoder: Mutex<Session>,
    pub u2netp: Mutex<Session>,
    pub sky_seg: Mutex<Session>,
    pub clip_model: Option<Mutex<Session>>,
    pub clip_tokenizer: Option<Tokenizer>,
}

#[derive(Clone)]
pub struct ImageEmbeddings {
    pub path_hash: String,
    pub embeddings: Array<f32, IxDyn>,
    pub original_size: (u32, u32),
}

pub struct AiState {
    pub models: Arc<AiModels>,
    pub embeddings: Option<ImageEmbeddings>,
}

fn get_models_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf> {
    let models_dir = app_handle.path().app_data_dir()?.join("models");
    if !models_dir.exists() {
        fs::create_dir_all(&models_dir)?;
    }
    Ok(models_dir)
}

async fn download_model(url: &str, dest: &Path) -> Result<()> {
    let response = reqwest::get(url).await?;
    let mut file = fs::File::create(dest)?;
    let mut content = Cursor::new(response.bytes().await?);
    std::io::copy(&mut content, &mut file)?;
    Ok(())
}

fn verify_sha256(path: &Path, expected_hash: &str) -> Result<bool> {
    if !path.exists() {
        return Ok(false);
    }
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    io::copy(&mut file, &mut hasher)?;
    let hash = hasher.finalize();
    let hex_hash = format!("{:x}", hash);
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
        download_model(url, &dest_path).await?;
        let _ = app_handle.emit("ai-model-download-finish", model_name);

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
    let settings = file_management::load_settings(app_handle.clone())
        .map_err(|e| anyhow::anyhow!("Failed to load settings: {}", e))?;
    let enable_tagging = settings.enable_ai_tagging.unwrap_or(false);

    if let Some(ai_state) = ai_state_mutex.lock().unwrap().as_ref() {
        if enable_tagging
            && (ai_state.models.clip_model.is_none() || ai_state.models.clip_tokenizer.is_none())
        {
            // tagging is enabled now, but models were loaded without it. re-initialize.
        } else {
            return Ok(ai_state.models.clone());
        }
    }

    let _guard = ai_init_lock.lock().await;

    if let Some(ai_state) = ai_state_mutex.lock().unwrap().as_ref() {
        if enable_tagging
            && (ai_state.models.clip_model.is_none() || ai_state.models.clip_tokenizer.is_none())
        {
            // fall through
        } else {
            return Ok(ai_state.models.clone());
        }
    }

    let models_dir = get_models_dir(app_handle)?;

    download_and_verify_model(
        app_handle,
        &models_dir,
        ENCODER_FILENAME,
        ENCODER_URL,
        ENCODER_SHA256,
        "SAM Encoder",
    )
    .await?;
    download_and_verify_model(
        app_handle,
        &models_dir,
        DECODER_FILENAME,
        DECODER_URL,
        DECODER_SHA256,
        "SAM Decoder",
    )
    .await?;
    download_and_verify_model(
        app_handle,
        &models_dir,
        U2NETP_FILENAME,
        U2NETP_URL,
        U2NETP_SHA256,
        "Foreground Model",
    )
    .await?;
    download_and_verify_model(
        app_handle,
        &models_dir,
        SKYSEG_FILENAME,
        SKYSEG_URL,
        SKYSEG_SHA256,
        "Sky Model",
    )
    .await?;

    let _ = ort::init()
        .with_name("AI")
        .commit();

    let mut clip_model = None;
    let mut clip_tokenizer = None;

    if enable_tagging {
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
            download_model(CLIP_TOKENIZER_URL, &clip_tokenizer_path).await?;
            let _ = app_handle.emit("ai-model-download-finish", "CLIP Tokenizer");
        }

        let clip_model_path = models_dir.join(CLIP_MODEL_FILENAME);
        clip_model = Some(Mutex::new(
            Session::builder()?.commit_from_file(clip_model_path)?
        ));
        clip_tokenizer = Some(
            Tokenizer::from_file(clip_tokenizer_path)
                .map_err(|e| anyhow::anyhow!(e.to_string()))?,
        );
    }

    let encoder_path = models_dir.join(ENCODER_FILENAME);
    let decoder_path = models_dir.join(DECODER_FILENAME);
    let u2netp_path = models_dir.join(U2NETP_FILENAME);
    let sky_seg_path = models_dir.join(SKYSEG_FILENAME);

    let sam_encoder = Session::builder()?.commit_from_file(encoder_path)?;
    let sam_decoder = Session::builder()?.commit_from_file(decoder_path)?;
    let u2netp = Session::builder()?.commit_from_file(u2netp_path)?;
    let sky_seg = Session::builder()?.commit_from_file(sky_seg_path)?;

    let models = Arc::new(AiModels {
        sam_encoder: Mutex::new(sam_encoder),
        sam_decoder: Mutex::new(sam_decoder),
        u2netp: Mutex::new(u2netp),
        sky_seg: Mutex::new(sky_seg),
        clip_model,
        clip_tokenizer,
    });

    let mut ai_state_lock = ai_state_mutex.lock().unwrap();
    *ai_state_lock = Some(AiState {
        models: models.clone(),
        embeddings: None,
    });

    Ok(models)
}

pub fn generate_image_embeddings(
    image: &DynamicImage,
    encoder: &Mutex<Session>,
) -> Result<ImageEmbeddings> {
    let (orig_width, orig_height) = image.dimensions();

    let long_side = orig_width.max(orig_height) as f32;
    let scale = SAM_INPUT_SIZE as f32 / long_side;
    let new_width = (orig_width as f32 * scale).round() as u32;
    let new_height = (orig_height as f32 * scale).round() as u32;

    let resized_image = image.resize(new_width, new_height, FilterType::Triangle);

    let mut input_tensor: Array<f32, _> =
        Array::zeros((1, 3, SAM_INPUT_SIZE as usize, SAM_INPUT_SIZE as usize));
    let mean = [123.675, 116.28, 103.53];
    let std = [58.395, 57.12, 57.375];

    for (x, y, pixel) in resized_image.to_rgb8().enumerate_pixels() {
        input_tensor[[0, 0, y as usize, x as usize]] = (pixel[0] as f32 - mean[0]) / std[0];
        input_tensor[[0, 1, y as usize, x as usize]] = (pixel[1] as f32 - mean[1]) / std[1];
        input_tensor[[0, 2, y as usize, x as usize]] = (pixel[2] as f32 - mean[2]) / std[2];
    }

    let input_tensor_dyn = input_tensor.into_dyn();

    let input_values = input_tensor_dyn.as_standard_layout();
    let input_tensor_ort = Tensor::from_array(input_values.into_owned())?;
    let mut session = encoder.lock().unwrap();
    let outputs = session.run(ort::inputs![input_tensor_ort])?;

    let embeddings = outputs[0].try_extract_array::<f32>()?.to_owned();

    Ok(ImageEmbeddings {
        path_hash: "".to_string(),
        embeddings: embeddings.into_dyn(),
        original_size: (orig_width, orig_height),
    })
}

pub fn run_sam_decoder(
    decoder: &Mutex<Session>,
    embeddings: &ImageEmbeddings,
    start_point: (f64, f64),
    end_point: (f64, f64),
) -> Result<GrayImage> {
    let (orig_width, orig_height) = embeddings.original_size;

    let long_side = orig_width.max(orig_height) as f64;
    let scale = SAM_INPUT_SIZE as f64 / long_side;

    let x1 = start_point.0.min(end_point.0) * scale;
    let y1 = start_point.1.min(end_point.1) * scale;
    let x2 = start_point.0.max(end_point.0) * scale;
    let y2 = start_point.1.max(end_point.1) * scale;

    let point_coords =
        Array::from_shape_vec((1, 2, 2), vec![x1 as f32, y1 as f32, x2 as f32, y2 as f32])?
            .into_dyn();
    let point_labels = Array::from_shape_vec((1, 2), vec![2.0f32, 3.0f32])?.into_dyn();

    let mask_input: Array<f32, IxDyn> = Array::zeros((1, 1, 256, 256)).into_dyn();
    let has_mask_input = Array::from_elem((1,), 0.0f32).into_dyn();
    let orig_im_size =
        Array::from_shape_vec((2,), vec![orig_height as f32, orig_width as f32])?.into_dyn();

    let embeddings_values = embeddings.embeddings.as_standard_layout();
    let point_coords_values = point_coords.as_standard_layout();
    let point_labels_values = point_labels.as_standard_layout();
    let mask_input_values = mask_input.as_standard_layout();
    let has_mask_input_values = has_mask_input.as_standard_layout();
    let orig_im_size_values = orig_im_size.as_standard_layout();

    let t_embeddings = Tensor::from_array(embeddings_values.into_owned())?;
    let t_point_coords = Tensor::from_array(point_coords_values.into_owned())?;
    let t_point_labels = Tensor::from_array(point_labels_values.into_owned())?;
    let t_mask_input = Tensor::from_array(mask_input_values.into_owned())?;
    let t_has_mask = Tensor::from_array(has_mask_input_values.into_owned())?;
    let t_orig_im_size = Tensor::from_array(orig_im_size_values.into_owned())?;

    let mut session = decoder.lock().unwrap();
    let outputs = session.run(ort::inputs![
        t_embeddings,
        t_point_coords,
        t_point_labels,
        t_mask_input,
        t_has_mask,
        t_orig_im_size
    ])?;
    
    let mask_tensor = outputs[0].try_extract_array::<f32>()?.to_owned();

    let mask_dims = mask_tensor.shape();
    let mask_height = mask_dims[2];
    let mask_width = mask_dims[3];

    let mask_data: Vec<u8> = mask_tensor
        .iter()
        .map(|&val| if val > 0.0 { 255 } else { 0 })
        .collect();

    let gray_mask = GrayImage::from_raw(mask_width as u32, mask_height as u32, mask_data)
        .ok_or_else(|| anyhow::anyhow!("Failed to create mask image from raw data"))?;

    let feathered_mask = image::imageops::blur(&gray_mask, 3.0);

    Ok(feathered_mask)
}

pub fn run_sky_seg_model(image: &DynamicImage, sky_seg_session: &Mutex<Session>) -> Result<GrayImage> {
    let (orig_width, orig_height) = image.dimensions();

    let resized_image = image.resize(SKYSEG_INPUT_SIZE, SKYSEG_INPUT_SIZE, FilterType::Triangle);
    let (resized_w, resized_h) = resized_image.dimensions();
    let resized_rgb = resized_image.to_rgb8();

    let mut square_input_image = image::RgbImage::new(SKYSEG_INPUT_SIZE, SKYSEG_INPUT_SIZE);
    let paste_x = (SKYSEG_INPUT_SIZE - resized_w) / 2;
    let paste_y = (SKYSEG_INPUT_SIZE - resized_h) / 2;
    imageops::overlay(
        &mut square_input_image,
        &resized_rgb,
        paste_x.into(),
        paste_y.into(),
    );

    let mut input_tensor: Array<f32, _> =
        Array::zeros((1, 3, SKYSEG_INPUT_SIZE as usize, SKYSEG_INPUT_SIZE as usize));
    let mean = [0.485, 0.456, 0.406];
    let std = [0.229, 0.224, 0.225];

    for y in 0..SKYSEG_INPUT_SIZE {
        for x in 0..SKYSEG_INPUT_SIZE {
            let pixel = square_input_image.get_pixel(x, y);
            input_tensor[[0, 0, y as usize, x as usize]] =
                (pixel[0] as f32 / 255.0 - mean[0]) / std[0];
            input_tensor[[0, 1, y as usize, x as usize]] =
                (pixel[1] as f32 / 255.0 - mean[1]) / std[1];
            input_tensor[[0, 2, y as usize, x as usize]] =
                (pixel[2] as f32 / 255.0 - mean[2]) / std[2];
        }
    }

    let input_tensor_dyn = input_tensor.into_dyn();
    let input_values = input_tensor_dyn.as_standard_layout();
    let t_input = Tensor::from_array(input_values.into_owned())?;

    let mut session = sky_seg_session.lock().unwrap();
    let outputs = session.run(ort::inputs![t_input])?;
    let output_tensor = outputs[0].try_extract_array::<f32>()?.to_owned();

    let (min_val, max_val) = output_tensor
        .iter()
        .fold((f32::MAX, f32::MIN), |(min, max), &v| {
            (min.min(v), max.max(v))
        });
    let range = max_val - min_val;

    let mask_data: Vec<u8> = output_tensor
        .iter()
        .map(|&val| {
            if range > 1e-6 {
                (((val - min_val) / range) * 255.0) as u8
            } else {
                0
            }
        })
        .collect();

    let square_mask = GrayImage::from_raw(SKYSEG_INPUT_SIZE, SKYSEG_INPUT_SIZE, mask_data)
        .ok_or_else(|| {
            anyhow::anyhow!("Failed to create mask from Sky Segmentation model output")
        })?;

    let cropped_mask =
        imageops::crop_imm(&square_mask, paste_x, paste_y, resized_w, resized_h).to_image();

    let final_mask = imageops::resize(&cropped_mask, orig_width, orig_height, FilterType::Triangle);

    Ok(final_mask)
}

pub fn run_u2netp_model(image: &DynamicImage, u2netp_session: &Mutex<Session>) -> Result<GrayImage> {
    let (orig_width, orig_height) = image.dimensions();

    let resized_image = image.resize(U2NETP_INPUT_SIZE, U2NETP_INPUT_SIZE, FilterType::Triangle);
    let (resized_w, resized_h) = resized_image.dimensions();
    let resized_rgb = resized_image.to_rgb8();

    let mut square_input_image = image::RgbImage::new(U2NETP_INPUT_SIZE, U2NETP_INPUT_SIZE);
    let paste_x = (U2NETP_INPUT_SIZE - resized_w) / 2;
    let paste_y = (U2NETP_INPUT_SIZE - resized_h) / 2;
    imageops::overlay(
        &mut square_input_image,
        &resized_rgb,
        paste_x.into(),
        paste_y.into(),
    );

    let mut input_tensor: Array<f32, _> =
        Array::zeros((1, 3, U2NETP_INPUT_SIZE as usize, U2NETP_INPUT_SIZE as usize));
    let mean = [0.485, 0.456, 0.406];
    let std = [0.229, 0.224, 0.225];

    for y in 0..U2NETP_INPUT_SIZE {
        for x in 0..U2NETP_INPUT_SIZE {
            let pixel = square_input_image.get_pixel(x, y);
            input_tensor[[0, 0, y as usize, x as usize]] =
                (pixel[0] as f32 / 255.0 - mean[0]) / std[0];
            input_tensor[[0, 1, y as usize, x as usize]] =
                (pixel[1] as f32 / 255.0 - mean[1]) / std[1];
            input_tensor[[0, 2, y as usize, x as usize]] =
                (pixel[2] as f32 / 255.0 - mean[2]) / std[2];
        }
    }

    let input_tensor_dyn = input_tensor.into_dyn();
    let input_values = input_tensor_dyn.as_standard_layout();
    let t_input = Tensor::from_array(input_values.into_owned())?;

    let mut session = u2netp_session.lock().unwrap();
    let outputs = session.run(ort::inputs![t_input])?;
    let output_tensor = outputs[0].try_extract_array::<f32>()?.to_owned();

    let (min_val, max_val) = output_tensor
        .iter()
        .fold((f32::MAX, f32::MIN), |(min, max), &v| {
            (min.min(v), max.max(v))
        });
    let range = max_val - min_val;

    let mask_data: Vec<u8> = output_tensor
        .iter()
        .map(|&val| {
            if range > 1e-6 {
                (((val - min_val) / range) * 255.0) as u8
            } else {
                0
            }
        })
        .collect();

    let square_mask = GrayImage::from_raw(U2NETP_INPUT_SIZE, U2NETP_INPUT_SIZE, mask_data)
        .ok_or_else(|| anyhow::anyhow!("Failed to create mask from U-2-Netp output"))?;

    let cropped_mask =
        imageops::crop_imm(&square_mask, paste_x, paste_y, resized_w, resized_h).to_image();

    let final_mask = imageops::resize(&cropped_mask, orig_width, orig_height, FilterType::Triangle);

    Ok(final_mask)
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