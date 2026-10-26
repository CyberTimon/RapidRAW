use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use image::imageops::{self, FilterType};
use image::{
    DynamicImage, GenericImageView, GrayImage, ImageBuffer, Luma, Rgb32FImage, RgbImage, RgbaImage,
};
use ndarray::{Array, Array4, ArrayViewD, IxDyn, s};
use ort::editor::{Graph, Model, Node, ONNX_DOMAIN, Opset, Outlet};
use ort::execution_providers::{CPUExecutionProvider, ExecutionProviderDispatch};
use ort::memory::Allocator;
use ort::session::{Output, Session};
use ort::tensor::{Shape, SymbolicDimensions, TensorElementType};
use ort::value::{Tensor, TensorRef, ValueType};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Emitter;
use tauri::Manager;
use tokenizers::Tokenizer;
use tokio::sync::Mutex as TokioMutex;

use crate::face_masking::FaceAnalysis;

const ENCODER_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/sam_vit_b_01ec64_encoder.onnx?download=true";
const DECODER_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/sam_vit_b_01ec64_decoder.onnx?download=true";
const ENCODER_FILENAME: &str = "sam_vit_b_01ec64_encoder.onnx";
const DECODER_FILENAME: &str = "sam_vit_b_01ec64_decoder.onnx";
const SAM_INPUT_SIZE: u32 = 1024;
const ENCODER_SHA256: &str = "16ab73d9c824886f0de2938c19df22fb9ec3deebfd0de58e65177e479213d7d1";
const DECODER_SHA256: &str = "85d0d672cf5b7fe763edcde429e5533e62f674af4b15c7d688b7673b0ef00bf7";

const BIREFNET_FP16_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/birefnet_general_lite_fp16.onnx?download=true";
const BIREFNET_FP16_FILENAME: &str = "birefnet_general_lite_fp16.onnx";
const BIREFNET_FP16_SHA256: &str =
    "3b72cb3c2138605ced0a4b271e8d13d3b3ca2483cf1665b098b6851767420fa1";
const BIREFNET_FP32_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/birefnet_general_lite.onnx?download=true";
const BIREFNET_FP32_FILENAME: &str = "birefnet_general_lite.onnx";
const BIREFNET_FP32_SHA256: &str =
    "5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333";
const BIREFNET_INPUT_SIZE: u32 = 1024;
const BIREFNET_ZOOM_MIN_IOU: f32 = 0.75;

const ZOOM_MARGIN: f32 = 0.15;
const ZOOM_MAX_FRACTION: f32 = 0.6;
const ZOOM_MIN_SIDE: f32 = 1024.0;
const ZOOM_FEATHER: f32 = 0.1;

const ESAM3_IMAGE_ENCODER_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/efficientsam3_ev_m_image_encoder.onnx?download=true";
const ESAM3_IMAGE_ENCODER_FILENAME: &str = "efficientsam3_ev_m_image_encoder.onnx";
const ESAM3_IMAGE_ENCODER_SHA256: &str =
    "2ed08306579138120dbf9f1110fd31784d1c20fe1b67fa2187a0a2a6d7c82729";
const ESAM3_DECODER_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/efficientsam3_ev_m_decoder.onnx?download=true";
const ESAM3_DECODER_FILENAME: &str = "efficientsam3_ev_m_decoder.onnx";
const ESAM3_DECODER_SHA256: &str =
    "16accc22a07ee99c73ef8a14e286ec567f94c116e0d8efa1a3a6c0bc9a2596a8";
const ESAM3_TEXT_ENCODER_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/efficientsam3_ev_m_text_encoder.onnx?download=true";
const ESAM3_TEXT_ENCODER_FILENAME: &str = "efficientsam3_ev_m_text_encoder.onnx";
const ESAM3_TEXT_ENCODER_SHA256: &str =
    "3065ea6116f21f6e22bc70a0c041e5da9ae05fdec7b48df953394f5657609590";
const ESAM3_SKY_PROMPT_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/efficientsam3_sky_prompt.bin?download=true";
const ESAM3_SKY_PROMPT_FILENAME: &str = "efficientsam3_sky_prompt.bin";
const ESAM3_SKY_PROMPT_SHA256: &str =
    "b8dc43661db640f2e3881466252d154906d90896eb3ed9dbc747bec87a97d180";
const ESAM3_FACE_PROMPT_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/efficientsam3_face_prompt.bin?download=true";
const ESAM3_FACE_PROMPT_FILENAME: &str = "efficientsam3_face_prompt.bin";
const ESAM3_FACE_PROMPT_SHA256: &str =
    "8fdbe63ef853756b1da9cdc642c277a6e422452f3feaf35f4297e6aea3a1ffb9";
const ESAM3_INPUT_SIZE: u32 = 1008;
const ESAM3_INPUT_PADDING: u32 = 30;
const ESAM3_PROMPT_TOKENS: usize = 16;
const ESAM3_EMBED_DIM: usize = 256;
const ESAM3_EXEMPLAR_SLOTS: usize = 8;
pub const ESAM3_SKY_SCORE_THRESHOLD: f32 = 0.6;
pub const ESAM3_TEXT_SCORE_THRESHOLD: f32 = 0.3;
pub const ESAM3_FACE_SCORE_THRESHOLD: f32 = 0.3;
const ESAM3_MASK_LOW: f32 = 0.3;
const ESAM3_MASK_HIGH: f32 = 0.7;
const ESAM3_REFINE_SIZE: u32 = 1024;
const ESAM3_REFINE_RADIUS: usize = 16;
pub const ESAM3_SKY_REFINE_EPS: f32 = 0.001;
pub const ESAM3_TEXT_REFINE_EPS: f32 = 0.01;
const ESAM3_ZOOM_MIN_IOU: f32 = 0.3;

const FACE_LANDMARKS_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/mediapipe_face_landmarks.onnx?download=true";
const FACE_LANDMARKS_FILENAME: &str = "mediapipe_face_landmarks.onnx";
const FACE_LANDMARKS_SHA256: &str =
    "6524d596b4d9151b0d8d590844566261f21de5186ac38125bdcd1de6974b0bb4";
const FACE_SEGMENTER_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/mediapipe_selfie_multiclass.onnx?download=true";
const FACE_SEGMENTER_FILENAME: &str = "mediapipe_selfie_multiclass.onnx";
const FACE_SEGMENTER_SHA256: &str =
    "a198470a4edec350a33b8182c149e417effc5e61c0506b947f226e7a81b9a08e";

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

const DEPTH_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/depth_anything_v2_vits.onnx?download=true";
const DEPTH_FILENAME: &str = "depth_anything_v2_vits.onnx";
const DEPTH_INPUT_SIZE: u32 = 518;
const DEPTH_SHA256: &str = "d2b11a11c1d4a12b47608fa65a17ee9a4c605b55ee1730c8e3b526304f2562be";

const NORMAL_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/moge-2-vits-normal-onnx.onnx?download=true";
const NORMAL_FILENAME: &str = "moge-2-vits-normal-onnx.onnx";
const NORMAL_MAX_SIZE: u32 = 768;
const NORMAL_NUM_TOKENS: i64 = 2500;
const NORMAL_SHA256: &str = "24eacb5dc7a2c54c7bc98f7de085ffbed79ad006ea5b664c2c2cdc02ff3a52f0";

type SharedSession = Arc<Mutex<Session>>;

const GPU_IDLE: u8 = 0;
const GPU_ACTIVE: u8 = 1;
const GPU_FAILED: u8 = 2;
const GPU_DISABLED: u8 = 3;

static GPU_STATUS: AtomicU8 = AtomicU8::new(GPU_IDLE);

struct ModelAsset {
    filename: &'static str,
    url: &'static str,
    sha256: Option<&'static str>,
    name: &'static str,
}

const SAM_ENCODER_ASSET: ModelAsset = ModelAsset {
    filename: ENCODER_FILENAME,
    url: ENCODER_URL,
    sha256: Some(ENCODER_SHA256),
    name: "SAM Encoder",
};
const SAM_DECODER_ASSET: ModelAsset = ModelAsset {
    filename: DECODER_FILENAME,
    url: DECODER_URL,
    sha256: Some(DECODER_SHA256),
    name: "SAM Decoder",
};
const BIREFNET_FP16_ASSET: ModelAsset = ModelAsset {
    filename: BIREFNET_FP16_FILENAME,
    url: BIREFNET_FP16_URL,
    sha256: Some(BIREFNET_FP16_SHA256),
    name: "Foreground Model",
};
const BIREFNET_FP32_ASSET: ModelAsset = ModelAsset {
    filename: BIREFNET_FP32_FILENAME,
    url: BIREFNET_FP32_URL,
    sha256: Some(BIREFNET_FP32_SHA256),
    name: "Foreground Model",
};
const ESAM3_IMAGE_ENCODER_ASSET: ModelAsset = ModelAsset {
    filename: ESAM3_IMAGE_ENCODER_FILENAME,
    url: ESAM3_IMAGE_ENCODER_URL,
    sha256: Some(ESAM3_IMAGE_ENCODER_SHA256),
    name: "EfficientSAM3 Encoder",
};
const ESAM3_DECODER_ASSET: ModelAsset = ModelAsset {
    filename: ESAM3_DECODER_FILENAME,
    url: ESAM3_DECODER_URL,
    sha256: Some(ESAM3_DECODER_SHA256),
    name: "EfficientSAM3 Decoder",
};
const ESAM3_TEXT_ENCODER_ASSET: ModelAsset = ModelAsset {
    filename: ESAM3_TEXT_ENCODER_FILENAME,
    url: ESAM3_TEXT_ENCODER_URL,
    sha256: Some(ESAM3_TEXT_ENCODER_SHA256),
    name: "EfficientSAM3 Text Encoder",
};
const ESAM3_SKY_PROMPT_ASSET: ModelAsset = ModelAsset {
    filename: ESAM3_SKY_PROMPT_FILENAME,
    url: ESAM3_SKY_PROMPT_URL,
    sha256: Some(ESAM3_SKY_PROMPT_SHA256),
    name: "Sky Prompt",
};
const ESAM3_FACE_PROMPT_ASSET: ModelAsset = ModelAsset {
    filename: ESAM3_FACE_PROMPT_FILENAME,
    url: ESAM3_FACE_PROMPT_URL,
    sha256: Some(ESAM3_FACE_PROMPT_SHA256),
    name: "Face Prompt",
};
const FACE_LANDMARKS_ASSET: ModelAsset = ModelAsset {
    filename: FACE_LANDMARKS_FILENAME,
    url: FACE_LANDMARKS_URL,
    sha256: Some(FACE_LANDMARKS_SHA256),
    name: "Face Landmarks Model",
};
const FACE_SEGMENTER_ASSET: ModelAsset = ModelAsset {
    filename: FACE_SEGMENTER_FILENAME,
    url: FACE_SEGMENTER_URL,
    sha256: Some(FACE_SEGMENTER_SHA256),
    name: "Face Segmentation Model",
};
const DEPTH_ASSET: ModelAsset = ModelAsset {
    filename: DEPTH_FILENAME,
    url: DEPTH_URL,
    sha256: Some(DEPTH_SHA256),
    name: "Depth Model",
};
const CLIP_MODEL_ASSET: ModelAsset = ModelAsset {
    filename: CLIP_MODEL_FILENAME,
    url: CLIP_MODEL_URL,
    sha256: Some(CLIP_MODEL_SHA256),
    name: "CLIP Model",
};
const CLIP_TOKENIZER_ASSET: ModelAsset = ModelAsset {
    filename: CLIP_TOKENIZER_FILENAME,
    url: CLIP_TOKENIZER_URL,
    sha256: None,
    name: "CLIP Tokenizer",
};
const DENOISE_ASSET: ModelAsset = ModelAsset {
    filename: DENOISE_FILENAME,
    url: DENOISE_URL,
    sha256: Some(DENOISE_SHA256),
    name: "NIND Denoise Model",
};
const LAMA_ASSET: ModelAsset = ModelAsset {
    filename: LAMA_FILENAME,
    url: LAMA_URL,
    sha256: Some(LAMA_SHA256),
    name: "Inpainting Model",
};
const NORMAL_ASSET: ModelAsset = ModelAsset {
    filename: NORMAL_FILENAME,
    url: NORMAL_URL,
    sha256: Some(NORMAL_SHA256),
    name: "Normal Model",
};

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum AiMaskModel {
    Subject,
    Foreground,
    Sky,
    Text,
    Face,
    Depth,
}

