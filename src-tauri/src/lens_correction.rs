use crate::AppState;
use fuzzy_matcher::FuzzyMatcher;
#[cfg(target_os = "android")]
use include_dir::{Dir, include_dir};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::fs;
use tauri::{Manager, State};
use walkdir::WalkDir;
#[cfg(target_os = "android")]
static LENS_DB_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/lensfun_db");

#[derive(Debug, Deserialize, Clone, PartialEq)]
pub struct Distortion {
    #[serde(rename = "@model")]
    pub model: String,
    #[serde(rename = "@focal")]
    pub focal: f32,
    #[serde(rename = "@real-focal")]
    pub real_focal: Option<f32>,
    #[serde(rename = "@k1")]
    pub k1: Option<f32>,
    #[serde(rename = "@k2")]
    pub k2: Option<f32>,
    #[serde(rename = "@k3")]
    pub k3: Option<f32>,
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
pub struct Aperture {
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
    #[serde(rename = "type")]
    pub type_: Option<String>,
    pub focal: Option<Focal>,
    pub aspect_ratio: Option<String>,
    pub center: Option<String>,
    pub compat: Option<String>,
    pub notes: Option<String>,
    pub aperture: Option<Aperture>,
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

#[derive(Serialize, Clone)]
pub struct LensDistortionParams {
    k1: f64,
    k2: f64,
    k3: f64,
    model: u32,
    /// Factor between the radius of the image, normalized to the half
    /// diagonal, and the radius that the Hugin models expect.
    radius_scale: f64,
    tca_vr: f64,
    tca_vb: f64,
    vig_k1: f64,
    vig_k2: f64,
    vig_k3: f64,
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

/// Compares all language variants of a name. The comparison is exact but
/// ignores upper and lower case.
fn any_name_matches(names: &[MultiName], needle: &str) -> bool {
    names
        .iter()
        .any(|n| n.value.trim().eq_ignore_ascii_case(needle))
}

impl Camera {
    pub fn get_maker(&self) -> String {
        pick_name(&self.maker, "Misc")
    }

    pub fn get_model(&self) -> String {
        pick_name(&self.model, "Unknown Model")
    }
}

impl Lens {
    pub fn get_full_model_name(&self) -> String {
        self.model
            .iter()
            .find(|m| m.lang.as_deref() == Some("en"))
            .or_else(|| self.model.first())
            .map(|m| m.value.clone())
            .unwrap_or_else(|| "Unknown Model".to_string())
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
        let raw_name = self.get_full_model_name();
        let maker = self.get_maker();

        if raw_name.to_lowercase().starts_with(&maker.to_lowercase())
            && let Some(rest) = raw_name.get(maker.len()..)
        {
            let stripped = rest.trim();
            if !stripped.is_empty() {
                return stripped.to_string();
            }
        }

        raw_name
    }

