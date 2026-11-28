use crate::ai::processing::{CachedDepthMap, Esam3Features, ImageEmbeddings};
use crate::effects::maps::EffectMapKind;
use crate::masks::face::FaceAnalysis;
use anyhow::Result;
use ndarray::{Array, IxDyn};
use once_cell::sync::OnceCell;
use ort::editor::{Graph, Model, Node, ONNX_DOMAIN, Opset};
use ort::environment::Environment;
use ort::ep::CPU;
use ort::memory::Allocator;
use ort::session::Session;
use ort::session::builder::{AutoDevicePolicy, SessionBuilder};
use ort::value::{Outlet, Shape, SymbolicDimensions, Tensor, TensorElementType, ValueType};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tokenizers::Tokenizer;
use tokio::sync::Mutex as TokioMutex;

const ENCODER_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/sam_vit_b_01ec64_encoder.onnx?download=true";

const DECODER_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/sam_vit_b_01ec64_decoder.onnx?download=true";

const ENCODER_FILENAME: &str = "sam_vit_b_01ec64_encoder.onnx";

const DECODER_FILENAME: &str = "sam_vit_b_01ec64_decoder.onnx";

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

const RAWREFINERY_URL: &str = "https://speets.eu/download/ShadowWeightedL1_24_deep_500_32_256.onnx";

const RAWREFINERY_FILENAME: &str = "ShadowWeightedL1_24_deep_500_32_256.onnx";

const RAWREFINERY_SHA256: &str = "b009ca72cf524251817643bbf03dfb08fba5347a448f3e886dd589d57bb3d667";

const UPSCALE_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/2xBHI_small_span_rapidraw.onnx?download=true";

const UPSCALE_FILENAME: &str = "2xBHI_small_span_rapidraw.onnx";

const UPSCALE_SHA256: &str = "9d3a51deab2518cde257048180070b078840f2aa32326b8bf0e86f15f2a689a0";

const UPSCALE_SPATIAL_DIMS: [&str; 2] = ["h", "w"];

const LAMA_URL: &str =
    "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/lama_fp16.onnx?download=true";

const LAMA_FILENAME: &str = "lama_fp16.onnx";

const LAMA_SHA256: &str = "2d6be6277c400d6f1b91819737f7c3da935e5c63d1b521d393be1196a2bfa82c";

const DEPTH_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/depth_anything_v2_vits.onnx?download=true";

const DEPTH_FILENAME: &str = "depth_anything_v2_vits.onnx";

const DEPTH_SHA256: &str = "d2b11a11c1d4a12b47608fa65a17ee9a4c605b55ee1730c8e3b526304f2562be";

const NORMAL_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/moge-2-vits-normal-onnx.onnx?download=true";

const NORMAL_FILENAME: &str = "moge-2-vits-normal-onnx.onnx";

const NORMAL_SHA256: &str = "24eacb5dc7a2c54c7bc98f7de085ffbed79ad006ea5b664c2c2cdc02ff3a52f0";

type SharedSession = Arc<Mutex<Session>>;

const GPU_IDLE: u8 = 0;

const GPU_ACTIVE: u8 = 1;

const GPU_FAILED: u8 = 2;

const GPU_DISABLED: u8 = 3;

static GPU_STATUS: AtomicU8 = AtomicU8::new(GPU_IDLE);

const PARKED_SESSION_IDLE: Duration = Duration::from_secs(30);

static PARKED_SESSIONS: Mutex<Vec<(EffectMapKind, Session, Instant)>> = Mutex::new(Vec::new());

static REAPING_SESSIONS: AtomicBool = AtomicBool::new(false);

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

const RAWREFINERY_ASSET: ModelAsset = ModelAsset {
    filename: RAWREFINERY_FILENAME,
    url: RAWREFINERY_URL,
    sha256: Some(RAWREFINERY_SHA256),
    name: "RawRefinery Denoise Model",
};