impl AiMaskModel {
    fn assets(self, gpu_inference: bool) -> &'static [ModelAsset] {
        match self {
            AiMaskModel::Subject => &[SAM_ENCODER_ASSET, SAM_DECODER_ASSET],
            AiMaskModel::Foreground if gpu_inference => &[BIREFNET_FP16_ASSET],
            AiMaskModel::Foreground => &[BIREFNET_FP32_ASSET],
            AiMaskModel::Sky => &[
                ESAM3_IMAGE_ENCODER_ASSET,
                ESAM3_DECODER_ASSET,
                ESAM3_SKY_PROMPT_ASSET,
            ],
            AiMaskModel::Text => &[
                ESAM3_IMAGE_ENCODER_ASSET,
                ESAM3_DECODER_ASSET,
                ESAM3_TEXT_ENCODER_ASSET,
                CLIP_TOKENIZER_ASSET,
            ],
            AiMaskModel::Face => &[
                ESAM3_IMAGE_ENCODER_ASSET,
                ESAM3_DECODER_ASSET,
                ESAM3_FACE_PROMPT_ASSET,
                FACE_LANDMARKS_ASSET,
                FACE_SEGMENTER_ASSET,
            ],
            AiMaskModel::Depth => &[DEPTH_ASSET],
        }
    }
}

pub struct Esam3Features {
    pub path_hash: String,
    pub fpn: [Array<f32, IxDyn>; 3],
    pub pos: Array<f32, IxDyn>,
}

pub struct Esam3Prompt {
    features: Array<f32, IxDyn>,
    padding: Array<f32, IxDyn>,
}

pub struct AiModels {
    models_dir: PathBuf,
    use_gpu: bool,
    downloaded: Mutex<HashSet<AiMaskModel>>,
    sam_encoder: Mutex<Option<SharedSession>>,
    sam_decoder: Mutex<Option<SharedSession>>,
    birefnet: Mutex<Option<SharedSession>>,
    esam3_image_encoder: Mutex<Option<SharedSession>>,
    esam3_decoder: Mutex<Option<SharedSession>>,
    esam3_text_encoder: Mutex<Option<SharedSession>>,
    esam3_sky_prompt: Mutex<Option<Arc<Esam3Prompt>>>,
    esam3_face_prompt: Mutex<Option<Arc<Esam3Prompt>>>,
    clip_tokenizer: Mutex<Option<Arc<Tokenizer>>>,
    face_landmarks: Mutex<Option<SharedSession>>,
    face_segmenter: Mutex<Option<SharedSession>>,
    depth_anything: Mutex<Option<SharedSession>>,
}

impl AiModels {
    fn session(
        &self,
        slot: &Mutex<Option<SharedSession>>,
        filename: &str,
        use_gpu: bool,
    ) -> Result<SharedSession> {
        let mut slot = slot.lock().unwrap();
        if let Some(session) = slot.as_ref() {
            return Ok(Arc::clone(session));
        }
        let session = Arc::new(Mutex::new(build_session(
            &self.models_dir.join(filename),
            SessionKind::OneShot,
            self.use_gpu && use_gpu,
            None,
        )?));
        *slot = Some(Arc::clone(&session));
        Ok(session)
    }

    pub fn sam_encoder(&self) -> Result<SharedSession> {
        self.session(&self.sam_encoder, ENCODER_FILENAME, false)
    }

    pub fn sam_decoder(&self) -> Result<SharedSession> {
        self.session(&self.sam_decoder, DECODER_FILENAME, false)
    }

    fn gpu_inference(&self) -> bool {
        self.use_gpu && gpu_allowed_on_platform() && gpu_execution_provider().is_some()
    }

    pub fn birefnet(&self) -> Result<SharedSession> {
        let filename = if self.gpu_inference() {
            BIREFNET_FP16_FILENAME
        } else {
            BIREFNET_FP32_FILENAME
        };
        self.session(&self.birefnet, filename, gpu_allowed_on_platform())
    }

    pub fn esam3_image_encoder(&self) -> Result<SharedSession> {
        self.session(
            &self.esam3_image_encoder,
            ESAM3_IMAGE_ENCODER_FILENAME,
            gpu_allowed_on_platform(),
        )
    }

    pub fn esam3_decoder(&self) -> Result<SharedSession> {
        self.session(
            &self.esam3_decoder,
            ESAM3_DECODER_FILENAME,
            gpu_allowed_on_platform(),
        )
    }

    pub fn depth_anything(&self) -> Result<SharedSession> {
        self.session(&self.depth_anything, DEPTH_FILENAME, true)
    }

    pub fn face_landmarks(&self) -> Result<SharedSession> {
        self.session(&self.face_landmarks, FACE_LANDMARKS_FILENAME, false)
    }

    pub fn face_segmenter(&self) -> Result<SharedSession> {
        self.session(&self.face_segmenter, FACE_SEGMENTER_FILENAME, false)
    }

    pub fn esam3_sky_prompt(&self) -> Result<Arc<Esam3Prompt>> {
        self.stored_prompt(&self.esam3_sky_prompt, ESAM3_SKY_PROMPT_FILENAME)
    }

    pub fn esam3_face_prompt(&self) -> Result<Arc<Esam3Prompt>> {
        self.stored_prompt(&self.esam3_face_prompt, ESAM3_FACE_PROMPT_FILENAME)
    }

