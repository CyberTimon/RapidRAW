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

#[derive(Serialize)]
pub struct LensDistortionParams {
    k1: f64,
    k2: f64,
    k3: f64,
    model: u32,
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

        Some(LensDistortionParams {
            k1,
            k2,
            k3,
            model,
            tca_vr,
            tca_vb,
            vig_k1,
            vig_k2,
            vig_k3,
        })
    }
}

fn extract_dist_params(dist: &Distortion) -> (f64, f64, f64, u32) {
    match dist.model.as_str() {
        "poly3" | "poly5" => (
            dist.k1.unwrap_or(0.0) as f64,
            dist.k2.unwrap_or(0.0) as f64,
            dist.k3.unwrap_or(0.0) as f64,
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

    inject_builtin_lenses(&mut combined_db);

    log::info!(
        "Loaded {} lenses and {} cameras from Lensfun database.",
        combined_db.lenses.len(),
        combined_db.cameras.len()
    );
    combined_db
}

fn inject_builtin_lenses(db: &mut LensDatabase) {
    let mut custom_lenses = Vec::new();

    // 1. Canon EF 70-200mm f/4L USM
    custom_lenses.push(Lens {
        maker: vec![MultiName { lang: None, value: "Canon".to_string() }],
        model: vec![MultiName { lang: None, value: "Canon EF 70-200mm f/4L USM".to_string() }],
        mount: vec!["Canon EF".to_string()],
        cropfactor: Some(1.0),
        calibration: Some(Calibration {
            elements: vec![
                CalibrationElement::Distortion(Distortion {
                    model: "poly3".to_string(), focal: 70.0, real_focal: None,
                    k1: Some(-0.008), k2: None, k3: None, a: None, b: None, c: None,
                }),
                CalibrationElement::Distortion(Distortion {
                    model: "poly3".to_string(), focal: 135.0, real_focal: None,
                    k1: Some(0.005), k2: None, k3: None, a: None, b: None, c: None,
                }),
                CalibrationElement::Distortion(Distortion {
                    model: "poly3".to_string(), focal: 200.0, real_focal: None,
                    k1: Some(0.012), k2: None, k3: None, a: None, b: None, c: None,
                }),
                CalibrationElement::Tca(Tca {
                    model: "poly3".to_string(), focal: 70.0,
                    vr: Some(1.0002), vb: Some(0.9998), cr: None, cb: None, br: None, bb: None,
                }),
                CalibrationElement::Vignetting(Vignetting {
                    model: "pa".to_string(), focal: 70.0, aperture: 4.0, distance: None,
                    k1: Some(-0.45), k2: Some(0.12), k3: None,
                }),
            ],
        }),
        type_: Some("rectilinear".to_string()),
        focal: Some(Focal { value: None, min: Some(70.0), max: Some(200.0) }),
        aspect_ratio: None, center: None, compat: None, notes: None,
        aperture: Some(Aperture { min: Some(4.0), max: Some(32.0) }),
    });

    // 2. Sigma 17-50mm f/2.8 EX DC OS HSM
    custom_lenses.push(Lens {
        maker: vec![MultiName { lang: None, value: "Sigma".to_string() }],
        model: vec![MultiName { lang: None, value: "Sigma 17-50mm f/2.8 EX DC OS HSM".to_string() }],
        mount: vec!["Canon EF-S".to_string(), "Sigma".to_string()],
        cropfactor: Some(1.6),
        calibration: Some(Calibration {
            elements: vec![
                CalibrationElement::Distortion(Distortion {
                    model: "poly3".to_string(), focal: 17.0, real_focal: None,
                    k1: Some(-0.032), k2: None, k3: None, a: None, b: None, c: None,
                }),
                CalibrationElement::Distortion(Distortion {
                    model: "poly3".to_string(), focal: 28.0, real_focal: None,
                    k1: Some(0.002), k2: None, k3: None, a: None, b: None, c: None,
                }),
                CalibrationElement::Distortion(Distortion {
                    model: "poly3".to_string(), focal: 50.0, real_focal: None,
                    k1: Some(0.014), k2: None, k3: None, a: None, b: None, c: None,
                }),
                CalibrationElement::Tca(Tca {
                    model: "poly3".to_string(), focal: 17.0,
                    vr: Some(1.0004), vb: Some(0.9995), cr: None, cb: None, br: None, bb: None,
                }),
                CalibrationElement::Vignetting(Vignetting {
                    model: "pa".to_string(), focal: 17.0, aperture: 2.8, distance: None,
                    k1: Some(-0.65), k2: Some(0.20), k3: None,
                }),
            ],
        }),
        type_: Some("rectilinear".to_string()),
        focal: Some(Focal { value: None, min: Some(17.0), max: Some(50.0) }),
        aspect_ratio: None, center: None, compat: None, notes: None,
        aperture: Some(Aperture { min: Some(2.8), max: Some(22.0) }),
    });

    // 3. Sigma 70mm f/2.8 EX DG Macro
    custom_lenses.push(Lens {
        maker: vec![MultiName { lang: None, value: "Sigma".to_string() }],
        model: vec![MultiName { lang: None, value: "Sigma 70mm f/2.8 EX DG Macro".to_string() }],
        mount: vec!["Canon EF".to_string()],
        cropfactor: Some(1.0),
        calibration: Some(Calibration {
            elements: vec![
                CalibrationElement::Distortion(Distortion {
                    model: "poly3".to_string(), focal: 70.0, real_focal: None,
                    k1: Some(0.001), k2: None, k3: None, a: None, b: None, c: None,
                }),
                CalibrationElement::Tca(Tca {
                    model: "poly3".to_string(), focal: 70.0,
                    vr: Some(1.0001), vb: Some(0.9999), cr: None, cb: None, br: None, bb: None,
                }),
                CalibrationElement::Vignetting(Vignetting {
                    model: "pa".to_string(), focal: 70.0, aperture: 2.8, distance: None,
                    k1: Some(-0.35), k2: Some(0.08), k3: None,
                }),
            ],
        }),
        type_: Some("rectilinear".to_string()),
        focal: Some(Focal { value: Some(70.0), min: Some(70.0), max: Some(70.0) }),
        aspect_ratio: None, center: None, compat: None, notes: None,
        aperture: Some(Aperture { min: Some(2.8), max: Some(22.0) }),
    });

    // 4. Helios-44-2 58mm f/2 (M42 vintage lens)
    custom_lenses.push(Lens {
        maker: vec![MultiName { lang: None, value: "KMZ / Valdai".to_string() }, MultiName { lang: None, value: "Helios".to_string() }],
        model: vec![MultiName { lang: None, value: "Helios-44-2 58mm f/2".to_string() }],
        mount: vec!["M42".to_string(), "Canon EF".to_string()],
        cropfactor: Some(1.0),
        calibration: Some(Calibration {
            elements: vec![
                CalibrationElement::Distortion(Distortion {
                    model: "poly3".to_string(), focal: 58.0, real_focal: None,
                    k1: Some(0.018), k2: None, k3: None, a: None, b: None, c: None,
                }),
                CalibrationElement::Tca(Tca {
                    model: "poly3".to_string(), focal: 58.0,
                    vr: Some(1.0006), vb: Some(0.9992), cr: None, cb: None, br: None, bb: None,
                }),
                CalibrationElement::Vignetting(Vignetting {
                    model: "pa".to_string(), focal: 58.0, aperture: 2.0, distance: None,
                    k1: Some(-0.85), k2: Some(0.35), k3: None,
                }),
            ],
        }),
        type_: Some("rectilinear".to_string()),
        focal: Some(Focal { value: Some(58.0), min: Some(58.0), max: Some(58.0) }),
        aspect_ratio: None, center: None, compat: None, notes: None,
        aperture: Some(Aperture { min: Some(2.0), max: Some(16.0) }),
    });

    // 5. MTO 1000 A 1000mm f/10 (Mirror / Catadioptric lens)
    custom_lenses.push(Lens {
        maker: vec![MultiName { lang: None, value: "KMZ".to_string() }, MultiName { lang: None, value: "MTO".to_string() }],
        model: vec![MultiName { lang: None, value: "MTO 1000 A 1000mm f/10".to_string() }],
        mount: vec!["M42".to_string(), "Canon EF".to_string()],
        cropfactor: Some(1.0),
        calibration: Some(Calibration {
            elements: vec![
                CalibrationElement::Distortion(Distortion {
                    model: "poly3".to_string(), focal: 1000.0, real_focal: None,
                    k1: Some(0.000), k2: None, k3: None, a: None, b: None, c: None,
                }),
                CalibrationElement::Vignetting(Vignetting {
                    model: "pa".to_string(), focal: 1000.0, aperture: 10.0, distance: None,
                    k1: Some(-0.75), k2: Some(0.25), k3: None,
                }),
            ],
        }),
        type_: Some("rectilinear".to_string()),
        focal: Some(Focal { value: Some(1000.0), min: Some(1000.0), max: Some(1000.0) }),
        aspect_ratio: None, center: None, compat: None, notes: None,
        aperture: Some(Aperture { min: Some(10.0), max: Some(10.0) }),
    });

    // 6. Apple iPhone 13 Back Camera
    custom_lenses.push(Lens {
        maker: vec![MultiName { lang: None, value: "Apple".to_string() }],
        model: vec![MultiName { lang: None, value: "iPhone 13 back camera 5.1mm f/1.6".to_string() }],
        mount: vec!["Apple".to_string()],
        cropfactor: Some(5.2),
        calibration: Some(Calibration {
            elements: vec![
                CalibrationElement::Distortion(Distortion {
                    model: "poly3".to_string(), focal: 5.1, real_focal: None,
                    k1: Some(-0.022), k2: None, k3: None, a: None, b: None, c: None,
                }),
            ],
        }),
        type_: Some("rectilinear".to_string()),
        focal: Some(Focal { value: Some(5.1), min: Some(5.1), max: Some(5.1) }),
        aspect_ratio: None, center: None, compat: None, notes: None,
        aperture: Some(Aperture { min: Some(1.6), max: Some(1.6) }),
    });

    // 7. Apple iPhone Xs / XR
    custom_lenses.push(Lens {
        maker: vec![MultiName { lang: None, value: "Apple".to_string() }],
        model: vec![MultiName { lang: None, value: "iPhone Xs / XR back camera 4.25mm f/1.8".to_string() }],
        mount: vec!["Apple".to_string()],
        cropfactor: Some(6.1),
        calibration: Some(Calibration {
            elements: vec![
                CalibrationElement::Distortion(Distortion {
                    model: "poly3".to_string(), focal: 4.25, real_focal: None,
                    k1: Some(-0.019), k2: None, k3: None, a: None, b: None, c: None,
                }),
            ],
        }),
        type_: Some("rectilinear".to_string()),
        focal: Some(Focal { value: Some(4.25), min: Some(4.25), max: Some(4.25) }),
        aspect_ratio: None, center: None, compat: None, notes: None,
        aperture: Some(Aperture { min: Some(1.8), max: Some(1.8) }),
    });

    // 8. Apple iPhone SE
    custom_lenses.push(Lens {
        maker: vec![MultiName { lang: None, value: "Apple".to_string() }],
        model: vec![MultiName { lang: None, value: "iPhone SE back camera 3.99mm f/1.8".to_string() }],
        mount: vec!["Apple".to_string()],
        cropfactor: Some(7.0),
        calibration: Some(Calibration {
            elements: vec![
                CalibrationElement::Distortion(Distortion {
                    model: "poly3".to_string(), focal: 3.99, real_focal: None,
                    k1: Some(-0.016), k2: None, k3: None, a: None, b: None, c: None,
                }),
            ],
        }),
        type_: Some("rectilinear".to_string()),
        focal: Some(Focal { value: Some(3.99), min: Some(3.99), max: Some(3.99) }),
        aspect_ratio: None, center: None, compat: None, notes: None,
        aperture: Some(Aperture { min: Some(1.8), max: Some(1.8) }),
    });

    for custom_lens in custom_lenses {
        let maker = custom_lens.get_maker();
        let name = custom_lens.get_full_model_name();
        if !db.lenses.iter().any(|l| l.get_maker() == maker && l.get_full_model_name() == name) {
            db.lenses.push(custom_lens);
        }
    }
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

pub fn find_best_lens_match(
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
    state: tauri::State<AppState>,
) -> Result<Option<(String, String)>, String> {
    let db_guard = state
        .lens_db
        .lock()
        .map_err(|e| format!("Lock poisoned: {}", e))?;
    if let Some(db) = &*db_guard {
        Ok(find_best_lens_match(db, &maker, &model))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn get_lens_distortion_params(
    maker: String,
    model: String,
    focal_length: f32,
    aperture: Option<f32>,
    distance: Option<f32>,
    state: State<AppState>,
) -> Result<Option<LensDistortionParams>, String> {
    let db_guard = state
        .lens_db
        .lock()
        .map_err(|e| format!("Lock poisoned: {}", e))?;
    if let Some(db) = &*db_guard {
        let maker_lenses = lenses_for_maker(db, &maker);

        if let Some(lens) = maker_lenses
            .iter()
            .find(|l| l.get_display_name(&maker_lenses) == model)
        {
            return Ok(lens.get_distortion_params(focal_length, aperture, distance));
        }
    }
    Ok(None)
}

pub fn resolve_lens_params(
    db: &LensDatabase,
    maker: &str,
    model: &str,
    focal_length: f32,
    aperture: Option<f32>,
    distance: Option<f32>,
) -> Option<LensDistortionParams> {
    let maker_lenses = lenses_for_maker(db, maker);
    if let Some(lens) = maker_lenses
        .iter()
        .find(|l| l.get_display_name(&maker_lenses) == model)
    {
        lens.get_distortion_params(focal_length, aperture, distance)
    } else {
        None
    }
}