const UPSCALE_ASSET: ModelAsset = ModelAsset {
    filename: UPSCALE_FILENAME,
    url: UPSCALE_URL,
    sha256: Some(UPSCALE_SHA256),
    name: "Super Resolution Model",
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
        self.use_gpu && birefnet_gpu_allowed() && gpu_provider_available()
    }

    pub fn birefnet(&self) -> Result<SharedSession> {
        let filename = if self.gpu_inference() {
            BIREFNET_FP16_FILENAME
        } else {
            BIREFNET_FP32_FILENAME
        };
        self.session(&self.birefnet, filename, birefnet_gpu_allowed())
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

    fn depth_anything_stream(&self) -> Result<Session> {
        build_session(
            &self.models_dir.join(DEPTH_FILENAME),
            SessionKind::Persistent,
            self.use_gpu,
            None,
        )
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

static ENVIRONMENT: OnceCell<Environment> = OnceCell::new();

fn environment() -> ort::Result<&'static Environment> {
    ENVIRONMENT.get_or_try_init(|| {
        let environment = ort::init().with_name("AI").build()?;
        crate::register_exit_handler();
        Ok(environment)
    })
}

pub fn session_builder() -> ort::Result<SessionBuilder> {
    Ok(Session::builder(environment()?)?.with_auto_device(AutoDevicePolicy::PreferCPU)?)
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
fn add_gpu_provider(builder: SessionBuilder) -> ort::Result<SessionBuilder> {
    let directml = ort::ep::DirectML::default()
        .with_device_id(high_performance_dml_device_id().unwrap_or(0))
        .build()
        .error_on_failure();
    Ok(builder.with_execution_providers([directml])?)
}

#[cfg(target_os = "macos")]
fn add_gpu_provider(builder: SessionBuilder) -> ort::Result<SessionBuilder> {
    use ort::ep::coreml::{ComputeUnits, ModelFormat};

    let coreml = ort::ep::CoreML::default()
        .with_model_format(ModelFormat::MLProgram)
        .with_compute_units(ComputeUnits::All)
        .build()
        .error_on_failure();
    Ok(builder.with_execution_providers([coreml])?)
}

#[cfg(target_os = "linux")]
const WEBGPU_EP: &str = "WebGpuExecutionProvider";

#[cfg(target_os = "linux")]
const WEBGPU_PLUGIN_LIBRARY: &str = "libonnxruntime_providers_webgpu.so";

#[cfg(target_os = "linux")]
fn webgpu_devices(environment: &Environment) -> impl Iterator<Item = ort::device::Device<'_>> {
    environment
        .devices()
        .filter(|device| device.ep().is_ok_and(|ep| ep == WEBGPU_EP))
}

#[cfg(target_os = "linux")]
fn register_webgpu_plugin(environment: &Environment) -> bool {
    let path = std::env::var_os("ORT_DYLIB_PATH")
        .map(|runtime| Path::new(&runtime).with_file_name(WEBGPU_PLUGIN_LIBRARY))
        .unwrap_or_else(|| PathBuf::from(WEBGPU_PLUGIN_LIBRARY));
    let reason = if !path.exists() {
        format!("{} is missing", path.display())
    } else if let Err(e) = environment.register_ep_library(WEBGPU_EP, &path) {
        e.to_string()
    } else if webgpu_devices(environment).next().is_none() {
        "no WebGPU adapter was found".to_string()
    } else {
        log::info!("AI models use WebGPU through {}", path.display());
        return true;
    };
    log::warn!(
        "WebGPU acceleration for AI models is unavailable: {}",
        reason
    );
    false
}

#[cfg(target_os = "linux")]
fn webgpu_device() -> Option<ort::device::Device<'static>> {
    static REGISTERED: OnceCell<bool> = OnceCell::new();
    let environment = environment().ok()?;
    if !*REGISTERED.get_or_init(|| register_webgpu_plugin(environment)) {
        return None;
    }
    webgpu_devices(environment).next()
}

