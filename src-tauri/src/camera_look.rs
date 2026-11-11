use std::collections::hash_map::DefaultHasher;
use std::fmt::Write as _;
use std::fs::{create_dir_all, write};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use image::{DynamicImage, Rgb32FImage};
use nalgebra::{DMatrix, Matrix3, Vector3};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, State};

use crate::AppState;
use crate::app_state::LoadedImage;
use crate::cache_utils::calculate_transform_hash;
use crate::file_management::{parse_virtual_path, try_load_embedded_raw_preview};
use crate::image_processing::{
    RenderRequest, get_all_adjustments_from_json, process_and_get_dynamic_image,
    resolve_render_options_from_handle,
};

const RENDER_DIM: u32 = 720;
const MIN_PREVIEW_DIM: u32 = 640;
const FIT_WIDTH: usize = 240;
const CENTER_MARGIN: f64 = 0.15;
const MAX_ASPECT_MISMATCH: f64 = 0.25;
const MIN_ALIGNMENT: f64 = 0.5;
const GAMMA: f64 = 2.2;
const CURVE_KNOTS: usize = 48;
const CURVE_SMOOTHNESS: f64 = 9.0;
const FIT_ITERATIONS: usize = 20;
const CLIP_LOW: f64 = 0.02;
const CLIP_HIGH: f64 = 0.98;
const RESIDUAL_GRID: usize = 9;
const RESIDUAL_SMOOTHNESS: f64 = 0.36;
const RESIDUAL_RIDGE: f64 = 0.0025;
const OUTPUT_GRID: usize = 33;

type Rgb = [f64; 3];

struct Samples {
    input: Vec<Rgb>,
    target: Vec<Rgb>,
}

struct CameraLook {
    matrix: Matrix3<f64>,
    knot_step: f64,
    curve: Vec<f64>,
    residual: Vec<Rgb>,
}

fn encode(v: f64) -> f64 {
    v.max(0.0).powf(1.0 / GAMMA)
}

fn decode(v: f64) -> f64 {
    v.max(0.0).powf(GAMMA)
}

fn luma(rgb: &Rgb) -> f64 {
    0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
}

fn box_downsample(image: &Rgb32FImage, width: usize, height: usize) -> Vec<Rgb> {
    let (src_w, src_h) = (image.width() as usize, image.height() as usize);
    let mut out = Vec::with_capacity(width * height);
    for y in 0..height {
        let y0 = y * src_h / height;
        let y1 = ((y + 1) * src_h / height).max(y0 + 1);
        for x in 0..width {
            let x0 = x * src_w / width;
            let x1 = ((x + 1) * src_w / width).max(x0 + 1);
            let mut sum = [0.0; 3];
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let p = image.get_pixel(sx as u32, sy as u32);
                    for c in 0..3 {
                        sum[c] += p[c] as f64;
                    }
                }
            }
            let n = ((y1 - y0) * (x1 - x0)) as f64;
            out.push([sum[0] / n, sum[1] / n, sum[2] / n]);
        }
    }
    out
}

fn crop_to_aspect(image: DynamicImage, aspect: f64) -> DynamicImage {
    let (w, h) = (image.width(), image.height());
    if w as f64 / h as f64 > aspect {
        let new_w = (h as f64 * aspect).round() as u32;
        image.crop_imm((w - new_w) / 2, 0, new_w, h)
    } else {
        let new_h = (w as f64 / aspect).round() as u32;
        image.crop_imm(0, (h - new_h) / 2, w, new_h)
    }
}

fn correlation(a: &[Rgb], b: &[Rgb]) -> f64 {
    let n = a.len() as f64;
    let la: Vec<f64> = a.iter().map(luma).collect();
    let lb: Vec<f64> = b.iter().map(luma).collect();
    let ma = la.iter().sum::<f64>() / n;
    let mb = lb.iter().sum::<f64>() / n;
    let (mut cov, mut va, mut vb) = (0.0, 0.0, 0.0);
    for (x, y) in la.iter().zip(&lb) {
        cov += (x - ma) * (y - mb);
        va += (x - ma) * (x - ma);
        vb += (y - mb) * (y - mb);
    }
    cov / (va.sqrt() * vb.sqrt()).max(1e-12)
}

