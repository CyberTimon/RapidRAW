use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GuideOrientation {
    Vertical,
    Horizontal,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
pub struct GuidePoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GuideLine {
    pub id: String,
    #[serde(rename = "type")]
    pub orientation: GuideOrientation,
    pub p1: GuidePoint,
    pub p2: GuidePoint,
}

/// Result of the solve. `forward_h` per Contract D2 (row-major 3x3, f64,
/// centered pixel coords of the width/height passed in).
/// `debug_vp` = [vertical, horizontal]: Some([x, y]) is the finite vanishing point in
/// centered pixel coords; None when that axis had < 2 usable lines or its VP is at
/// infinity.
#[derive(Debug, Clone)]
pub struct GuidedResult {
    pub forward_h: [[f64; 3]; 3],
    pub debug_vp: [Option<[f64; 2]>; 2],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuidedResultJson {
    /// row-major 3x3 flattened (row 0, 1, 2); centered pixel coords — Contract D2
    pub forward_h: [f64; 9],
    pub crop: [f64; 4],
    pub valid: bool,
    pub debug_vp: [Option<[f64; 2]>; 2],
}

const EPS_INF: f64 = 1e-9;
const EPS_DEG: f64 = 1e-9;

fn unit_norm(v: [f64; 3]) -> [f64; 3] {
    let n = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if n < EPS_INF {
        v
    } else {
        [v[0] / n, v[1] / n, v[2] / n]
    }
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn matmul(a: &[[f64; 3]; 3], b: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut out = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    out
}

fn hom_mul(h: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    [
        h[0][0] * v[0] + h[0][1] * v[1] + h[0][2] * v[2],
        h[1][0] * v[0] + h[1][1] * v[1] + h[1][2] * v[2],
        h[2][0] * v[0] + h[2][1] * v[1] + h[2][2] * v[2],
    ]
}

fn project_h(h: &[[f64; 3]; 3], x: f64, y: f64) -> Option<(f64, f64)> {
    let w = h[2][0] * x + h[2][1] * y + h[2][2];
    if w.abs() < 1e-6 {
        return None;
    }
    Some((
        (h[0][0] * x + h[0][1] * y + h[0][2]) / w,
        (h[1][0] * x + h[1][1] * y + h[1][2]) / w,
    ))
}

fn rotation(theta: f64) -> [[f64; 3]; 3] {
    let (s, c) = theta.sin_cos();
    [[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]]
}

fn det3(h: &[[f64; 3]; 3]) -> f64 {
    h[0][0] * (h[1][1] * h[2][2] - h[1][2] * h[2][1])
        - h[0][1] * (h[1][0] * h[2][2] - h[1][2] * h[2][0])
        + h[0][2] * (h[1][0] * h[2][1] - h[1][1] * h[2][0])
}

fn uv_to_centered(p: GuidePoint, width: f64, height: f64) -> (f64, f64) {
    (p.x * width - width / 2.0, p.y * height - height / 2.0)
}

fn line_centered(line: &GuideLine, width: f64, height: f64) -> ((f64, f64), (f64, f64)) {
    (
        uv_to_centered(line.p1, width, height),
        uv_to_centered(line.p2, width, height),
    )
}

fn is_line_valid(line: &GuideLine, width: f64, height: f64) -> bool {
    let ((x1, y1), (x2, y2)) = line_centered(line, width, height);
    let dx = x2 - x1;
    let dy = y2 - y1;
    let length = dx.hypot(dy);
    let min_len = 0.02 * width.hypot(height);
    if length < min_len {
        return false;
    }
    let tan_35 = 35.0_f64.to_radians().tan();
    match line.orientation {
        GuideOrientation::Vertical => dx.abs() <= dy.abs() * tan_35,
        GuideOrientation::Horizontal => dy.abs() <= dx.abs() * tan_35,
    }
}

fn filter_valid_lines(
    lines: &[GuideLine],
    width: f64,
    height: f64,
) -> (Vec<GuideLine>, Vec<GuideLine>) {
    let mut verts = Vec::new();
    let mut hors = Vec::new();
    for line in lines {
        if !is_line_valid(line, width, height) {
            continue;
        }
        match line.orientation {
            GuideOrientation::Vertical if verts.len() < 2 => verts.push(line.clone()),
            GuideOrientation::Horizontal if hors.len() < 2 => hors.push(line.clone()),
            _ => {}
        }
    }
    (verts, hors)
}

/// Number of individually valid lines (used by is_geometry_identity and the warp
/// gate in Task 03).
pub fn count_valid_lines(lines: &[GuideLine], width: f64, height: f64) -> usize {
    let (verts, hors) = filter_valid_lines(lines, width, height);
    verts.len() + hors.len()
}

fn vanishing_point(l1: &GuideLine, l2: &GuideLine, width: f64, height: f64) -> ([f64; 3], Option<[f64; 2]>) {
    let (p1, p2) = line_centered(l1, width, height);
    let (q1, q2) = line_centered(l2, width, height);
    let l1h = unit_norm(cross([p1.0, p1.1, 1.0], [p2.0, p2.1, 1.0]));
    let l2h = unit_norm(cross([q1.0, q1.1, 1.0], [q2.0, q2.1, 1.0]));
    let v = unit_norm(cross(l1h, l2h));
    let q = if v[2].abs() >= EPS_INF {
        Some([v[0] / v[2], v[1] / v[2]])
    } else {
        None
    };
    (v, q)
}

fn primary_vertical(v: [f64; 3], q_opt: Option<[f64; 2]>, height: f64) -> Option<[[f64; 3]; 3]> {
    if let Some(mut q) = q_opt {
        if q[1] < 0.0 {
            q = [-q[0], -q[1]];
        }
        let theta = q[0].atan2(q[1]);
        let r = rotation(theta);
        let d = q[0].hypot(q[1]);
        if d <= 0.6 * height {
            return None;
        }
        let p = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, -1.0 / d, 1.0]];
        Some(matmul(&p, &r))
    } else {
        let mut dx = v[0];
        let mut dy = v[1];
        if dy < 0.0 {
            dx = -dx;
            dy = -dy;
        }
        Some(rotation(dx.atan2(dy)))
    }
}

fn primary_horizontal(v: [f64; 3], q_opt: Option<[f64; 2]>, width: f64) -> Option<[[f64; 3]; 3]> {
    if let Some(mut q) = q_opt {
        if q[0] < 0.0 {
            q = [-q[0], -q[1]];
        }
        let theta = -q[1].atan2(q[0]);
        let r = rotation(theta);
        let d = q[0].hypot(q[1]);
        if d <= 0.6 * width {
            return None;
        }
        let p = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [-1.0 / d, 0.0, 1.0]];
        Some(matmul(&p, &r))
    } else {
        let mut dx = v[0];
        let mut dy = v[1];
        if dx < 0.0 {
            dx = -dx;
            dy = -dy;
        }
        Some(rotation(-dy.atan2(dx)))
    }
}

