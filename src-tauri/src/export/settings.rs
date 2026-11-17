use crate::app::settings::AppSettings;
use crate::render::color_space::OutputColorSpace;
use crate::render::gpu::processor::RenderOutputPrecision;
use crate::render::hdr::Headroom;
use crate::render::options::{RenderOptions, resolve_render_options};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(try_from = "u8", into = "u8")]
pub enum TiffBitDepth {
    Eight = 8,
    #[default]
    Sixteen = 16,
}

impl TryFrom<u8> for TiffBitDepth {
    type Error = String;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            8 => Ok(Self::Eight),
            16 => Ok(Self::Sixteen),
            _ => Err(format!(
                "Invalid TIFF bit depth '{}'; expected 8 or 16.",
                value
            )),
        }
    }
}

impl From<TiffBitDepth> for u8 {
    fn from(value: TiffBitDepth) -> Self {
        value as u8
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub enum ResizeMode {
    LongEdge,
    ShortEdge,
    Width,
    Height,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResizeOptions {
    pub mode: ResizeMode,
    pub value: u32,
    pub dont_enlarge: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::enum_variant_names)]
pub enum BorderBasis {
    #[default]
    LongEdge,
    ShortEdge,
    EachEdge,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BorderOptions {
    #[serde(default)]
    pub basis: BorderBasis,
    pub horizontal_percent: f32,
    pub vertical_percent: f32,
    pub color: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PadOptions {
    pub ratio_width: f32,
    pub ratio_height: f32,
    pub color: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettings {
    pub jpeg_quality: u8,
    #[serde(default)]
    pub tiff_bit_depth: TiffBitDepth,
    #[serde(default)]
    pub color_space: OutputColorSpace,
    #[serde(default)]
    pub hdr: bool,
    pub resize: Option<ResizeOptions>,
    #[serde(default)]
    pub border: Option<BorderOptions>,
    #[serde(default)]
    pub pad: Option<PadOptions>,
    pub keep_metadata: bool,
    #[serde(default)]
    pub preserve_timestamps: bool,
    pub strip_gps: bool,
    pub filename_template: Option<String>,
    pub watermark: Option<WatermarkSettings>,
    #[serde(default)]
    pub export_masks: bool,
    #[serde(default)]
    pub preserve_folders: bool,
    #[serde(default)]
    pub destination_type: Option<String>,
    #[serde(default)]
    pub subfolder: Option<String>,
    #[serde(default)]
    pub dpi: Option<u16>,
    #[serde(default)]
    pub export_original: Option<OriginalExportOptions>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HdrOutput {
    Pq,
    GainMap,
}

impl ExportSettings {
    pub fn hdr_output(&self, output_format: &str) -> Option<HdrOutput> {
        match output_format.to_lowercase().as_str() {
            "jxl" if self.hdr => Some(HdrOutput::Pq),
            "jpg" | "jpeg" if self.hdr => Some(HdrOutput::GainMap),
            _ => None,
        }
    }

    pub fn color_space_for(&self, output_format: &str) -> OutputColorSpace {
        if self.hdr_output(output_format) == Some(HdrOutput::Pq) {
            return OutputColorSpace::Rec2020;
        }
        match output_format.to_lowercase().as_str() {
            "jpg" | "jpeg" | "png" | "tif" | "tiff" | "webp" | "jxl" => self.color_space,
            _ => OutputColorSpace::Srgb,
        }
    }

    pub fn render_options(
        &self,
        output_format: &str,
        settings: &AppSettings,
        is_raw: bool,
    ) -> RenderOptions {
        RenderOptions {
            output_space: self.color_space_for(output_format),
            headroom: if self.hdr_output(output_format) == Some(HdrOutput::Pq) {
                Headroom::from_settings(settings)
            } else {
                Headroom::SDR
            },
            ..resolve_render_options(settings, is_raw)
        }
    }

    pub fn gain_map_render_options(
        &self,
        output_format: &str,
        settings: &AppSettings,
        is_raw: bool,
    ) -> Option<RenderOptions> {
        (self.hdr_output(output_format) == Some(HdrOutput::GainMap)).then(|| RenderOptions {
            headroom: Headroom::from_settings(settings),
            ..self.render_options(output_format, settings, is_raw)
        })
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct OriginalExportOptions {
    pub crop: bool,
    pub keep_exposure: bool,
}

#[derive(Clone)]
pub(crate) enum ExportAdjustmentsMode {
    UseSidecars {
        active_path: Option<String>,
        active_adjustments: Option<Value>,
    },
    GlobalOverride(Value),
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub enum WatermarkAnchor {
    TopLeft,
    TopCenter,
    TopRight,
    CenterLeft,
    Center,
    CenterRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WatermarkSettings {
    pub path: String,
    pub anchor: WatermarkAnchor,
    pub scale: f32,
    pub spacing: f32,
    pub opacity: f32,
}

pub fn render_output_precision(
    output_format: &str,
    export_settings: &ExportSettings,
) -> RenderOutputPrecision {
    if export_settings.hdr_output(output_format) == Some(HdrOutput::Pq) {
        RenderOutputPrecision::Float
    } else if matches!(output_format.to_lowercase().as_str(), "tif" | "tiff")
        && export_settings.tiff_bit_depth == TiffBitDepth::Sixteen
    {
        RenderOutputPrecision::SixteenBit
    } else {
        RenderOutputPrecision::EightBit
    }
}
