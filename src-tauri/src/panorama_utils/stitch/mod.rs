pub mod blend;
pub mod camera;
pub mod finish;
pub mod project;

use rayon::prelude::*;
const MAX_TOTAL_PIXELS: f64 = 512e6;

use super::features;
use super::linalg;
use super::log;
use super::raster::{Plane, Rgb32f};
use crate::panorama_utils::spill::Store;
use blend::{Blender, Buf, push_pull};
use camera::Camera;
use project::Projection;

pub const DISPLAY_LONG_SIDE: u32 = 1920;
const WORK_EDGE: usize = 1000;
const MAX_FEATURES: usize = 1200;

#[derive(Clone, Debug)]
pub struct Frame {
    pub name: String,
    pub width: usize,
    pub height: usize,
    pub native_width: usize,
    pub native_height: usize,
    pub rgb: Vec<f32>,
    pub clip: f32,
    pub exposure: Option<f64>,
    pub focal35: Option<f64>,
    pub meta: Option<FrameMeta>,
}

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameMeta {
    pub native_mm: Option<f64>,
    pub focal35: Option<f64>,
    pub shutter: Option<String>,
    pub aperture: Option<f64>,
    pub iso: Option<f64>,
}

impl Frame {
    pub fn width(&self) -> usize {
        self.width
    }
    pub fn height(&self) -> usize {
        self.height
    }
    pub fn image(&self) -> Rgb32f {
        Rgb32f {
            width: self.width,
            height: self.height,
            data: self
                .rgb
                .as_chunks::<3>()
                .0
                .iter()
                .map(|c| [c[0], c[1], c[2]])
                .collect(),
        }
    }
}

const MAX_LONG_EDGE: f64 = 65_000.0;

