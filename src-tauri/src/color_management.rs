//! Bridge from rawler's decoded metadata to rawcolor's camera profiles.
//!
//! rawler carries every calibration matrix the file declares, keyed by
//! illuminant, but its develop path picks the D65 one and ignores the rest.
//! That means a tungsten-lit frame gets developed through the daylight matrix.
//! This module hands the full set to rawcolor so the matrix can be interpolated
//! for the actual scene illuminant instead.
//!
//! The profile is extracted at decode time and carried alongside the image so
//! the renderer can resolve white balance per adjustment without re-decoding.
//! The develop path itself still runs rawler's own calibration — switching it
//! to camera-native output has to land together with the shader change.
#![allow(dead_code)]

use rawcolor::{
    camera::{Calibration, CalibrationIlluminant, CameraProfile},
    cct::{TempTint, chromaticity_to_temp_tint},
    math::{Mat3, Vec3},
};
use rawcolor::{cat::Cat, rgb::RgbSpace, wb::WhiteBalance};
use rawler::{imgop::xyz::Illuminant, rawimage::RawImage};

/// Working space for the editing pipeline.
///
/// This has to match whatever the rest of the pipeline thinks its numbers
/// are in, which is sRGB primaries at D65 - see `PRIMARIES_SRGB` in
/// `image_processing.rs`, where AgX takes the pipe as sRGB and converts to
/// Rec.2020 for its own rendering transform. Handing the pipe Rec.2020
/// instead reads as desaturation, because every later stage misinterprets it.
///
/// Widening the pipe is worth doing - sRGB primaries clip saturated reds a
/// raw file can capture - but it is a pipeline-wide change, not this one.
pub const WORKING_SPACE: RgbSpace = RgbSpace::SRGB;

/// Adaptation used when moving between white points. Bradford is what ICC and
/// DNG both assume, so this keeps results comparable with other tools.
pub const ADAPTATION: Cat = Cat::Bradford;

/// White balance resolved for the renderer.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ResolvedWhiteBalance {
    /// Camera-space gains, green normalized to 1.
    pub coefficients: [f32; 3],
    /// Camera RGB to the working space, column-major.
    pub camera_to_working: [[f32; 3]; 3],
    /// Where the sliders ended up, for display.
    pub cct: f64,
    /// Tint as Duv.
    pub duv: f64,
    /// Highlight roll-off limit, carried through from the decode that produced
    /// these pixels so the shader rolls off exactly what develop assumed.
    pub highlight_compression: f32,
}

/// Everything needed to resolve white balance for one image.
///
/// Built once when the file is decoded and kept with the loaded image, since
/// re-deriving it means decoding the raw again.
#[derive(Debug, Clone, PartialEq)]
pub struct CameraColorInfo {
    /// The camera's calibration, for interpolating the color matrix.
    pub profile: CameraProfile,
    /// As-shot white balance gains from the file, normalized to green.
    pub as_shot_coefficients: Option<Vec3>,
    /// The as-shot balance expressed as temperature and tint. This is what the
    /// UI sliders should be seeded with, and what "As Shot" resets to.
    pub as_shot_temp_tint: Option<TempTint>,
    /// The highlight compression this image was developed under. Held here
    /// rather than read at render time so it cannot drift from the decode.
    pub highlight_compression: f32,
}

impl CameraColorInfo {
    /// Extract color information from a decoded raw image.
    ///
    /// Returns `None` when the file carries no usable calibration, in which
    /// case the caller keeps the existing develop path.
    /// Resolve white balance for a chosen temperature and tint.
    ///
    /// Falling back to the as-shot values when the target is unusable keeps a
    /// nonsense slider position from blanking the image.
    pub fn resolve(&self, cct: f64, duv: f64) -> Option<ResolvedWhiteBalance> {
        let requested = TempTint::new(
            cct.clamp(rawcolor::cct::MIN_CCT, rawcolor::cct::MAX_CCT),
            duv,
        );
        let wb = match WhiteBalance::from_temp_tint(
            &self.profile,
            requested,
            &WORKING_SPACE,
            ADAPTATION,
        ) {
            Ok(wb) => wb,
            Err(_) => {
                let fallback = self.as_shot_temp_tint?;
                WhiteBalance::from_temp_tint(&self.profile, fallback, &WORKING_SPACE, ADAPTATION)
                    .ok()?
            }
        };

        Some(ResolvedWhiteBalance {
            coefficients: wb.coefficients_f32(),
            camera_to_working: wb.matrix_f32(),
            highlight_compression: self.highlight_compression,
            cct: wb.temp_tint.cct,
            duv: wb.temp_tint.duv,
        })
    }

