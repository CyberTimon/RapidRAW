use crate::app::settings::{AppSettings, load_settings};
use crate::decode::baseline_exposure::BaselineOptions;
use crate::render::color_space::OutputColorSpace;
use crate::render::hdr::Headroom;

pub fn resolve_tonemapper_override(settings: &AppSettings, is_raw: bool) -> Option<u32> {
    if !settings.tonemapper_override_enabled.unwrap_or(false) {
        return None;
    }
    let tm = if is_raw {
        settings.default_raw_tonemapper.as_deref().unwrap_or("agx")
    } else {
        settings
            .default_non_raw_tonemapper
            .as_deref()
            .unwrap_or("basic")
    };
    Some(if tm == "agx" { 1 } else { 0 })
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RenderOptions {
    pub tonemapper_override: Option<u32>,
    pub non_raw_tonemapper_override: Option<u32>,
    pub baseline: BaselineOptions,
    pub output_space: OutputColorSpace,
    pub headroom: Headroom,
}

pub fn resolve_render_options(settings: &AppSettings, is_raw: bool) -> RenderOptions {
    RenderOptions {
        tonemapper_override: resolve_tonemapper_override(settings, is_raw),
        non_raw_tonemapper_override: resolve_tonemapper_override(settings, false),
        baseline: BaselineOptions::from_settings(settings),
        output_space: OutputColorSpace::default(),
        headroom: Headroom::SDR,
    }
}

pub fn resolve_render_options_from_handle(
    app_handle: &tauri::AppHandle,
    is_raw: bool,
) -> RenderOptions {
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    resolve_render_options(&settings, is_raw)
}