fn paired_samples(render: &Rgb32FImage, preview: &DynamicImage) -> Option<Samples> {
    let aspect = render.width() as f64 / render.height() as f64;
    let height = ((FIT_WIDTH as f64 / aspect).round() as usize).max(1);
    let input = box_downsample(render, FIT_WIDTH, height);

    let mut rotated = preview.clone();
    let mut best: Option<(f64, Vec<Rgb>)> = None;
    for _ in 0..4 {
        let preview_aspect = rotated.width() as f64 / rotated.height() as f64;
        if (preview_aspect - aspect).abs() / aspect <= MAX_ASPECT_MISMATCH {
            let candidate = box_downsample(
                &crop_to_aspect(rotated.clone(), aspect).to_rgb32f(),
                FIT_WIDTH,
                height,
            );
            let score = correlation(&input, &candidate);
            if best.as_ref().is_none_or(|(s, _)| score > *s) {
                best = Some((score, candidate));
            }
        }
        rotated = rotated.rotate90();
    }

    let (score, target) = best?;
    if score < MIN_ALIGNMENT {
        return None;
    }

    let margin_x = (FIT_WIDTH as f64 * CENTER_MARGIN) as usize;
    let margin_y = (height as f64 * CENTER_MARGIN) as usize;
    let mut samples = Samples {
        input: Vec::new(),
        target: Vec::new(),
    };
    for y in margin_y..height - margin_y {
        for x in margin_x..FIT_WIDTH - margin_x {
            samples.input.push(input[y * FIT_WIDTH + x]);
            samples.target.push(target[y * FIT_WIDTH + x]);
        }
    }
    Some(samples)
}

fn solve_spd(matrix: DMatrix<f64>, rhs: DMatrix<f64>) -> Result<DMatrix<f64>, String> {
    matrix
        .cholesky()
        .map(|c| c.solve(&rhs))
        .ok_or_else(|| "Camera look fit did not converge".to_string())
}

fn hat_weights(value: f64, step: f64, knots: usize) -> (usize, f64) {
    let p = (value / step).clamp(0.0, (knots - 1) as f64 - 1e-9);
    let i = p.floor() as usize;
    (i, p - i as f64)
}

fn trilinear_weights(rgb: &Rgb, grid: usize) -> [(usize, f64); 8] {
    let scale = (grid - 1) as f64;
    let mut base = [0usize; 3];
    let mut frac = [0.0; 3];
    for c in 0..3 {
        let q = rgb[c].clamp(0.0, 1.0) * scale;
        base[c] = (q.floor() as usize).min(grid - 2);
        frac[c] = q - base[c] as f64;
    }
    let mut out = [(0usize, 0.0); 8];
    for (corner, slot) in out.iter_mut().enumerate() {
        let d = [corner & 1, (corner >> 1) & 1, (corner >> 2) & 1];
        let mut weight = 1.0;
        for c in 0..3 {
            weight *= if d[c] == 1 { frac[c] } else { 1.0 - frac[c] };
        }
        let index = ((base[2] + d[2]) * grid + (base[1] + d[1])) * grid + (base[0] + d[0]);
        *slot = (index, weight);
    }
    out
}

impl CameraLook {
    fn encoded(&self, rgb: &Rgb) -> Rgb {
        let mixed = self.matrix * Vector3::new(decode(rgb[0]), decode(rgb[1]), decode(rgb[2]));
        [encode(mixed[0]), encode(mixed[1]), encode(mixed[2])]
    }

    fn tone(&self, value: f64) -> f64 {
        let (i, f) = hat_weights(value, self.knot_step, CURVE_KNOTS);
        self.curve[i] * (1.0 - f) + self.curve[i + 1] * f
    }

    fn inverse_tone(&self, value: f64) -> f64 {
        let i = self
            .curve
            .partition_point(|&v| v < value)
            .clamp(1, CURVE_KNOTS - 1);
        let (lo, hi) = (self.curve[i - 1], self.curve[i]);
        let f = ((value - lo) / (hi - lo)).clamp(0.0, 1.0);
        (i - 1) as f64 * self.knot_step + f * self.knot_step
    }

    fn base(&self, rgb: &Rgb) -> Rgb {
        let e = self.encoded(rgb);
        [self.tone(e[0]), self.tone(e[1]), self.tone(e[2])]
    }

    fn apply(&self, rgb: &Rgb) -> Rgb {
        let base = self.base(rgb);
        let mut out = base;
        if !self.residual.is_empty() {
            for (index, weight) in trilinear_weights(&base, RESIDUAL_GRID) {
                for (value, delta) in out.iter_mut().zip(self.residual[index]) {
                    *value += delta * weight;
                }
            }
        }
        out.map(|v| v.clamp(0.0, 1.0))
    }