#[cfg(target_os = "linux")]
fn add_gpu_provider(builder: SessionBuilder) -> ort::Result<SessionBuilder> {
    let device = webgpu_device().ok_or_else(|| ort::Error::new("No WebGPU adapter"))?;
    let options = [(
        format!("{}.powerPreference", WEBGPU_EP),
        "high-performance".to_string(),
    )];
    Ok(builder.with_devices([device], Some(&options[..]))?)
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn add_gpu_provider(builder: SessionBuilder) -> ort::Result<SessionBuilder> {
    Ok(builder)
}

#[cfg(target_os = "linux")]
fn gpu_provider_available() -> bool {
    webgpu_device().is_some()
}

#[cfg(not(target_os = "linux"))]
fn gpu_provider_available() -> bool {
    cfg!(any(target_os = "windows", target_os = "macos"))
}

fn gpu_allowed_on_platform() -> bool {
    !cfg!(target_os = "macos")
}

fn birefnet_gpu_allowed() -> bool {
    gpu_allowed_on_platform() && !cfg!(target_os = "linux")
}

type ModelPatch = fn() -> ort::Result<Model>;

fn i64_initializer(values: &[i64]) -> ort::Result<Tensor<i64>> {
    let mut tensor = Tensor::<i64>::new(&Allocator::default(), [values.len()])?;
    tensor.extract_tensor_mut().1.copy_from_slice(values);
    Ok(tensor)
}

fn create_session(
    model_path: &Path,
    kind: SessionKind,
    use_gpu: bool,
    patch: Option<ModelPatch>,
    fixed_dims: &[(&str, i64)],
) -> ort::Result<Session> {
    let mut builder = session_builder()?;
    if use_gpu || kind == SessionKind::OneShot {
        builder = builder.with_memory_pattern(false)?;
    }
    if use_gpu && kind == SessionKind::OneShot {
        builder = builder.with_config_entry("ep.dml.disable_memory_arena", "1")?;
    }
    for &(name, size) in fixed_dims {
        builder = builder.with_dimension_override(name, size)?;
    }
    if use_gpu {
        builder = add_gpu_provider(builder)?;
    }
    let cpu = CPU::default()
        .with_arena_allocator(kind == SessionKind::Persistent)
        .build();
    let mut builder = builder.with_execution_providers([cpu])?;
    match patch {
        Some(patch) => {
            let model = patch()?;
            let mut session = builder.edit_from_file(model_path)?;
            session.apply_model(&model)?;
            session.into_session()
        }
        None => builder.commit_from_file(model_path),
    }
}

fn build_session(
    model_path: &Path,
    kind: SessionKind,
    use_gpu: bool,
    patch: Option<ModelPatch>,
) -> Result<Session> {
    build_session_with_dims(model_path, kind, use_gpu, patch, &[])
}

fn build_session_with_dims(
    model_path: &Path,
    kind: SessionKind,
    use_gpu: bool,
    patch: Option<ModelPatch>,
    fixed_dims: &[(&str, i64)],
) -> Result<Session> {
    if use_gpu && GPU_STATUS.load(Ordering::Acquire) < GPU_FAILED && gpu_provider_available() {
        match create_session(model_path, kind, true, patch, fixed_dims) {
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
    Ok(create_session(model_path, kind, false, patch, fixed_dims)?)
}

pub fn gpu_acceleration_enabled(app_handle: &tauri::AppHandle) -> bool {
    GPU_STATUS.load(Ordering::Acquire) < GPU_FAILED
        && crate::app::settings::load_settings(app_handle.clone())
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
            PARKED_SESSIONS.lock().unwrap().clear();
        }
        e.into()
    })
}

pub fn reset_ai_sessions(ai_state_mutex: &Mutex<Option<AiState>>) {
    if let Some(ai_state) = ai_state_mutex.lock().unwrap().as_mut() {
        ai_state.release_sessions();
    }
    PARKED_SESSIONS.lock().unwrap().clear();
    GPU_STATUS.store(GPU_IDLE, Ordering::Release);
}

pub struct ClipModels {
    pub model: Mutex<Session>,
    pub tokenizer: Tokenizer,
}

fn get_models_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf> {
    let models_dir = app_handle.path().app_data_dir()?.join("models");
    if !models_dir.exists() {
        fs::create_dir_all(&models_dir)?;
    }
    Ok(models_dir)
}

