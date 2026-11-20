use crate::app::settings::AppSettings;
use crate::render::color_space::TransferCurve;

pub const MIDDLE_GREY: f32 = 0.18;
pub const REFERENCE_WHITE_NITS: f32 = 203.0;

const BASIC_BRIGHTNESS_GAMMA: f32 = 1.1;
const BASIC_CONTRAST_MIX: f32 = 0.75;
const SOFT_CLIP_START: f32 = 0.75;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Headroom(f32);

impl Default for Headroom {
    fn default() -> Self {
        Self::SDR
    }
}

impl Headroom {
    pub const SDR: Self = Self(1.0);
    pub const MIN_STOPS: f32 = 1.0;
    pub const MAX_STOPS: f32 = 4.0;
    pub const DEFAULT_STOPS: f32 = 2.0;

    pub fn from_stops(stops: f32) -> Self {
        Self(stops.clamp(Self::MIN_STOPS, Self::MAX_STOPS).exp2())
    }

    pub fn from_settings(settings: &AppSettings) -> Self {
        Self::from_stops(settings.hdr_headroom)
    }

    pub fn limited_to(self, ratio: f32) -> Self {
        Self(self.0.min(ratio).max(1.0))
    }

    pub fn ratio(self) -> f32 {
        self.0
    }

    pub fn is_hdr(self) -> bool {
        self.0 > 1.0
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Knee {
    pub scene: f32,
    pub display: f32,
}

pub fn scene_linear_knee(curve: impl Fn(f32) -> f32, from: f32, to: f32) -> Knee {
    const STEP: f32 = 1.01;
    let contrast =
        |scene: f32| (curve(scene * STEP) / curve(scene / STEP)).ln() / (STEP * STEP).ln();
    let (mut low, mut high) = (from, to);
    for _ in 0..40 {
        let middle = (low * high).sqrt();
        if contrast(middle) > 1.0 {
            low = middle;
        } else {
            high = middle;
        }
    }
    Knee {
        scene: low,
        display: curve(low),
    }
}

pub fn basic_raw_display(scene: f32) -> f32 {
    let srgb = TransferCurve::SRGB;
    let encoded = srgb
        .encode(scene.min(1.0))
        .powf(1.0 / BASIC_BRIGHTNESS_GAMMA);
    let contrast = encoded * encoded * (3.0 - 2.0 * encoded);
    srgb.decode(encoded + (contrast - encoded) * BASIC_CONTRAST_MIX)
}

pub fn shader_constants() -> String {
    let knee = scene_linear_knee(basic_raw_display, MIDDLE_GREY, 1.0);
    [
        ("BASIC_BRIGHTNESS_GAMMA", BASIC_BRIGHTNESS_GAMMA),
        ("BASIC_CONTRAST_MIX", BASIC_CONTRAST_MIX),
        ("BASIC_HDR_KNEE_SCENE", knee.scene),
        ("BASIC_HDR_KNEE_LINEAR", knee.display),
        ("HDR_SOFT_CLIP_START", SOFT_CLIP_START),
    ]
    .iter()
    .map(|(name, value)| format!("const {}: f32 = {:?};\n", name, value))
    .collect()
}