    /// Resolve at the camera's as-shot white balance.
    pub fn resolve_as_shot(&self) -> Option<ResolvedWhiteBalance> {
        let tt = self.as_shot_temp_tint?;
        self.resolve(tt.cct, tt.duv)
    }

    pub fn from_raw(raw: &RawImage, highlight_compression: f32) -> Option<Self> {
        let Some(profile) = profile_from_raw(raw) else {
            log::warn!(
                "Color management: no usable calibration for '{} {}' ({} matrices in file), keeping the default develop path",
                raw.clean_make,
                raw.clean_model,
                raw.color_matrix.len(),
            );
            return None;
        };
        let as_shot_coefficients = as_shot_coefficients(raw);

        // Gains are the reciprocal of the neutral the camera recorded, so
        // invert before asking the profile what illuminant produced it.
        let as_shot_temp_tint = as_shot_coefficients
            .and_then(|c| c.recip_safe(1e-12).normalized_to(1, 1e-12))
            .and_then(|neutral| profile.neutral_to_xy(neutral).ok())
            .and_then(chromaticity_to_temp_tint);

        match as_shot_temp_tint {
            Some(tt) => log::info!(
                "Color management: '{} {}' calibrated for {:?}{}, as shot {:.0}K duv {:+.4}",
                raw.clean_make,
                raw.clean_model,
                profile.primary.illuminant,
                profile
                    .secondary
                    .map(|c| format!(" and {:?}", c.illuminant))
                    .unwrap_or_default(),
                tt.cct,
                tt.duv,
            ),
            None => log::warn!(
                "Color management: '{} {}' has a profile but no usable as-shot white balance",
                raw.clean_make,
                raw.clean_model,
            ),
        }

        Some(CameraColorInfo {
            profile,
            as_shot_coefficients,
            as_shot_temp_tint,
            highlight_compression,
        })
    }
}

/// Map a rawler illuminant onto rawcolor's.
///
/// Both enums use the EXIF LightSource codes as discriminants, so this is a
/// numeric hand-off rather than a translation table. `Unknown` has no defined
/// chromaticity and is dropped.
fn convert_illuminant(illuminant: Illuminant) -> Option<CalibrationIlluminant> {
    if illuminant == Illuminant::Unknown {
        return None;
    }
    CalibrationIlluminant::from_exif_code(illuminant as u16)
}

/// Reshape rawler's flat row-major matrix into a 3x3.
///
/// Returns `None` for four-color sensors (RGBE, CMYG), whose matrices are 4x3.
/// Those keep the existing develop path — handling them needs a 4xN transform
/// that rawcolor does not model.
fn to_mat3(flat: &[f32]) -> Option<Mat3> {
    if flat.len() != 9 {
        return None;
    }
    let mut rows = [[0.0f64; 3]; 3];
    for r in 0..3 {
        for c in 0..3 {
            rows[r][c] = flat[r * 3 + c] as f64;
        }
    }
    let m = Mat3::new(rows);
    // A matrix that cannot be inverted is unusable downstream, so reject it
    // here rather than letting it fail later inside the solver.
    m.inverse().map(|_| m)
}

/// Build a camera profile from a decoded raw image.
///
/// Returns `None` when the file carries no usable 3x3 calibration, in which
/// case callers should fall back to rawler's own develop path.
pub fn profile_from_raw(raw: &RawImage) -> Option<CameraProfile> {
    let mut calibrations: Vec<(f64, Calibration)> = raw
        .color_matrix
        .iter()
        .filter_map(|(illuminant, flat)| {
            let illuminant = convert_illuminant(*illuminant)?;
            let matrix = to_mat3(flat)?;
            Some((illuminant.cct(), Calibration::new(illuminant, matrix)))
        })
        .collect();

    if calibrations.is_empty() {
        return None;
    }

    // Sort by temperature so the selection below is deterministic. The source
    // is a HashMap, whose iteration order is not.
    calibrations.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    if calibrations.len() == 1 {
        return Some(CameraProfile::single(calibrations.remove(0).1));
    }

    // Use the widest available pair. Interpolating between the extremes covers
    // the whole range; intermediate calibrations would need a piecewise blend
    // that DNG itself does not define.
    let cool = calibrations.pop()?.1;
    let warm = calibrations.remove(0).1;
    Some(CameraProfile::dual(warm, cool))
}