    fn fit_curve(&mut self, samples: &Samples) -> Result<(), String> {
        let encoded: Vec<Rgb> = samples.input.iter().map(|p| self.encoded(p)).collect();
        let mut values: Vec<f64> = encoded.iter().flatten().copied().collect();
        values.sort_by(f64::total_cmp);
        let top = values[((values.len() - 1) as f64 * 0.999) as usize].max(1e-3) * 1.05;
        self.knot_step = top / (CURVE_KNOTS - 1) as f64;

        let mut normal = DMatrix::<f64>::zeros(CURVE_KNOTS, CURVE_KNOTS);
        let mut rhs = DMatrix::<f64>::zeros(CURVE_KNOTS, 1);
        for (e, y) in encoded.iter().zip(&samples.target) {
            for c in 0..3 {
                let (i, f) = hat_weights(e[c], self.knot_step, CURVE_KNOTS);
                let w = [(i, 1.0 - f), (i + 1, f)];
                for &(a, wa) in &w {
                    rhs[a] += wa * y[c];
                    for &(b, wb) in &w {
                        normal[(a, b)] += wa * wb;
                    }
                }
            }
        }
        let lambda = CURVE_SMOOTHNESS * (encoded.len() * 3) as f64 / CURVE_KNOTS as f64;
        for k in 0..CURVE_KNOTS - 2 {
            let d = [(k, 1.0), (k + 1, -2.0), (k + 2, 1.0)];
            for &(a, wa) in &d {
                for &(b, wb) in &d {
                    normal[(a, b)] += lambda * wa * wb;
                }
            }
        }
        let solution = solve_spd(normal, rhs)?;
        let mut running = 0.0f64;
        self.curve = (0..CURVE_KNOTS)
            .map(|k| {
                running = running.max(solution[k].clamp(0.0, 1.0));
                running + k as f64 * 1e-6
            })
            .collect();
        Ok(())
    }

    fn fit_matrix(&mut self, samples: &Samples) {
        let mut xtx = Matrix3::<f64>::zeros();
        let mut xty = Matrix3::<f64>::zeros();
        for (x, y) in samples.input.iter().zip(&samples.target) {
            if y.iter().any(|&v| !(CLIP_LOW..=CLIP_HIGH).contains(&v)) {
                continue;
            }
            let lin = Vector3::new(decode(x[0]), decode(x[1]), decode(x[2]));
            let tgt = Vector3::new(
                decode(self.inverse_tone(y[0])),
                decode(self.inverse_tone(y[1])),
                decode(self.inverse_tone(y[2])),
            );
            xtx += lin * lin.transpose();
            xty += lin * tgt.transpose();
        }
        if let Some(inverse) = xtx.try_inverse() {
            self.matrix = (inverse * xty).transpose();
        }
    }

    fn fit_residual(&mut self, samples: &Samples) -> Result<(), String> {
        let cells = RESIDUAL_GRID.pow(3);
        let mut normal = DMatrix::<f64>::zeros(cells, cells);
        let mut rhs = DMatrix::<f64>::zeros(cells, 3);
        for (x, y) in samples.input.iter().zip(&samples.target) {
            let base = self.base(x);
            let weights = trilinear_weights(&base, RESIDUAL_GRID);
            for &(a, wa) in &weights {
                for c in 0..3 {
                    rhs[(a, c)] += wa * (y[c] - base[c]);
                }
                for &(b, wb) in &weights {
                    normal[(a, b)] += wa * wb;
                }
            }
        }
        let density = samples.input.len() as f64 / cells as f64;
        let smooth = RESIDUAL_SMOOTHNESS * density;
        let index = |r: usize, g: usize, b: usize| (b * RESIDUAL_GRID + g) * RESIDUAL_GRID + r;
        for b in 0..RESIDUAL_GRID {
            for g in 0..RESIDUAL_GRID {
                for r in 0..RESIDUAL_GRID {
                    let a = index(r, g, b);
                    normal[(a, a)] += RESIDUAL_RIDGE * density;
                    for (dr, dg, db) in [(1, 0, 0), (0, 1, 0), (0, 0, 1)] {
                        let (r2, g2, b2) = (r + dr, g + dg, b + db);
                        if r2 < RESIDUAL_GRID && g2 < RESIDUAL_GRID && b2 < RESIDUAL_GRID {
                            let n = index(r2, g2, b2);
                            normal[(a, a)] += smooth;
                            normal[(n, n)] += smooth;
                            normal[(a, n)] -= smooth;
                            normal[(n, a)] -= smooth;
                        }
                    }
                }
            }
        }
        let solution = solve_spd(normal, rhs)?;
        self.residual = (0..cells)
            .map(|i| [solution[(i, 0)], solution[(i, 1)], solution[(i, 2)]])
            .collect();
        Ok(())
    }

