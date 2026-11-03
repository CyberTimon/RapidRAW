use std::collections::HashMap;

const MIN_FOCAL_MM_35EQ: f64 = 8.0;
const MAX_FOCAL_MM_35EQ: f64 = 400.0;

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

pub fn parse_focal_mm_35eq(exif: &HashMap<String, String>) -> Option<f64> {
    ["FocalLengthIn35mmFilm", "FocalLength"]
        .iter()
        .find_map(|k| {
            exif.get(*k)
                .and_then(|s| parse_mm(s))
                .and_then(sanitize_focal_mm_35eq)
        })
}