    pub fn get_maker(&self) -> String {
        self.maker
            .iter()
            .find(|m| m.lang.as_deref() == Some("en"))
            .or_else(|| self.maker.first())
            .map(|m| m.value.clone())
            .unwrap_or_else(|| "Misc".to_string())
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

    pub fn get_distortion_params(
        &self,
        focal_length: f32,
        aperture: Option<f32>,
        distance: Option<f32>,
        camera_crop: Option<f32>,
    ) -> Option<LensDistortionParams> {
        let cal = self.calibration.as_ref()?;

        let mut distortions: Vec<&Distortion> = cal
            .elements
            .iter()
            .filter_map(|e| {
                if let CalibrationElement::Distortion(d) = e {
                    Some(d)
                } else {
                    None
                }
            })
            .collect();

        let mut tcas: Vec<&Tca> = cal
            .elements
            .iter()
            .filter_map(|e| {
                if let CalibrationElement::Tca(t) = e {
                    Some(t)
                } else {
                    None
                }
            })
            .collect();

        let mut vignettings: Vec<&Vignetting> = cal
            .elements
            .iter()
            .filter_map(|e| {
                if let CalibrationElement::Vignetting(v) = e {
                    Some(v)
                } else {
                    None
                }
            })
            .collect();

        let (k1, k2, k3, model) = if distortions.is_empty() {
            (0.0, 0.0, 0.0, 0)
        } else {
            distortions.sort_by(|a, b| a.focal.partial_cmp(&b.focal).unwrap_or(Ordering::Equal));

            if let Some(exact) = distortions
                .iter()
                .find(|d| (d.focal - focal_length).abs() < 1e-5)
            {
                extract_dist_params(exact)
            } else if focal_length < distortions[0].focal {
                extract_dist_params(distortions[0])
            } else if focal_length > distortions.last().unwrap().focal {
                extract_dist_params(distortions.last().unwrap())
            } else {
                let mut res = (0.0, 0.0, 0.0, 0);
                for pair in distortions.windows(2) {
                    let (d1, d2) = (&pair[0], &pair[1]);

                    if focal_length >= d1.focal && focal_length <= d2.focal {
                        let p1 = extract_dist_params(d1);
                        let p2 = extract_dist_params(d2);

                        let range = d2.focal - d1.focal;
                        if range.abs() < 1e-5 || p1.3 != p2.3 {
                            res = p1;
                        } else {
                            let t = (focal_length - d1.focal) / range;
                            res = (
                                p1.0 + t as f64 * (p2.0 - p1.0),
                                p1.1 + t as f64 * (p2.1 - p1.1),
                                p1.2 + t as f64 * (p2.2 - p1.2),
                                p1.3,
                            );
                        }
                        break;
                    }
                }
                res
            }
        };

        let (tca_vr, tca_vb) = if tcas.is_empty() {
            (1.0, 1.0)
        } else {
            tcas.sort_by(|a, b| a.focal.partial_cmp(&b.focal).unwrap_or(Ordering::Equal));

            if let Some(exact) = tcas.iter().find(|d| (d.focal - focal_length).abs() < 1e-5) {
                extract_tca_params(exact)
            } else if focal_length < tcas[0].focal {
                extract_tca_params(tcas[0])
            } else if focal_length > tcas.last().unwrap().focal {
                extract_tca_params(tcas.last().unwrap())
            } else {
                let mut res = (1.0, 1.0);
                for pair in tcas.windows(2) {
                    let (d1, d2) = (&pair[0], &pair[1]);
                    if focal_length >= d1.focal && focal_length <= d2.focal {
                        let p1 = extract_tca_params(d1);
                        let p2 = extract_tca_params(d2);

                        let range = d2.focal - d1.focal;
                        if range.abs() < 1e-5 {
                            res = p1;
                        } else {
                            let t = (focal_length - d1.focal) / range;
                            res = (
                                p1.0 + t as f64 * (p2.0 - p1.0),
                                p1.1 + t as f64 * (p2.1 - p1.1),
                            );
                        }
                        break;
                    }
                }
                res
            }
        };

        let (vig_k1, vig_k2, vig_k3) = if vignettings.is_empty() {
            (0.0, 0.0, 0.0)
        } else {
            let target_aperture = aperture.unwrap_or(3.5);
            let target_distance = distance.unwrap_or(1000.0);

            vignettings.sort_by(|a, b| a.focal.partial_cmp(&b.focal).unwrap_or(Ordering::Equal));

            let find_best_vig = |items: &[&Vignetting]| -> (f64, f64, f64) {
                let best_aperture_item = items.iter().min_by(|a, b| {
                    (a.aperture - target_aperture)
                        .abs()
                        .partial_cmp(&(b.aperture - target_aperture).abs())
                        .unwrap_or(Ordering::Equal)
                });
                if let Some(best_ap) = best_aperture_item {
                    let candidates: Vec<&&Vignetting> = items
                        .iter()
                        .filter(|x| (x.aperture - best_ap.aperture).abs() < 0.01)
                        .collect();
                    let best_dist = candidates.into_iter().min_by(|a, b| {
                        let da = a.distance.unwrap_or(1000.0);
                        let db = b.distance.unwrap_or(1000.0);
                        (da - target_distance)
                            .abs()
                            .partial_cmp(&(db - target_distance).abs())
                            .unwrap_or(Ordering::Equal)
                    });
                    extract_vig_params(best_dist.unwrap_or(best_ap))
                } else {
                    (0.0, 0.0, 0.0)
                }
            };

            if focal_length <= vignettings[0].focal + 0.01 {
                let group: Vec<&Vignetting> = vignettings
                    .iter()
                    .filter(|x| (x.focal - vignettings[0].focal).abs() < 0.01)
                    .copied()
                    .collect();
                find_best_vig(&group)
            } else if focal_length >= vignettings.last().unwrap().focal - 0.01 {
                let last_focal = vignettings.last().unwrap().focal;
                let group: Vec<&Vignetting> = vignettings
                    .iter()
                    .filter(|x| (x.focal - last_focal).abs() < 0.01)
                    .copied()
                    .collect();
                find_best_vig(&group)
            } else {
                let mut res = (0.0, 0.0, 0.0);
                let unique_focals: Vec<f32> = {
                    let mut f: Vec<f32> = vignettings.iter().map(|v| v.focal).collect();
                    f.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
                    f.dedup_by(|a, b| (*a - *b).abs() < 0.01);
                    f
                };
                for pair in unique_focals.windows(2) {
                    let (f1, f2) = (pair[0], pair[1]);
                    if focal_length >= f1 && focal_length <= f2 {
                        let group1: Vec<&Vignetting> = vignettings
                            .iter()
                            .filter(|x| (x.focal - f1).abs() < 0.01)
                            .copied()
                            .collect();
                        let group2: Vec<&Vignetting> = vignettings
                            .iter()
                            .filter(|x| (x.focal - f2).abs() < 0.01)
                            .copied()
                            .collect();

                        let p1 = find_best_vig(&group1);
                        let p2 = find_best_vig(&group2);

                        let range = f2 - f1;
                        if range.abs() > 0.01 {
                            let t = (focal_length - f1) / range;
                            res = (
                                p1.0 + t as f64 * (p2.0 - p1.0),
                                p1.1 + t as f64 * (p2.1 - p1.1),
                                p1.2 + t as f64 * (p2.2 - p1.2),
                            );
                        } else {
                            res = p1;
                        }
                        break;
                    }
                }
                res
            }
        };

        let (k1, k2, k3, model) = rescale_dist_params(k1, k2, k3, model);

        Some(LensDistortionParams {
            k1,
            k2,
            k3,
            model,
            radius_scale: distortion_radius_scale(self, camera_crop),
            tca_vr,
            tca_vb,
            vig_k1,
            vig_k2,
            vig_k3,
        })
    }

    fn has_distortion_data(&self) -> bool {
        self.calibration.as_ref().is_some_and(|c| {
            c.elements
                .iter()
                .any(|e| matches!(e, CalibrationElement::Distortion(_)))
        })
    }

    fn has_tca_data(&self) -> bool {
        self.calibration.as_ref().is_some_and(|c| {
            c.elements
                .iter()
                .any(|e| matches!(e, CalibrationElement::Tca(_)))
        })
    }

    fn has_vignetting_data(&self) -> bool {
        self.calibration.as_ref().is_some_and(|c| {
            c.elements
                .iter()
                .any(|e| matches!(e, CalibrationElement::Vignetting(_)))
        })
    }
}

/// Reads the raw terms of a distortion element.
///
/// The model number is internal: 0 = poly5, 1 = ptlens, 2 = poly3.
/// `rescale_dist_params` turns these terms into the form the pipeline uses.
fn extract_dist_params(dist: &Distortion) -> (f64, f64, f64, u32) {
    match dist.model.as_str() {
        "poly3" => (dist.k1.unwrap_or(0.0) as f64, 0.0, 0.0, 2),
        "poly5" => (
            dist.k1.unwrap_or(0.0) as f64,
            dist.k2.unwrap_or(0.0) as f64,
            0.0,
            0,
        ),
        "ptlens" => {
            let a = dist.a.unwrap_or(0.0) as f64;
            let b = dist.b.unwrap_or(0.0) as f64;
            let c = dist.c.unwrap_or(0.0) as f64;
            (a, b, c, 1)
        }
        _ => (0.0, 0.0, 0.0, 0),
    }
}

/// Turns the raw Hugin terms into the form the pipeline uses.
///
/// The PanoTools formula shrinks the image center by `d = 1 - a - b - c`,
/// which changes the focal length. Lensfun divides this out, so that the
/// correction keeps the focal length. See `rescale_polynomial_coefficients`
/// in `mod-coord.cpp` of Lensfun.
///
/// The result is evaluated as
/// `m(t) = 1 + k1*t + k2*t^2 + k3*t^3` for ptlens (model 1) and
/// `m(t) = 1 + k1*t^2 + k2*t^4` for the polynomial models (model 0).
fn rescale_dist_params(k1: f64, k2: f64, k3: f64, model: u32) -> (f64, f64, f64, u32) {
    match model {
        // ptlens, the raw terms are a, b, c
        1 => {
            let (a, b, c) = (k1, k2, k3);
            let d = 1.0 - a - b - c;
            if d.abs() < 1e-9 {
                return (0.0, 0.0, 0.0, 0);
            }
            (c / d.powi(2), b / d.powi(3), a / d.powi(4), 1)
        }
        // poly3, the raw term is k1
        2 => {
            let d = 1.0 - k1;
            if d.abs() < 1e-9 {
                return (0.0, 0.0, 0.0, 0);
            }
            (k1 / d.powi(3), 0.0, 0.0, 0)
        }
        // poly5 needs no rescaling
        _ => (k1, k2, 0.0, 0),
    }
}

/// Reads an aspect ratio such as "3:2" or "1.5". Lensfun uses 1.5 as default.
fn parse_aspect_ratio(value: Option<&String>) -> f64 {
    const DEFAULT: f64 = 1.5;
    let Some(text) = value else {
        return DEFAULT;
    };
    let text = text.trim();
    if let Some((w, h)) = text.split_once(':') {
        match (w.trim().parse::<f64>(), h.trim().parse::<f64>()) {
            (Ok(w), Ok(h)) if h.abs() > 1e-9 => w / h,
            _ => DEFAULT,
        }
    } else {
        text.parse::<f64>().unwrap_or(DEFAULT)
    }
}

/// Factor between the image radius, normalized to the half diagonal, and the
/// radius that the Hugin models expect.
///
/// Lensfun defines `r = 1` at the middle of the long edge, which is half the
/// image height in landscape. It also rescales a calibration that was made on
/// another sensor size. Both steps end in one factor:
///
/// `t = r_half_diagonal * hypot(aspect, 1) * lens_crop / camera_crop`
fn distortion_radius_scale(lens: &Lens, camera_crop: Option<f32>) -> f64 {
    let aspect = parse_aspect_ratio(lens.aspect_ratio.as_ref());
    let lens_crop = lens.cropfactor.unwrap_or(1.0) as f64;
    let camera_crop = camera_crop.map(|c| c as f64).unwrap_or(lens_crop);
    if camera_crop.abs() < 1e-6 {
        return aspect.hypot(1.0);
    }
    aspect.hypot(1.0) * lens_crop / camera_crop
}

fn extract_tca_params(tca: &Tca) -> (f64, f64) {
    (tca.vr.unwrap_or(1.0) as f64, tca.vb.unwrap_or(1.0) as f64)
}

fn extract_vig_params(vig: &Vignetting) -> (f64, f64, f64) {
    (
        vig.k1.unwrap_or(0.0) as f64,
        vig.k2.unwrap_or(0.0) as f64,
        vig.k3.unwrap_or(0.0) as f64,
    )
}

fn lenses_for_maker<'a>(db: &'a LensDatabase, maker: &str) -> Vec<&'a Lens> {
    db.lenses
        .iter()
        .filter(|l| l.get_maker() == maker)
        .collect()
}

pub fn load_lensfun_db(app_handle: &tauri::AppHandle) -> LensDatabase {
    let mut combined_db = LensDatabase {
        cameras: Vec::new(),
        lenses: Vec::new(),
    };

    #[cfg(target_os = "android")]
    {
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
pub fn get_lensfun_makers(state: State<AppState>) -> Result<Vec<String>, String> {
    let db_guard = state
        .lens_db
        .lock()
        .map_err(|e| format!("Lock poisoned: {}", e))?;
    if let Some(db) = &*db_guard {
        let mut makers: Vec<String> = db.lenses.iter().map(|lens| lens.get_maker()).collect();
        makers.sort_unstable();
        makers.dedup();
        Ok(makers)
    } else {
        Err("Lens database not loaded".to_string())
    }
}

#[tauri::command]
pub fn get_lensfun_lenses_for_maker(
    maker: String,
    state: State<AppState>,
) -> Result<Vec<String>, String> {
    let db_guard = state
        .lens_db
        .lock()
        .map_err(|e| format!("Lock poisoned: {}", e))?;
    if let Some(db) = &*db_guard {
        let maker_lenses = lenses_for_maker(db, &maker);

        let mut models: Vec<String> = maker_lenses
            .iter()
            .map(|lens| lens.get_display_name(&maker_lenses))
            .collect();
        models.sort_unstable();
        models.dedup();
        Ok(models)
    } else {
        Err("Lens database not loaded".to_string())
    }
}

/// Finds the lens of a fixed lens camera through the Lensfun mount.
///
/// A camera with a fixed lens writes no `LensModel` EXIF tag. Lensfun gives
/// such a camera its own mount, and exactly one lens uses that mount. The
/// fallback applies only in this unambiguous case. If the mount has more than
/// one lens, the camera has interchangeable lenses. The search then stops.
/// Otherwise a Canon EOS would get an arbitrary EF lens.
pub fn find_lens_by_camera_mount<'a>(
    db: &'a LensDatabase,
    camera_maker: &str,
    camera_model: &str,
) -> Option<&'a Lens> {
    let clean_maker = camera_maker.trim().trim_matches('"');
    let clean_model = camera_model.trim().trim_matches('"');

    if clean_maker.is_empty() || clean_model.is_empty() {
        return None;
    }

    let mounts: Vec<&str> = db
        .cameras
        .iter()
        .filter(|c| {
            any_name_matches(&c.maker, clean_maker) && any_name_matches(&c.model, clean_model)
        })
        .map(|c| c.mount.trim())
        .filter(|m| !m.is_empty())
        .collect();

    if mounts.is_empty() {
        return None;
    }

    let mut hits: Vec<&Lens> = Vec::new();
    for lens in &db.lenses {
        if lens
            .mount
            .iter()
            .any(|m| mounts.iter().any(|c| m.trim().eq_ignore_ascii_case(c)))
        {
            hits.push(lens);
            if hits.len() > 1 {
                log::info!(
                    "Mount fallback for {} {}: more than one lens on mount, giving up.",
                    clean_maker,
                    clean_model
                );
                return None;
            }
        }
    }

    let lens = hits.into_iter().next()?;
    log::info!(
        "Mount fallback for {} {}: using fixed lens {} {}",
        clean_maker,
        clean_model,
        lens.get_maker(),
        lens.get_full_model_name()
    );
    Some(lens)
}

fn lens_result(db: &LensDatabase, lens: &Lens) -> (String, String) {
    let lens_maker = lens.get_maker();
    let maker_lenses = lenses_for_maker(db, &lens_maker);
    (lens_maker, lens.get_display_name(&maker_lenses))
}

/// Finds the best lens for the EXIF data.
///
/// `model` is the EXIF tag `LensModel`. `camera_model` is the tag `Model`.
/// If `LensModel` is absent, or if the fuzzy search finds nothing, the
/// fallback through the camera mount applies.
pub fn find_best_lens_match(
    db: &LensDatabase,
    maker: &str,
    model: &str,
    camera_model: &str,
) -> Option<(String, String)> {
    let clean_model = model.trim().trim_matches('"');

    if !clean_model.is_empty()
        && let Some(hit) = find_lens_by_fuzzy_model(db, maker, clean_model)
    {
        return Some(hit);
    }

    find_lens_by_camera_mount(db, maker, camera_model).map(|lens| lens_result(db, lens))
}

fn find_lens_by_fuzzy_model(
    db: &LensDatabase,
    maker: &str,
    model: &str,
) -> Option<(String, String)> {
    let clean_maker = maker.trim().trim_matches('"').to_string();
    let clean_model = model.trim().trim_matches('"').to_string();
    let matcher = fuzzy_matcher::skim::SkimMatcherV2::default().ignore_case();

    let lenses_from_maker: Vec<&Lens> = db
        .lenses
        .iter()
        .filter(|lens| lens.get_maker().eq_ignore_ascii_case(&clean_maker))
        .collect();

    if !lenses_from_maker.is_empty() {
        let best_match = lenses_from_maker
            .iter()
            .filter_map(|lens| {
                let english_name = lens.get_full_model_name();
                let canonical_name = lens.get_canonical_model_name();

                let score_english = matcher
                    .fuzzy_match(&english_name, &clean_model)
                    .unwrap_or(0);
                let score_canonical = matcher
                    .fuzzy_match(&canonical_name, &clean_model)
                    .unwrap_or(0);
                let score = score_english.max(score_canonical);

                if score > 0 {
                    let best_name = if score_canonical > score_english {
                        &canonical_name
                    } else {
                        &english_name
                    };
                    let length_penalty =
                        (best_name.len() as i64 - clean_model.len() as i64).max(0) / 2;
                    let adjusted_score = score - length_penalty;
                    Some((adjusted_score, *lens))
                } else {
                    None
                }
            })
            .max_by_key(|(score, _)| *score);

        if let Some((_, best_lens)) = best_match {
            return Some((
                best_lens.get_maker(),
                best_lens.get_display_name(&lenses_from_maker),
            ));
        }
    }

    let best_match_fallback = db
        .lenses
        .iter()
        .filter_map(|lens| {
            let english_name = lens.get_full_model_name();
            let canonical_name = lens.get_canonical_model_name();

            let score_english = matcher
                .fuzzy_match(&english_name, &clean_model)
                .unwrap_or(0);
            let score_canonical = matcher
                .fuzzy_match(&canonical_name, &clean_model)
                .unwrap_or(0);
            let score = score_english.max(score_canonical);

            if score > 0 { Some((score, lens)) } else { None }
        })
        .max_by_key(|(score, _): &(i64, _)| *score);

    if let Some((_, best_lens)) = best_match_fallback {
        let lens_maker = best_lens.get_maker();
        let maker_lenses = lenses_for_maker(db, &lens_maker);
        return Some((lens_maker, best_lens.get_display_name(&maker_lenses)));
    }

    None
}

#[tauri::command]
pub fn autodetect_lens(
    maker: String,
    model: String,
    camera_model: Option<String>,
    state: tauri::State<AppState>,
) -> Result<Option<(String, String)>, String> {
    let db_guard = state
        .lens_db
        .lock()
        .map_err(|e| format!("Lock poisoned: {}", e))?;
    if let Some(db) = &*db_guard {
        Ok(find_best_lens_match(
            db,
            &maker,
            &model,
            camera_model.as_deref().unwrap_or(""),
        ))
    } else {
        Ok(None)
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn get_lens_distortion_params(
    maker: String,
    model: String,
    focal_length: f32,
    aperture: Option<f32>,
    distance: Option<f32>,
    camera_maker: Option<String>,
    camera_model: Option<String>,
    state: State<AppState>,
) -> Result<Option<LensDistortionParams>, String> {
    let db_guard = state
        .lens_db
        .lock()
        .map_err(|e| format!("Lock poisoned: {}", e))?;
    if let Some(db) = &*db_guard {
        let camera_crop = camera_crop_factor(
            db,
            camera_maker.as_deref().unwrap_or(""),
            camera_model.as_deref().unwrap_or(""),
        );
        return Ok(resolve_lens_params(
            db,
            &maker,
            &model,
            focal_length,
            aperture,
            distance,
            camera_crop,
        ));
    }
    Ok(None)
}

/// Finds the camera entry for the EXIF tags `Make` and `Model`.
pub fn find_camera<'a>(
    db: &'a LensDatabase,
    camera_maker: &str,
    camera_model: &str,
) -> Option<&'a Camera> {
    let clean_maker = camera_maker.trim().trim_matches('"');
    let clean_model = camera_model.trim().trim_matches('"');
    if clean_maker.is_empty() || clean_model.is_empty() {
        return None;
    }
    db.cameras.iter().find(|c| {
        any_name_matches(&c.maker, clean_maker) && any_name_matches(&c.model, clean_model)
    })
}

/// Crop factor of the camera, taken from the Lensfun camera entry.
pub fn camera_crop_factor(
    db: &LensDatabase,
    camera_maker: &str,
    camera_model: &str,
) -> Option<f32> {
    find_camera(db, camera_maker, camera_model).map(|c| c.cropfactor)
}

/// All entries that describe the same lens.
///
/// Lensfun stores one entry per calibration sensor size. The entries share
/// the maker, the model and the mount, and differ in `cropfactor`.
fn lens_group<'a>(db: &'a LensDatabase, lens: &Lens) -> Vec<&'a Lens> {
    let maker = lens.get_maker();
    let model = lens.get_canonical_model_name();
    db.lenses
        .iter()
        .filter(|l| l.get_maker() == maker && l.get_canonical_model_name() == model)
        .collect()
}

