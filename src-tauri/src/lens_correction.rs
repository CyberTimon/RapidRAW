use crate::file_management::{parse_virtual_path, read_file_mapped};
use fuzzy_matcher::FuzzyMatcher;
#[cfg(target_os = "android")]
use include_dir::{Dir, include_dir};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
#[cfg(not(target_os = "android"))]
use std::fs;
use std::sync::{Arc, Mutex, OnceLock};
#[cfg(not(target_os = "android"))]
use tauri::Manager;
#[cfg(not(target_os = "android"))]
use walkdir::WalkDir;
#[cfg(target_os = "android")]
static LENS_DB_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/lensfun_db");

const MAX_CACHED_PROFILES: usize = 1024;
const DEFAULT_ASPECT_RATIO: f64 = 1.5;
const DEFAULT_DISTANCE: f32 = 1000.0;
const TCA_FOCAL_SCALED: [bool; 6] = [false, false, true, true, true, true];

static DATABASE: OnceLock<LensDatabase> = OnceLock::new();

#[derive(Debug, Deserialize, Clone, PartialEq)]
pub struct Distortion {
    #[serde(rename = "@model")]
    pub model: String,
    #[serde(rename = "@focal")]
    pub focal: f32,
    #[serde(rename = "@k1")]
    pub k1: Option<f32>,
    #[serde(rename = "@k2")]
    pub k2: Option<f32>,
    #[serde(rename = "@a")]
    pub a: Option<f32>,
    #[serde(rename = "@b")]
    pub b: Option<f32>,
    #[serde(rename = "@c")]
    pub c: Option<f32>,
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
pub struct Tca {
    #[serde(rename = "@model")]
    pub model: String,
    #[serde(rename = "@focal")]
    pub focal: f32,
    #[serde(rename = "@kr")]
    pub kr: Option<f32>,
    #[serde(rename = "@kb")]
    pub kb: Option<f32>,
    #[serde(rename = "@vr")]
    pub vr: Option<f32>,
    #[serde(rename = "@vb")]
    pub vb: Option<f32>,
    #[serde(rename = "@cr")]
    pub cr: Option<f32>,
    #[serde(rename = "@cb")]
    pub cb: Option<f32>,
    #[serde(rename = "@br")]
    pub br: Option<f32>,
    #[serde(rename = "@bb")]
    pub bb: Option<f32>,
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
pub struct Vignetting {
    #[serde(rename = "@model")]
    pub model: String,
    #[serde(rename = "@focal")]
    pub focal: f32,
    #[serde(rename = "@aperture")]
    pub aperture: f32,
    #[serde(rename = "@distance")]
    pub distance: Option<f32>,
    #[serde(rename = "@k1")]
    pub k1: Option<f32>,
    #[serde(rename = "@k2")]
    pub k2: Option<f32>,
    #[serde(rename = "@k3")]
    pub k3: Option<f32>,
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum CalibrationElement {
    Distortion(Distortion),
    Tca(Tca),
    Vignetting(Vignetting),
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
pub struct Calibration {
    #[serde(rename = "$value", default)]
    pub elements: Vec<CalibrationElement>,
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
pub struct Focal {
    #[serde(rename = "@value")]
    pub value: Option<f32>,
    #[serde(rename = "@min")]
    pub min: Option<f32>,
    #[serde(rename = "@max")]
    pub max: Option<f32>,
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub struct Lens {
    #[serde(default)]
    pub maker: Vec<MultiName>,
    #[serde(default)]
    pub model: Vec<MultiName>,
    #[serde(default)]
    pub mount: Vec<String>,
    pub cropfactor: Option<f32>,
    pub calibration: Option<Calibration>,
    pub focal: Option<Focal>,
    pub aspect_ratio: Option<String>,
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub struct Camera {
    pub maker: Vec<MultiName>,
    pub model: Vec<MultiName>,
    pub mount: String,
    pub cropfactor: f32,
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
pub struct LensDatabase {
    #[serde(rename = "camera", default)]
    pub cameras: Vec<Camera>,
    #[serde(rename = "lens", default)]
    pub lenses: Vec<Lens>,
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
pub struct MultiName {
    #[serde(rename = "@lang")]
    lang: Option<String>,
    #[serde(rename = "$value")]
    value: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct LensProfile {
    pub distortion: Option<[f64; 5]>,
    pub tca: Option<[f64; 6]>,
    pub vignetting: Option<[f64; 3]>,
    pub distortion_scale: f64,
    pub vignetting_scale: f64,
}

#[derive(Serialize, Clone)]
pub struct LensCorrectionInfo {
    maker: String,
    model: String,
    distortion: bool,
    tca: bool,
    vignetting: bool,
}

struct ResolvedLens {
    info: LensCorrectionInfo,
    profile: LensProfile,
}

type ProfileKey = (String, Option<(String, String)>);

#[derive(Default)]
struct Shot {
    make: String,
    model: String,
    lens_model: String,
    focal: Option<f32>,
    aperture: Option<f32>,
    distance: Option<f32>,
}

fn strip_maker_prefix(name: &str, maker: &str) -> String {
    if name.to_lowercase().starts_with(&maker.to_lowercase())
        && let Some(rest) = name.get(maker.len()..)
    {
        let trimmed = rest.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    name.to_string()
}

fn pick_name(names: &[MultiName], fallback: &str) -> String {
    names
        .iter()
        .find(|n| n.lang.as_deref() == Some("en"))
        .or_else(|| names.first())
        .map(|n| n.value.clone())
        .unwrap_or_else(|| fallback.to_string())
}

fn any_name_matches(names: &[MultiName], needle: &str) -> bool {
    names
        .iter()
        .any(|n| n.value.trim().eq_ignore_ascii_case(needle))
}

fn clean_exif_text(value: &str) -> &str {
    value.trim().trim_matches('"')
}

fn parse_aspect_ratio(value: &str) -> Option<f64> {
    match value.split_once(':') {
        Some((w, h)) => Some(w.trim().parse::<f64>().ok()? / h.trim().parse::<f64>().ok()?),
        None => value.trim().parse().ok(),
    }
}

fn exif_number(exif: &HashMap<String, String>, key: &str) -> Option<f32> {
    let text = exif.get(key)?.trim();
    let text = text.strip_prefix("f/").unwrap_or(text);
    let end = text
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(text.len());
    text[..end]
        .parse::<f32>()
        .ok()
        .filter(|v| v.is_finite() && *v > 0.0)
}

fn hermite(p0: f64, m0: f64, p1: f64, m1: f64, t: f64) -> f64 {
    let t2 = t * t;
    let t3 = t2 * t;
    (2.0 * t3 - 3.0 * t2 + 1.0) * p0
        + (t3 - 2.0 * t2 + t) * m0
        + (-2.0 * t3 + 3.0 * t2) * p1
        + (t3 - t2) * m1
}

fn interpolate_by_focal<const N: usize>(
    mut samples: Vec<(f32, [f64; N])>,
    focal: f32,
    focal_scaled: [bool; N],
) -> Option<[f64; N]> {
    samples.sort_by(|a, b| a.0.total_cmp(&b.0));
    if let Some(exact) = samples.iter().find(|s| (s.0 - focal).abs() < 1e-4) {
        return Some(exact.1);
    }
    let upper = samples.partition_point(|s| s.0 < focal);
    if upper == 0 || upper == samples.len() {
        return samples
            .get(upper.min(samples.len().saturating_sub(1)))
            .map(|s| s.1);
    }

    let (lo, hi) = (&samples[upper - 1], &samples[upper]);
    let before = upper.checked_sub(2).map(|i| &samples[i]);
    let after = samples.get(upper + 1);
    let t = ((focal - lo.0) / (hi.0 - lo.0)) as f64;

    Some(std::array::from_fn(|i| {
        let value = |s: &(f32, [f64; N])| {
            if focal_scaled[i] {
                s.1[i] * s.0 as f64
            } else {
                s.1[i]
            }
        };
        let (y_lo, y_hi) = (value(lo), value(hi));
        let tangent_lo = before.map_or(y_hi - y_lo, |s| (y_hi - value(s)) * 0.5);
        let tangent_hi = after.map_or(y_hi - y_lo, |s| (value(s) - y_lo) * 0.5);
        let y = hermite(y_lo, tangent_lo, y_hi, tangent_hi, t);
        if focal_scaled[i] { y / focal as f64 } else { y }
    }))
}

fn distortion_terms(d: &Distortion) -> Option<[f64; 3]> {
    let v = |x: Option<f32>| x.unwrap_or(0.0) as f64;
    match d.model.as_str() {
        "poly3" => Some([v(d.k1), 0.0, 0.0]),
        "poly5" => Some([v(d.k1), v(d.k2), 0.0]),
        "ptlens" => Some([v(d.a), v(d.b), v(d.c)]),
        _ => None,
    }
}

fn distortion_polynomial(model: &str, [t0, t1, t2]: [f64; 3]) -> [f64; 5] {
    match model {
        "poly3" => [1.0 - t0, 0.0, t0, 0.0, 0.0],
        "poly5" => [1.0, 0.0, t0, 0.0, t1],
        _ => [1.0 - t0 - t1 - t2, t2, t1, t0, 0.0],
    }
}

fn tca_terms(t: &Tca) -> Option<[f64; 6]> {
    let v = |x: Option<f32>, default: f32| x.unwrap_or(default) as f64;
    match t.model.as_str() {
        "linear" => Some([v(t.kr, 1.0), v(t.kb, 1.0), 0.0, 0.0, 0.0, 0.0]),
        "poly3" => Some([
            v(t.vr, 1.0),
            v(t.vb, 1.0),
            v(t.cr, 0.0),
            v(t.cb, 0.0),
            v(t.br, 0.0),
            v(t.bb, 0.0),
        ]),
        _ => None,
    }
}

fn vignetting_terms(v: &Vignetting) -> [f64; 3] {
    [v.k1, v.k2, v.k3].map(|k| k.unwrap_or(0.0) as f64)
}

fn crop_score(lens_crop: f32, camera_crop: Option<f32>) -> Option<i64> {
    let Some(camera_crop) = camera_crop else {
        return Some(0);
    };
    let ratio = camera_crop / lens_crop;
    match ratio {
        r if r < 0.96 => None,
        r if r >= 1.41 => Some(2),
        r if r >= 1.31 => Some(4),
        r if r >= 1.21 => Some(6),
        r if r >= 1.11 => Some(8),
        r if r >= 1.01 => Some(10),
        r if r >= 1.0 => Some(5),
        _ => Some(3),
    }
}

impl Shot {
    fn from_exif(exif: &HashMap<String, String>) -> Self {
        let text = |key: &str| exif.get(key).map_or("", |v| clean_exif_text(v)).to_string();
        Self {
            make: text("Make"),
            model: text("Model"),
            lens_model: text("LensModel"),
            focal: exif_number(exif, "FocalLength"),
            aperture: exif_number(exif, "FNumber")
                .or_else(|| exif_number(exif, "ApertureValue").map(|av| 2f32.powf(av / 2.0))),
            distance: exif_number(exif, "SubjectDistance"),
        }
    }

    fn read(source_path: &str) -> Self {
        let path = std::path::Path::new(source_path);
        crate::exif_processing::read_rrexif_sidecar(path)
            .or_else(|| {
                let bytes = read_file_mapped(path).ok()?;
                Some(crate::exif_processing::read_exif_data_from_bytes(
                    source_path,
                    &bytes,
                ))
            })
            .map(|exif| Self::from_exif(&exif))
            .unwrap_or_default()
    }
}

impl Lens {
    pub fn get_full_model_name(&self) -> String {
        pick_name(&self.model, "Unknown Model")
    }

    pub fn get_canonical_model_name(&self) -> String {
        self.model
            .iter()
            .find(|m| m.lang.is_none())
            .or_else(|| self.model.first())
            .map(|m| m.value.clone())
            .unwrap_or_else(|| "Unknown Model".to_string())
    }

    pub fn get_name(&self) -> String {
        strip_maker_prefix(&self.get_full_model_name(), &self.get_maker())
    }

    pub fn get_maker(&self) -> String {
        pick_name(&self.maker, "Misc")
    }

    pub fn get_display_name(&self, all_maker_lenses: &[&Lens]) -> String {
        let my_short = self.get_name();
        let short_count = all_maker_lenses
            .iter()
            .filter(|l| l.get_name() == my_short)
            .count();

        if short_count <= 1 {
            return my_short;
        }

        let maker = self.get_maker();
        let my_canonical_short = strip_maker_prefix(&self.get_canonical_model_name(), &maker);

        let canonical_short_count = all_maker_lenses
            .iter()
            .filter(|l| {
                strip_maker_prefix(&l.get_canonical_model_name(), &l.get_maker())
                    == my_canonical_short
            })
            .count();

        if canonical_short_count <= 1 {
            return my_canonical_short;
        }

        let my_canonical = self.get_canonical_model_name();
        let canonical_count = all_maker_lenses
            .iter()
            .filter(|l| l.get_canonical_model_name() == my_canonical)
            .count();

        if canonical_count <= 1 {
            return my_canonical;
        }

        if let Some(cf) = self.cropfactor {
            format!("{} (crop {:.1}x)", my_canonical_short, cf)
        } else {
            my_canonical_short
        }
    }

    fn calibration_crop(&self) -> f32 {
        self.cropfactor.filter(|c| *c > 0.0).unwrap_or(1.0)
    }

    fn aspect_ratio(&self) -> f64 {
        self.aspect_ratio
            .as_deref()
            .and_then(parse_aspect_ratio)
            .filter(|r| *r >= 1.0)
            .unwrap_or(DEFAULT_ASPECT_RATIO)
    }

    fn calibrations(&self) -> impl Iterator<Item = &CalibrationElement> {
        self.calibration.iter().flat_map(|c| &c.elements)
    }

    fn focal_range(&self) -> (f32, f32) {
        let declared = self.focal.as_ref().and_then(|f| {
            let min = f.min.or(f.value)?;
            Some((min, f.max.or(f.value).unwrap_or(min)))
        });
        declared.unwrap_or_else(|| {
            self.calibrations()
                .map(|c| match c {
                    CalibrationElement::Distortion(d) => d.focal,
                    CalibrationElement::Tca(t) => t.focal,
                    CalibrationElement::Vignetting(v) => v.focal,
                })
                .fold((f32::MAX, f32::MIN), |(lo, hi), f| (lo.min(f), hi.max(f)))
        })
    }

    fn distortion_at(&self, focal: f32) -> Option<[f64; 5]> {
        let mut model = None;
        let samples = self
            .calibrations()
            .filter_map(|c| match c {
                CalibrationElement::Distortion(d) => Some(d),
                _ => None,
            })
            .filter_map(|d| {
                let terms = distortion_terms(d)?;
                (*model.get_or_insert(d.model.as_str()) == d.model).then_some((d.focal, terms))
            })
            .collect();
        let terms = interpolate_by_focal(samples, focal, [true; 3])?;
        let polynomial = distortion_polynomial(model?, terms);
        (polynomial[0].abs() > 1e-6 && polynomial[1..].iter().any(|c| c.abs() > 1e-9))
            .then_some(polynomial)
    }

    fn tca_at(&self, focal: f32) -> Option<[f64; 6]> {
        let mut model = None;
        let samples = self
            .calibrations()
            .filter_map(|c| match c {
                CalibrationElement::Tca(t) => Some(t),
                _ => None,
            })
            .filter_map(|t| {
                let terms = tca_terms(t)?;
                (*model.get_or_insert(t.model.as_str()) == t.model).then_some((t.focal, terms))
            })
            .collect();
        let terms = interpolate_by_focal(samples, focal, TCA_FOCAL_SCALED)?;
        let identity = [1.0, 1.0, 0.0, 0.0, 0.0, 0.0];
        terms
            .iter()
            .zip(identity)
            .any(|(t, i)| (t - i).abs() > 1e-9)
            .then_some(terms)
    }

    fn vignetting_at(&self, focal: f32, aperture: f32, distance: f32) -> Option<[f64; 3]> {
        let (min_focal, max_focal) = self.focal_range();
        let focal_span = max_focal - min_focal;
        let normalized = |f: f32| {
            let offset = (f - min_focal) as f64;
            if focal_span != 0.0 {
                offset / focal_span as f64
            } else {
                offset
            }
        };

        let mut weighted = [0.0f64; 3];
        let mut total_weight = 0.0f64;
        let mut nearest = f64::MAX;
        for v in self.calibrations().filter_map(|c| match c {
            CalibrationElement::Vignetting(v) if v.model == "pa" => Some(v),
            _ => None,
        }) {
            let calibration_distance = v.distance.unwrap_or(0.0) as f64;
            let separation = ((normalized(v.focal) - normalized(focal)).powi(2)
                + (4.0 / v.aperture as f64 - 4.0 / aperture as f64).powi(2)
                + (0.1 / calibration_distance - 0.1 / distance as f64).powi(2))
            .sqrt();
            if separation < 1e-4 {
                return Some(vignetting_terms(v));
            }
            nearest = nearest.min(separation);
            let weight = 1.0 / separation.powf(3.5);
            if weight.is_finite() && weight > 0.0 {
                for (acc, term) in weighted.iter_mut().zip(vignetting_terms(v)) {
                    *acc += weight * term;
                }
                total_weight += weight;
            }
        }

        (nearest <= 1.0 && total_weight > 0.0)
            .then(|| weighted.map(|t| t / total_weight))
            .filter(|terms| terms.iter().any(|k| k.abs() > 1e-9))
    }

    fn profile(&self, shot: &Shot, camera_crop: Option<f32>) -> LensProfile {
        let focal = shot.focal.unwrap_or_else(|| self.focal_range().0);
        let crop_ratio = camera_crop.map_or(1.0, |crop| (self.calibration_crop() / crop) as f64);
        LensProfile {
            distortion: self.distortion_at(focal),
            tca: self.tca_at(focal),
            vignetting: shot.aperture.and_then(|aperture| {
                self.vignetting_at(focal, aperture, shot.distance.unwrap_or(DEFAULT_DISTANCE))
            }),
            distortion_scale: self.aspect_ratio().hypot(1.0) * crop_ratio,
            vignetting_scale: crop_ratio,
        }
    }
}

impl LensDatabase {
    fn lenses_for_maker(&self, maker: &str) -> Vec<&Lens> {
        self.lenses
            .iter()
            .filter(|l| l.get_maker() == maker)
            .collect()
    }

    fn lens_by_name(&self, maker: &str, model: &str) -> Option<&Lens> {
        let maker_lenses = self.lenses_for_maker(maker);
        maker_lenses
            .iter()
            .find(|l| l.get_display_name(&maker_lenses) == model)
            .copied()
    }

    fn camera_crop(&self, make: &str, model: &str) -> Option<f32> {
        self.cameras
            .iter()
            .find(|c| any_name_matches(&c.maker, make) && any_name_matches(&c.model, model))
            .map(|c| c.cropfactor)
            .filter(|c| *c > 0.01)
    }

    fn lens_on_camera_mount(&self, make: &str, model: &str) -> Option<&Lens> {
        if make.is_empty() || model.is_empty() {
            return None;
        }

        let mounts: Vec<&str> = self
            .cameras
            .iter()
            .filter(|c| any_name_matches(&c.maker, make) && any_name_matches(&c.model, model))
            .map(|c| c.mount.trim())
            .filter(|m| !m.is_empty())
            .collect();

        let mut hits = self.lenses.iter().filter(|lens| {
            lens.mount
                .iter()
                .any(|m| mounts.iter().any(|c| m.trim().eq_ignore_ascii_case(c)))
        });
        let lens = hits.next()?;
        if hits.next().is_some() {
            log::info!(
                "Mount fallback for {} {}: more than one lens on mount, giving up.",
                make,
                model
            );
            return None;
        }
        log::info!(
            "Mount fallback for {} {}: using fixed lens {} {}",
            make,
            model,
            lens.get_maker(),
            lens.get_full_model_name()
        );
        Some(lens)
    }

    fn lens_by_fuzzy_model<'a>(
        &'a self,
        maker: &str,
        model: &str,
        camera_crop: Option<f32>,
    ) -> Option<&'a Lens> {
        let matcher = fuzzy_matcher::skim::SkimMatcherV2::default().ignore_case();
        let score = |lens: &Lens, penalize_length: bool| {
            let crop = crop_score(lens.calibration_crop(), camera_crop)?;
            let english_name = lens.get_full_model_name();
            let canonical_name = lens.get_canonical_model_name();
            let score_english = matcher.fuzzy_match(&english_name, model).unwrap_or(0);
            let score_canonical = matcher.fuzzy_match(&canonical_name, model).unwrap_or(0);
            let score = score_english.max(score_canonical);
            if score <= 0 {
                return None;
            }
            let penalty = if penalize_length {
                let best_name = if score_canonical > score_english {
                    &canonical_name
                } else {
                    &english_name
                };
                (best_name.len() as i64 - model.len() as i64).max(0) / 2
            } else {
                0
            };
            Some(score - penalty + crop)
        };
        let best = |penalize_length: bool, lenses: Vec<&'a Lens>| {
            lenses
                .into_iter()
                .filter_map(|lens| Some((score(lens, penalize_length)?, lens)))
                .max_by_key(|(score, _)| *score)
                .map(|(_, lens)| lens)
        };

        best(
            true,
            self.lenses
                .iter()
                .filter(|lens| lens.get_maker().eq_ignore_ascii_case(maker))
                .collect(),
        )
        .or_else(|| best(false, self.lenses.iter().collect()))
    }

    fn detect_lens(&self, shot: &Shot, camera_crop: Option<f32>) -> Option<&Lens> {
        (!shot.lens_model.is_empty())
            .then(|| self.lens_by_fuzzy_model(&shot.make, &shot.lens_model, camera_crop))
            .flatten()
            .or_else(|| self.lens_on_camera_mount(&shot.make, &shot.model))
    }

    fn resolve(&self, shot: &Shot, selection: &Option<(String, String)>) -> Option<ResolvedLens> {
        let camera_crop = self.camera_crop(&shot.make, &shot.model);
        let lens = match selection {
            Some((maker, model)) => self.lens_by_name(maker, model),
            None => self.detect_lens(shot, camera_crop),
        }?;
        let profile = lens.profile(shot, camera_crop);
        let maker = lens.get_maker();
        let info = LensCorrectionInfo {
            model: lens.get_display_name(&self.lenses_for_maker(&maker)),
            maker,
            distortion: profile.distortion.is_some(),
            tca: profile.tca.is_some(),
            vignetting: profile.vignetting.is_some(),
        };
        Some(ResolvedLens { info, profile })
    }
}

fn database() -> Option<&'static LensDatabase> {
    DATABASE.get()
}

fn profile_cache() -> &'static Mutex<HashMap<ProfileKey, Option<Arc<ResolvedLens>>>> {
    static CACHE: OnceLock<Mutex<HashMap<ProfileKey, Option<Arc<ResolvedLens>>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn source_key(path: &str) -> String {
    parse_virtual_path(path).0.to_string_lossy().into_owned()
}

fn lens_selection(adjustments: &Value) -> Option<Option<(String, String)>> {
    if adjustments
        .get("lensCorrectionMode")
        .and_then(Value::as_str)
        == Some("auto")
    {
        return Some(None);
    }
    let name = |key: &str| {
        adjustments
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    Some(Some((name("lensMaker")?, name("lensModel")?)))
}

fn resolve(path: &str, adjustments: &Value) -> Option<Arc<ResolvedLens>> {
    let selection = lens_selection(adjustments)?;
    let key = (source_key(path), selection);
    if let Some(cached) = profile_cache().lock().unwrap().get(&key) {
        return cached.clone();
    }
    let db = database()?;
    let resolved = db.resolve(&Shot::read(&key.0), &key.1).map(Arc::new);
    let mut cache = profile_cache().lock().unwrap();
    if cache.len() >= MAX_CACHED_PROFILES {
        cache.clear();
    }
    cache.insert(key, resolved.clone());
    resolved
}

pub fn has_lens_selection(adjustments: &Value) -> bool {
    lens_selection(adjustments).is_some()
}

pub fn lens_profile(path: &str, adjustments: &Value) -> Option<LensProfile> {
    resolve(path, adjustments).map(|r| r.profile.clone())
}

pub fn forget_lens_profiles(path: &str) {
    let source = source_key(path);
    profile_cache()
        .lock()
        .unwrap()
        .retain(|(cached, _), _| *cached != source);
}

pub fn init_lensfun_db(app_handle: &tauri::AppHandle) {
    let _ = DATABASE.set(load_lensfun_db(app_handle));
}

fn load_lensfun_db(app_handle: &tauri::AppHandle) -> LensDatabase {
    let mut combined_db = LensDatabase {
        cameras: Vec::new(),
        lenses: Vec::new(),
    };

    #[cfg(target_os = "android")]
    {
        let _ = app_handle;
        log::info!("Loading Lensfun DB from embedded assets (Android path)");

        for file in LENS_DB_DIR.files() {
            let is_xml = file
                .path()
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.eq_ignore_ascii_case("xml"))
                .unwrap_or(false);

            if is_xml {
                if let Some(xml_content) = file.contents_utf8() {
                    match quick_xml::de::from_str::<LensDatabase>(xml_content) {
                        Ok(mut db) => {
                            combined_db.cameras.append(&mut db.cameras);
                            combined_db.lenses.append(&mut db.lenses);
                        }
                        Err(e) => {
                            log::error!("Failed to parse embedded XML {:?}: {}", file.path(), e)
                        }
                    }
                }
            }
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let resource_path = app_handle
            .path()
            .resolve("lensfun_db", tauri::path::BaseDirectory::Resource)
            .expect("failed to resolve lensfun_db directory");

        if !resource_path.exists() {
            log::error!("Lensfun DB directory not found at: {:?}", resource_path);
            return combined_db;
        }

        for entry in WalkDir::new(resource_path)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|ext| ext == "xml"))
        {
            let path = entry.path();
            log::info!("Processing file: {:?}", path);
            match fs::read_to_string(path) {
                Ok(xml_content) => match quick_xml::de::from_str::<LensDatabase>(&xml_content) {
                    Ok(mut db) => {
                        combined_db.cameras.append(&mut db.cameras);
                        combined_db.lenses.append(&mut db.lenses);
                    }
                    Err(e) => {
                        log::error!("Failed to parse Lensfun XML file {:?}: {}", path, e);
                    }
                },
                Err(e) => log::error!("Failed to read Lensfun XML file {:?}: {}", path, e),
            }
        }
    }

    log::info!(
        "Loaded {} lenses and {} cameras from Lensfun database.",
        combined_db.lenses.len(),
        combined_db.cameras.len()
    );
    combined_db
}

#[tauri::command]
pub fn get_lensfun_makers() -> Result<Vec<String>, String> {
    let db = database().ok_or("Lens database not loaded")?;
    let mut makers: Vec<String> = db.lenses.iter().map(|lens| lens.get_maker()).collect();
    makers.sort_unstable();
    makers.dedup();
    Ok(makers)
}

#[tauri::command]
pub fn get_lensfun_lenses_for_maker(maker: String) -> Result<Vec<String>, String> {
    let db = database().ok_or("Lens database not loaded")?;
    let maker_lenses = db.lenses_for_maker(&maker);
    let mut models: Vec<String> = maker_lenses
        .iter()
        .map(|lens| lens.get_display_name(&maker_lenses))
        .collect();
    models.sort_unstable();
    models.dedup();
    Ok(models)
}

#[tauri::command]
pub fn get_lens_correction_info(path: String, selection: Value) -> Option<LensCorrectionInfo> {
    resolve(&path, &selection).map(|r| r.info.clone())
}