fn secondary_two_horizontal(h_p: &[[f64; 3]; 3], v: [f64; 3], width: f64) -> Option<[[f64; 3]; 3]> {
    let vp = unit_norm(hom_mul(h_p, v));
    if vp[2].abs() >= EPS_INF {
        let qx = vp[0] / vp[2];
        let qy = vp[1] / vp[2];
        let e = qx;
        if e.abs() <= 0.6 * width {
            return None;
        }
        if qx.abs() < EPS_DEG {
            return None;
        }
        let k = -qy / qx;
        let keystone = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [-1.0 / e, 0.0, 1.0]];
        let shear = [[1.0, 0.0, 0.0], [k, 1.0, 0.0], [0.0, 0.0, 1.0]];
        Some(matmul(&shear, &matmul(&keystone, h_p)))
    } else {
        if vp[0].abs() < EPS_DEG {
            return None;
        }
        let k = -vp[1] / vp[0];
        let shear = [[1.0, 0.0, 0.0], [k, 1.0, 0.0], [0.0, 0.0, 1.0]];
        Some(matmul(&shear, h_p))
    }
}

fn secondary_one_line(
    h: &[[f64; 3]; 3],
    line: &GuideLine,
    is_vertical: bool,
    width: f64,
    height: f64,
) -> [[f64; 3]; 3] {
    let (p1, p2) = line_centered(line, width, height);
    let Some((x1, y1)) = project_h(h, p1.0, p1.1) else {
        return *h;
    };
    let Some((x2, y2)) = project_h(h, p2.0, p2.1) else {
        return *h;
    };
    let dx = x2 - x1;
    let dy = y2 - y1;
    if is_vertical {
        if dy.abs() < EPS_DEG {
            return *h;
        }
        let k = -dx / dy;
        let shear = [[1.0, k, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        matmul(&shear, h)
    } else {
        if dx.abs() < EPS_DEG {
            return *h;
        }
        let k = -dy / dx;
        let shear = [[1.0, 0.0, 0.0], [k, 1.0, 0.0], [0.0, 0.0, 1.0]];
        matmul(&shear, h)
    }
}

fn solve_1v1h(vert: &GuideLine, hor: &GuideLine, width: f64, height: f64) -> Option<[[f64; 3]; 3]> {
    let (hp1, hp2) = line_centered(hor, width, height);
    let mut dx = hp2.0 - hp1.0;
    let mut dy = hp2.1 - hp1.1;
    if dx < 0.0 {
        dx = -dx;
        dy = -dy;
    }
    let theta = -dy.atan2(dx);
    let r = rotation(theta);
    Some(secondary_one_line(&r, vert, true, width, height))
}

fn quad_ok(pts: &[(f64, f64); 4]) -> bool {
    let mut sign = 0.0;
    for i in 0..4 {
        let (x0, y0) = pts[i];
        let (x1, y1) = pts[(i + 1) % 4];
        let (x2, y2) = pts[(i + 2) % 4];
        let c = (x1 - x0) * (y2 - y1) - (y1 - y0) * (x2 - x1);
        if c.abs() < 1e-12 {
            continue;
        }
        let s = c.signum();
        if sign == 0.0 {
            sign = s;
        } else if s != sign {
            return false;
        }
    }
    sign > 0.0
}

fn finalize_h(mut h: [[f64; 3]; 3], width: f64, height: f64) -> Option<[[f64; 3]; 3]> {
    let scale = h[2][2];
    if scale.abs() > 1e-15 {
        for row in &mut h {
            for v in row {
                *v /= scale;
            }
        }
    }
    debug_assert!((h[2][2] - 1.0).abs() < 1e-6);
    if det3(&h).abs() < 1e-9 {
        return None;
    }
    let hw = width / 2.0;
    let hh = height / 2.0;
    let src = [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)];
    let mut dest = [(0.0, 0.0); 4];
    for (i, (x, y)) in src.iter().enumerate() {
        let w = h[2][0] * x + h[2][1] * y + h[2][2];
        if w.abs() < 1e-6 {
            return None;
        }
        dest[i] = (
            (h[0][0] * x + h[0][1] * y + h[0][2]) / w,
            (h[1][0] * x + h[1][1] * y + h[1][2]) / w,
        );
    }
    if !quad_ok(&dest) {
        return None;
    }
    Some(h)
}

pub fn compute_guided_homography(
    lines: &[GuideLine],
    width: f64,
    height: f64,
) -> Option<GuidedResult> {
    // Per-line validation, vanishing points, primary/secondary composition, final guards.
    let (verts, hors) = filter_valid_lines(lines, width, height);
    if verts.len() + hors.len() < 2 {
        return None;
    }

    let mut debug_vp = [None, None];
    let v_vp = if verts.len() == 2 {
        Some(vanishing_point(&verts[0], &verts[1], width, height))
    } else {
        None
    };
    let h_vp = if hors.len() == 2 {
        Some(vanishing_point(&hors[0], &hors[1], width, height))
    } else {
        None
    };
    if let Some((_, q)) = v_vp {
        debug_vp[0] = q;
    }
    if let Some((_, q)) = h_vp {
        debug_vp[1] = q;
    }

    let h = if verts.len() == 2 {
        let (v, q) = v_vp.unwrap();
        let mut hp = primary_vertical(v, q, height)?;
        if hors.len() == 2 {
            let (vh, _) = h_vp.unwrap();
            hp = secondary_two_horizontal(&hp, vh, width)?;
        } else if hors.len() == 1 {
            hp = secondary_one_line(&hp, &hors[0], false, width, height);
        }
        hp
    } else if hors.len() == 2 {
        let (v, q) = h_vp.unwrap();
        let mut hp = primary_horizontal(v, q, width)?;
        if verts.len() == 1 {
            hp = secondary_one_line(&hp, &verts[0], true, width, height);
        }
        hp
    } else {
        solve_1v1h(&verts[0], &hors[0], width, height)?
    };

    let forward_h = finalize_h(h, width, height)?;
    Some(GuidedResult {
        forward_h,
        debug_vp,
    })
}

fn clip_poly_edge(
    poly: &[(f64, f64)],
    inside: impl Fn(f64, f64) -> bool,
    intersect: impl Fn((f64, f64), (f64, f64)) -> (f64, f64),
) -> Vec<(f64, f64)> {
    if poly.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut prev = poly[poly.len() - 1];
    let mut prev_in = inside(prev.0, prev.1);
    for &curr in poly {
        let curr_in = inside(curr.0, curr.1);
        if curr_in {
            if !prev_in {
                out.push(intersect(prev, curr));
            }
            out.push(curr);
        } else if prev_in {
            out.push(intersect(prev, curr));
        }
        prev = curr;
        prev_in = curr_in;
    }
    out
}

fn sutherland_hodgman_unit_square(poly: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let mut p = poly.to_vec();
    p = clip_poly_edge(&p, |x, _| x >= 0.0, |a, b| {
        let t = (0.0 - a.0) / (b.0 - a.0);
        (0.0, a.1 + t * (b.1 - a.1))
    });
    p = clip_poly_edge(&p, |x, _| x <= 1.0, |a, b| {
        let t = (1.0 - a.0) / (b.0 - a.0);
        (1.0, a.1 + t * (b.1 - a.1))
    });
    p = clip_poly_edge(&p, |_, y| y >= 0.0, |a, b| {
        let t = (0.0 - a.1) / (b.1 - a.1);
        (a.0 + t * (b.0 - a.0), 0.0)
    });
    p = clip_poly_edge(&p, |_, y| y <= 1.0, |a, b| {
        let t = (1.0 - a.1) / (b.1 - a.1);
        (a.0 + t * (b.0 - a.0), 1.0)
    });
    p
}

fn x_bounds_at(poly: &[(f64, f64)], y: f64) -> Option<(f64, f64)> {
    let mut xs = Vec::new();
    let n = poly.len();
    for i in 0..n {
        let (x1, y1) = poly[i];
        let (x2, y2) = poly[(i + 1) % n];
        let dy = y2 - y1;
        if dy.abs() <= 1e-15 {
            if (y1 - y).abs() < 1e-12 {
                xs.push(x1);
                xs.push(x2);
            }
            continue;
        }
        let t = (y - y1) / dy;
        if (-1e-9..=1.0 + 1e-9).contains(&t) {
            xs.push(x1 + t * (x2 - x1));
        }
    }
    if xs.is_empty() {
        return None;
    }
    let x_l = xs.iter().cloned().fold(f64::INFINITY, f64::min);
    let x_r = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    if x_r <= x_l {
        None
    } else {
        Some((x_l, x_r))
    }
}

fn slab_rect(poly: &[(f64, f64)], y1: f64, y2: f64) -> Option<[f64; 4]> {
    let (l1, r1) = x_bounds_at(poly, y1)?;
    let (l2, r2) = x_bounds_at(poly, y2)?;
    let x1 = l1.max(l2);
    let x2 = r1.min(r2);
    if x2 <= x1 || y2 <= y1 {
        return None;
    }
    Some([x1, y1, x2 - x1, y2 - y1])
}

/// Largest axis-aligned rectangle fully inside (warped quad ∩ image bounds).
/// Returns normalized [x, y, w, h] (fractions of width/height). Scale-covariant:
/// the same normalized result regardless of which resolution's dims were used.
pub fn compute_max_inscribed_crop(forward_h: &[[f64; 3]; 3], width: f64, height: f64) -> [f64; 4] {
    let hw = width / 2.0;
    let hh = height / 2.0;
    let src = [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)];
    let mut quad = Vec::with_capacity(4);
    for (x, y) in src {
        let w = forward_h[2][0] * x + forward_h[2][1] * y + forward_h[2][2];
        if w.abs() < 1e-6 {
            return [0.0, 0.0, 1.0, 1.0];
        }
        let px = (forward_h[0][0] * x + forward_h[0][1] * y + forward_h[0][2]) / w;
        let py = (forward_h[1][0] * x + forward_h[1][1] * y + forward_h[1][2]) / w;
        quad.push(((px + hw) / width, (py + hh) / height));
    }
    let poly = sutherland_hodgman_unit_square(&quad);
    if poly.len() < 3 {
        return [0.0, 0.0, 1.0, 1.0];
    }

    let y_min = poly.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
    let y_max = poly.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);
    if y_max - y_min < 1e-12 {
        return [0.0, 0.0, 1.0, 1.0];
    }

    const SAMPLES: usize = 96;
    let mut best = [0.0, 0.0, 1.0, 1.0];
    let mut best_area = 0.0;
    let mut best_i = 0usize;
    let mut best_j = 1usize;
    for i in 0..SAMPLES {
        for j in (i + 1)..SAMPLES {
            let y1 = y_min + (y_max - y_min) * (i as f64) / ((SAMPLES - 1) as f64);
            let y2 = y_min + (y_max - y_min) * (j as f64) / ((SAMPLES - 1) as f64);
            if let Some(rect) = slab_rect(&poly, y1, y2) {
                let area = rect[2] * rect[3];
                if area > best_area {
                    best_area = area;
                    best = rect;
                    best_i = i;
                    best_j = j;
                }
            }
        }
    }

    let step = (y_max - y_min) / ((SAMPLES - 1) as f64);
    let mut y1 = y_min + step * (best_i as f64);
    let mut y2 = y_min + step * (best_j as f64);
    let mut half = step;
    for _ in 0..6 {
        half *= 0.5;
        for (dy1, dy2) in [
            (-half, 0.0),
            (half, 0.0),
            (0.0, -half),
            (0.0, half),
            (-half, -half),
            (-half, half),
            (half, -half),
            (half, half),
        ] {
            let ny1 = (y1 + dy1).clamp(y_min, y_max);
            let ny2 = (y2 + dy2).clamp(y_min, y_max);
            if ny2 <= ny1 {
                continue;
            }
            if let Some(rect) = slab_rect(&poly, ny1, ny2) {
                let area = rect[2] * rect[3];
                if area > best_area {
                    best_area = area;
                    best = rect;
                    y1 = ny1;
                    y2 = ny2;
                }
            }
        }
    }

    let _ = best_area;
    best
}