    fn stored_prompt(
        &self,
        slot: &Mutex<Option<Arc<Esam3Prompt>>>,
        filename: &str,
    ) -> Result<Arc<Esam3Prompt>> {
        let mut slot = slot.lock().unwrap();
        if let Some(prompt) = slot.as_ref() {
            return Ok(Arc::clone(prompt));
        }
        let bytes = fs::read(self.models_dir.join(filename))?;
        let values: Vec<f32> = bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|&chunk| f32::from_le_bytes(chunk))
            .collect();
        let feature_len = ESAM3_PROMPT_TOKENS * ESAM3_EMBED_DIM;
        if values.len() != feature_len + ESAM3_PROMPT_TOKENS {
            return Err(anyhow::anyhow!("Invalid prompt embedding {}", filename));
        }
        let prompt = Arc::new(Esam3Prompt {
            features: Array::from_shape_vec(
                IxDyn(&[ESAM3_PROMPT_TOKENS, 1, ESAM3_EMBED_DIM]),
                values[..feature_len].to_vec(),
            )?,
            padding: Array::from_shape_vec(
                IxDyn(&[1, ESAM3_PROMPT_TOKENS]),
                values[feature_len..].to_vec(),
            )?,
        });
        *slot = Some(Arc::clone(&prompt));
        Ok(prompt)
    }

    pub fn esam3_text_prompt(&self, text: &str) -> Result<Esam3Prompt> {
        let tokenizer = {
            let mut slot = self.clip_tokenizer.lock().unwrap();
            match slot.as_ref() {
                Some(tokenizer) => Arc::clone(tokenizer),
                None => {
                    let tokenizer = Arc::new(
                        Tokenizer::from_file(self.models_dir.join(CLIP_TOKENIZER_FILENAME))
                            .map_err(|e| anyhow::anyhow!(e.to_string()))?,
                    );
                    *slot = Some(Arc::clone(&tokenizer));
                    tokenizer
                }
            }
        };
        let encoding = tokenizer
            .encode(text.trim(), true)
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let ids = encoding.get_ids();
        let mut tokens = Array::<i64, _>::zeros((1, ESAM3_PROMPT_TOKENS));
        let kept = ids.len().min(ESAM3_PROMPT_TOKENS);
        for (i, &id) in ids[..kept].iter().enumerate() {
            tokens[[0, i]] = id as i64;
        }
        if let Some(&end) = ids.last()
            && ids.len() > ESAM3_PROMPT_TOKENS
        {
            tokens[[0, ESAM3_PROMPT_TOKENS - 1]] = end as i64;
        }

        let session = self.session(&self.esam3_text_encoder, ESAM3_TEXT_ENCODER_FILENAME, false)?;
        let mut session = session.lock().unwrap();
        let outputs = session.run(ort::inputs!["tokens" => Tensor::from_array(tokens)?])?;
        Ok(Esam3Prompt {
            features: outputs["language_features"]
                .try_extract_array::<f32>()?
                .to_owned(),
            padding: outputs["language_padding"]
                .try_extract_array::<f32>()?
                .to_owned(),
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SessionKind {
    OneShot,
    Persistent,
}

#[cfg(target_os = "windows")]
fn high_performance_dml_device_id() -> Option<i32> {
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory2, DXGI_CREATE_FACTORY_FLAGS, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE,
        IDXGIAdapter1, IDXGIFactory6,
    };

    unsafe {
        let factory: IDXGIFactory6 = CreateDXGIFactory2(DXGI_CREATE_FACTORY_FLAGS(0)).ok()?;
        let preferred: IDXGIAdapter1 = factory
            .EnumAdapterByGpuPreference(0, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE)
            .ok()?;
        let luid = preferred.GetDesc1().ok()?.AdapterLuid;
        (0..)
            .map_while(|i| factory.EnumAdapters1(i).ok())
            .position(|adapter| {
                adapter
                    .GetDesc1()
                    .is_ok_and(|desc| desc.AdapterLuid == luid)
            })
            .map(|index| index as i32)
    }
}

#[cfg(target_os = "windows")]
fn gpu_execution_provider() -> Option<ExecutionProviderDispatch> {
    Some(
        ort::execution_providers::DirectMLExecutionProvider::default()
            .with_device_id(high_performance_dml_device_id().unwrap_or(0))
            .build()
            .error_on_failure(),
    )
}

#[cfg(target_os = "macos")]
fn gpu_execution_provider() -> Option<ExecutionProviderDispatch> {
    use ort::execution_providers::coreml::{CoreMLComputeUnits, CoreMLModelFormat};

    Some(
        ort::execution_providers::CoreMLExecutionProvider::default()
            .with_model_format(CoreMLModelFormat::MLProgram)
            .with_compute_units(CoreMLComputeUnits::All)
            .build()
            .error_on_failure(),
    )
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn gpu_execution_provider() -> Option<ExecutionProviderDispatch> {
    None
}

fn gpu_allowed_on_platform() -> bool {
    !cfg!(target_os = "macos")
}

type GpuModelPatch = fn() -> ort::Result<(Model, Vec<Output>)>;

fn i64_initializer(values: &[i64]) -> ort::Result<Tensor<i64>> {
    let mut tensor = Tensor::<i64>::new(&Allocator::default(), [values.len()])?;
    tensor.extract_tensor_mut().1.copy_from_slice(values);
    Ok(tensor)
}

fn denoise_crop_as_slice() -> ort::Result<(Model, Vec<Output>)> {
    let output_type = ValueType::Tensor {
        ty: TensorElementType::Float32,
        shape: Shape::new([1, 3, -1, -1]),
        dimension_symbols: SymbolicDimensions::empty(4),
    };

    let mut graph = Graph::new()?;
    graph.add_initializer("crop_starts", i64_initializer(&[2, 2])?, false)?;
    graph.add_initializer("crop_ends", i64_initializer(&[-2, -2])?, false)?;
    graph.add_initializer("crop_axes", i64_initializer(&[2, 3])?, false)?;
    graph.add_node(Node::new(
        "Slice",
        ONNX_DOMAIN,
        "crop_slice",
        ["conv2d_9", "crop_starts", "crop_ends", "crop_axes"],
        ["denoised"],
        [],
    )?)?;
    graph.set_outputs([Outlet::new("denoised", &output_type)?])?;

    let mut model = Model::new([Opset::new(ONNX_DOMAIN, 18)?])?;
    model.add_graph(graph)?;
    Ok((
        model,
        vec![Output {
            name: "denoised".to_string(),
            output_type,
        }],
    ))
}

fn create_session(
    model_path: &Path,
    kind: SessionKind,
    gpu_provider: Option<ExecutionProviderDispatch>,
    gpu_patch: Option<GpuModelPatch>,
) -> Result<Session> {
    let use_gpu = gpu_provider.is_some();
    let cpu_provider = CPUExecutionProvider::default()
        .with_arena_allocator(kind == SessionKind::Persistent)
        .build();
    let providers: Vec<_> = gpu_provider.into_iter().chain([cpu_provider]).collect();

    let mut builder = Session::builder()?;
    if use_gpu || kind == SessionKind::OneShot {
        builder = builder.with_memory_pattern(false)?;
    }
    if use_gpu && kind == SessionKind::OneShot {
        builder = builder.with_config_entry("ep.dml.disable_memory_arena", "1")?;
    }
    let builder = builder.with_execution_providers(providers)?;
    match gpu_patch {
        Some(patch) => {
            let (model, outputs) = patch()?;
            let mut session = builder.edit_from_file(model_path)?;
            session.apply_model(&model)?;
            let mut session = session.into_session()?;
            session.outputs = outputs;
            Ok(session)
        }
        None => Ok(builder.commit_from_file(model_path)?),
    }
}

fn build_session(
    model_path: &Path,
    kind: SessionKind,
    use_gpu: bool,
    gpu_patch: Option<GpuModelPatch>,
) -> Result<Session> {
    if use_gpu
        && GPU_STATUS.load(Ordering::Acquire) < GPU_FAILED
        && let Some(gpu_provider) = gpu_execution_provider()
    {
        match create_session(model_path, kind, Some(gpu_provider), gpu_patch) {
            Ok(session) => {
                let _ = GPU_STATUS.compare_exchange(
                    GPU_IDLE,
                    GPU_ACTIVE,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                );
                return Ok(session);
            }
            Err(e) => log::warn!(
                "GPU acceleration unavailable for {}, falling back to CPU: {}",
                model_path.display(),
                e
            ),
        }
    }
    create_session(model_path, kind, None, None)
}

pub fn gpu_acceleration_enabled(app_handle: &tauri::AppHandle) -> bool {
    GPU_STATUS.load(Ordering::Acquire) < GPU_FAILED
        && crate::app_settings::load_settings(app_handle.clone())
            .map(|settings| settings.ai_gpu_acceleration)
            .unwrap_or(true)
}

pub fn gpu_inference<T>(result: ort::Result<T>) -> Result<T> {
    result.map_err(|e| {
        if GPU_STATUS
            .compare_exchange(GPU_ACTIVE, GPU_FAILED, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            log::warn!(
                "GPU inference failed, using the CPU for AI models from now on: {}",
                e
            );
        }
        e.into()
    })
}

pub fn reset_ai_sessions(ai_state_mutex: &Mutex<Option<AiState>>) {
    if let Some(ai_state) = ai_state_mutex.lock().unwrap().as_mut() {
        ai_state.release_sessions();
    }
    GPU_STATUS.store(GPU_IDLE, Ordering::Release);
}

pub struct ClipModels {
    pub model: Mutex<Session>,
    pub tokenizer: Tokenizer,
}

#[derive(Clone)]
pub struct ImageEmbeddings {
    pub path_hash: String,
    pub embeddings: Array<f32, IxDyn>,
    pub original_size: (u32, u32),
}

#[derive(Clone)]
pub struct CachedDepthMap {
    pub path_hash: String,
    pub depth_image: GrayImage,
    pub original_size: (u32, u32),
}

#[derive(Default)]
pub struct AiState {
    pub models: Option<Arc<AiModels>>,
    pub denoise_model: Option<Arc<Mutex<Session>>>,
    pub clip_models: Option<Arc<ClipModels>>,
    pub lama_model: Option<Arc<Mutex<Session>>>,
    pub normal_model: Option<Arc<Mutex<Session>>>,
    pub embeddings: Option<ImageEmbeddings>,
    pub esam3_features: Option<Arc<Esam3Features>>,
    pub face_analysis: Option<Arc<FaceAnalysis>>,
    pub depth_map: Option<CachedDepthMap>,
}

impl AiState {
    pub fn release_sessions(&mut self) {
        self.models = None;
        self.denoise_model = None;
        self.clip_models = None;
        self.lama_model = None;
        self.normal_model = None;
    }
}

fn cached_ai_state<T>(
    ai_state_mutex: &Mutex<Option<AiState>>,
    get: impl Fn(&AiState) -> Option<T>,
) -> Option<T> {
    let mut ai_state = ai_state_mutex.lock().unwrap();
    if GPU_STATUS
        .compare_exchange(
            GPU_FAILED,
            GPU_DISABLED,
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .is_ok()
        && let Some(ai_state) = ai_state.as_mut()
    {
        ai_state.release_sessions();
    }
    ai_state.as_ref().and_then(get)
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

    let guide_lr = if (lr_w, lr_h) == (hr_w, hr_h) {
        std::borrow::Cow::Borrowed(guide_hr)
    } else {
        std::borrow::Cow::Owned(imageops::resize(guide_hr, lr_w, lr_h, FilterType::Triangle))
    };

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

    drop(guide_lr);

    let mut temp1 = vec![0.0; area];
    let mut temp2 = vec![0.0; area];

    let box_filter = |src: Vec<f32>, temp1: &mut [f32], temp2: &mut [f32]| {
        let mut mean = vec![0.0; area];
        box_filter_opt(&src, &mut mean, temp1, temp2, w, h, r);
        mean
    };
    let mean_i = box_filter(i_lr, &mut temp1, &mut temp2);
    let mean_p = box_filter(p_lr, &mut temp1, &mut temp2);
    let mut a = box_filter(ip_lr, &mut temp1, &mut temp2);
    let mut b = box_filter(ii_lr, &mut temp1, &mut temp2);

    a.par_iter_mut()
        .zip(b.par_iter_mut())
        .zip(mean_i.par_iter())
        .zip(mean_p.par_iter())
        .for_each(|(((a_out, b_out), &m_i), &m_p)| {
            let (m_ip, m_ii) = (*a_out, *b_out);
            let cov_ip = m_ip - m_i * m_p;
            let var_i = m_ii - m_i * m_i;
            let a_val = cov_ip / (var_i + eps);
            *a_out = a_val;
            *b_out = m_p - a_val * m_i;
        });

    let (mut mean_a, mut mean_b) = (mean_i, mean_p);
    box_filter_opt(&a, &mut mean_a, &mut temp1, &mut temp2, w, h, r);
    box_filter_opt(&b, &mut mean_b, &mut temp1, &mut temp2, w, h, r);
    drop((a, b, temp1, temp2));

    let mean_a_img = ImageBuffer::<Luma<f32>, Vec<f32>>::from_raw(lr_w, lr_h, mean_a).unwrap();
    let mean_b_img = ImageBuffer::<Luma<f32>, Vec<f32>>::from_raw(lr_w, lr_h, mean_b).unwrap();

    let upscale = |img: ImageBuffer<Luma<f32>, Vec<f32>>| {
        if (lr_w, lr_h) == (hr_w, hr_h) {
            img.into_raw()
        } else {
            imageops::resize(&img, hr_w, hr_h, FilterType::Triangle).into_raw()
        }
    };
    let mean_a_hr_raw = upscale(mean_a_img);
    let mean_b_hr_raw = upscale(mean_b_img);
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

fn bilinear_sample(i: usize, scale: f32, n: usize) -> (usize, usize, f32) {
    let f = ((i as f32 + 0.5) * scale - 0.5).max(0.0);
    let i0 = (f.floor() as usize).min(n - 1);
    let i1 = (i0 + 1).min(n - 1);
    (i0, i1, (f - i0 as f32).clamp(0.0, 1.0))
}

pub fn fast_color_guided_filter(
    guide_hr: &RgbImage,
    mask_lr: &GrayImage,
    r: usize,
    eps: f32,
) -> GrayImage {
    let (hr_w, hr_h) = guide_hr.dimensions();
    let (lr_w, lr_h) = mask_lr.dimensions();
    let (w, h) = (lr_w as usize, lr_h as usize);
    let area = w * h;

    let guide_lr = imageops::resize(guide_hr, lr_w, lr_h, FilterType::Triangle);
    let guide: [Vec<f32>; 3] =
        std::array::from_fn(|c| guide_lr.pixels().map(|p| p[c] as f32 / 255.0).collect());
    drop(guide_lr);
    let p: Vec<f32> = mask_lr.as_raw().iter().map(|&v| v as f32 / 255.0).collect();

    let mut temp1 = vec![0.0; area];
    let mut temp2 = vec![0.0; area];
    let mut box_filter = |src: &[f32]| {
        let mut mean = vec![0.0; area];
        box_filter_opt(src, &mut mean, &mut temp1, &mut temp2, w, h, r);
        mean
    };
    let product = |a: &[f32], b: &[f32]| -> Vec<f32> {
        a.par_iter().zip(b.par_iter()).map(|(x, y)| x * y).collect()
    };

    let mean_i = guide.each_ref().map(|c| box_filter(c));
    let mean_p = box_filter(&p);
    let mean_ip: [Vec<f32>; 3] = std::array::from_fn(|c| box_filter(&product(&guide[c], &p)));
    let mean_ii = [(0, 0), (0, 1), (0, 2), (1, 1), (1, 2), (2, 2)]
        .map(|(i, j)| box_filter(&product(&guide[i], &guide[j])));
    drop((guide, p));

    let coefficients: Vec<[f32; 4]> = (0..area)
        .into_par_iter()
        .map(|k| {
            let m = [mean_i[0][k], mean_i[1][k], mean_i[2][k]];
            let cov = [0, 1, 2].map(|c| mean_ip[c][k] - m[c] * mean_p[k]);
            let s00 = mean_ii[0][k] - m[0] * m[0] + eps;
            let s01 = mean_ii[1][k] - m[0] * m[1];
            let s02 = mean_ii[2][k] - m[0] * m[2];
            let s11 = mean_ii[3][k] - m[1] * m[1] + eps;
            let s12 = mean_ii[4][k] - m[1] * m[2];
            let s22 = mean_ii[5][k] - m[2] * m[2] + eps;
            let c00 = s11 * s22 - s12 * s12;
            let c01 = s02 * s12 - s01 * s22;
            let c02 = s01 * s12 - s02 * s11;
            let c11 = s00 * s22 - s02 * s02;
            let c12 = s01 * s02 - s00 * s12;
            let c22 = s00 * s11 - s01 * s01;
            let det = s00 * c00 + s01 * c01 + s02 * c02;
            let a0 = (c00 * cov[0] + c01 * cov[1] + c02 * cov[2]) / det;
            let a1 = (c01 * cov[0] + c11 * cov[1] + c12 * cov[2]) / det;
            let a2 = (c02 * cov[0] + c12 * cov[1] + c22 * cov[2]) / det;
            [a0, a1, a2, mean_p[k] - a0 * m[0] - a1 * m[1] - a2 * m[2]]
        })
        .collect();
    drop((mean_i, mean_p, mean_ip, mean_ii));

    let mean_coefficients: [Vec<f32>; 4] = std::array::from_fn(|i| {
        box_filter(&coefficients.iter().map(|c| c[i]).collect::<Vec<f32>>())
    });
    drop(coefficients);

    let (hr_w, hr_h) = (hr_w as usize, hr_h as usize);
    let x_samples: Vec<(usize, usize, f32)> = (0..hr_w)
        .map(|x| bilinear_sample(x, w as f32 / hr_w as f32, w))
        .collect();
    let mut final_mask_raw = vec![0u8; hr_w * hr_h];

    final_mask_raw
        .par_chunks_exact_mut(hr_w)
        .zip(guide_hr.as_raw().par_chunks_exact(hr_w * 3))
        .enumerate()
        .for_each(|(y, (out_row, guide_row))| {
            let (y0, y1, ty) = bilinear_sample(y, h as f32 / hr_h as f32, h);
            for (x, (out, pixel)) in out_row
                .iter_mut()
                .zip(guide_row.as_chunks::<3>().0)
                .enumerate()
            {
                let (x0, x1, tx) = x_samples[x];
                let sample = |values: &[f32]| {
                    let top = values[y0 * w + x0] * (1.0 - tx) + values[y0 * w + x1] * tx;
                    let bottom = values[y1 * w + x0] * (1.0 - tx) + values[y1 * w + x1] * tx;
                    top * (1.0 - ty) + bottom * ty
                };
                let q = (0..3)
                    .map(|c| sample(&mean_coefficients[c]) * pixel[c] as f32 / 255.0)
                    .sum::<f32>()
                    + sample(&mean_coefficients[3]);
                *out = (q.clamp(0.0, 1.0) * 255.0).round() as u8;
            }
        });

    GrayImage::from_raw(hr_w as u32, hr_h as u32, final_mask_raw).unwrap()
}

fn get_models_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf> {
    let models_dir = app_handle.path().app_data_dir()?.join("models");
    if !models_dir.exists() {
        fs::create_dir_all(&models_dir)?;
    }
    Ok(models_dir)
}

fn persist_downloaded_asset(dest: &Path, bytes: &[u8]) -> Result<()> {
    if bytes.is_empty() {
        return Err(anyhow::anyhow!(
            "Downloaded asset for {} was empty",
            dest.display()
        ));
    }

    let parent = dest.parent().ok_or_else(|| {
        anyhow::anyhow!(
            "Cannot determine parent directory for downloaded asset {}",
            dest.display()
        )
    })?;
    fs::create_dir_all(parent)?;

    let file_name = dest
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow::anyhow!("Invalid downloaded asset path {}", dest.display()))?;
    let tmp_path = dest.with_file_name(format!(".{}.download", file_name));

    {
        let mut file = fs::File::create(&tmp_path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }

    fs::rename(&tmp_path, dest).or_else(|rename_error| -> std::io::Result<()> {
        if dest.exists() {
            fs::remove_file(dest)?;
            fs::rename(&tmp_path, dest)?;
            Ok(())
        } else {
            Err(rename_error)
        }
    })?;
    Ok(())
}

async fn download_model(
    app_handle: &tauri::AppHandle,
    asset: &ModelAsset,
    dest: &Path,
) -> Result<()> {
    let mut response = reqwest::get(asset.url).await?.error_for_status()?;
    let total = response.content_length().unwrap_or(0);
    let mut bytes = Vec::with_capacity(total as usize);
    let mut last_progress = Instant::now();
    while let Some(chunk) = response.chunk().await? {
        bytes.extend_from_slice(&chunk);
        if total > 0 && last_progress.elapsed() >= Duration::from_millis(200) {
            last_progress = Instant::now();
            let _ = app_handle.emit(
                "ai-model-download-progress",
                serde_json::json!({ "name": asset.name, "current": bytes.len(), "total": total }),
            );
        }
    }
    persist_downloaded_asset(dest, &bytes)
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
    asset: &ModelAsset,
) -> Result<()> {
    let dest_path = models_dir.join(asset.filename);
    let is_valid = match asset.sha256 {
        Some(expected_hash) => verify_sha256(&dest_path, expected_hash)?,
        None => dest_path.exists(),
    };

    if !is_valid {
        if dest_path.exists() {
            println!("Model {} has incorrect hash. Re-downloading.", asset.name);
            fs::remove_file(&dest_path)?;
        }
        let _ = app_handle.emit("ai-model-download-start", asset.name);
        let download_result = async {
            download_model(app_handle, asset, &dest_path).await?;
            if let Some(expected_hash) = asset.sha256
                && !verify_sha256(&dest_path, expected_hash)?
            {
                return Err(anyhow::anyhow!(
                    "Failed to verify model {} after download. Hash mismatch.",
                    asset.name
                ));
            }
            Ok(())
        }
        .await;
        let _ = app_handle.emit(
            "ai-model-download-finish",
            serde_json::json!({
                "name": asset.name,
                "error": download_result.as_ref().err().map(|e| e.to_string()),
            }),
        );
        download_result?;
    }
    Ok(())
}

pub async fn get_or_init_ai_models(
    app_handle: &tauri::AppHandle,
    ai_state_mutex: &Mutex<Option<AiState>>,
    ai_init_lock: &TokioMutex<()>,
    model: AiMaskModel,
) -> Result<Arc<AiModels>> {
    let is_downloaded = |models: &AiModels| models.downloaded.lock().unwrap().contains(&model);

    if let Some(models) = cached_ai_state(ai_state_mutex, |state| state.models.clone())
        && is_downloaded(&models)
    {
        return Ok(models);
    }

    let _guard = ai_init_lock.lock().await;

    let models = match cached_ai_state(ai_state_mutex, |state| state.models.clone()) {
        Some(models) => models,
        None => {
            let _ = ort::init().with_name("AI").commit();
            crate::register_exit_handler();

            let models = Arc::new(AiModels {
                models_dir: get_models_dir(app_handle)?,
                use_gpu: gpu_acceleration_enabled(app_handle),
                downloaded: Mutex::new(HashSet::new()),
                sam_encoder: Mutex::new(None),
                sam_decoder: Mutex::new(None),
                birefnet: Mutex::new(None),
                esam3_image_encoder: Mutex::new(None),
                esam3_decoder: Mutex::new(None),
                esam3_text_encoder: Mutex::new(None),
                esam3_sky_prompt: Mutex::new(None),
                esam3_face_prompt: Mutex::new(None),
                clip_tokenizer: Mutex::new(None),
                face_landmarks: Mutex::new(None),
                face_segmenter: Mutex::new(None),
                depth_anything: Mutex::new(None),
            });
            ai_state_mutex
                .lock()
                .unwrap()
                .get_or_insert_with(AiState::default)
                .models = Some(models.clone());
            models
        }
    };

    if !is_downloaded(&models) {
        for asset in model.assets(models.gpu_inference()) {
            download_and_verify_model(app_handle, &models.models_dir, asset).await?;
        }
        models.downloaded.lock().unwrap().insert(model);
    }

    Ok(models)
}

pub async fn get_or_init_denoise_model(
    app_handle: &tauri::AppHandle,
    ai_state_mutex: &Mutex<Option<AiState>>,
    ai_init_lock: &TokioMutex<()>,
) -> Result<Arc<Mutex<Session>>> {
    if let Some(denoise_model) =
        cached_ai_state(ai_state_mutex, |state| state.denoise_model.clone())
    {
        return Ok(denoise_model);
    }

    let _guard = ai_init_lock.lock().await;

    if let Some(denoise_model) =
        cached_ai_state(ai_state_mutex, |state| state.denoise_model.clone())
    {
        return Ok(denoise_model);
    }

    let models_dir = get_models_dir(app_handle)?;
    download_and_verify_model(app_handle, &models_dir, &DENOISE_ASSET).await?;

    let _ = ort::init().with_name("AI-Denoise").commit();
    let model_path = models_dir.join(DENOISE_FILENAME);
    let session = build_session(
        &model_path,
        SessionKind::Persistent,
        gpu_acceleration_enabled(app_handle),
        Some(denoise_crop_as_slice),
    )?;
    let denoise_model = Arc::new(Mutex::new(session));

    crate::register_exit_handler();

    ai_state_mutex
        .lock()
        .unwrap()
        .get_or_insert_with(AiState::default)
        .denoise_model = Some(denoise_model.clone());

    Ok(denoise_model)
}

pub async fn get_or_init_clip_models(
    app_handle: &tauri::AppHandle,
    ai_state_mutex: &Mutex<Option<AiState>>,
    ai_init_lock: &TokioMutex<()>,
) -> Result<Arc<ClipModels>> {
    if let Some(clip_models) = cached_ai_state(ai_state_mutex, |state| state.clip_models.clone()) {
        return Ok(clip_models);
    }

    let _guard = ai_init_lock.lock().await;

    if let Some(clip_models) = cached_ai_state(ai_state_mutex, |state| state.clip_models.clone()) {
        return Ok(clip_models);
    }

    let models_dir = get_models_dir(app_handle)?;

    download_and_verify_model(app_handle, &models_dir, &CLIP_MODEL_ASSET).await?;
    download_and_verify_model(app_handle, &models_dir, &CLIP_TOKENIZER_ASSET).await?;
    let clip_tokenizer_path = models_dir.join(CLIP_TOKENIZER_FILENAME);

    let _ = ort::init().with_name("AI-Tagging").commit();
    let clip_model_path = models_dir.join(CLIP_MODEL_FILENAME);
    let model = Mutex::new(build_session(
        &clip_model_path,
        SessionKind::Persistent,
        gpu_allowed_on_platform() && gpu_acceleration_enabled(app_handle),
        None,
    )?);
    let tokenizer =
        Tokenizer::from_file(clip_tokenizer_path).map_err(|e| anyhow::anyhow!(e.to_string()))?;

    crate::register_exit_handler();

    let clip_models = Arc::new(ClipModels { model, tokenizer });

    ai_state_mutex
        .lock()
        .unwrap()
        .get_or_insert_with(AiState::default)
        .clip_models = Some(clip_models.clone());

    Ok(clip_models)
}

pub async fn get_or_init_lama_model(
    app_handle: &tauri::AppHandle,
    ai_state_mutex: &Mutex<Option<AiState>>,
    ai_init_lock: &TokioMutex<()>,
) -> Result<Arc<Mutex<Session>>> {
    if let Some(lama_model) = cached_ai_state(ai_state_mutex, |state| state.lama_model.clone()) {
        return Ok(lama_model);
    }

    let _guard = ai_init_lock.lock().await;

    if let Some(lama_model) = cached_ai_state(ai_state_mutex, |state| state.lama_model.clone()) {
        return Ok(lama_model);
    }

    let models_dir = get_models_dir(app_handle)?;
    download_and_verify_model(app_handle, &models_dir, &LAMA_ASSET).await?;

    let _ = ort::init().with_name("AI-Inpainting").commit();
    let model_path = models_dir.join(LAMA_FILENAME);
    let session = build_session(&model_path, SessionKind::OneShot, false, None)?;
    let lama_model = Arc::new(Mutex::new(session));

    crate::register_exit_handler();

    ai_state_mutex
        .lock()
        .unwrap()
        .get_or_insert_with(AiState::default)
        .lama_model = Some(lama_model.clone());

    Ok(lama_model)
}

pub async fn get_or_init_normal_model(
    app_handle: &tauri::AppHandle,
    ai_state_mutex: &Mutex<Option<AiState>>,
    ai_init_lock: &TokioMutex<()>,
) -> Result<Arc<Mutex<Session>>> {
    if let Some(normal_model) = cached_ai_state(ai_state_mutex, |state| state.normal_model.clone())
    {
        return Ok(normal_model);
    }

    let _guard = ai_init_lock.lock().await;

    if let Some(normal_model) = cached_ai_state(ai_state_mutex, |state| state.normal_model.clone())
    {
        return Ok(normal_model);
    }

    let models_dir = get_models_dir(app_handle)?;
    download_and_verify_model(app_handle, &models_dir, &NORMAL_ASSET).await?;

    let _ = ort::init().with_name("AI-Normal").commit();
    let model_path = models_dir.join(NORMAL_FILENAME);
    let session = build_session(
        &model_path,
        SessionKind::OneShot,
        gpu_allowed_on_platform() && gpu_acceleration_enabled(app_handle),
        None,
    )?;
    let normal_model = Arc::new(Mutex::new(session));

    crate::register_exit_handler();

    ai_state_mutex
        .lock()
        .unwrap()
        .get_or_insert_with(AiState::default)
        .normal_model = Some(normal_model.clone());

    Ok(normal_model)
}

#[derive(Clone, Copy)]
struct TileParams {
    cs: usize,
    margin: usize,
    overlap: usize,
}

const DENOISE_TILE: TileParams = TileParams {
    cs: 504,
    margin: 12,
    overlap: 64,
};

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

fn tile_origins(len: usize, params: TileParams) -> Vec<i32> {
    let valid = params.cs - 2 * params.margin;
    let step = (valid - params.overlap).max(1);
    let mut origins = Vec::new();
    let mut start = 0;
    loop {
        origins.push(start as i32 - params.margin as i32);
        if start + valid >= len {
            break;
        }
        start += step;
    }
    origins
}

fn tile_blend_weights(params: TileParams) -> Vec<f32> {
    let valid = params.cs - 2 * params.margin;
    let ramp = |d: usize| ((d as f32 + 0.5) / params.overlap.max(1) as f32).min(1.0);
    (0..valid)
        .map(|i| {
            let t = ramp(i).min(ramp(valid - 1 - i));
            t * t * (3.0 - 2.0 * t)
        })
        .collect()
}

fn run_native_denoise(
    img: &Rgb32FImage,
    session: &Mutex<Session>,
    params: TileParams,
    on_progress: &dyn Fn(f32),
) -> Result<Rgb32FImage> {
    let (width, height) = (img.width() as usize, img.height() as usize);
    let valid = params.cs - 2 * params.margin;
    let weights = tile_blend_weights(params);
    let xs = tile_origins(width, params);
    let ys = tile_origins(height, params);
    let total = xs.len() * ys.len();

    let mut accumulator = vec![0.0f32; width * height * 3];
    let mut weight_sum = vec![0.0f32; width * height];

    for (i, (&y0, &x0)) in ys
        .iter()
        .flat_map(|y| xs.iter().map(move |x| (y, x)))
        .enumerate()
    {
        on_progress(i as f32 / total as f32);

        let crop = extract_tile_mirror(img, x0, y0, params.cs);
        let t_input = Tensor::from_array(crop.as_standard_layout().to_owned())?;

        let tile = {
            let mut sess = session.lock().unwrap();
            let outputs = gpu_inference(sess.run(ort::inputs![t_input]))?;
            outputs[0]
                .try_extract_array::<f32>()?
                .to_owned()
                .into_dimensionality::<ndarray::Ix4>()
                .map_err(|e| anyhow::anyhow!("Unexpected output shape: {}", e))?
        };

        for ty in 0..valid {
            let gy = y0 + (params.margin + ty) as i32;
            if gy < 0 || gy >= height as i32 {
                continue;
            }
            for tx in 0..valid {
                let gx = x0 + (params.margin + tx) as i32;
                if gx < 0 || gx >= width as i32 {
                    continue;
                }
                let w = weights[ty] * weights[tx];
                let idx = gy as usize * width + gx as usize;
                for c in 0..3 {
                    let v = tile[[0, c, params.margin + ty, params.margin + tx]].clamp(0.0, 1.0);
                    accumulator[idx * 3 + c] += v * w;
                }
                weight_sum[idx] += w;
            }
        }
    }

    let mut out = Rgb32FImage::new(width as u32, height as u32);
    out.par_chunks_exact_mut(3)
        .zip(accumulator.par_chunks_exact(3))
        .zip(weight_sum.par_iter())
        .for_each(|((px, acc), &w)| {
            let inv = if w > 0.0 { 1.0 / w } else { 0.0 };
            for c in 0..3 {
                px[c] = (acc[c] * inv).clamp(0.0, 1.0);
            }
        });
    Ok(out)
}

pub fn run_ai_denoise(
    rgb_img: &Rgb32FImage,
    session: &Mutex<Session>,
    on_progress: &dyn Fn(f32),
) -> Result<DynamicImage> {
    let out = run_native_denoise(rgb_img, session, DENOISE_TILE, on_progress)?;
    Ok(DynamicImage::ImageRgb32F(out))
}

const LAMA_PIXEL_BUDGET: f32 = 768.0 * 768.0;
const LAMA_PATCH_RADIUS: i32 = 3;
const LAMA_PATCH_MATCH_ITERS: u32 = 6;

fn dilate_mask(mask: &[bool], w: usize, h: usize, r: usize) -> Vec<bool> {
    let mut horiz = vec![false; w * h];
    horiz.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let src = &mask[y * w..(y + 1) * w];
        let mut prefix = vec![0u32; w + 1];
        for x in 0..w {
            prefix[x + 1] = prefix[x] + src[x] as u32;
        }
        for (x, out) in row.iter_mut().enumerate() {
            *out = prefix[(x + r + 1).min(w)] > prefix[x.saturating_sub(r)];
        }
    });
    let mut dilated = vec![false; w * h];
    dilated.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let y0 = y.saturating_sub(r);
        let y1 = (y + r).min(h - 1);
        for (x, out) in row.iter_mut().enumerate() {
            *out = (y0..=y1).any(|yy| horiz[yy * w + x]);
        }
    });
    dilated
}

fn catmull_rom_sample(img: &[[f32; 3]], w: usize, h: usize, x: f32, y: f32) -> [f32; 3] {
    let weights = |t: f32| {
        let t2 = t * t;
        let t3 = t2 * t;
        [
            -0.5 * t3 + t2 - 0.5 * t,
            1.5 * t3 - 2.5 * t2 + 1.0,
            -1.5 * t3 + 2.0 * t2 + 0.5 * t,
            0.5 * t3 - 0.5 * t2,
        ]
    };
    let (fx, fy) = (x.floor(), y.floor());
    let wx = weights(x - fx);
    let wy = weights(y - fy);
    let mut acc = [0.0f32; 3];
    for (j, wyj) in wy.iter().enumerate() {
        let sy = (fy as i32 + j as i32 - 1).clamp(0, h as i32 - 1) as usize;
        for (i, wxi) in wx.iter().enumerate() {
            let sx = (fx as i32 + i as i32 - 1).clamp(0, w as i32 - 1) as usize;
            let p = img[sy * w + sx];
            let wgt = wyj * wxi;
            acc[0] += p[0] * wgt;
            acc[1] += p[1] * wgt;
            acc[2] += p[2] * wgt;
        }
    }
    acc
}

fn splitmix64(mut z: u64) -> u64 {
    z = z.wrapping_add(0x9E3779B97F4A7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
    z ^ (z >> 31)
}

fn patch_distance(
    target: &[[f32; 3]],
    source: &[[f32; 3]],
    w: usize,
    h: usize,
    t: (i32, i32),
    s: (i32, i32),
    limit: f32,
) -> f32 {
    let mut d = 0.0f32;
    for dy in -LAMA_PATCH_RADIUS..=LAMA_PATCH_RADIUS {
        let ty = (t.1 + dy).clamp(0, h as i32 - 1) as usize;
        let srow = (s.1 + dy) as usize * w;
        for dx in -LAMA_PATCH_RADIUS..=LAMA_PATCH_RADIUS {
            let tx = (t.0 + dx).clamp(0, w as i32 - 1) as usize;
            let a = target[ty * w + tx];
            let b = source[srow + (s.0 + dx) as usize];
            let (e0, e1, e2) = (a[0] - b[0], a[1] - b[1], a[2] - b[2]);
            d += e0 * e0 + e1 * e1 + e2 * e2;
        }
        if d >= limit {
            return d;
        }
    }
    d
}

fn lama_patch_match(
    target: &[[f32; 3]],
    source: &[[f32; 3]],
    w: usize,
    h: usize,
    is_target: &[bool],
    is_source: &[bool],
) -> Option<Vec<Option<(i32, i32)>>> {
    let sources: Vec<(i32, i32)> = (0..w * h)
        .filter(|&i| is_source[i])
        .map(|i| ((i % w) as i32, (i / w) as i32))
        .collect();
    let targets: Vec<usize> = (0..w * h).filter(|&i| is_target[i]).collect();
    if sources.is_empty() || targets.is_empty() {
        return None;
    }

    let valid = |p: (i32, i32)| {
        p.0 >= 0
            && p.1 >= 0
            && (p.0 as usize) < w
            && (p.1 as usize) < h
            && is_source[p.1 as usize * w + p.0 as usize]
    };
    let random_source = |seed: u64| sources[(seed % sources.len() as u64) as usize];

    let mut nnf = vec![(0i32, 0i32); w * h];
    let mut cost = vec![f32::MAX; w * h];
    let init: Vec<((i32, i32), f32)> = targets
        .par_iter()
        .map(|&i| {
            let t = ((i % w) as i32, (i / w) as i32);
            let s = random_source(splitmix64(i as u64));
            (s, patch_distance(target, source, w, h, t, s, f32::MAX))
        })
        .collect();
    for (&i, (s, c)) in targets.iter().zip(init) {
        nnf[i] = s;
        cost[i] = c;
    }

    for iter in 0..LAMA_PATCH_MATCH_ITERS {
        let jump = 1i32 << (LAMA_PATCH_MATCH_ITERS - 1 - iter).min(3);
        let updates: Vec<((i32, i32), f32)> = targets
            .par_iter()
            .map(|&i| {
                let t = ((i % w) as i32, (i / w) as i32);
                let mut best = nnf[i];
                let mut best_cost = cost[i];
                let consider = |c: (i32, i32), best: &mut (i32, i32), best_cost: &mut f32| {
                    if valid(c) && c != *best {
                        let d = patch_distance(target, source, w, h, t, c, *best_cost);
                        if d < *best_cost {
                            *best = c;
                            *best_cost = d;
                        }
                    }
                };

                for (dx, dy) in [(-jump, 0), (jump, 0), (0, -jump), (0, jump)] {
                    let (nx, ny) = (t.0 + dx, t.1 + dy);
                    if nx >= 0 && ny >= 0 && (nx as usize) < w && (ny as usize) < h {
                        let n = ny as usize * w + nx as usize;
                        if is_target[n] {
                            consider((nnf[n].0 - dx, nnf[n].1 - dy), &mut best, &mut best_cost);
                        }
                    }
                }

                let mut seed = splitmix64(i as u64 ^ ((iter as u64 + 1) << 40));
                let mut radius = w.max(h) as i32;
                while radius >= 1 {
                    seed = splitmix64(seed);
                    let span = (2 * radius + 1) as u64;
                    let c = (
                        best.0 + (seed % span) as i32 - radius,
                        best.1 + ((seed >> 32) % span) as i32 - radius,
                    );
                    consider(c, &mut best, &mut best_cost);
                    radius /= 2;
                }
                consider(random_source(splitmix64(seed)), &mut best, &mut best_cost);

                (best, best_cost)
            })
            .collect();
        for (&i, (s, c)) in targets.iter().zip(updates) {
            nnf[i] = s;
            cost[i] = c;
        }
    }

    Some((0..w * h).map(|i| is_target[i].then_some(nnf[i])).collect())
}

pub fn run_lama_inpainting(
    image: &DynamicImage,
    mask: &GrayImage,
    lama_session: &Mutex<Session>,
) -> Result<(RgbaImage, u32, u32)> {
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
        return Ok((image.to_rgba8(), 0, 0));
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

    let cropped_img = image.crop_imm(x0, y0, crop_w, crop_h).to_rgba8();
    let cropped_mask = imageops::crop_imm(mask, x0, y0, crop_w, crop_h).to_image();

    let scale = (LAMA_PIXEL_BUDGET / (crop_w as f32 * crop_h as f32))
        .sqrt()
        .min(1.0);
    let fw = ((crop_w as f32 * scale).round() as u32).max(1);
    let fh = ((crop_h as f32 * scale).round() as u32).max(1);
    let needs_downscale = fw != crop_w || fh != crop_h;

    let (inf_img, inf_mask) = if needs_downscale {
        (
            imageops::resize(&cropped_img, fw, fh, FilterType::Lanczos3),
            imageops::resize(&cropped_mask, fw, fh, FilterType::Triangle),
        )
    } else {
        (cropped_img.clone(), cropped_mask.clone())
    };

    let align = 32u32;
    let tensor_w = fw.div_ceil(align) * align;
    let tensor_h = fh.div_ceil(align) * align;

    let mut img_tensor = Array::<f32, _>::zeros((1, 3, tensor_h as usize, tensor_w as usize));
    let mut msk_tensor = Array::<f32, _>::zeros((1, 1, tensor_h as usize, tensor_w as usize));

    for y in 0..tensor_h {
        for x in 0..tensor_w {
            let p = inf_img.get_pixel(x.min(fw - 1), y.min(fh - 1));
            let m = inf_mask.get_pixel(x.min(fw - 1), y.min(fh - 1))[0];
            let (y, x) = (y as usize, x as usize);

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

    let (iw, ih) = (fw as usize, fh as usize);
    let target: Vec<[f32; 3]> = (0..iw * ih)
        .map(|i| {
            let (x, y) = (i % iw, i / iw);
            [0, 1, 2].map(|c| (output_tensor[[0, c, y, x]] / 255.0).clamp(0.0, 1.0))
        })
        .collect();
    let source: Vec<[f32; 3]> = inf_img
        .pixels()
        .map(|p| {
            [
                p[0] as f32 / 255.0,
                p[1] as f32 / 255.0,
                p[2] as f32 / 255.0,
            ]
        })
        .collect();

    let nnf = if needs_downscale {
        let hole: Vec<bool> = inf_mask.pixels().map(|p| p[0] > 0).collect();
        let is_target = dilate_mask(&hole, iw, ih, 1);
        let blocked = dilate_mask(&hole, iw, ih, LAMA_PATCH_RADIUS as usize + 2);
        let r = LAMA_PATCH_RADIUS;
        let is_source: Vec<bool> = (0..iw * ih)
            .map(|i| {
                let (x, y) = ((i % iw) as i32, (i / iw) as i32);
                !blocked[i] && x >= r && y >= r && x < iw as i32 - r && y < ih as i32 - r
            })
            .collect();
        lama_patch_match(&target, &source, iw, ih, &is_target, &is_source)
    } else {
        None
    };

    let sx = fw as f32 / crop_w as f32;
    let sy = fh as f32 / crop_h as f32;
    let mut final_crop = cropped_img.clone();

    final_crop
        .par_chunks_mut(crop_w as usize * 4)
        .enumerate()
        .for_each(|(y, row)| {
            for x in 0..crop_w as usize {
                let m = cropped_mask.get_pixel(x as u32, y as u32)[0];
                if m == 0 {
                    continue;
                }
                let u = (x as f32 + 0.5) * sx - 0.5;
                let v = (y as f32 + 0.5) * sy - 0.5;
                let mut value = catmull_rom_sample(&target, iw, ih, u, v);

                if let Some(nnf) = &nnf {
                    let (u0, v0) = (u.floor(), v.floor());
                    let (fu, fv) = (u - u0, v - v0);
                    let mut groups = [((0i32, 0i32), 0.0f32, [0.0f32; 3]); 4];
                    let mut group_count = 0;
                    for (cu, cv, wgt) in [
                        (u0, v0, (1.0 - fu) * (1.0 - fv)),
                        (u0 + 1.0, v0, fu * (1.0 - fv)),
                        (u0, v0 + 1.0, (1.0 - fu) * fv),
                        (u0 + 1.0, v0 + 1.0, fu * fv),
                    ] {
                        let cu = (cu as i32).clamp(0, iw as i32 - 1);
                        let cv = (cv as i32).clamp(0, ih as i32 - 1);
                        let Some((su, sv)) = nnf[cv as usize * iw + cu as usize] else {
                            continue;
                        };
                        let qx = x as i32 + ((su - cu) as f32 / sx).round() as i32;
                        let qy = y as i32 + ((sv - cv) as f32 / sy).round() as i32;
                        if qx < 0 || qy < 0 || qx >= crop_w as i32 || qy >= crop_h as i32 {
                            continue;
                        }
                        if cropped_mask.get_pixel(qx as u32, qy as u32)[0] > 0 {
                            continue;
                        }
                        let o = cropped_img.get_pixel(qx as u32, qy as u32);
                        let low = catmull_rom_sample(
                            &source,
                            iw,
                            ih,
                            (qx as f32 + 0.5) * sx - 0.5,
                            (qy as f32 + 0.5) * sy - 0.5,
                        );
                        let detail = [0, 1, 2].map(|c| o[c] as f32 / 255.0 - low[c]);
                        let shift = (qx - x as i32, qy - y as i32);
                        match groups[..group_count].iter_mut().find(|g| g.0 == shift) {
                            Some(g) => g.1 += wgt,
                            None => {
                                groups[group_count] = (shift, wgt, detail);
                                group_count += 1;
                            }
                        }
                    }
                    let norm = groups[..group_count]
                        .iter()
                        .map(|g| g.1 * g.1)
                        .sum::<f32>()
                        .sqrt();
                    if norm > 0.0 {
                        for (_, wgt, detail) in &groups[..group_count] {
                            for c in 0..3 {
                                value[c] += wgt * detail[c] / norm;
                            }
                        }
                    }
                }

                let alpha = m as f32 / 255.0;
                let px = &mut row[x * 4..x * 4 + 3];
                for c in 0..3 {
                    px[c] = (value[c].clamp(0.0, 1.0) * 255.0 * alpha
                        + px[c] as f32 * (1.0 - alpha))
                        .round() as u8;
                }
            }
        });

    Ok((final_crop, x0, y0))
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
    let rgb_image = resized_image.into_rgb8();
    let (actual_width, actual_height) = rgb_image.dimensions();
    let raw_pixels = rgb_image.as_raw();

    let mut input_tensor: Array<u8, _> =
        Array::zeros((1, 3, SAM_INPUT_SIZE as usize, SAM_INPUT_SIZE as usize));

    let w_usize = actual_width as usize;
    for y in 0..(actual_height as usize) {
        for x in 0..w_usize {
            let idx = (y * w_usize + x) * 3;
            input_tensor[[0, 0, y, x]] = raw_pixels[idx];
            input_tensor[[0, 1, y, x]] = raw_pixels[idx + 1];
            input_tensor[[0, 2, y, x]] = raw_pixels[idx + 2];
        }
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
    original_image: Option<&DynamicImage>,
) -> Result<GrayImage> {
    let (orig_width, orig_height) = embeddings.original_size;
    let long_side = orig_width.max(orig_height) as f64;
    let scale = SAM_INPUT_SIZE as f64 / long_side;

    let iters = 2;

    let is_point =
        (start_point.0 - end_point.0).abs() < 1e-6 && (start_point.1 - end_point.1).abs() < 1e-6;
    let mut point_coords = Vec::new();
    let mut point_labels = Vec::new();

    if is_point {
        point_coords.push((
            (start_point.0 * scale) as f32,
            (start_point.1 * scale) as f32,
        ));
        point_labels.push(1.0f32);
    } else {
        let x1 = (start_point.0.min(end_point.0) * scale) as f32;
        let y1 = (start_point.1.min(end_point.1) * scale) as f32;
        let x2 = (start_point.0.max(end_point.0) * scale) as f32;
        let y2 = (start_point.1.max(end_point.1) * scale) as f32;
        point_coords.push((x1, y1));
        point_coords.push((x2, y2));
        point_labels.push(2.0f32);
        point_labels.push(3.0f32);
    }

    let mut mask_input = Array::zeros((1, 1, 256, 256)).into_dyn();
    let mut has_mask_input = 0.0f32;

    let orig_im_size =
        Array::from_shape_vec((2,), vec![orig_height as f32, orig_width as f32])?.into_dyn();

    let mut final_mask_data: Vec<u8> = Vec::new();
    let mut final_w = 0;
    let mut final_h = 0;

    for i in 0..iters {
        let pc_len = point_coords.len();
        let pl_len = point_labels.len();

        let coords_flat: Vec<f32> = point_coords.iter().flat_map(|&(x, y)| vec![x, y]).collect();
        let coords_array = Array::from_shape_vec((1, pc_len, 2), coords_flat)?.into_dyn();
        let labels_array = Array::from_shape_vec((1, pl_len), point_labels.clone())?.into_dyn();

        let t_embeddings = Tensor::from_array(
            embeddings
                .embeddings
                .clone()
                .as_standard_layout()
                .into_owned(),
        )?;
        let t_point_coords = Tensor::from_array(coords_array.as_standard_layout().into_owned())?;
        let t_point_labels = Tensor::from_array(labels_array.as_standard_layout().into_owned())?;
        let t_mask_input =
            Tensor::from_array(mask_input.clone().as_standard_layout().into_owned())?;
        let t_has_mask = Tensor::from_array(
            Array::from_elem((1,), has_mask_input)
                .into_dyn()
                .as_standard_layout()
                .into_owned(),
        )?;
        let t_orig_im_size =
            Tensor::from_array(orig_im_size.clone().as_standard_layout().into_owned())?;

        let mask_tensor = {
            let mut session = decoder.lock().unwrap();
            let outputs = session.run(ort::inputs![
                t_embeddings,
                t_point_coords,
                t_point_labels,
                t_mask_input,
                t_has_mask,
                t_orig_im_size
            ])?;
            outputs[0].try_extract_array::<f32>()?.to_owned()
        };

        let mask_dims = mask_tensor.shape();
        let h = mask_dims[2];
        let w = mask_dims[3];
        let area = h * w;

        let mask_slice = mask_tensor.as_slice().unwrap();
        let first_mask_slice = &mask_slice[0..area];

        if i == iters - 1 {
            final_mask_data = first_mask_slice
                .iter()
                .map(|&val| if val > 0.0 { 255 } else { 0 })
                .collect();
            final_w = w;
            final_h = h;
            break;
        }

        let mut binary_mask = vec![false; area];
        let mut mask_area = 0.0;
        let mut min_x = w;
        let mut min_y = h;
        let mut max_x = 0;
        let mut max_y = 0;

        for (idx, &val) in first_mask_slice.iter().enumerate() {
            if val > 0.0 {
                binary_mask[idx] = true;
                let x = idx % w;
                let y = idx / w;
                min_x = min_x.min(x);
                max_x = max_x.max(x);
                min_y = min_y.min(y);
                max_y = max_y.max(y);
                mask_area += 1.0;
            }
        }

        if mask_area == 0.0 || min_x > max_x {
            final_mask_data = first_mask_slice
                .iter()
                .map(|&val| if val > 0.0 { 255 } else { 0 })
                .collect();
            final_w = w;
            final_h = h;
            break;
        }

        let dt_in = edt_2d(&binary_mask, w, h);
        let mut max_in = 0.0;
        let mut pos_idx = 0;
        for (idx, &v) in dt_in.iter().enumerate() {
            if v > max_in {
                max_in = v;
                pos_idx = idx;
            }
        }
        let pos_y = pos_idx / w;
        let pos_x = pos_idx % w;

        let mut rev_mask = vec![false; area];
        for (idx, is_true) in binary_mask.iter().enumerate() {
            rev_mask[idx] = !is_true;
        }
        let mut dt_out = edt_2d(&rev_mask, w, h);

        for y in 0..h {
            for x in 0..w {
                if x < min_x || x > max_x || y < min_y || y > max_y {
                    dt_out[y * w + x] = 0.0;
                }
            }
        }

        let mut max_out = 0.0;
        let mut neg_idx = 0;
        for (idx, &v) in dt_out.iter().enumerate() {
            if v > max_out {
                max_out = v;
                neg_idx = idx;
            }
        }
        let neg_y = neg_idx / w;
        let neg_x = neg_idx % w;

        point_coords.clear();
        point_labels.clear();

        point_coords.push(((pos_x as f64 * scale) as f32, (pos_y as f64 * scale) as f32));
        point_labels.push(1.0);
        point_coords.push(((neg_x as f64 * scale) as f32, (neg_y as f64 * scale) as f32));
        point_labels.push(0.0);
        point_coords.push(((min_x as f64 * scale) as f32, (min_y as f64 * scale) as f32));
        point_labels.push(2.0);
        point_coords.push(((max_x as f64 * scale) as f32, (max_y as f64 * scale) as f32));
        point_labels.push(3.0);

        let mut gaus_dt = vec![0.0f32; area];
        let variance = (mask_area / 4.0_f32).max(1.0_f32);
        for (idx, &is_true) in binary_mask.iter().enumerate() {
            if is_true {
                let diff = dt_in[idx] - max_in;
                gaus_dt[idx] = (-(diff * diff) / variance).exp();
            }
        }

        let mask_f32_vec: Vec<f32> = first_mask_slice
            .iter()
            .map(|&v| if v > 0.0 { 15.0 } else { -15.0 })
            .collect();

        let img_mask_f32 =
            ImageBuffer::<Luma<f32>, Vec<f32>>::from_raw(w as u32, h as u32, mask_f32_vec).unwrap();
        let img_gaus_f32 =
            ImageBuffer::<Luma<f32>, Vec<f32>>::from_raw(w as u32, h as u32, gaus_dt).unwrap();

        let resized_mask = imageops::resize(&img_mask_f32, 256, 256, FilterType::Triangle);
        let resized_gaus = imageops::resize(&img_gaus_f32, 256, 256, FilterType::Triangle);

        let rm_raw = resized_mask.as_raw();
        let rg_raw = resized_gaus.as_raw();
        let mut mask_input_flat = vec![0.0f32; 256 * 256];

        for i in 0..(256 * 256) {
            let m_val = rm_raw[i];
            let mut g_val = rg_raw[i];
            if g_val <= 0.0 {
                g_val = 1.0;
            }
            mask_input_flat[i] = m_val * g_val;
        }

        mask_input = Array::from_shape_vec((1, 1, 256, 256), mask_input_flat)
            .unwrap()
            .into_dyn();
        has_mask_input = 1.0;
    }

    let gray_mask = GrayImage::from_raw(final_w as u32, final_h as u32, final_mask_data)
        .ok_or_else(|| anyhow::anyhow!("Failed to create mask image from raw data"))?;

    if let Some(img) = original_image {
        let (orig_width, orig_height) = img.dimensions();
        let guide_hr = img.to_luma8();

        let long_edge = orig_width.max(orig_height) as f32;
        let radius = (long_edge * 0.0075).clamp(8.0, 24.0);

        let resized_coarse_mask =
            image::imageops::resize(&gray_mask, orig_width, orig_height, FilterType::Triangle);

        let feathered_coarse_mask = image::imageops::blur(&resized_coarse_mask, radius / 3.0);

        let mut refined_mask =
            fast_guided_filter(&guide_hr, &feathered_coarse_mask, radius as usize, 0.01);

        for p in refined_mask.pixels_mut() {
            let v = p[0] as f32 / 255.0;
            p[0] = (((v - 0.03) / 0.94).clamp(0.0, 1.0) * 255.0).round() as u8;
        }

        Ok(refined_mask)
    } else {
        let feathered_mask = image::imageops::blur(&gray_mask, 2.0);
        let (orig_width, orig_height) = embeddings.original_size;
        let final_mask = image::imageops::resize(
            &feathered_mask,
            orig_width,
            orig_height,
            FilterType::Triangle,
        );

        Ok(final_mask)
    }
}

fn sigmoid(value: f32) -> f32 {
    1.0 / (1.0 + (-value).exp())
}

pub fn run_esam3_image_encoder(
    image: &DynamicImage,
    encoder_session: &Mutex<Session>,
) -> Result<Esam3Features> {
    let size = ESAM3_INPUT_SIZE as usize;
    let padding = ESAM3_INPUT_PADDING as i64;
    let inner = ESAM3_INPUT_SIZE - 2 * ESAM3_INPUT_PADDING;
    let resized_rgb = image
        .resize_exact(inner, inner, FilterType::Triangle)
        .into_rgb8();

    let reflect = |i: usize| -> u32 {
        let (i, n) = (i as i64 - padding, inner as i64);
        let i = if i < 0 { -i } else { i };
        (if i >= n { 2 * n - 2 - i } else { i }) as u32
    };
    let mut input_tensor = Array4::<f32>::zeros((1, 3, size, size));
    for y in 0..size {
        let src_y = reflect(y);
        for x in 0..size {
            let pixel = resized_rgb.get_pixel(reflect(x), src_y);
            for c in 0..3 {
                input_tensor[[0, c, y, x]] = pixel[c] as f32 / 127.5 - 1.0;
            }
        }
    }

    let mut session = encoder_session.lock().unwrap();
    let outputs =
        gpu_inference(session.run(ort::inputs!["image" => Tensor::from_array(input_tensor)?]))?;
    let extract = |name: &str| -> Result<Array<f32, IxDyn>> {
        Ok(outputs[name].try_extract_array::<f32>()?.to_owned())
    };

    Ok(Esam3Features {
        path_hash: String::new(),
        fpn: [extract("fpn_0")?, extract("fpn_1")?, extract("fpn_2")?],
        pos: extract("pos_2")?,
    })
}

fn run_esam3_queries<T>(
    decoder_session: &Mutex<Session>,
    features: &Esam3Features,
    prompt: &Esam3Prompt,
    read: impl FnOnce(Vec<f32>, ArrayViewD<f32>, ArrayViewD<f32>) -> T,
) -> Result<T> {
    let exemplar_boxes = Array::<f32, _>::zeros((ESAM3_EXEMPLAR_SLOTS, 1, 4));
    let exemplar_labels = Array::<i64, _>::zeros((ESAM3_EXEMPLAR_SLOTS, 1));
    let exemplar_mask = Array::<f32, _>::ones((1, ESAM3_EXEMPLAR_SLOTS));

    let mut session = decoder_session.lock().unwrap();
    let outputs = gpu_inference(session.run(ort::inputs![
        "fpn_0" => TensorRef::from_array_view(&features.fpn[0])?,
        "fpn_1" => TensorRef::from_array_view(&features.fpn[1])?,
        "fpn_2" => TensorRef::from_array_view(&features.fpn[2])?,
        "pos_2" => TensorRef::from_array_view(&features.pos)?,
        "language_features" => TensorRef::from_array_view(&prompt.features)?,
        "language_padding" => TensorRef::from_array_view(&prompt.padding)?,
        "exemplar_boxes" => Tensor::from_array(exemplar_boxes)?,
        "exemplar_labels" => Tensor::from_array(exemplar_labels)?,
        "exemplar_mask" => Tensor::from_array(exemplar_mask)?,
    ]))?;

    let presence = outputs["presence_logit"]
        .try_extract_array::<f32>()?
        .iter()
        .next()
        .map_or(0.0, |&v| sigmoid(v));
    let scores = outputs["pred_logits"]
        .try_extract_array::<f32>()?
        .iter()
        .map(|&logit| sigmoid(logit) * presence)
        .collect();
    Ok(read(
        scores,
        outputs["pred_boxes"].try_extract_array::<f32>()?,
        outputs["pred_masks"].try_extract_array::<f32>()?,
    ))
}

pub fn run_esam3_boxes(
    decoder_session: &Mutex<Session>,
    features: &Esam3Features,
    prompt: &Esam3Prompt,
    score_threshold: f32,
) -> Result<Vec<(f32, [f32; 4])>> {
    let mut detections =
        run_esam3_queries(decoder_session, features, prompt, |scores, boxes, _| {
            scores
                .iter()
                .enumerate()
                .filter(|&(_, &score)| score > score_threshold)
                .map(|(query, &score)| {
                    let size = ESAM3_INPUT_SIZE as f32;
                    let padding = ESAM3_INPUT_PADDING as f32;
                    let inner = size - 2.0 * padding;
                    let [cx, cy, w, h]: [f32; 4] = std::array::from_fn(|i| {
                        let v = boxes[[0, query, i]] * size;
                        if i < 2 {
                            (v - padding) / inner
                        } else {
                            v / inner
                        }
                    });
                    (
                        score,
                        [cx - w / 2.0, cy - h / 2.0, cx + w / 2.0, cy + h / 2.0],
                    )
                })
                .collect::<Vec<_>>()
        })?;
    detections.sort_by(|a, b| b.0.total_cmp(&a.0));
    Ok(detections)
}

pub fn run_esam3_decoder(
    decoder_session: &Mutex<Session>,
    features: &Esam3Features,
    prompt: &Esam3Prompt,
    image: &DynamicImage,
    score_threshold: f32,
    refine_eps: f32,
) -> Result<Option<GrayImage>> {
    let (coarse_mask, mask_w, mask_h) =
        run_esam3_queries(decoder_session, features, prompt, |scores, _, masks| {
            let (mask_h, mask_w) = (masks.shape()[2], masks.shape()[3]);
            let mut coarse_mask: Option<Vec<f32>> = None;
            for (query, &score) in scores.iter().enumerate() {
                if score <= score_threshold {
                    continue;
                }
                let combined = coarse_mask.get_or_insert_with(|| vec![0.0; mask_h * mask_w]);
                let query_mask = masks.slice(s![0, query, .., ..]);
                for (out, &value) in combined.iter_mut().zip(query_mask.iter()) {
                    *out = out.max(sigmoid(value));
                }
            }
            (coarse_mask, mask_w, mask_h)
        })?;

    let Some(coarse_mask) = coarse_mask else {
        return Ok(None);
    };

    let coarse_mask = GrayImage::from_raw(
        mask_w as u32,
        mask_h as u32,
        coarse_mask
            .iter()
            .map(|&v| {
                let v = ((v - ESAM3_MASK_LOW) / (ESAM3_MASK_HIGH - ESAM3_MASK_LOW)).clamp(0.0, 1.0);
                (v * 255.0).round() as u8
            })
            .collect(),
    )
    .ok_or_else(|| anyhow::anyhow!("Failed to create mask from EfficientSAM3 output"))?;

    let input_mask = imageops::resize(
        &coarse_mask,
        ESAM3_INPUT_SIZE,
        ESAM3_INPUT_SIZE,
        FilterType::Triangle,
    );
    let inner = ESAM3_INPUT_SIZE - 2 * ESAM3_INPUT_PADDING;
    let image_mask = imageops::crop_imm(
        &input_mask,
        ESAM3_INPUT_PADDING,
        ESAM3_INPUT_PADDING,
        inner,
        inner,
    )
    .to_image();

    let (orig_width, orig_height) = image.dimensions();
    let scale = (ESAM3_REFINE_SIZE as f32 / orig_width.max(orig_height) as f32).min(1.0);
    let refine_w = ((orig_width as f32 * scale).round() as u32).max(1);
    let refine_h = ((orig_height as f32 * scale).round() as u32).max(1);
    let refine_mask = imageops::resize(&image_mask, refine_w, refine_h, FilterType::Triangle);

    Ok(Some(fast_color_guided_filter(
        &image.to_rgb8(),
        &refine_mask,
        ESAM3_REFINE_RADIUS,
        refine_eps,
    )))
}

pub fn run_esam3_zoomed_decoder(
    encoder_session: &Mutex<Session>,
    decoder_session: &Mutex<Session>,
    features: &Esam3Features,
    prompt: &Esam3Prompt,
    image: &DynamicImage,
    score_threshold: f32,
    refine_eps: f32,
) -> Result<Option<GrayImage>> {
    let Some(mut mask) = run_esam3_decoder(
        decoder_session,
        features,
        prompt,
        image,
        score_threshold,
        refine_eps,
    )?
    else {
        return Ok(None);
    };

    let (width, height) = image.dimensions();
    let grid_size = ZOOM_MIN_SIDE as u32;
    let grid = imageops::resize(&mask, grid_size, grid_size, FilterType::Triangle);
    if let Some((x, y, crop_width, crop_height)) = zoom_region(&grid, width, height) {
        let crop = image.crop_imm(x, y, crop_width, crop_height);
        let crop_features = run_esam3_image_encoder(&crop, encoder_session)?;
        if let Some(detail) = run_esam3_decoder(
            decoder_session,
            &crop_features,
            prompt,
            &crop,
            score_threshold,
            refine_eps,
        )? && mask_iou(&mask, &detail, x, y) >= ESAM3_ZOOM_MIN_IOU
        {
            blend_feathered(&mut mask, &detail, x, y);
        }
    }

    Ok(Some(mask))
}

pub fn run_birefnet_model(
    image: &DynamicImage,
    birefnet_session: &Mutex<Session>,
) -> Result<GrayImage> {
    let (width, height) = image.dimensions();
    let mut session = birefnet_session.lock().unwrap();
    let coarse = run_birefnet_pass(image, &mut session)?;
    let mut mask = imageops::resize(&coarse, width, height, FilterType::Triangle);

    if let Some((x, y, crop_width, crop_height)) = zoom_region(&coarse, width, height) {
        let detail =
            run_birefnet_pass(&image.crop_imm(x, y, crop_width, crop_height), &mut session)?;
        let detail = imageops::resize(&detail, crop_width, crop_height, FilterType::Triangle);
        if mask_iou(&mask, &detail, x, y) >= BIREFNET_ZOOM_MIN_IOU {
            blend_feathered(&mut mask, &detail, x, y);
        }
    }

    Ok(mask)
}

fn mask_iou(mask: &GrayImage, detail: &GrayImage, x0: u32, y0: u32) -> f32 {
    let (mut intersection, mut union) = (0u64, 0u64);
    for (u, v, refined) in detail.enumerate_pixels() {
        let base = mask.get_pixel(x0 + u, y0 + v)[0] >= 128;
        let refined = refined[0] >= 128;
        intersection += (base && refined) as u64;
        union += (base || refined) as u64;
    }
    if union == 0 {
        0.0
    } else {
        intersection as f32 / union as f32
    }
}

fn blend_feathered(mask: &mut GrayImage, detail: &GrayImage, x0: u32, y0: u32) {
    let (width, height) = mask.dimensions();
    let (crop_width, crop_height) = detail.dimensions();
    let feather = (crop_width.min(crop_height) as f32 * ZOOM_FEATHER).max(1.0);
    let ramp = |start: u32, length: u32, extent: u32| -> Vec<f32> {
        (0..length)
            .map(|i| {
                let head = if start == 0 { f32::MAX } else { i as f32 + 0.5 };
                let tail = if start + length == extent {
                    f32::MAX
                } else {
                    (length - i) as f32 - 0.5
                };
                (head.min(tail) / feather).min(1.0)
            })
            .collect()
    };
    let weights_x = ramp(x0, crop_width, width);
    let weights_y = ramp(y0, crop_height, height);

    for (v, weight_y) in weights_y.iter().enumerate() {
        for (u, weight_x) in weights_x.iter().enumerate() {
            let weight = weight_x.min(*weight_y);
            let base = mask.get_pixel(x0 + u as u32, y0 + v as u32)[0] as f32;
            let refined = detail.get_pixel(u as u32, v as u32)[0] as f32;
            mask.put_pixel(
                x0 + u as u32,
                y0 + v as u32,
                Luma([(base + (refined - base) * weight).round() as u8]),
            );
        }
    }
}

fn zoom_region(coarse: &GrayImage, width: u32, height: u32) -> Option<(u32, u32, u32, u32)> {
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (u32::MAX, u32::MAX, 0, 0);
    for (x, y, pixel) in coarse.enumerate_pixels() {
        if pixel[0] >= 128 {
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x + 1);
            max_y = max_y.max(y + 1);
        }
    }
    if min_x == u32::MAX {
        return None;
    }

    let scale_x = width as f32 / coarse.width() as f32;
    let scale_y = height as f32 / coarse.height() as f32;
    let long_side = width.max(height) as f32;
    let subject_side = ((max_x - min_x) as f32 * scale_x).max((max_y - min_y) as f32 * scale_y);
    let side = (subject_side * (1.0 + 2.0 * ZOOM_MARGIN))
        .max(ZOOM_MIN_SIDE)
        .min(long_side);
    if side > ZOOM_MAX_FRACTION * long_side {
        return None;
    }

    let place = |min: u32, max: u32, scale: f32, extent: u32| {
        let center = (min + max) as f32 * 0.5 * scale;
        let length = side.min(extent as f32);
        let start = (center - length * 0.5).clamp(0.0, extent as f32 - length);
        (start as u32, (length as u32).min(extent - start as u32))
    };
    let (x, crop_width) = place(min_x, max_x, scale_x, width);
    let (y, crop_height) = place(min_y, max_y, scale_y, height);
    Some((x, y, crop_width, crop_height))
}

fn run_birefnet_pass(image: &DynamicImage, session: &mut Session) -> Result<GrayImage> {
    let size = BIREFNET_INPUT_SIZE as usize;
    let resized_rgb = image
        .resize_exact(
            BIREFNET_INPUT_SIZE,
            BIREFNET_INPUT_SIZE,
            FilterType::Triangle,
        )
        .into_rgb8();

    let mean = [0.485, 0.456, 0.406];
    let std = [0.229, 0.224, 0.225];

    let mut input_tensor = Array4::<f32>::zeros((1, 3, size, size));
    for (x, y, pixel) in resized_rgb.enumerate_pixels() {
        for c in 0..3 {
            input_tensor[[0, c, y as usize, x as usize]] =
                (pixel[c] as f32 / 255.0 - mean[c]) / std[c];
        }
    }

    let outputs = gpu_inference(session.run(ort::inputs![Tensor::from_array(input_tensor)?]))?;
    let mask_data: Vec<u8> = outputs[0]
        .try_extract_array::<f32>()?
        .iter()
        .map(|&v| (sigmoid(v) * 255.0).round() as u8)
        .collect();

    GrayImage::from_raw(BIREFNET_INPUT_SIZE, BIREFNET_INPUT_SIZE, mask_data)
        .ok_or_else(|| anyhow::anyhow!("Failed to create mask from BiRefNet output"))
}

pub fn run_depth_anything_model(
    image: &DynamicImage,
    depth_session: &Mutex<Session>,
) -> Result<GrayImage> {
    let resized_image = image.resize(DEPTH_INPUT_SIZE, DEPTH_INPUT_SIZE, FilterType::Triangle);
    let (resized_w, resized_h) = resized_image.dimensions();
    let resized_rgb = resized_image.into_rgb8();
    let raw_pixels = resized_rgb.as_raw();

    let paste_x = ((DEPTH_INPUT_SIZE - resized_w) / 2) as usize;
    let paste_y = ((DEPTH_INPUT_SIZE - resized_h) / 2) as usize;

    let mut input_tensor: Array<f32, _> =
        Array::zeros((1, 3, DEPTH_INPUT_SIZE as usize, DEPTH_INPUT_SIZE as usize));

    let mean = [0.485, 0.456, 0.406];
    let std = [0.229, 0.224, 0.225];

    let rw = resized_w as usize;
    let rh = resized_h as usize;

    for y in 0..rh {
        for x in 0..rw {
            let idx = (y * rw + x) * 3;
            let dest_y = y + paste_y;
            let dest_x = x + paste_x;

            input_tensor[[0, 0, dest_y, dest_x]] =
                (raw_pixels[idx] as f32 / 255.0 - mean[0]) / std[0];
            input_tensor[[0, 1, dest_y, dest_x]] =
                (raw_pixels[idx + 1] as f32 / 255.0 - mean[1]) / std[1];
            input_tensor[[0, 2, dest_y, dest_x]] =
                (raw_pixels[idx + 2] as f32 / 255.0 - mean[2]) / std[2];
        }
    }

    let input_tensor_dyn = input_tensor.into_dyn();
    let t_input = Tensor::from_array(input_tensor_dyn.as_standard_layout().into_owned())?;

    let mut session = depth_session.lock().unwrap();
    let outputs = gpu_inference(session.run(ort::inputs![t_input]))?;
    let output_tensor = outputs[0].try_extract_array::<f32>()?.to_owned();
    let out_slice = output_tensor.as_slice().unwrap();

    let usize_size = DEPTH_INPUT_SIZE as usize;

    let mut min_val = f32::MAX;
    let mut max_val = f32::MIN;
    for y in 0..rh {
        let src_y = y + paste_y;
        for x in 0..rw {
            let src_x = x + paste_x;
            let val = out_slice[src_y * usize_size + src_x];
            min_val = min_val.min(val);
            max_val = max_val.max(val);
        }
    }

    let range = max_val - min_val;
    let scale = if range > 1e-6 { 255.0 / range } else { 0.0 };

    let mut cropped_depth_data = Vec::with_capacity(rw * rh);

    for y in 0..rh {
        let src_y = y + paste_y;
        for x in 0..rw {
            let src_x = x + paste_x;
            let val = out_slice[src_y * usize_size + src_x];
            let pixel = if range > 1e-6 {
                ((val - min_val) * scale) as u8
            } else {
                0
            };
            cropped_depth_data.push(pixel);
        }
    }

    let depth_map = GrayImage::from_raw(resized_w, resized_h, cropped_depth_data)
        .ok_or_else(|| anyhow::anyhow!("Failed to create mask from Depth output"))?;

    Ok(depth_map)
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
    let outputs = gpu_inference(session.run(ort::inputs![
        "image" => t_image,
        "num_tokens" => t_num_tokens,
    ]))?;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub box_space_width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub box_space_height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_source: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_source: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiTextMaskParameters {
    #[serde(default)]
    pub prompt: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_source: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiFaceMaskParameters {
    #[serde(default)]
    pub parts: Vec<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_source: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_source: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_source: Option<String>,
}