type Cancelled<'a> = &'a (dyn Fn() -> bool + Sync);

async fn download_model(
    app_handle: &tauri::AppHandle,
    asset: &ModelAsset,
    dest: &Path,
    cancelled: Cancelled<'_>,
) -> Result<()> {
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

    let written = async {
        let mut response = reqwest::get(asset.url).await?.error_for_status()?;
        let total = response.content_length().unwrap_or(0);
        let mut file = fs::File::create(&tmp_path)?;
        let mut written = 0u64;
        let mut last_progress = Instant::now();
        let report = |current: u64| {
            let _ = app_handle.emit(
                "ai-model-download-progress",
                serde_json::json!({ "name": asset.name, "current": current, "total": total }),
            );
        };
        while let Some(chunk) = response.chunk().await? {
            if cancelled() {
                anyhow::bail!("Download cancelled");
            }
            file.write_all(&chunk)?;
            written += chunk.len() as u64;
            if total > 0 && last_progress.elapsed() >= Duration::from_millis(200) {
                last_progress = Instant::now();
                report(written);
            }
        }
        if total > 0 {
            report(written);
        }
        file.sync_all()?;
        anyhow::Ok(written)
    }
    .await;
    let written = written.inspect_err(|_| {
        let _ = fs::remove_file(&tmp_path);
    })?;
    if written == 0 {
        let _ = fs::remove_file(&tmp_path);
        return Err(anyhow::anyhow!(
            "Downloaded asset for {} was empty",
            dest.display()
        ));
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
    download_and_verify_model_until(app_handle, models_dir, asset, &|| false).await
}

async fn download_and_verify_model_until(
    app_handle: &tauri::AppHandle,
    models_dir: &Path,
    asset: &ModelAsset,
    cancelled: Cancelled<'_>,
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
            download_model(app_handle, asset, &dest_path, cancelled).await?;
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
                "cancelled": download_result.is_err() && cancelled(),
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

const SPEECH_DIR: &str = "parakeet-tdt-0.6b-v3";

const SPEECH_ASSETS: [ModelAsset; 4] = [
    ModelAsset {
        filename: "parakeet-tdt-0.6b-v3/vocab.txt",
        url: "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/parakeet-tdt-0.6b-v3/vocab.txt?download=true",
        sha256: Some("d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d"),
        name: "Speech Recognition",
    },
    ModelAsset {
        filename: "parakeet-tdt-0.6b-v3/nemo128.onnx",
        url: "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/parakeet-tdt-0.6b-v3/nemo128.onnx?download=true",
        sha256: Some("a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f"),
        name: "Speech Recognition",
    },
    ModelAsset {
        filename: "parakeet-tdt-0.6b-v3/decoder_joint-model.int8.onnx",
        url: "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/parakeet-tdt-0.6b-v3/decoder_joint-model.int8.onnx?download=true",
        sha256: Some("eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70"),
        name: "Speech Recognition",
    },
    ModelAsset {
        filename: "parakeet-tdt-0.6b-v3/encoder-model.int8.onnx",
        url: "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/parakeet-tdt-0.6b-v3/encoder-model.int8.onnx?download=true",
        sha256: Some("6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09"),
        name: "Speech Recognition",
    },
];

static SPEECH_DOWNLOAD: TokioMutex<bool> = TokioMutex::const_new(false);

pub fn speech_model_downloaded(app_handle: &tauri::AppHandle) -> bool {
    get_models_dir(app_handle).is_ok_and(|models_dir| {
        SPEECH_ASSETS
            .iter()
            .all(|asset| models_dir.join(asset.filename).exists())
    })
}

pub async fn get_or_download_speech_model(
    app_handle: &tauri::AppHandle,
    cancelled: Cancelled<'_>,
) -> Result<PathBuf> {
    let models_dir = get_models_dir(app_handle)?;
    let mut verified = SPEECH_DOWNLOAD.lock().await;
    if !*verified {
        for asset in &SPEECH_ASSETS {
            download_and_verify_model_until(app_handle, &models_dir, asset, cancelled).await?;
        }
        *verified = true;
    }
    Ok(models_dir.join(SPEECH_DIR))
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

    let model_path = models_dir.join(DENOISE_FILENAME);
    let session = build_session(
        &model_path,
        SessionKind::Persistent,
        gpu_acceleration_enabled(app_handle),
        Some(denoise_crop_as_slice),
    )?;
    let denoise_model = Arc::new(Mutex::new(session));

    ai_state_mutex
        .lock()
        .unwrap()
        .get_or_insert_with(AiState::default)
        .denoise_model = Some(denoise_model.clone());

    Ok(denoise_model)
}

pub async fn get_or_init_denoise_model_rr(
    app_handle: &tauri::AppHandle,
    ai_state_mutex: &Mutex<Option<AiState>>,
    ai_init_lock: &TokioMutex<()>,
) -> Result<Arc<Mutex<Session>>> {
    if let Some(denoise_model_rr) =
        cached_ai_state(ai_state_mutex, |state| state.denoise_model_rr.clone())
    {
        return Ok(denoise_model_rr);
    }

    let _guard = ai_init_lock.lock().await;

    if let Some(denoise_model_rr) =
        cached_ai_state(ai_state_mutex, |state| state.denoise_model_rr.clone())
    {
        return Ok(denoise_model_rr);
    }

    let models_dir = get_models_dir(app_handle)?;
    download_and_verify_model(app_handle, &models_dir, &RAWREFINERY_ASSET).await?;

    let model_path = models_dir.join(RAWREFINERY_FILENAME);
    let session = build_session(
        &model_path,
        SessionKind::Persistent,
        gpu_acceleration_enabled(app_handle),
        None,
    )?;
    let denoise_model_rr = Arc::new(Mutex::new(session));

    ai_state_mutex
        .lock()
        .unwrap()
        .get_or_insert_with(AiState::default)
        .denoise_model_rr = Some(denoise_model_rr.clone());

    Ok(denoise_model_rr)
}

pub async fn get_or_init_upscale_model(
    app_handle: &tauri::AppHandle,
    ai_state_mutex: &Mutex<Option<AiState>>,
    ai_init_lock: &TokioMutex<()>,
) -> Result<Arc<Mutex<Session>>> {
    if let Some(upscale_model) =
        cached_ai_state(ai_state_mutex, |state| state.upscale_model.clone())
    {
        return Ok(upscale_model);
    }

    let _guard = ai_init_lock.lock().await;

    if let Some(upscale_model) =
        cached_ai_state(ai_state_mutex, |state| state.upscale_model.clone())
    {
        return Ok(upscale_model);
    }

    let models_dir = get_models_dir(app_handle)?;
    download_and_verify_model(app_handle, &models_dir, &UPSCALE_ASSET).await?;

    let tile = crate::ai::tiling::UPSCALE_TILE_SIZE as i64;
    let session = build_session_with_dims(
        &models_dir.join(UPSCALE_FILENAME),
        SessionKind::Persistent,
        gpu_acceleration_enabled(app_handle),
        None,
        &UPSCALE_SPATIAL_DIMS.map(|dim| (dim, tile)),
    )?;
    let upscale_model = Arc::new(Mutex::new(session));

    ai_state_mutex
        .lock()
        .unwrap()
        .get_or_insert_with(AiState::default)
        .upscale_model = Some(upscale_model.clone());

    Ok(upscale_model)
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

    let clip_model_path = models_dir.join(CLIP_MODEL_FILENAME);
    let model = Mutex::new(build_session(
        &clip_model_path,
        SessionKind::Persistent,
        gpu_allowed_on_platform() && gpu_acceleration_enabled(app_handle),
        None,
    )?);
    let tokenizer =
        Tokenizer::from_file(clip_tokenizer_path).map_err(|e| anyhow::anyhow!(e.to_string()))?;

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

    let model_path = models_dir.join(LAMA_FILENAME);
    let session = build_session(&model_path, SessionKind::OneShot, false, None)?;
    let lama_model = Arc::new(Mutex::new(session));

    ai_state_mutex
        .lock()
        .unwrap()
        .get_or_insert_with(AiState::default)
        .lama_model = Some(lama_model.clone());

    Ok(lama_model)
}

async fn normal_model_stream(
    app_handle: &tauri::AppHandle,
    ai_init_lock: &TokioMutex<()>,
) -> Result<Session> {
    let models_dir = get_models_dir(app_handle)?;
    {
        let _guard = ai_init_lock.lock().await;
        download_and_verify_model(app_handle, &models_dir, &NORMAL_ASSET).await?;
    }
    build_session(
        &models_dir.join(NORMAL_FILENAME),
        SessionKind::Persistent,
        gpu_allowed_on_platform() && gpu_acceleration_enabled(app_handle),
        None,
    )
}

pub async fn effect_map_session(
    app_handle: &tauri::AppHandle,
    ai_state_mutex: &Mutex<Option<AiState>>,
    ai_init_lock: &TokioMutex<()>,
    kind: EffectMapKind,
) -> Result<Session> {
    let parked = {
        let mut parked = PARKED_SESSIONS.lock().unwrap();
        parked
            .iter()
            .position(|(parked, ..)| *parked == kind)
            .map(|index| parked.swap_remove(index).1)
    };
    if let Some(session) = parked {
        return Ok(session);
    }
    match kind {
        EffectMapKind::Depth => {
            get_or_init_ai_models(app_handle, ai_state_mutex, ai_init_lock, AiMaskModel::Depth)
                .await?
                .depth_anything_stream()
        }
        EffectMapKind::Normal => normal_model_stream(app_handle, ai_init_lock).await,
    }
}

pub fn park_effect_map_session(kind: EffectMapKind, session: Session) {
    let mut parked = PARKED_SESSIONS.lock().unwrap();
    parked.push((kind, session, Instant::now()));
    if !REAPING_SESSIONS.swap(true, Ordering::Relaxed) {
        std::thread::spawn(reap_parked_sessions);
    }
}

fn reap_parked_sessions() {
    loop {
        std::thread::sleep(PARKED_SESSION_IDLE);
        let mut parked = PARKED_SESSIONS.lock().unwrap();
        parked.retain(|(.., since)| since.elapsed() < PARKED_SESSION_IDLE);
        if parked.is_empty() {
            REAPING_SESSIONS.store(false, Ordering::Relaxed);
            return;
        }
    }
}

const ESAM3_PROMPT_TOKENS: usize = 16;

const ESAM3_EMBED_DIM: usize = 256;

pub struct Esam3Prompt {
    pub features: Array<f32, IxDyn>,
    pub padding: Array<f32, IxDyn>,
}

#[derive(Default)]
pub struct AiState {
    pub models: Option<Arc<AiModels>>,
    pub denoise_model: Option<Arc<Mutex<Session>>>,
    pub denoise_model_rr: Option<Arc<Mutex<Session>>>,
    pub upscale_model: Option<Arc<Mutex<Session>>>,
    pub clip_models: Option<Arc<ClipModels>>,
    pub lama_model: Option<Arc<Mutex<Session>>>,
    pub embeddings: Option<ImageEmbeddings>,
    pub esam3_features: Option<Arc<Esam3Features>>,
    pub face_analysis: Option<Arc<FaceAnalysis>>,
    pub depth_map: Option<CachedDepthMap>,
}

impl AiState {
    pub fn release_sessions(&mut self) {
        self.models = None;
        self.denoise_model = None;
        self.denoise_model_rr = None;
        self.upscale_model = None;
        self.clip_models = None;
        self.lama_model = None;
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

pub const DENOISE_OUTPUT: &str = "denoised";

fn denoise_crop_as_slice() -> ort::Result<Model> {
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
        [DENOISE_OUTPUT],
        [],
    )?)?;
    graph.set_outputs([Outlet::new(DENOISE_OUTPUT, output_type)])?;

    let mut model = Model::new([Opset::new(ONNX_DOMAIN, 18)?])?;
    model.set_graph(graph)?;
    Ok(model)
}