fn flatten_row_major(h: &[[f64; 3]; 3]) -> [f64; 9] {
    [
        h[0][0], h[0][1], h[0][2], h[1][0], h[1][1], h[1][2], h[2][0], h[2][1], h[2][2],
    ]
}

#[tauri::command]
pub fn calculate_guided_perspective(
    lines: Vec<GuideLine>,
    width: f64,
    height: f64,
) -> GuidedResultJson {
    match compute_guided_homography(&lines, width, height) {
        Some(result) => GuidedResultJson {
            forward_h: flatten_row_major(&result.forward_h),
            crop: compute_max_inscribed_crop(&result.forward_h, width, height),
            valid: true,
            debug_vp: result.debug_vp,
        },
        None => GuidedResultJson {
            forward_h: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            crop: [0.0, 0.0, 1.0, 1.0],
            valid: false,
            debug_vp: [None, None],
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn invert3(h: &[[f64; 3]; 3]) -> Option<[[f64; 3]; 3]> {
        let det = det3(h);
        if det.abs() < 1e-15 {
            return None;
        }
        let a = h[0][0];
        let b = h[0][1];
        let c = h[0][2];
        let d = h[1][0];
        let e = h[1][1];
        let f = h[1][2];
        let g = h[2][0];
        let hh = h[2][1];
        let i = h[2][2];
        let inv_det = 1.0 / det;
        Some([
            [
                (e * i - f * hh) * inv_det,
                (c * hh - b * i) * inv_det,
                (b * f - c * e) * inv_det,
            ],
            [
                (f * g - d * i) * inv_det,
                (a * i - c * g) * inv_det,
                (c * d - a * f) * inv_det,
            ],
            [
                (d * hh - e * g) * inv_det,
                (b * g - a * hh) * inv_det,
                (a * e - b * d) * inv_det,
            ],
        ])
    }

    fn centered_to_uv(x: f64, y: f64, w: f64, h: f64) -> GuidePoint {
        GuidePoint {
            x: (x + w / 2.0) / w,
            y: (y + h / 2.0) / h,
        }
    }

    fn make_line(id: &str, orientation: GuideOrientation, p1: GuidePoint, p2: GuidePoint) -> GuideLine {
        GuideLine {
            id: id.to_string(),
            orientation,
            p1,
            p2,
        }
    }

    fn map_centered(h: &[[f64; 3]; 3], x: f64, y: f64) -> (f64, f64) {
        project_h(h, x, y).expect("projection")
    }

    fn point_in_convex(pt: (f64, f64), poly: &[(f64, f64)]) -> bool {
        let n = poly.len();
        if n < 3 {
            return false;
        }
        let mut sign = 0.0;
        for i in 0..n {
            let (x0, y0) = poly[i];
            let (x1, y1) = poly[(i + 1) % n];
            let c = (x1 - x0) * (pt.1 - y0) - (y1 - y0) * (pt.0 - x0);
            if c.abs() < 1e-9 {
                continue;
            }
            let s = c.signum();
            if sign == 0.0 {
                sign = s;
            } else if s != sign {
                return false;
            }
        }
        true
    }

    fn warped_quad_normalized(h: &[[f64; 3]; 3], width: f64, height: f64) -> Vec<(f64, f64)> {
        let hw = width / 2.0;
        let hh = height / 2.0;
        [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]
            .into_iter()
            .map(|(x, y)| {
                let (px, py) = map_centered(h, x, y);
                ((px + hw) / width, (py + hh) / height)
            })
            .collect()
    }

    #[test]
    fn synthetic_2v2h_recovers_axes() {
        let w = 2000.0;
        let h = 1500.0;
        let theta = 2.0_f64.to_radians();
        let r = rotation(theta);
        let d = 8.0 * h;
        let p = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, -1.0 / d, 1.0]];
        let h_true = matmul(&p, &r);
        let h_inv = invert3(&h_true).unwrap();

        let dest_segs = [
            ((-0.25 * w, -0.35 * h), (-0.25 * w, 0.35 * h), GuideOrientation::Vertical, "v1"),
            ((0.25 * w, -0.35 * h), (0.25 * w, 0.35 * h), GuideOrientation::Vertical, "v2"),
            ((-0.35 * w, -0.25 * h), (0.35 * w, -0.25 * h), GuideOrientation::Horizontal, "h1"),
            ((-0.35 * w, 0.25 * h), (0.35 * w, 0.25 * h), GuideOrientation::Horizontal, "h2"),
        ];
        let mut lines = Vec::new();
        let mut src_segs = Vec::new();
        for (p1, p2, ori, id) in dest_segs {
            let s1 = map_centered(&h_inv, p1.0, p1.1);
            let s2 = map_centered(&h_inv, p2.0, p2.1);
            src_segs.push((s1, s2));
            lines.push(make_line(
                id,
                ori,
                centered_to_uv(s1.0, s1.1, w, h),
                centered_to_uv(s2.0, s2.1, w, h),
            ));
        }

        let result = compute_guided_homography(&lines, w, h).expect("2V2H should solve");
        for (s1, s2) in src_segs {
            let a = map_centered(&result.forward_h, s1.0, s1.1);
            let b = map_centered(&result.forward_h, s2.0, s2.1);
            let dx = (b.0 - a.0).abs();
            let dy = (b.1 - a.1).abs();
            let aligned = dx.min(dy);
            assert!(
                aligned < 0.005,
                "segment not axis-aligned: dx={dx} dy={dy}"
            );
        }
        assert!(det3(&result.forward_h).abs() > 1e-6);
    }

    #[test]
    fn two_vertical_converging() {
        let w = 2000.0;
        let h = 1500.0;
        let lines = [
            make_line(
                "v1",
                GuideOrientation::Vertical,
                centered_to_uv(-0.22 * w, -0.4 * h, w, h),
                centered_to_uv(-0.10 * w, 0.4 * h, w, h),
            ),
            make_line(
                "v2",
                GuideOrientation::Vertical,
                centered_to_uv(0.22 * w, -0.4 * h, w, h),
                centered_to_uv(0.10 * w, 0.4 * h, w, h),
            ),
        ];
        let result = compute_guided_homography(&lines, w, h).expect("2V should solve");
        for line in &lines {
            let (p1, p2) = line_centered(line, w, h);
            let a = map_centered(&result.forward_h, p1.0, p1.1);
            let b = map_centered(&result.forward_h, p2.0, p2.1);
            assert!((b.0 - a.0).abs() < 0.05, "vertical not aligned: {:?}", (a, b));
            assert!(a.0.is_finite() && a.1.is_finite() && b.0.is_finite() && b.1.is_finite());
        }
        let probe = map_centered(&result.forward_h, -0.3 * w, 0.0);
        assert!(probe.0.is_finite() && probe.1.is_finite());
    }

    #[test]
    fn two_vertical_parallel_tilted_is_pure_rotation() {
        let w = 2000.0;
        let h = 1500.0;
        let a = 3.0_f64.to_radians();
        let (s, c) = a.sin_cos();
        let dir = (s, c);
        let make = |id: &str, cx: f64| {
            let p1 = (cx - 0.4 * h * dir.0, 0.0 - 0.4 * h * dir.1);
            let p2 = (cx + 0.4 * h * dir.0, 0.0 + 0.4 * h * dir.1);
            make_line(
                id,
                GuideOrientation::Vertical,
                centered_to_uv(p1.0, p1.1, w, h),
                centered_to_uv(p2.0, p2.1, w, h),
            )
        };
        let lines = [make("v1", -0.2 * w), make("v2", 0.2 * w)];
        let result = compute_guided_homography(&lines, w, h).expect("tilted 2V");
        let expected = rotation(a);
        for i in 0..3 {
            for j in 0..3 {
                assert!(
                    (result.forward_h[i][j] - expected[i][j]).abs() < 1e-6,
                    "H[{i}][{j}] {} vs {}",
                    result.forward_h[i][j],
                    expected[i][j]
                );
            }
        }
        assert!(result.debug_vp[0].is_none());
    }

    #[test]
    fn one_vertical_one_horizontal() {
        let w = 2000.0;
        let h = 1500.0;
        let lines = [
            make_line(
                "v",
                GuideOrientation::Vertical,
                centered_to_uv(-0.05 * w, -0.4 * h, w, h),
                centered_to_uv(0.08 * w, 0.4 * h, w, h),
            ),
            make_line(
                "h",
                GuideOrientation::Horizontal,
                centered_to_uv(-0.4 * w, 0.06 * h, w, h),
                centered_to_uv(0.4 * w, -0.04 * h, w, h),
            ),
        ];
        let result = compute_guided_homography(&lines, w, h).expect("1V1H");
        let (hp1, hp2) = line_centered(&lines[1], w, h);
        let a = map_centered(&result.forward_h, hp1.0, hp1.1);
        let b = map_centered(&result.forward_h, hp2.0, hp2.1);
        let h_angle = (b.1 - a.1).atan2(b.0 - a.0).abs();
        assert!(h_angle < 0.3_f64.to_radians(), "horizontal angle {h_angle}");

        let (vp1, vp2) = line_centered(&lines[0], w, h);
        let c = map_centered(&result.forward_h, vp1.0, vp1.1);
        let d = map_centered(&result.forward_h, vp2.0, vp2.1);
        let v_from_vert = (d.0 - c.0).atan2(d.1 - c.1).abs();
        assert!(v_from_vert < 0.3_f64.to_radians(), "vertical angle {v_from_vert}");
    }

    #[test]
    fn short_line_dropped_among_good_ones() {
        let w: f64 = 2000.0;
        let h: f64 = 1500.0;
        let short = 0.005 * w.hypot(h);
        let lines = [
            make_line(
                "v1",
                GuideOrientation::Vertical,
                centered_to_uv(-0.2 * w, -0.4 * h, w, h),
                centered_to_uv(-0.2 * w, 0.4 * h, w, h),
            ),
            make_line(
                "v2",
                GuideOrientation::Vertical,
                centered_to_uv(0.2 * w, -0.4 * h, w, h),
                centered_to_uv(0.2 * w, 0.4 * h, w, h),
            ),
            make_line(
                "h1",
                GuideOrientation::Horizontal,
                centered_to_uv(-0.3 * w, 0.1 * h, w, h),
                centered_to_uv(0.3 * w, 0.1 * h, w, h),
            ),
            make_line(
                "short",
                GuideOrientation::Horizontal,
                centered_to_uv(0.0, 0.0, w, h),
                centered_to_uv(short, 0.0, w, h),
            ),
        ];
        assert!(count_valid_lines(&lines, w, h) == 3);
        assert!(compute_guided_homography(&lines, w, h).is_some());
    }

    #[test]
    fn fewer_than_two_valid_lines_returns_none() {
        let w = 2000.0;
        let h = 1500.0;
        assert!(compute_guided_homography(&[], w, h).is_none());
        let one = [make_line(
            "v",
            GuideOrientation::Vertical,
            centered_to_uv(-0.2 * w, -0.4 * h, w, h),
            centered_to_uv(-0.2 * w, 0.4 * h, w, h),
        )];
        assert!(compute_guided_homography(&one, w, h).is_none());
    }

    #[test]
    fn line_off_axis_dropped() {
        let w = 2000.0;
        let h = 1500.0;
        let lines = [
            make_line(
                "diag",
                GuideOrientation::Vertical,
                centered_to_uv(-0.3 * w, -0.3 * h, w, h),
                centered_to_uv(0.3 * w, 0.3 * h, w, h),
            ),
            make_line(
                "v",
                GuideOrientation::Vertical,
                centered_to_uv(0.2 * w, -0.4 * h, w, h),
                centered_to_uv(0.2 * w, 0.4 * h, w, h),
            ),
        ];
        assert_eq!(count_valid_lines(&lines, w, h), 1);
        assert!(compute_guided_homography(&lines, w, h).is_none());
    }

    #[test]
    fn crossing_verticals_inside_frame_rejected() {
        let w = 2000.0;
        let h = 1500.0;
        let lines = [
            make_line(
                "v1",
                GuideOrientation::Vertical,
                centered_to_uv(-0.15 * w, -0.4 * h, w, h),
                centered_to_uv(0.05 * w, 0.4 * h, w, h),
            ),
            make_line(
                "v2",
                GuideOrientation::Vertical,
                centered_to_uv(0.15 * w, -0.4 * h, w, h),
                centered_to_uv(-0.05 * w, 0.4 * h, w, h),
            ),
        ];
        assert!(compute_guided_homography(&lines, w, h).is_none());
    }

    #[test]
    fn degenerate_crop_returns_full_frame() {
        let singular = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 0.0]];
        let crop = compute_max_inscribed_crop(&singular, 1000.0, 800.0);
        assert_eq!(crop, [0.0, 0.0, 1.0, 1.0]);
    }

    #[test]
    fn crop_for_pure_rotation_is_inside_and_near_analytic() {
        let w = 6000.0;
        let h = 4000.0;
        let theta = 5.0_f64.to_radians();
        let rh = rotation(theta);
        let crop = compute_max_inscribed_crop(&rh, w, h);
        let quad = warped_quad_normalized(&rh, w, h);
        let corners = [
            (crop[0], crop[1]),
            (crop[0] + crop[2], crop[1]),
            (crop[0] + crop[2], crop[1] + crop[3]),
            (crop[0], crop[1] + crop[3]),
        ];
        for c in corners {
            assert!(point_in_convex(c, &quad), "crop corner {c:?} outside quad");
        }

        let (s, c) = theta.sin_cos();
        let abs_c = c.abs();
        let abs_s = s.abs();
        let hw = w / 2.0;
        let hh = h / 2.0;
        let den = abs_c * abs_c - abs_s * abs_s;
        let mut analytic_area = 0.0;
        if den.abs() > 1e-9 {
            let a = (abs_c * hw - abs_s * hh) / den;
            let b = (abs_c * hh - abs_s * hw) / den;
            if a > 0.0 && b > 0.0 && a <= hw + 1e-6 && b <= hh + 1e-6 {
                analytic_area = (2.0 * a / w) * (2.0 * b / h);
            }
        }
        let simple_w = (w * abs_c - h * abs_s).max(0.0) / w;
        let simple_h = (h * abs_c - w * abs_s).max(0.0) / h;
        analytic_area = analytic_area.max(simple_w * simple_h);
        let area = crop[2] * crop[3];
        assert!(
            (area - analytic_area).abs() <= 0.02 * analytic_area.max(area),
            "area {area} vs analytic {analytic_area}"
        );
    }

    #[test]
    fn accepted_h_is_invertible_and_roundtrips() {
        let w = 2000.0;
        let h = 1500.0;
        let lines = [
            make_line(
                "v1",
                GuideOrientation::Vertical,
                centered_to_uv(-0.25 * w, -0.4 * h, w, h),
                centered_to_uv(-0.20 * w, 0.4 * h, w, h),
            ),
            make_line(
                "v2",
                GuideOrientation::Vertical,
                centered_to_uv(0.25 * w, -0.4 * h, w, h),
                centered_to_uv(0.20 * w, 0.4 * h, w, h),
            ),
            make_line(
                "h1",
                GuideOrientation::Horizontal,
                centered_to_uv(-0.4 * w, -0.2 * h, w, h),
                centered_to_uv(0.4 * w, -0.15 * h, w, h),
            ),
        ];
        let result = compute_guided_homography(&lines, w, h).expect("solve");
        assert!(det3(&result.forward_h).abs() > 1e-6);
        let inv = invert3(&result.forward_h).expect("invert");
        for i in 0..100 {
            let x = -w / 2.0 + w * ((i * 17 + 3) as f64 % 97.0) / 97.0;
            let y = -h / 2.0 + h * ((i * 31 + 5) as f64 % 89.0) / 89.0;
            let mid = map_centered(&result.forward_h, x, y);
            let back = map_centered(&inv, mid.0, mid.1);
            assert!((back.0 - x).abs() < 1e-9 && (back.1 - y).abs() < 1e-9);
        }
    }

    #[test]
    fn scale_covariance_of_normalized_crop() {
        let lines = [
            make_line(
                "v1",
                GuideOrientation::Vertical,
                GuidePoint { x: 0.28, y: 0.08 },
                GuidePoint { x: 0.32, y: 0.92 },
            ),
            make_line(
                "v2",
                GuideOrientation::Vertical,
                GuidePoint { x: 0.70, y: 0.08 },
                GuidePoint { x: 0.66, y: 0.92 },
            ),
            make_line(
                "h1",
                GuideOrientation::Horizontal,
                GuidePoint { x: 0.10, y: 0.30 },
                GuidePoint { x: 0.90, y: 0.28 },
            ),
            make_line(
                "h2",
                GuideOrientation::Horizontal,
                GuidePoint { x: 0.10, y: 0.72 },
                GuidePoint { x: 0.90, y: 0.74 },
            ),
        ];
        let a = compute_guided_homography(&lines, 6000.0, 4000.0).expect("6k");
        let b = compute_guided_homography(&lines, 1500.0, 1000.0).expect("1.5k");
        let crop_a = compute_max_inscribed_crop(&a.forward_h, 6000.0, 4000.0);
        let crop_b = compute_max_inscribed_crop(&b.forward_h, 1500.0, 1000.0);
        for i in 0..4 {
            assert!(
                (crop_a[i] - crop_b[i]).abs() < 1e-6,
                "crop[{i}] {} vs {}",
                crop_a[i],
                crop_b[i]
            );
        }
    }

    #[test]
    fn solve_and_crop_under_100ms_at_24mp() {
        let lines = [
            make_line(
                "v1",
                GuideOrientation::Vertical,
                GuidePoint { x: 0.28, y: 0.08 },
                GuidePoint { x: 0.32, y: 0.92 },
            ),
            make_line(
                "v2",
                GuideOrientation::Vertical,
                GuidePoint { x: 0.70, y: 0.08 },
                GuidePoint { x: 0.66, y: 0.92 },
            ),
            make_line(
                "h1",
                GuideOrientation::Horizontal,
                GuidePoint { x: 0.10, y: 0.30 },
                GuidePoint { x: 0.90, y: 0.28 },
            ),
            make_line(
                "h2",
                GuideOrientation::Horizontal,
                GuidePoint { x: 0.10, y: 0.72 },
                GuidePoint { x: 0.90, y: 0.74 },
            ),
        ];
        let start = std::time::Instant::now();
        let result = compute_guided_homography(&lines, 6000.0, 4000.0).expect("solve");
        let crop = compute_max_inscribed_crop(&result.forward_h, 6000.0, 4000.0);
        let elapsed = start.elapsed();
        println!("guided solve+crop at 6000x4000: {elapsed:?} crop={crop:?}");
        assert!(
            elapsed.as_millis() < 100,
            "solve+crop took {elapsed:?}, budget is 100ms"
        );
    }

    #[test]
    fn ipc_invalid_returns_identity() {
        let json = calculate_guided_perspective(Vec::new(), 1000.0, 800.0);
        assert!(!json.valid);
        assert_eq!(json.forward_h, [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
        assert_eq!(json.crop, [0.0, 0.0, 1.0, 1.0]);
    }
}
