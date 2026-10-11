use std::collections::HashMap;

const DEFAULT_FOCAL_MM_35EQ: f64 = 50.0;
const MIN_FOCAL_MM_35EQ: f64 = 8.0;
const MAX_FOCAL_MM_35EQ: f64 = 400.0;
const SENSOR_WIDTH_35MM: f64 = 36.0;

pub fn fov_rad_from_focal_mm_35eq(focal_mm: f64) -> f64 {
    let f = if focal_mm > 1e-3 {
        focal_mm
    } else {
        DEFAULT_FOCAL_MM_35EQ
    };
    2.0 * (SENSOR_WIDTH_35MM / (2.0 * f)).atan()
}

pub fn focal_px_from_fov(fov_rad: f64, width: u32) -> f64 {
    (width as f64 * 0.5) / (fov_rad * 0.5).tan()
}

fn parse_mm(s: &str) -> Option<f64> {
    let cleaned = s.replace(" mm", "").replace("mm", "").trim().to_string();
    if cleaned.contains('/') {
        let parts: Vec<&str> = cleaned.split('/').collect();
        if parts.len() == 2 {
            let n = parts[0].trim().parse::<f64>().ok()?;
            let d = parts[1].trim().parse::<f64>().ok()?;
            if d.abs() > 1e-9 {
                return Some(n / d);
            }
        }
        return None;
    }
    cleaned.parse::<f64>().ok()
}

fn sanitize_focal_mm_35eq(v: f64) -> Option<f64> {
    if v.is_finite() && (MIN_FOCAL_MM_35EQ..=MAX_FOCAL_MM_35EQ).contains(&v) {
        Some(v)
    } else {
        None
    }
}

// Reads a 35mm-equivalent focal length from the photo.
pub fn parse_focal_mm_35eq(exif: &HashMap<String, String>) -> f64 {
    let fl = exif.get("FocalLength").and_then(|s| parse_mm(s));
    let fl35 = exif
        .get("FocalLengthIn35mmFilm")
        .and_then(|s| parse_mm(s))
        .and_then(sanitize_focal_mm_35eq);
    let scale = exif
        .get("ScaleFactor35efl")
        .or_else(|| exif.get("ScaleFactor35Efl"))
        .and_then(|s| parse_mm(s))
        .filter(|s| *s > 0.5 && *s < 10.0);
    let candidate = match (fl, fl35) {
        (Some(a), Some(b)) if (a - b).abs() >= 0.05 => Some(b),
        (_, Some(b)) => {
            if let Some(a) = fl {
                if (a - b).abs() < 0.05 {
                    if let Some(s) = scale {
                        sanitize_focal_mm_35eq(a * s)
                    } else if a < 24.0 {
                        sanitize_focal_mm_35eq(a * 1.5)
                    } else {
                        sanitize_focal_mm_35eq(a)
                    }
                } else {
                    Some(b)
                }
            } else {
                Some(b)
            }
        }
        (Some(a), None) => {
            if let Some(s) = scale {
                sanitize_focal_mm_35eq(a * s)
            } else {
                sanitize_focal_mm_35eq(a)
            }
        }
        _ => None,
    };
    candidate
        .and_then(sanitize_focal_mm_35eq)
        .unwrap_or(DEFAULT_FOCAL_MM_35EQ)
}