/// The camera's as-shot white balance coefficients, normalized to green.
///
/// rawler reports `wb_coeffs` in RGBE order and signals "absent" with NaN in
/// the first slot.
pub fn as_shot_coefficients(raw: &RawImage) -> Option<Vec3> {
    let coeffs = raw.wb_coeffs;
    if coeffs[..3].iter().any(|c| !c.is_finite() || *c <= 0.0) {
        return None;
    }
    Vec3::new(coeffs[0] as f64, coeffs[1] as f64, coeffs[2] as f64).normalized_to(1, 1e-12)
}

/// Full-scale travel of the temperature slider, in mired.
///
/// Matches the constant the Lightroom preset importer already uses, so a
/// slider position keeps meaning the same shift it did before.
const MAX_MIRED_SHIFT: f64 = 150.0;

/// Full-scale travel of the tint slider, in Duv.
///
/// Approximate: the slider was never calibrated against a colorimetric unit,
/// so this is chosen to cover the useful range rather than derived.
const MAX_DUV_SHIFT: f64 = 0.03;

/// Turn the UI's relative temperature and tint into an absolute white point.
///
/// The sliders are offsets from the as-shot value rather than absolutes, which
/// is what existing presets and sidecars encode. Reading them that way keeps
/// saved edits meaning what they meant before.
pub fn target_temp_tint(info: &CameraColorInfo, js_adjustments: &serde_json::Value) -> (f64, f64) {
    let as_shot = info
        .as_shot_temp_tint
        .unwrap_or_else(|| TempTint::new(5500.0, 0.0));

    let temperature = js_adjustments
        .get("temperature")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0)
        .clamp(-100.0, 100.0);
    let tint = js_adjustments
        .get("tint")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0)
        .clamp(-100.0, 100.0);

    // Warming the image means telling the renderer the light was bluer than
    // assumed, so a positive slider raises the target temperature.
    let as_shot_mired = 1.0e6 / as_shot.cct;
    let target_mired = (as_shot_mired - (temperature / 100.0) * MAX_MIRED_SHIFT)
        .max(1.0e6 / rawcolor::cct::MAX_CCT);

    // Same inversion as temperature. A magenta image comes from telling the
    // renderer the light was greener than assumed, so a positive slider raises
    // Duv even though positive Duv is itself the green direction.
    let duv = as_shot.duv + (tint / 100.0) * MAX_DUV_SHIFT;

    (1.0e6 / target_mired, duv)
}