/// Reads the correction values for one lens on one camera.
///
/// A lens can have several entries, one per calibration sensor size. Each
/// correction type is taken from the entry whose crop factor is closest to
/// the camera. This is what Lensfun does. Without it a full frame lens on a
/// crop body can lose its distortion data, because the entry that matches
/// the sensor may hold vignetting only.
pub fn resolve_lens_params(
    db: &LensDatabase,
    maker: &str,
    model: &str,
    focal_length: f32,
    aperture: Option<f32>,
    distance: Option<f32>,
    camera_crop: Option<f32>,
) -> Option<LensDistortionParams> {
    let maker_lenses = lenses_for_maker(db, maker);
    let primary = maker_lenses
        .iter()
        .find(|l| l.get_display_name(&maker_lenses) == model)?;

    let mut group = lens_group(db, primary);
    if group.is_empty() {
        group.push(primary);
    }

    if let Some(target) = camera_crop {
        group.sort_by(|a, b| {
            let da = (a.cropfactor.unwrap_or(1.0) - target).abs();
            let db_ = (b.cropfactor.unwrap_or(1.0) - target).abs();
            da.partial_cmp(&db_).unwrap_or(Ordering::Equal)
        });
    }

    let params_of =
        |lens: &Lens| lens.get_distortion_params(focal_length, aperture, distance, camera_crop);

    let mut merged = group
        .iter()
        .find(|l| l.has_distortion_data() || l.has_tca_data() || l.has_vignetting_data())
        .and_then(|l| params_of(l))
        .or_else(|| params_of(primary))?;

    if let Some(source) = group.iter().find(|l| l.has_distortion_data())
        && let Some(p) = params_of(source)
    {
        merged.k1 = p.k1;
        merged.k2 = p.k2;
        merged.k3 = p.k3;
        merged.model = p.model;
        merged.radius_scale = p.radius_scale;
    }

    if let Some(source) = group.iter().find(|l| l.has_tca_data())
        && let Some(p) = params_of(source)
    {
        merged.tca_vr = p.tca_vr;
        merged.tca_vb = p.tca_vb;
    }

    if let Some(source) = group.iter().find(|l| l.has_vignetting_data())
        && let Some(p) = params_of(source)
    {
        merged.vig_k1 = p.vig_k1;
        merged.vig_k2 = p.vig_k2;
        merged.vig_k3 = p.vig_k3;
    }

    Some(merged)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn distortion(model: &str, focal: f32) -> Distortion {
        Distortion {
            model: model.to_string(),
            focal,
            real_focal: None,
            k1: None,
            k2: None,
            k3: None,
            a: None,
            b: None,
            c: None,
        }
    }

    #[test]
    fn aspect_ratio_is_read_or_defaults_to_three_to_two() {
        assert!((parse_aspect_ratio(None) - 1.5).abs() < 1e-9);
        assert!((parse_aspect_ratio(Some(&"3:2".to_string())) - 1.5).abs() < 1e-9);
        assert!((parse_aspect_ratio(Some(&"4:3".to_string())) - 4.0 / 3.0).abs() < 1e-9);
        assert!((parse_aspect_ratio(Some(&"1.5".to_string())) - 1.5).abs() < 1e-9);
        assert!((parse_aspect_ratio(Some(&"nonsense".to_string())) - 1.5).abs() < 1e-9);
    }

    #[test]
    fn ptlens_terms_are_divided_by_d() {
        // Leica DMC-LX10 & compatibles, 8.8 mm.
        let a = 0.0340763561797834;
        let b = -0.112939517866333;
        let c = -0.00478327940864424;
        let d = 1.0 - a - b - c;

        let (k1, k2, k3, model) = rescale_dist_params(a, b, c, 1);
        assert_eq!(model, 1);
        assert!((k1 - c / d.powi(2)).abs() < 1e-12);
        assert!((k2 - b / d.powi(3)).abs() < 1e-12);
        assert!((k3 - a / d.powi(4)).abs() < 1e-12);
    }

    #[test]
    fn poly3_gets_its_own_scaling() {
        let k1 = -0.0042;
        let d = 1.0 - k1;
        let (r1, r2, r3, model) = rescale_dist_params(k1, 0.0, 0.0, 2);
        assert_eq!(model, 0);
        assert!((r1 - k1 / d.powi(3)).abs() < 1e-12);
        assert!(r2.abs() < 1e-12 && r3.abs() < 1e-12);
    }

    #[test]
    fn poly5_is_used_as_it_is() {
        let (k1, k2, k3, model) = rescale_dist_params(-0.01, 0.002, 0.0, 0);
        assert_eq!(model, 0);
        assert!((k1 - -0.01).abs() < 1e-12);
        assert!((k2 - 0.002).abs() < 1e-12);
        assert!(k3.abs() < 1e-12);
    }

    #[test]
    fn extract_separates_poly3_from_poly5() {
        let mut d3 = distortion("poly3", 32.0);
        d3.k1 = Some(-0.0042);
        assert_eq!(extract_dist_params(&d3).3, 2);

        let mut d5 = distortion("poly5", 32.0);
        d5.k1 = Some(-0.01);
        d5.k2 = Some(0.002);
        assert_eq!(extract_dist_params(&d5).3, 0);

        let mut pt = distortion("ptlens", 50.0);
        pt.a = Some(0.006);
        assert_eq!(extract_dist_params(&pt).3, 1);
    }

    #[test]
    fn radius_scale_carries_aspect_and_crop() {
        let mut lens = Lens {
            maker: Vec::new(),
            model: Vec::new(),
            mount: Vec::new(),
            cropfactor: Some(1.0),
            calibration: None,
            type_: None,
            focal: None,
            aspect_ratio: None,
            center: None,
            compat: None,
            notes: None,
            aperture: None,
        };

        // A lens calibrated and used on the same sensor: aspect only.
        let same = distortion_radius_scale(&lens, Some(1.0));
        assert!((same - 1.5f64.hypot(1.0)).abs() < 1e-9, "{}", same);

        // A full frame lens on APS-C shrinks the radius. The crop factor is
        // stored as f32, so the expected value uses the same type.
        let crop = distortion_radius_scale(&lens, Some(1.613));
        let expected = 1.5f64.hypot(1.0) / (1.613f32 as f64);
        assert!(
            (crop - expected).abs() < 1e-12,
            "{} instead of {}",
            crop,
            expected
        );

        // Without a camera the lens crop factor is used, so the ratio is 1.
        lens.cropfactor = Some(2.73);
        let none = distortion_radius_scale(&lens, None);
        assert!((none - 1.5f64.hypot(1.0)).abs() < 1e-9, "{}", none);
    }

    /// Cross check of two independent measurements of the same lens.
    ///
    /// The Lensfun profile `Leica / DMC-LX10 & compatibles (Standard)` at
    /// 8.8 mm and the values that a Panasonic DMC-LX15 writes into its RW2
    /// file describe the same lens. Evaluated correctly, both agree.
    #[test]
    fn lensfun_matches_the_embedded_panasonic_data() {
        let a = 0.0340763561797834;
        let b = -0.112939517866333;
        let c = -0.00478327940864424;
        let (k1, k2, k3, model) = rescale_dist_params(a, b, c, 1);
        assert_eq!(model, 1);

        // Camera and calibration share the crop factor 2.73, so the scale is
        // the aspect term only.
        let scale = 1.5f64.hypot(1.0);

        // Panasonic, tag 0x0119: a, b, c and the scale from the RW2 file.
        let (pa, pb, pc) = (0.2809448, -0.0426331, -0.00067138);
        let forward = |rd: f64| rd + pa * rd.powi(3) + pb * rd.powi(5) + pc * rd.powi(7);
        let solve = |ru: f64| {
            let mut rd = ru;
            for _ in 0..40 {
                let g = forward(rd) - ru;
                let gp =
                    1.0 + 3.0 * pa * rd.powi(2) + 5.0 * pb * rd.powi(4) + 7.0 * pc * rd.powi(6);
                rd -= g / gp;
            }
            rd
        };

        for step in 1..=10 {
            let r = step as f64 / 10.0;
            let t = r * scale;
            let lensfun = 1.0 + k1 * t + k2 * t * t + k3 * t * t * t;
            let panasonic = solve(r) / r;
            let error = (lensfun / panasonic - 1.0).abs();
            assert!(
                error < 0.002,
                "r = {}: lensfun {}, panasonic {}, error {:.4} %",
                r,
                lensfun,
                panasonic,
                error * 100.0
            );
        }
    }

    /// A full frame lens on a crop body, mounted through an adapter.
    ///
    /// A Canon EF 50mm f/1.8 STM on a Canon EOS M6 Mark II sits on the
    /// EF-EOS M adapter. Lensfun holds two entries for this lens. The entry
    /// at crop factor 1.0 carries the distortion and the TCA, the entry at
    /// 1.613 carries the vignetting only. Each correction type has to come
    /// from the entry that holds it, and the radius scale has to follow the
    /// entry that provided the distortion.
    #[test]
    fn adapted_lens_keeps_the_distortion_of_the_full_frame_entry() {
        let xml = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/lensfun_db/slr-canon.xml"
        ))
        .expect("slr-canon.xml is part of the bundled database");
        let db: LensDatabase = quick_xml::de::from_str(&xml).expect("slr-canon.xml parses");

        let maker = "Canon";
        let maker_lenses = lenses_for_maker(&db, maker);
        let entries: Vec<&&Lens> = maker_lenses
            .iter()
            .filter(|l| l.get_canonical_model_name() == "Canon EF 50mm f/1.8 STM")
            .collect();
        assert_eq!(entries.len(), 2, "the lens has two calibration entries");

        let full_frame = entries
            .iter()
            .find(|l| l.cropfactor == Some(1.0))
            .expect("entry at crop 1.0");
        let aps_c = entries
            .iter()
            .find(|l| l.cropfactor == Some(1.613))
            .expect("entry at crop 1.613");

        assert!(full_frame.has_distortion_data());
        assert!(
            !aps_c.has_distortion_data(),
            "the entry that matches the sensor holds vignetting only"
        );
        assert!(aps_c.has_vignetting_data());

        // The camera crop factor comes from the Lensfun camera entry of the
        // Canon EOS M6 Mark II.
        let camera_crop = 1.613f32;
        let model = aps_c.get_display_name(&maker_lenses);
        let params =
            resolve_lens_params(&db, maker, &model, 50.0, Some(1.8), None, Some(camera_crop))
                .expect("the adapted lens resolves to a profile");

        // The distortion survives, although the entry for this sensor has none.
        // The database stores the terms as f32, so the expected values have
        // to pass through the same type.
        let (k1, k2, k3, dist_model) = rescale_dist_params(
            0.0061844f32 as f64,
            -0.0313122f32 as f64,
            0.0314815f32 as f64,
            1,
        );
        assert_eq!(params.model, dist_model);
        assert!(
            (params.k1 - k1).abs() < 1e-12,
            "k1 {} instead of {}",
            params.k1,
            k1
        );
        assert!(
            (params.k2 - k2).abs() < 1e-12,
            "k2 {} instead of {}",
            params.k2,
            k2
        );
        assert!(
            (params.k3 - k3).abs() < 1e-12,
            "k3 {} instead of {}",
            params.k3,
            k3
        );

        // The radius scale carries the crop factor of the distortion entry,
        // not the one of the entry that matched the sensor.
        let expected_scale = 1.5f64.hypot(1.0) / (camera_crop as f64);
        assert!(
            (params.radius_scale - expected_scale).abs() < 1e-9,
            "radius scale {} instead of {}",
            params.radius_scale,
            expected_scale
        );

        // The vignetting still comes from the entry that matches the sensor.
        // The full frame entry would give -1.5829 at f/1.8.
        assert!(
            (params.vig_k1 - -0.7811).abs() < 1e-6,
            "vignetting k1 {} is not the APS-C value",
            params.vig_k1
        );

        // The TCA comes from the full frame entry as well.
        assert!((params.tca_vr - 1.0000409).abs() < 1e-6);
        assert!((params.tca_vb - 0.9999893).abs() < 1e-6);
    }
}