    fn fit(samples: &Samples) -> Result<Self, String> {
        let mut look = CameraLook {
            matrix: Matrix3::identity(),
            knot_step: 1.0 / (CURVE_KNOTS - 1) as f64,
            curve: Vec::new(),
            residual: Vec::new(),
        };
        for _ in 0..FIT_ITERATIONS {
            look.fit_curve(samples)?;
            look.fit_matrix(samples);
        }
        look.fit_curve(samples)?;
        look.fit_residual(samples)?;
        Ok(look)
    }

    fn to_cube(&self) -> String {
        let scale = (OUTPUT_GRID - 1) as f64;
        let mut cube = format!("TITLE \"Camera look\"\nLUT_3D_SIZE {}\n", OUTPUT_GRID);
        for b in 0..OUTPUT_GRID {
            for g in 0..OUTPUT_GRID {
                for r in 0..OUTPUT_GRID {
                    let out = self.apply(&[r as f64 / scale, g as f64 / scale, b as f64 / scale]);
                    let _ = writeln!(cube, "{:.6} {:.6} {:.6}", out[0], out[1], out[2]);
                }
            }
        }
        cube
    }
}

fn render_without_look(
    app_handle: &AppHandle,
    state: &State<AppState>,
    loaded_image: &LoadedImage,
    mut js_adjustments: Value,
) -> Result<Rgb32FImage, String> {
    let context = crate::image_processing::get_or_init_gpu_context(state, app_handle)?;
    let base_json = json!({});
    let (base_image, _scale, _offset) =
        crate::generate_transformed_preview(state, loaded_image, &base_json, RENDER_DIM)?;

    if let Some(object) = js_adjustments.as_object_mut() {
        object.remove("lutPath");
        object.insert("grainAmount".to_string(), json!(0));
        object.insert("masks".to_string(), json!([]));
    }
    let render = resolve_render_options_from_handle(app_handle, loaded_image.is_raw);
    let adjustments = get_all_adjustments_from_json(
        &js_adjustments,
        loaded_image.is_raw,
        loaded_image.as_shot,
        render,
    );

    let processed = process_and_get_dynamic_image(
        &context,
        state,
        &base_image,
        calculate_transform_hash(&base_json),
        RenderRequest {
            adjustments,
            mask_bitmaps: &[],
            mask_cache_key: None,
            lut: None,
            roi: None,
        },
        "fit_camera_look",
    )?;
    Ok(processed.to_rgb32f())
}

fn look_path(app_handle: &AppHandle, source_path: &Path) -> Result<PathBuf, String> {
    let mut hasher = DefaultHasher::new();
    source_path.hash(&mut hasher);
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("camera_looks")
        .join(format!("{:016x}", hasher.finish()));
    create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = source_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("image");
    Ok(dir.join(format!("{} camera look.cube", stem)))
}

#[tauri::command]
pub async fn fit_camera_look(
    js_adjustments: Value,
    app_handle: AppHandle,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let loaded_image = state
            .original_image
            .lock()
            .unwrap()
            .clone()
            .ok_or("No image loaded")?;
        if !loaded_image.is_raw {
            return Err("Camera look matching needs a raw file".to_string());
        }
        let source_path = parse_virtual_path(&loaded_image.path).0;
        let preview = try_load_embedded_raw_preview(&source_path, MIN_PREVIEW_DIM)
            .ok_or("No embedded camera JPEG found in this raw")?;
        let render = render_without_look(&app_handle, &state, &loaded_image, js_adjustments)?;
        let samples = paired_samples(&render, &preview)
            .ok_or("The embedded camera JPEG does not line up with the raw")?;
        let look = CameraLook::fit(&samples)?;
        let output = look_path(&app_handle, &source_path)?;
        write(&output, look.to_cube()).map_err(|e| e.to_string())?;
        Ok(output.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}