/// Point a render at the color-managed white balance path.
///
/// Does nothing without a profile, which is also the signal that the pixels
/// are camera-native, so the two stay in step.
pub fn apply_to_render(
    adjustments: &mut crate::image_processing::AllAdjustments,
    color_info: Option<&CameraColorInfo>,
    js_adjustments: &serde_json::Value,
) {
    let Some(info) = color_info else {
        return;
    };
    let (cct, duv) = target_temp_tint(info, js_adjustments);
    if let Some(resolved) = info.resolve(cct, duv) {
        adjustments.set_camera_color(&resolved);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rawcolor::{cat::Cat, cct::TempTint, rgb::RgbSpace, wb::WhiteBalance};
    use std::collections::HashMap;

    fn tungsten_flat() -> Vec<f32> {
        vec![
            0.7137, -0.1793, -0.0442, -0.4894, 1.2521, 0.2647, -0.0774, 0.1258, 0.7773,
        ]
    }

    fn daylight_flat() -> Vec<f32> {
        vec![
            0.7866, -0.2108, -0.0555, -0.4869, 1.2483, 0.2681, -0.0856, 0.1287, 0.7473,
        ]
    }

    fn profile_from_map(entries: Vec<(Illuminant, Vec<f32>)>) -> Option<CameraProfile> {
        // profile_from_raw only reads color_matrix, so exercising the same
        // logic over a bare map avoids constructing a whole RawImage.
        let map: HashMap<Illuminant, Vec<f32>> = entries.into_iter().collect();
        let mut calibrations: Vec<(f64, Calibration)> = map
            .iter()
            .filter_map(|(illuminant, flat)| {
                let illuminant = convert_illuminant(*illuminant)?;
                let matrix = to_mat3(flat)?;
                Some((illuminant.cct(), Calibration::new(illuminant, matrix)))
            })
            .collect();
        if calibrations.is_empty() {
            return None;
        }
        calibrations.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        if calibrations.len() == 1 {
            return Some(CameraProfile::single(calibrations.remove(0).1));
        }
        let cool = calibrations.pop()?.1;
        let warm = calibrations.remove(0).1;
        Some(CameraProfile::dual(warm, cool))
    }

    #[test]
    fn illuminant_codes_hand_off_numerically() {
        assert_eq!(
            convert_illuminant(Illuminant::A),
            Some(CalibrationIlluminant::StandardA)
        );
        assert_eq!(
            convert_illuminant(Illuminant::D65),
            Some(CalibrationIlluminant::D65)
        );
        assert_eq!(
            convert_illuminant(Illuminant::Tungsten),
            Some(CalibrationIlluminant::Tungsten)
        );
        assert_eq!(convert_illuminant(Illuminant::Unknown), None);
    }

    #[test]
    fn four_color_matrices_are_declined() {
        assert!(to_mat3(&vec![0.5; 12]).is_none());
        assert!(to_mat3(&vec![0.5; 3]).is_none());
    }

    #[test]
    fn singular_matrices_are_declined() {
        // Third row is the sum of the first two.
        let flat = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 5.0, 7.0, 9.0];
        assert!(to_mat3(&flat).is_none());
    }

    #[test]
    fn dual_illuminant_file_yields_an_interpolating_profile() {
        let profile = profile_from_map(vec![
            (Illuminant::A, tungsten_flat()),
            (Illuminant::D65, daylight_flat()),
        ])
        .expect("two valid matrices must produce a profile");

        assert_eq!(profile.primary.illuminant, CalibrationIlluminant::StandardA);
        assert!(profile.secondary.is_some());

        // The whole point: the matrix must actually change with temperature.
        let warm = profile.xyz_to_camera_at_cct(3000.0);
        let cool = profile.xyz_to_camera_at_cct(6500.0);
        assert!(
            (warm.rows[0][0] - cool.rows[0][0]).abs() > 1e-4,
            "matrix did not vary with illuminant"
        );
    }

    #[test]
    fn single_illuminant_file_still_works() {
        let profile = profile_from_map(vec![(Illuminant::D65, daylight_flat())])
            .expect("one matrix is enough");
        assert!(profile.secondary.is_none());
        assert_eq!(
            profile.xyz_to_camera_at_cct(3000.0),
            profile.xyz_to_camera_at_cct(6500.0)
        );
    }

    #[test]
    fn unusable_matrices_leave_no_profile() {
        assert!(profile_from_map(vec![(Illuminant::Unknown, daylight_flat())]).is_none());
        assert!(profile_from_map(vec![(Illuminant::D65, vec![0.5; 12])]).is_none());
        assert!(profile_from_map(vec![]).is_none());
    }

    #[test]
    fn selection_is_stable_regardless_of_map_order() {
        // The source is a HashMap, so this guards the ordering fix.
        let a = profile_from_map(vec![
            (Illuminant::A, tungsten_flat()),
            (Illuminant::D65, daylight_flat()),
            (Illuminant::D50, daylight_flat()),
        ]);
        let b = profile_from_map(vec![
            (Illuminant::D50, daylight_flat()),
            (Illuminant::D65, daylight_flat()),
            (Illuminant::A, tungsten_flat()),
        ]);
        assert_eq!(a, b);
        let profile = a.unwrap();
        assert_eq!(profile.primary.illuminant, CalibrationIlluminant::StandardA);
        assert_eq!(
            profile.secondary.unwrap().illuminant,
            CalibrationIlluminant::D65
        );
    }

    #[test]
    fn resolve_produces_gains_that_neutralize_the_scene() {
        let info = CameraColorInfo {
            profile: profile_from_map(vec![
                (Illuminant::A, tungsten_flat()),
                (Illuminant::D65, daylight_flat()),
            ])
            .unwrap(),
            as_shot_coefficients: None,
            as_shot_temp_tint: None,
            highlight_compression: 2.5,
        };

        for cct in [2800.0, 4000.0, 5500.0, 6504.0, 9000.0] {
            let resolved = info.resolve(cct, 0.0).expect("resolve must succeed");
            assert!((resolved.cct - cct).abs() < 5.0, "got {}K", resolved.cct);
            // Green stays at unity so the transform never darkens the image.
            assert!((resolved.coefficients[1] - 1.0).abs() < 1e-6);
            assert!(
                resolved
                    .coefficients
                    .iter()
                    .all(|c| c.is_finite() && *c > 0.0)
            );
        }
    }

    #[test]
    fn resolve_clamps_absurd_temperatures_instead_of_failing() {
        let info = CameraColorInfo {
            profile: profile_from_map(vec![(Illuminant::D65, daylight_flat())]).unwrap(),
            as_shot_coefficients: None,
            as_shot_temp_tint: None,
            highlight_compression: 2.5,
        };
        let cold = info.resolve(-1000.0, 0.0).expect("clamped, not rejected");
        let hot = info.resolve(1.0e9, 0.0).expect("clamped, not rejected");
        assert!(cold.cct >= rawcolor::cct::MIN_CCT - 1.0);
        assert!(hot.cct <= rawcolor::cct::MAX_CCT + 1.0);
    }

    #[test]
    fn warmer_target_lifts_blue_relative_to_red() {
        let info = CameraColorInfo {
            profile: profile_from_map(vec![
                (Illuminant::A, tungsten_flat()),
                (Illuminant::D65, daylight_flat()),
            ])
            .unwrap(),
            as_shot_coefficients: None,
            as_shot_temp_tint: None,
            highlight_compression: 2.5,
        };
        let tungsten = info.resolve(2856.0, 0.0).unwrap();
        let daylight = info.resolve(6504.0, 0.0).unwrap();
        assert!(tungsten.coefficients[2] > daylight.coefficients[2]);
        assert!(tungsten.coefficients[0] < daylight.coefficients[0]);
    }

    fn info_at(cct: f64) -> CameraColorInfo {
        CameraColorInfo {
            profile: profile_from_map(vec![
                (Illuminant::A, tungsten_flat()),
                (Illuminant::D65, daylight_flat()),
            ])
            .unwrap(),
            as_shot_coefficients: None,
            as_shot_temp_tint: Some(TempTint::new(cct, 0.0)),
            highlight_compression: 2.5,
        }
    }

    #[test]
    fn neutral_sliders_reproduce_the_as_shot_white_point() {
        let info = info_at(5200.0);
        let (cct, duv) = target_temp_tint(&info, &serde_json::json!({}));
        assert!((cct - 5200.0).abs() < 1e-6, "got {cct}");
        assert!(duv.abs() < 1e-12);
    }

    #[test]
    fn positive_temperature_warms_the_image() {
        // Warmer output means a higher assumed scene temperature.
        let info = info_at(5000.0);
        let (warm, _) = target_temp_tint(&info, &serde_json::json!({"temperature": 100.0}));
        let (cool, _) = target_temp_tint(&info, &serde_json::json!({"temperature": -100.0}));
        assert!(warm > 5000.0, "warm slider gave {warm}");
        assert!(cool < 5000.0, "cool slider gave {cool}");

        // Full scale is the same 150 mired the preset importer assumes.
        let expected = 1.0e6 / (1.0e6 / 5000.0 - 150.0);
        assert!((warm - expected).abs() < 1e-6, "{warm} vs {expected}");
    }

    /// How magenta a camera-neutral pixel renders under a given slider setting.
    ///
    /// Asserting on the Duv that comes out of `target_temp_tint` is what let
    /// the sign error through the first time: that is the illuminant's tint,
    /// and the render divides by it, so it reads backwards from the image.
    /// This goes all the way to a pixel instead.
    fn rendered_magenta(info: &CameraColorInfo, tint: f64) -> f64 {
        let (cct, duv) = target_temp_tint(info, &serde_json::json!({ "tint": tint }));
        let resolved = info.resolve(cct, duv).expect("must resolve");
        let [gr, gg, gb] = resolved.coefficients;
        let m = resolved.camera_to_working;

        // A neutral sensor reading, balanced and taken into the working space.
        let balanced = [gr, gg, gb];
        let out: Vec<f64> = (0..3)
            .map(|row| {
                (0..3)
                    .map(|col| m[col][row] as f64 * balanced[col] as f64)
                    .sum()
            })
            .collect();

        (out[0] + out[2]) / 2.0 - out[1]
    }

    #[test]
    fn resolve_carries_the_highlight_limit_to_the_renderer() {
        // The shader reads this out of wb_coefficients.w and rolls highlights
        // off with it, because develop no longer can - its own branch only
        // fires above 1.0, and camera-native data never gets there. A zero
        // here would silently disable the roll-off all over again.
        let mut info = info_at(5000.0);
        info.highlight_compression = 3.25;
        let resolved = info.resolve(5000.0, 0.0).expect("must resolve");
        assert!((resolved.highlight_compression - 3.25).abs() < 1e-6);

        let mut adj = crate::image_processing::AllAdjustments::default();
        adj.set_camera_color(&resolved);
        assert!((adj.global.wb_coefficients[3] - 3.25).abs() < 1e-6);

        // And the path reads as live, which is the same field.
        assert!(adj.global.wb_coefficients[3] > 0.0);
    }

    #[test]
    fn working_space_matches_the_rest_of_the_pipeline() {
        // image_processing.rs feeds AgX PRIMARIES_SRGB at WP_D65 as the pipe
        // profile. camera_to_working writes into that same pipe, so the two
        // have to name the same space. If someone widens the pipeline, this
        // fails and points at the constant that also needs changing.
        let expect = [
            (WORKING_SPACE.red, [0.64, 0.33]),
            (WORKING_SPACE.green, [0.30, 0.60]),
            (WORKING_SPACE.blue, [0.15, 0.06]),
            (WORKING_SPACE.white, [0.3127, 0.3290]),
        ];
        for (got, [x, y]) in expect {
            assert!(
                (got.x - x).abs() < 1e-4 && (got.y - y).abs() < 1e-4,
                "working space drifted from the pipeline: got ({}, {}), pipeline has ({x}, {y})",
                got.x,
                got.y
            );
        }
    }

    #[test]
    fn positive_tint_renders_more_magenta() {
        let info = info_at(5000.0);
        let magenta = rendered_magenta(&info, 100.0);
        let neutral = rendered_magenta(&info, 0.0);
        let green = rendered_magenta(&info, -100.0);

        assert!(
            magenta > neutral,
            "positive tint must render magenta: {magenta} vs {neutral}"
        );
        assert!(
            green < neutral,
            "negative tint must render green: {green} vs {neutral}"
        );
    }

    #[test]
    fn tint_slider_matches_the_legacy_shader_direction() {
        // apply_white_balance in shader.wgsl scales (r, g, b) by
        // (1 + t*0.25, 1 - t*0.25, 1 + t*0.25), so a positive slider lifts red
        // and blue over green. The color-managed path has to agree, or saved
        // edits flip sign the moment the setting is switched on.
        let info = info_at(5000.0);
        assert!(rendered_magenta(&info, 50.0) > rendered_magenta(&info, -50.0));
    }

    #[test]
    fn sliders_stay_inside_the_supported_range() {
        let info = info_at(2000.0);
        let (cct, _) = target_temp_tint(&info, &serde_json::json!({"temperature": -100.0}));
        assert!(cct >= rawcolor::cct::MIN_CCT * 0.5, "got {cct}");
        assert!(
            info.resolve(cct, 0.0).is_some(),
            "must still resolve at {cct}"
        );
    }

    #[test]
    fn out_of_range_slider_values_are_clamped() {
        let info = info_at(5000.0);
        let (huge, _) = target_temp_tint(&info, &serde_json::json!({"temperature": 100000.0}));
        let (at_max, _) = target_temp_tint(&info, &serde_json::json!({"temperature": 100.0}));
        assert!((huge - at_max).abs() < 1e-9);
    }

    #[test]
    fn round_trips_into_a_usable_white_balance() {
        // End to end: a file's matrices resolve to gains and a matrix that
        // render the as-shot neutral neutral.
        let profile = profile_from_map(vec![
            (Illuminant::A, tungsten_flat()),
            (Illuminant::D65, daylight_flat()),
        ])
        .unwrap();

        let wb = WhiteBalance::from_temp_tint(
            &profile,
            TempTint::new(3200.0, 0.0),
            &RgbSpace::REC2020,
            Cat::Bradford,
        )
        .unwrap();

        let scene = rawcolor::cct::temp_tint_to_chromaticity(TempTint::new(3200.0, 0.0)).unwrap();
        let camera_pixel = profile.xy_to_neutral(scene).unwrap();
        let balanced = Vec3::new(
            camera_pixel.x() * wb.coefficients.x(),
            camera_pixel.y() * wb.coefficients.y(),
            camera_pixel.z() * wb.coefficients.z(),
        );
        let working = wb.camera_to_working * balanced;
        let max = working.max_component();
        assert!((working.x() / max - working.y() / max).abs() < 1e-6);
        assert!((working.y() / max - working.z() / max).abs() < 1e-6);
    }
}