impl Default for PanoOptions {
    fn default() -> Self {
        PanoOptions {
            projection: Projection::Auto,
            boundary_warp: 0.0,
            auto_crop: false,
            fill_edges: false,
            quality: 1.0,
            preview_canvas: None,
            save_scale: 1.0,
            frame_scale: 1.0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct PanoResult {
    pub image: Rgb32f,
    pub alpha: Plane,
    pub crop: Option<[f64; 4]>,
    pub projection: Projection,
    pub used: Vec<usize>,
    pub cameras: Vec<Option<Camera>>,
    pub gains: Vec<f64>,
    pub rms_before: f64,
    pub rms: f64,
    pub fov: (f64, f64),
    pub focal: f64,
}

fn fov(frames: &[Frame], cams: &[Option<Camera>]) -> (f64, f64) {
    let (mut tmin, mut tmax, mut pmin, mut pmax) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for (f, c) in frames.iter().zip(cams) {
        let Some(c) = c else { continue };
        for (x, y) in border(f.width(), f.height(), 16) {
            if let Some((t, p)) = Projection::Spherical.forward(c.ray(x, y), 1.0) {
                tmin = tmin.min(t);
                tmax = tmax.max(t);
                pmin = pmin.min(p);
                pmax = pmax.max(p);
            }
        }
    }
    ((tmax - tmin).to_degrees(), (pmax - pmin).to_degrees())
}

fn border(w: usize, h: usize, per_edge: usize) -> Vec<(f64, f64)> {
    let (w, h) = (w as f64, h as f64);
    let mut v = Vec::new();
    for k in 0..=per_edge {
        let t = k as f64 / per_edge as f64;
        v.extend([(t * w, 0.0), (t * w, h), (0.0, t * h), (w, t * h)]);
    }
    v
}

fn bounds(
    frames: &[Frame],
    cams: &[Option<Camera>],
    proj: Projection,
    f: f64,
) -> Option<(f64, f64, f64, f64)> {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for (fr, c) in frames.iter().zip(cams) {
        let Some(c) = c else { continue };
        for (x, y) in border(fr.width(), fr.height(), 24) {
            let (u, v) = proj.forward(c.ray(x, y), f)?;
            x0 = x0.min(u);
            y0 = y0.min(v);
            x1 = x1.max(u);
            y1 = y1.max(v);
        }
    }
    (x1 > x0 && y1 > y0).then_some((x0, y0, x1, y1))
}

// Picks a projection from how wide the photos look together.
pub fn choose_projection(frames: &[Frame], cams: &[Option<Camera>]) -> Projection {
    let (h, v) = fov(frames, cams);
    let area: f64 = frames
        .iter()
        .zip(cams)
        .filter(|(_, c)| c.is_some())
        .map(|(f, _)| (f.width() * f.height()) as f64)
        .sum();
    let fmed = median(cams.iter().flatten().map(|c| c.f).collect());
    if h < 110.0
        && v < 110.0
        && let Some((x0, y0, x1, y1)) = bounds(frames, cams, Projection::Perspective, fmed)
        && (x1 - x0) * (y1 - y0) < 2.5 * area
    {
        return Projection::Perspective;
    }
    if v < 90.0 {
        Projection::Cylindrical
    } else {
        Projection::Spherical
    }
}

fn median(mut v: Vec<f64>) -> f64 {
    if v.is_empty() {
        return 1.0;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    v[v.len() / 2]
}

struct Tile {
    x0: usize,
    y0: usize,
    w: usize,
    h: usize,
    rgb: crate::panorama_utils::spill::Store<f32>,
    wgt: crate::panorama_utils::spill::Store<f32>,
}

#[derive(Clone, Debug)]
pub struct PanoOptions {
    pub projection: Projection,
    pub boundary_warp: f64,
    pub auto_crop: bool,
    pub fill_edges: bool,
    pub quality: f64,
    pub preview_canvas: Option<(usize, usize)>,
    pub save_scale: f64,
    pub frame_scale: f64,
}

#[derive(Clone)]
pub struct Registration {
    pub cameras: Vec<Option<Camera>>,
    pub used: Vec<usize>,
    pub rms_before: f64,
    pub rms: f64,
    pub focal_outlier: Vec<bool>,
    pub focal_px: Vec<Option<f64>>,
}

pub const FOCAL_OUTLIER_TOLERANCE: f64 = 0.10;

// Aligns the photos that overlap.
pub fn register(frames: &[Frame]) -> Result<Registration, String> {
    let n = frames.len();
    let work: Vec<(features::Features, f64)> = frames
        .par_iter()
        .map(|f| {
            let img = f.image();
            let med = features::median_luma(&img, f.clip);
            let (p, s) = features::work_image(&img, 0.18 / med.max(1e-6), WORK_EDGE);
            (features::detect(&p, MAX_FEATURES), s)
        })
        .collect();
    log::line(&format!(
        "features done ({} per frame)",
        work.iter().map(|(f, _)| f.len()).max().unwrap_or(0)
    ));
    log::gate()?;
    let feats: Vec<_> = work.iter().map(|(f, _)| f.clone()).collect();
    let scales: Vec<f64> = work.iter().map(|(_, s)| *s).collect();
    let pairs = camera::match_pairs(&feats, &scales);
    log::line(&format!("matched {} pairs", pairs.len()));
    for p in &pairs {
        log::line(&format!(
            "pair {} {}: {} inliers rmsPx {:.2}",
            p.i,
            p.j,
            p.pts.len(),
            ransac_rms(p)
        ));
    }
    log::gate()?;
    let ids = camera::largest_component(n, &pairs);
    if ids.len() < 2 {
        return Err("The photos don't overlap enough to be stitched.".into());
    }
    log::line(&format!("connected set: {} of {} photos", ids.len(), n));
    let sizes: Vec<(usize, usize)> = frames.iter().map(|f| (f.width(), f.height())).collect();
    let mut fs = Vec::new();
    for p in &pairs {
        if !(ids.contains(&p.i) && ids.contains(&p.j)) {
            continue;
        }
        let ci = (sizes[p.i].0 as f64 / 2.0, sizes[p.i].1 as f64 / 2.0);
        let cj = (sizes[p.j].0 as f64 / 2.0, sizes[p.j].1 as f64 / 2.0);
        let ti = super::geom::Homography([1.0, 0.0, ci.0, 0.0, 1.0, ci.1, 0.0, 0.0, 1.0]);
        let tj = super::geom::Homography([1.0, 0.0, -cj.0, 0.0, 1.0, -cj.1, 0.0, 0.0, 1.0]);
        let hc = tj.mul(&p.h).mul(&ti);
        if let (Some(a), Some(b)) = camera::focals_from_homography(&hc) {
            fs.push((a * b).sqrt());
        }
    }
    let long = sizes[ids[0]].0.max(sizes[ids[0]].1) as f64;
    let exif_f = frames[ids[0]]
        .focal35
        .filter(|v| *v > 1.0)
        .map(|f35| f35 / 36.0 * long);
    let hom_f = (!fs.is_empty())
        .then(|| median(fs.clone()))
        .filter(|f| *f > 0.1 * long && *f < 20.0 * long);
    let f0 = exif_f.or(hom_f).unwrap_or(long * 1.07);
    log::line(&format!(
        "focal0 {:.1}px (exif {} homography {} fallback {:.1})",
        f0,
        exif_f.is_some(),
        hom_f.is_some(),
        long * 1.07
    ));
    let priors: Vec<f64> = (0..n)
        .map(|i| {
            frames[i]
                .focal35
                .filter(|v| *v > 1.0)
                .map(|f35| {
                    let li = sizes[i].0.max(sizes[i].1) as f64;
                    f35 / 36.0 * li
                })
                .unwrap_or(f0)
        })
        .collect();
    let spread: Vec<f64> = (0..n)
        .map(|i| if priors[i] > 0.0 { priors[i] / f0 } else { 1.0 })
        .collect();
    let (lo, hi) = spread
        .iter()
        .fold((f64::MAX, 0.0f64), |(a, b), &v| (a.min(v), b.max(v)));
    if hi > lo * 1.05 {
        log::line(&format!(
            "mixed focal lengths: {} distinct, {:.0}%..{:.0}% of {:.1}px",
            spread
                .iter()
                .filter(|v| (**v - lo).abs() > 0.05 || (**v - hi).abs() > 0.05)
                .count()
                + 1,
            lo * 100.0,
            hi * 100.0,
            f0
        ));
    }
    let cams = camera::initial_cameras(&ids, &sizes, &pairs, &priors, f0);
    let anchor = ids
        .iter()
        .copied()
        .find(|&i| cams[i].is_some())
        .unwrap_or(ids[0]);
    log::gate()?;
    let adj = camera::bundle_adjust(&cams, &pairs, anchor, 60);
    log::line(&format!(
        "bundle adjust: {} iterations, rmsPx {:.3} -> {:.3}",
        adj.iterations, adj.rms_before, adj.rms
    ));
    let mut cams = adj.cameras;
    for (i, c) in cams.iter_mut().enumerate() {
        let Some(c) = c else { continue };
        let prior = priors.get(i).copied().filter(|v| *v > 0.0).unwrap_or(f0);
        if !c.f.is_finite() || c.f < prior * 0.25 || c.f > prior * 4.0 {
            log::line(&format!(
                "frame {i} focal {:.1}px out of range, holding its own prior {:.1}px",
                c.f, prior
            ));
            c.f = prior;
        }
    }
    camera::straighten(&mut cams);
    let used: Vec<usize> = (0..n).filter(|&i| cams[i].is_some()).collect();
    for (i, c) in cams.iter().enumerate() {
        if let Some(c) = c {
            log::line(&format!(
                "camera {} focalPx {:.2} cx {:.1} cy {:.1}",
                i, c.f, c.cx, c.cy
            ));
        }
    }
    let focal_px: Vec<Option<f64>> = cams.iter().map(|c| c.map(|c| c.f)).collect();
    let dev = |med: f64, v: Option<f64>| -> bool {
        match (v, med > 0.0) {
            (Some(v), true) => (v / med - 1.0).abs() > FOCAL_OUTLIER_TOLERANCE,
            _ => false,
        }
    };
    let present: Vec<f64> = focal_px.iter().flatten().copied().collect();
    let med_refined = if present.is_empty() {
        0.0
    } else {
        median(present)
    };
    let exif: Vec<Option<f64>> = frames.iter().map(|f| f.focal35).collect();
    let exif_present: Vec<f64> = exif.iter().flatten().copied().collect();
    let med_exif = if exif_present.is_empty() {
        0.0
    } else {
        median(exif_present)
    };
    let focal_outlier: Vec<bool> = (0..n)
        .map(|i| dev(med_refined, focal_px[i]) || dev(med_exif, exif[i]))
        .collect();
    let n_out = focal_outlier.iter().filter(|b| **b).count();
    if n_out > 0 {
        let names: Vec<String> = (0..n)
            .filter(|&i| focal_outlier[i])
            .map(|i| frames[i].name.clone())
            .collect();
        log::line(&format!(
            "focal outlier(s) >{:.0}%: {}",
            FOCAL_OUTLIER_TOLERANCE * 100.0,
            names.join(", ")
        ));
    }
    Ok(Registration {
        cameras: cams,
        used,
        rms_before: adj.rms_before,
        rms: adj.rms,
        focal_outlier,
        focal_px,
    })
}

fn ransac_rms(p: &camera::PairMatch) -> f64 {
    let n = p.pts.len().max(1) as f64;
    (p.pts
        .iter()
        .map(|(a, b)| super::ransac::transfer_error2(&p.h, *a, *b))
        .sum::<f64>()
        / n)
        .sqrt()
}

fn bounds_of(
    sizes: &[(usize, usize)],
    cams: &[Option<Camera>],
    proj: Projection,
    f: f64,
) -> Option<(f64, f64, f64, f64)> {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for (&(w, h), c) in sizes.iter().zip(cams) {
        let Some(c) = c else { continue };
        for (x, y) in border(w, h, 24) {
            let (u, v) = proj.forward(c.ray(x, y), f)?;
            x0 = x0.min(u);
            y0 = y0.min(v);
            x1 = x1.max(u);
            y1 = y1.max(v);
        }
    }
    (x1 > x0 && y1 > y0).then_some((x0, y0, x1, y1))
}

pub struct Measure {
    sizes: Vec<(usize, usize)>,
    cams: Vec<Option<Camera>>,
    projection: Projection,
    fmed: f64,
    b: (f64, f64, f64, f64),
    n_used: u32,
    frame_w: u32,
    frame_h: u32,
}

impl Measure {
    pub fn new(
        sizes: &[(usize, usize)],
        cams: &[Option<Camera>],
        projection: Projection,
        fmed: f64,
    ) -> Option<Self> {
        let b = bounds_of(sizes, cams, projection, fmed)?;
        Some(Self {
            sizes: sizes.to_vec(),
            cams: cams.to_vec(),
            projection,
            fmed,
            b,
            n_used: cams.iter().filter(|c| c.is_some()).count() as u32,
            frame_w: sizes.iter().map(|s| s.0 as u32).max().unwrap_or(1),
            frame_h: sizes.iter().map(|s| s.1 as u32).max().unwrap_or(1),
        })
    }
    pub fn native_area(&self) -> f64 {
        (self.b.2 - self.b.0) * (self.b.3 - self.b.1)
    }
    pub fn bounds(&self) -> (f64, f64, f64, f64) {
        self.b
    }
    pub fn canvas_pixels(&self, sc: f64) -> f64 {
        self.measure(sc).0
    }
    fn measure(&self, sc: f64) -> (f64, u64) {
        let (b0, b1, b2, b3) = self.b;
        let (unit, (pw, ph)) = pyramid_units(
            ((b2 - b0) * sc).ceil() as usize,
            ((b3 - b1) * sc).ceil() as usize,
        );
        let ox = b0 * sc;
        let oy = b1 * sc;
        let tile_px: u64 = self
            .cams
            .iter()
            .enumerate()
            .filter_map(|(i, c)| c.map(|c| (i, c)))
            .map(|(i, c)| {
                tile_px(
                    &c,
                    self.sizes[i],
                    self.projection,
                    self.fmed * sc,
                    ox,
                    oy,
                    unit,
                    pw,
                    ph,
                )
                .unwrap_or(0)
            })
            .sum();
        let canvas_px = ((b2 - b0) * sc * (b3 - b1) * sc).max(1.0);
        (canvas_px, tile_px)
    }
    pub fn cost_at(&self, sc: f64) -> crate::panorama_utils::memory::StitchCost {
        let (canvas_px, tile_px) = self.measure(sc);
        crate::panorama_utils::memory::stitch_cost(
            self.n_used,
            self.frame_w,
            self.frame_h,
            tile_px,
            canvas_px as u64,
        )
    }
}

fn levels_for(short: f64) -> usize {
    if !short.is_finite() || short <= 1.0 {
        return 1;
    }
    (short.log2() - 3.0).floor().clamp(1.0, 7.0) as usize
}

fn fit_canvas_ceilings(cw: usize, ch: usize) -> (usize, usize) {
    let long = (cw.max(ch) as f64).max(1.0);
    let px = (cw as f64 * ch as f64).max(1.0);
    let fit = (MAX_LONG_EDGE / long)
        .min((MAX_TOTAL_PIXELS / px).sqrt())
        .min(1.0);
    if fit >= 1.0 {
        return (cw, ch);
    }
    (
        (cw as f64 * fit).round().max(1.0) as usize,
        (ch as f64 * fit).round().max(1.0) as usize,
    )
}

fn pyramid_levels(short: usize, frame_scale: f64) -> usize {
    let scale = if frame_scale.is_finite() && frame_scale > 1.0 {
        frame_scale
    } else {
        1.0
    };
    let file_levels = levels_for(short as f64 * scale);
    if scale == 1.0 {
        return file_levels;
    }
    let drop = scale.log2().round() as i32;
    (file_levels as i32 - drop).clamp(1, file_levels as i32) as usize
}

fn pyramid_units(w: usize, h: usize) -> (usize, (usize, usize)) {
    let levels = levels_for(w.min(h) as f64);
    let unit = 1usize << levels;
    (unit, (w, h))
}

#[allow(clippy::too_many_arguments)]
fn tile_px(
    cam: &Camera,
    size: (usize, usize),
    projection: Projection,
    f_out: f64,
    ox: f64,
    oy: f64,
    unit: usize,
    pw_max: usize,
    ph_max: usize,
) -> Option<u64> {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for (x, y) in border(size.0, size.1, 32) {
        let (u, v) = projection.forward(cam.ray(x, y), f_out)?;
        x0 = x0.min(u - ox);
        y0 = y0.min(v - oy);
        x1 = x1.max(u - ox);
        y1 = y1.max(v - oy);
    }
    let pad = 2.0 * unit as f64;
    let tw = ((((x1 + pad).max(0.0) as usize).min(pw_max)).div_ceil(unit) * unit)
        .saturating_sub((((x0 - pad).max(0.0) as usize) / unit) * unit);
    let th = ((((y1 + pad).max(0.0) as usize).min(ph_max)).div_ceil(unit) * unit)
        .saturating_sub((((y0 - pad).max(0.0) as usize) / unit) * unit);
    if tw == 0 || th == 0 {
        None
    } else {
        Some((tw as u64) * (th as u64))
    }
}

pub struct Composed {
    pub image: Rgb32f,
    pub alpha: Plane,
    pub label: Vec<u16>,
    pub crop: Option<[f64; 4]>,
    pub projection: Projection,
    pub focal: f64,
    pub gains: Vec<f64>,
    pub scale: f64,
    pub saved_quality: f64,
    pub saved_attempts: u32,
    pub width: usize,
    pub height: usize,
}

pub fn detect_clip(img: &Rgb32f) -> f32 {
    let maxv = img
        .data
        .iter()
        .map(|p| p[0].max(p[1]).max(p[2]))
        .fold(0.0f32, f32::max);
    if maxv.is_nan() || maxv <= 0.0 {
        return 1.0;
    }
    let level = maxv.min(1.0);
    let (mut near, mut below) = (0usize, 0usize);
    for p in &img.data {
        let m = p[0].max(p[1]).max(p[2]);
        if m >= level * 0.995 {
            near += 1;
        } else if m >= level * 0.97 && m < level * 0.99 {
            below += 1;
        }
    }
    let piled = near as f64 > img.data.len() as f64 * 1e-4
        && near >= 4
        && near as f64 / 0.005 > 4.0 * below as f64 / 0.02;
    if maxv >= 1.0 || piled {
        level * 0.995
    } else {
        1.0
    }
}

pub type ComposeProgress<'a> = dyn Fn(&str, f64) + Sync + 'a;

// Projects the aligned photos and blends them.
pub fn compose(
    frames: &[Frame],
    reg: &Registration,
    projection: Projection,
    opts: &PanoOptions,
    scratch: Option<&crate::panorama_utils::spill::Scratch>,
    progress: &ComposeProgress<'_>,
) -> Result<Composed, String> {
    let n = frames.len();
    let cams = &reg.cameras;
    let used = &reg.used;
    let fovd = fov(frames, cams);
    let projection = match projection {
        Projection::Auto => choose_projection(frames, cams),
        p => p,
    };
    log::line(&format!(
        "projection {} fov {:.1}° x {:.1}°",
        projection.as_str(),
        fovd.0,
        fovd.1
    ));
    let fmed = median(used.iter().filter_map(|&i| cams[i].map(|c| c.f)).collect());
    let Some((bx0, by0, bx1, by1)) = bounds(frames, cams, projection, fmed) else {
        return Err(format!(
            "The field of view ({:.0}°) is too wide for a rectilinear projection.",
            fovd.0
        ));
    };
    let area: f64 = used
        .iter()
        .map(|&i| (frames[i].width() * frames[i].height()) as f64)
        .sum();
    if projection == Projection::Perspective && (bx1 - bx0) * (by1 - by0) > 12.0 * area {
        return Err(format!(
            "The field of view ({:.0}°) is too wide for a rectilinear projection.",
            fovd.0
        ));
    }
    let native_area = (bx1 - bx0) * (by1 - by0);
    let sizes: Vec<(usize, usize)> = frames.iter().map(|f| (f.width(), f.height())).collect();
    let used_cams: Vec<Option<Camera>> = used.iter().map(|&i| cams[i]).collect();
    let used_sizes: Vec<(usize, usize)> = used.iter().map(|&i| sizes[i]).collect();
    Measure::new(&used_sizes, &used_cams, projection, fmed)
        .ok_or_else(|| "Could not measure the projected canvas.".to_string())?;
    let quality = opts.quality.clamp(0.25, 1.0);
    let allowed_px = (native_area * quality * quality).min(MAX_TOTAL_PIXELS);
    let s = (allowed_px / native_area)
        .sqrt()
        .min(MAX_LONG_EDGE / (bx1 - bx0).max(bx1 - by0))
        .clamp(0.0, 1.0);
    let (f_out, (ox, oy)) = (fmed * s, (bx0 * s, by0 * s));
    let (cw, ch) = if let Some((vw, vh)) = opts.preview_canvas {
        let r = if opts.save_scale.is_finite() && opts.save_scale > 0.0 {
            opts.save_scale
        } else {
            1.0
        };
        (
            (vw as f64 * r * s).round().max(1.0) as usize,
            (vh as f64 * r * s).round().max(1.0) as usize,
        )
    } else {
        (
            ((bx1 - bx0) * s).ceil() as usize + 1,
            ((by1 - by0) * s).ceil() as usize + 1,
        )
    };
    let (cw, ch) = fit_canvas_ceilings(cw, ch);
    let levels = pyramid_levels(cw.min(ch), opts.frame_scale);
    let unit = 1usize << levels;
    let (pw, ph) = (cw, ch);
    let owned_scratch;
    let scratch = match scratch {
        Some(s) => s,
        None => {
            owned_scratch = crate::panorama_utils::spill::Scratch::in_ram_only();
            &owned_scratch
        }
    };
    log::line(&format!(
        "compose {:.1} MP at {:.0}% ({}x{}) levels {}",
        cw as f64 * ch as f64 / 1e6,
        s * 100.0,
        cw,
        ch,
        levels
    ));
    let memory_scale = s;
    log::line(&format!(
        "canvas {cw}x{ch} levels {levels} focalOut {f_out:.1}px scale {s:.4}"
    ));
    progress("Projecting", 0.0);
    let ev0 = frames[used[0]].exposure;
    let mut gains: Vec<f64> = (0..n)
        .map(|i| match (frames[i].exposure, ev0) {
            (Some(e), Some(e0)) => 2f64.powf(e0 - e),
            _ => 1.0,
        })
        .collect();
    let tiles: Vec<Option<Tile>> = (0..n)
        .into_par_iter()
        .map(|i| -> Result<Option<Tile>, String> {
            log::gate()?;
            let Some(c) = cams[i] else { return Ok(None) };
            let fr = &frames[i];
            let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
            for (x, y) in border(fr.width(), fr.height(), 32) {
                let Some((u, v)) = projection.forward(c.ray(x, y), f_out) else {
                    return Ok(None);
                };
                x0 = x0.min(u - ox);
                y0 = y0.min(v - oy);
                x1 = x1.max(u - ox);
                y1 = y1.max(v - oy);
            }
            let pad = 2.0 * unit as f64;
            let tx0 = (((x0 - pad).max(0.0) as usize) / unit) * unit;
            let ty0 = (((y0 - pad).max(0.0) as usize) / unit) * unit;
            let tx1 = (((x1 + pad).max(0.0) as usize).min(pw)).div_ceil(unit) * unit;
            let ty1 = (((y1 + pad).max(0.0) as usize).min(ph)).div_ceil(unit) * unit;
            let (tw, th) = (
                tx1.min(pw).saturating_sub(tx0),
                ty1.min(ph).saturating_sub(ty0),
            );
            if tw == 0 || th == 0 {
                return Ok(None);
            }
            let (fw, fh) = (fr.width as f64, fr.height as f64);
            scratch.check();
            let mut rgb = <Store<f32>>::try_mapped(tw * th * 3, scratch.file())?;
            let mut wgt = <Store<f32>>::try_mapped(tw * th, scratch.file())?;
            rgb[..]
                .par_chunks_mut(tw * 3)
                .zip(wgt[..].par_chunks_mut(tw))
                .enumerate()
                .for_each(|(ty, (row, wrow))| {
                    let v = (ty0 + ty) as f64 + 0.5 + oy;
                    for tx in 0..tw {
                        let u = (tx0 + tx) as f64 + 0.5 + ox;
                        let d = projection.inverse(u, v, f_out);
                        let Some((px, py)) = c.project(d) else {
                            continue;
                        };
                        if px < 0.0 || py < 0.0 || px > fw || py > fh {
                            continue;
                        }
                        let wx = 1.0 - (2.0 * px / fw - 1.0).abs();
                        let wy = 1.0 - (2.0 * py / fh - 1.0).abs();
                        let w = (wx * wy).max(1e-6) as f32;
                        let c = crate::panorama_utils::raster::sample_interleaved(
                            &fr.rgb, fr.width, fr.height, px as f32, py as f32,
                        );
                        row[tx * 3] = c[0];
                        row[tx * 3 + 1] = c[1];
                        row[tx * 3 + 2] = c[2];
                        wrow[tx] = w;
                    }
                });
            Ok(Some(Tile {
                x0: tx0,
                y0: ty0,
                w: tw,
                h: th,
                rgb,
                wgt,
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    log::gate()?;
    log::line(&format!(
        "warped {} tiles",
        tiles.iter().filter(|t| t.is_some()).count()
    ));
    progress("Projecting", 1.0);
    progress("Exposure compensation", 0.0);
    compensate_gains(&tiles, &mut gains, frames);
    log::line(&format!(
        "gains {}",
        gains
            .iter()
            .map(|g| format!("{g:.3}"))
            .collect::<Vec<_>>()
            .join(" ")
    ));
    progress("Exposure compensation", 1.0);
    scratch.check();
    let mut best = <Store<f32>>::try_mapped(pw * ph, scratch.file())?;
    let mut label = <Store<u16>>::try_mapped(pw * ph, scratch.file())?;
    label.fill(u16::MAX);
    for (i, t) in tiles.iter().enumerate() {
        let Some(t) = t else { continue };
        for ty in 0..t.h {
            let row = (t.y0 + ty) * pw + t.x0;
            for tx in 0..t.w {
                let w = t.wgt[ty * t.w + tx];
                if w > 0.0 && w > best[row + tx] {
                    best[row + tx] = w;
                    label[row + tx] = i as u16;
                }
            }
        }
    }
    progress("Blending", 0.0);
    let tile_bytes: u64 = tiles
        .iter()
        .flatten()
        .map(|t| (t.w * t.h) as u64 * 16)
        .sum();
    let source_bytes: u64 = used.iter().map(|&i| frames[i].rgb.len() as u64 * 4).sum();
    let mut blender = Blender::try_new(pw, ph, levels, scratch.file())?;
    if scratch.is_spilling() {
        let over = scratch.over_by();
        if over > 0 {
            blender.spill_levels(scratch.file().expect("spilling"), over);
        }
    }
    let pyramid_bytes: u64 = blender
        .acc
        .iter()
        .map(|b| b.data.len() as u64 * 4)
        .sum::<u64>()
        + blender
            .wsum
            .iter()
            .map(|b| b.data.len() as u64 * 4)
            .sum::<u64>();
    let canvas_bytes = (cw * ch * 16) as u64;
    let label_bytes = (pw * ph * 6) as u64;
    let total_bytes = source_bytes + tile_bytes + canvas_bytes + pyramid_bytes + label_bytes;
    let peak_bytes = source_bytes + tile_bytes + pyramid_bytes + label_bytes;
    let (total_ram, available_ram) = crate::panorama_utils::ram::available_and_total();
    let breakdown = format!(
        "MEMBREAK sources={:.2} tiles={:.2} labels={:.2} pyramid={:.2} | peak-during-blend={:.2}GB \
         canvas-comes-later={:.2}GB sum-of-all={:.2}GB | rss={:.2}GB used-of-total={:.2}/{:.2}GB \
         spill={} disk={:.2}GB canvas={}x{} levels={}",
        source_bytes as f64 / 1e9,
        tile_bytes as f64 / 1e9,
        label_bytes as f64 / 1e9,
        pyramid_bytes as f64 / 1e9,
        peak_bytes as f64 / 1e9,
        canvas_bytes as f64 / 1e9,
        total_bytes as f64 / 1e9,
        crate::panorama_utils::ram::process_resident_bytes() as f64 / 1e9,
        total_ram.saturating_sub(available_ram) as f64 / 1e9,
        total_ram as f64 / 1e9,
        if scratch.is_spilling() { "YES" } else { "no" },
        scratch.disk_bytes() as f64 / 1e9,
        pw,
        ph,
        levels,
    );
    log::line(&breakdown);
    let blend_rows = blend::blend_work_rows(tiles.iter().flatten().map(|t| t.h), levels, ph);
    let tick = blend::BlendTick::new(blend_rows, progress);
    for (i, t) in tiles.into_iter().enumerate() {
        log::gate()?;
        let Some(t) = t else { continue };
        let g = gains[i] as f32;
        let mut vals = Buf::new(t.w, t.h, 3);
        let mut mask = Buf::new(t.w, t.h, 1);
        let mut covered = Buf::new(t.w, t.h, 1);
        for ty in 0..t.h {
            for tx in 0..t.w {
                let k = ty * t.w + tx;
                if t.wgt[k] > 0.0 {
                    covered.data[k] = 1.0;
                    for c in 0..3 {
                        vals.data[k * 3 + c] = (t.rgb[k * 3 + c] * g).max(1e-6).ln();
                    }
                }
                if label[(t.y0 + ty) * pw + t.x0 + tx] == i as u16 {
                    mask.data[k] = 1.0;
                }
            }
        }
        push_pull(&mut vals, &t.wgt);
        blender.add(t.x0, t.y0, vals, mask, covered, Some(&tick));
        log::line(&format!("blended tile {} at {}x{}", i, t.w, t.h));
    }
    let out = blender.finish(Some(&tick));
    progress("Blending", 1.0);
    let mut image = Rgb32f::try_new(cw, ch)?;
    let mut alpha = Plane::try_new(cw, ch)?;
    for y in 0..ch {
        for x in 0..cw {
            let k = y * pw + x;
            if label[k] != u16::MAX {
                image.data[y * cw + x] = [0, 1, 2].map(|c| out.data[k * 3 + c].exp());
                alpha.data[y * cw + x] = 1.0;
            }
        }
    }
    progress("Finishing", 0.0);
    let (mut image, alpha) = finish::boundary_warp(&image, &alpha, opts.boundary_warp / 100.0);
    let crop = if opts.auto_crop {
        finish::coverage_crop(&alpha)
    } else {
        None
    };
    if opts.fill_edges {
        image = finish::fill_edges(&image, &alpha)?;
    }
    progress("Finishing", 1.0);
    log::line(&format!("composed {}x{} crop {:?}", cw, ch, crop));
    let mut label_out = vec![u16::MAX; cw * ch];
    for y in 0..ch {
        label_out[y * cw..(y + 1) * cw].copy_from_slice(&label[y * pw..y * pw + cw]);
    }
    Ok(Composed {
        image,
        alpha,
        label: label_out,
        crop,
        projection,
        focal: f_out,
        scale: memory_scale,
        saved_quality: 1.0,
        saved_attempts: 1,
        gains,
        width: cw,
        height: ch,
    })
}

fn compensate_gains(tiles: &[Option<Tile>], gains: &mut [f64], frames: &[Frame]) {
    let n = tiles.len();
    let lum = |p: [f32; 3]| 0.25 * p[0] as f64 + 0.6 * p[1] as f64 + 0.15 * p[2] as f64;
    let mut nij = vec![0f64; n * n];
    let mut iij = vec![0f64; n * n];
    for i in 0..n {
        let Some(a) = &tiles[i] else { continue };
        for j in 0..n {
            let Some(b) = tiles[j].as_ref().filter(|_| i != j) else {
                continue;
            };
            let (x0, y0) = (a.x0.max(b.x0), a.y0.max(b.y0));
            let (x1, y1) = ((a.x0 + a.w).min(b.x0 + b.w), (a.y0 + a.h).min(b.y0 + b.h));
            let (mut cnt, mut sum) = (0usize, 0f64);
            for y in (y0..y1).step_by(2) {
                for x in (x0..x1).step_by(2) {
                    let ka = (y - a.y0) * a.w + x - a.x0;
                    let kb = (y - b.y0) * b.w + x - b.x0;
                    if a.wgt[ka] > 0.0 && b.wgt[kb] > 0.0 {
                        let pa = [a.rgb[ka * 3], a.rgb[ka * 3 + 1], a.rgb[ka * 3 + 2]];
                        if pa.iter().any(|v| *v >= frames[i].clip * 0.95)
                            || [b.rgb[kb * 3], b.rgb[kb * 3 + 1], b.rgb[kb * 3 + 2]]
                                .iter()
                                .any(|v| *v >= frames[j].clip * 0.95)
                        {
                            continue;
                        }
                        cnt += 1;
                        sum += lum(pa);
                    }
                }
            }
            if cnt > 50 {
                nij[i * n + j] = cnt as f64;
                iij[i * n + j] = sum / cnt as f64;
            }
        }
    }
    let total: f64 = nij.iter().sum();
    if total <= 0.0 {
        return;
    }
    let mean = (0..n * n)
        .map(|k| nij[k] * iij[k] * gains[k / n])
        .sum::<f64>()
        / total;
    if mean <= 0.0 {
        return;
    }
    let (sn, sg) = (0.1f64, 1.0f64);
    let g0: Vec<f64> = gains.to_vec();
    let mut a = vec![0f64; n * n];
    let mut b = vec![0f64; n];
    for i in 0..n {
        if tiles[i].is_none() {
            a[i * n + i] = 1.0;
            b[i] = g0[i];
            continue;
        }
        for j in 0..n {
            let nn = nij[i * n + j];
            if nn <= 0.0 || nij[j * n + i] <= 0.0 {
                continue;
            }
            let (ii, ij) = (iij[i * n + j] / mean, iij[j * n + i] / mean);
            a[i * n + i] += 2.0 * nn * ii * ii / (sn * sn);
            a[i * n + j] -= 2.0 * nn * ii * ij / (sn * sn);
            a[i * n + i] += 2.0 * nn / (sg * sg * g0[i] * g0[i]);
            b[i] += 2.0 * nn / (sg * sg * g0[i]);
        }
        if a[i * n + i] == 0.0 {
            a[i * n + i] = 1.0;
            b[i] = g0[i];
        }
    }
    if let Some(g) = linalg::solve(a, b, n)
        && g.iter().all(|v| v.is_finite() && *v > 0.0)
    {
        gains.copy_from_slice(&g);
    }
}
