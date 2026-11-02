use std::path::Path;
use std::sync::Mutex;

use anyhow::{Result, anyhow};
use image::RgbImage;
use image::imageops::{self, FilterType};
use ndarray::Array4;
use ort::session::Session;
use ort::value::Tensor;
use rayon::prelude::*;

const DETECTOR_SIZE: u32 = 640;
const DETECTOR_SCORE_THRESHOLD: f32 = 0.6;
const DETECTOR_CONFIDENT_SCORE: f32 = 0.75;
const DETECTOR_NMS_IOU: f32 = 0.3;
const MAX_FACES: usize = 10;

const PARSER_SIZE: usize = 512;
const PARSER_CLASSES: usize = 19;

// CelebAMask-HQ class indices produced by the parsing model.
const SKIN: usize = 1;
const LEFT_BROW: usize = 2;
const RIGHT_BROW: usize = 3;
const LEFT_EYE: usize = 4;
const RIGHT_EYE: usize = 5;
const GLASSES: usize = 6;
const LEFT_EAR: usize = 7;
const RIGHT_EAR: usize = 8;
const EARRING: usize = 9;
const NOSE: usize = 10;
const MOUTH: usize = 11;
const UPPER_LIP: usize = 12;
const LOWER_LIP: usize = 13;
const NECK: usize = 14;
const HAIR: usize = 17;
const HAT: usize = 18;

pub struct FaceModels {
    pub detector: Mutex<Session>,
    pub parser: Mutex<Session>,
}

/// Loads the parsing model on the GPU when that works and gives the same answer as the
/// CPU, and on the CPU otherwise.
pub fn load_face_parser_session(model_path: &Path) -> Result<Session> {
    let cpu_session = Session::builder()?.commit_from_file(model_path)?;

    #[cfg(target_os = "windows")]
    let cpu_session = {
        let mut cpu_session = cpu_session;
        match build_gpu_parser_session(model_path, &mut cpu_session) {
            Ok(session) => {
                log::info!("Face parsing model running on GPU (DirectML)");
                return Ok(session);
            }
            Err(e) => log::warn!("GPU face parsing unavailable, falling back to CPU: {}", e),
        }
        cpu_session
    };

    Ok(cpu_session)
}

#[cfg(target_os = "windows")]
fn build_gpu_parser_session(model_path: &Path, cpu_session: &mut Session) -> Result<Session> {
    use ort::execution_providers::DirectMLExecutionProvider;

    let mut gpu_session = Session::builder()?
        .with_memory_pattern(false)?
        .with_parallel_execution(false)?
        .with_execution_providers([DirectMLExecutionProvider::default()
            .build()
            .error_on_failure()])?
        .commit_from_file(model_path)?;

    // A fixed, face-free pattern is enough to tell a broken GPU path from a working one.
    let probe = Array4::<f32>::from_shape_fn((1, 3, PARSER_SIZE, PARSER_SIZE), |(_, c, y, x)| {
        ((x * 7 + y * 13 + c * 29) % 97) as f32 / 48.0 - 1.0
    });
    let run = |session: &mut Session| -> Result<Vec<f32>> {
        let tensor = Tensor::from_array(probe.clone().into_dyn())?;
        let outputs = session.run(ort::inputs![tensor])?;
        Ok(outputs[0]
            .try_extract_array::<f32>()?
            .iter()
            .copied()
            .collect())
    };
    let expected = run(cpu_session)?;
    let actual = run(&mut gpu_session)?;

    let area = PARSER_SIZE * PARSER_SIZE;
    if actual.len() != expected.len() || actual.len() != PARSER_CLASSES * area {
        return Err(anyhow!("GPU face parsing returned an unexpected shape"));
    }
    let winner = |logits: &[f32], i: usize| {
        (0..PARSER_CLASSES)
            .max_by(|&a, &b| logits[a * area + i].total_cmp(&logits[b * area + i]))
            .unwrap_or(0)
    };
    let disagreements = (0..area)
        .filter(|&i| winner(&expected, i) != winner(&actual, i))
        .count();
    if disagreements * 100 > area {
        return Err(anyhow!(
            "GPU face parsing self-check failed ({} of {} pixels differ)",
            disagreements,
            area
        ));
    }
    Ok(gpu_session)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaceRegion {
    Skin,
    Eyes,
    EyeWhites,
    Teeth,
    /// Everything on a head that is not skin. Used to protect features while retouching.
    Features,
    /// Forehead and cheeks: the skin where spots are removed. The nose, the nasolabial
    /// folds, the area around the mouth, the chin, the ears and the neck are left out.
    BlemishZone,
}

impl FaceRegion {
    fn classes(self) -> &'static [usize] {
        match self {
            Self::Skin => &[SKIN, NOSE, LEFT_EAR, RIGHT_EAR, NECK],
            Self::Eyes | Self::EyeWhites => &[LEFT_EYE, RIGHT_EYE],
            Self::Teeth => &[MOUTH],
            Self::BlemishZone => &[SKIN],
            Self::Features => &[
                LEFT_BROW, RIGHT_BROW, LEFT_EYE, RIGHT_EYE, GLASSES, EARRING, MOUTH, UPPER_LIP,
                LOWER_LIP, HAIR, HAT,
            ],
        }
    }

    /// Luma and saturation limits that separate teeth from the rest of the mouth and
    /// the whites of the eyes from the iris.
    fn bright_neutral_limits(self) -> Option<([f32; 2], [f32; 2])> {
        match self {
            Self::Teeth => Some(([0.18, 0.38], [0.30, 0.55])),
            Self::EyeWhites => Some(([0.25, 0.45], [0.18, 0.38])),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct Detection {
    score: f32,
    /// x, y, width, height
    bbox: [f32; 4],
    /// right eye, left eye, nose, right mouth corner, left mouth corner
    landmarks: [[f32; 2]; 5],
}

impl Detection {
    fn map_points(&self, f: impl Fn([f32; 2]) -> [f32; 2]) -> Self {
        let [x, y, w, h] = self.bbox;
        let a = f([x, y]);
        let b = f([x + w, y + h]);
        Self {
            score: self.score,
            bbox: [
                a[0].min(b[0]),
                a[1].min(b[1]),
                (a[0] - b[0]).abs(),
                (a[1] - b[1]).abs(),
            ],
            landmarks: self.landmarks.map(&f),
        }
    }

    fn iou(&self, other: &Self) -> f32 {
        let [ax, ay, aw, ah] = self.bbox;
        let [bx, by, bw, bh] = other.bbox;
        let iw = ((ax + aw).min(bx + bw) - ax.max(bx)).max(0.0);
        let ih = ((ay + ah).min(by + bh) - ay.max(by)).max(0.0);
        let inter = iw * ih;
        inter / (aw * ah + bw * bh - inter).max(1e-6)
    }
}

/// A face cut out of the image, upright and scaled the way the parsing model expects,
/// together with the per-class probabilities the model returned for it.
#[derive(Clone)]
pub struct ParsedFace {
    center: [f32; 2],
    x_dir: [f32; 2],
    half: f32,
    /// Approximate width of the face in image pixels.
    pub width: f32,
    /// The detector's landmarks in crop coordinates: right eye, left eye, nose, right
    /// mouth corner, left mouth corner.
    landmarks: [[f32; 2]; 5],
    /// `PARSER_CLASSES` planes of `PARSER_SIZE * PARSER_SIZE` probabilities.
    probs: Vec<u8>,
}

impl ParsedFace {
    fn y_dir(&self) -> [f32; 2] {
        [-self.x_dir[1], self.x_dir[0]]
    }

    fn crop_to_image(&self, u: f32, v: f32) -> [f32; 2] {
        let half_size = PARSER_SIZE as f32 / 2.0;
        let a = (u / half_size - 1.0) * self.half;
        let b = (v / half_size - 1.0) * self.half;
        let y_dir = self.y_dir();
        [
            self.center[0] + self.x_dir[0] * a + y_dir[0] * b,
            self.center[1] + self.x_dir[1] * a + y_dir[1] * b,
        ]
    }

    fn image_to_crop(&self, point: [f32; 2]) -> [f32; 2] {
        let half_size = PARSER_SIZE as f32 / 2.0;
        let (dx, dy) = (point[0] - self.center[0], point[1] - self.center[1]);
        let y_dir = self.y_dir();
        let a = (dx * self.x_dir[0] + dy * self.x_dir[1]) / self.half;
        let b = (dx * y_dir[0] + dy * y_dir[1]) / self.half;
        [(a + 1.0) * half_size, (b + 1.0) * half_size]
    }

    /// How much the crop position (`u`, `v`) belongs to the forehead or the cheeks.
    fn blemish_zone_weight(&self, u: f32, v: f32) -> f32 {
        let [right_eye, left_eye, nose, right_mouth, left_mouth] = self.landmarks;
        let eye_y = (right_eye[1] + left_eye[1]) * 0.5;
        let mouth_y = (right_mouth[1] + left_mouth[1]) * 0.5;
        // The eye distance collapses on turned heads, so the face height backs it up.
        let unit = (left_eye[0] - right_eye[0])
            .abs()
            .max((mouth_y - eye_y) * 0.8)
            .max(8.0);

        let forehead = 1.0 - smoothstep(eye_y - 0.45 * unit, eye_y - 0.30 * unit, v);
        let cheek_top = eye_y + 0.20 * unit;
        let below_eyes = smoothstep(cheek_top, eye_y + 0.35 * unit, v);
        let above_mouth = 1.0 - smoothstep(mouth_y - 0.15 * unit, mouth_y, v);

        // The cheek starts outside the nasolabial fold, which runs from the wing of the
        // nose down to just outside the corner of the mouth.
        let mouth_corner = if u < nose[0] { right_mouth } else { left_mouth };
        let at_nose = 0.50 * unit;
        let at_mouth = (mouth_corner[0] - nose[0]).abs() + 0.22 * unit;
        let fold = if v <= nose[1] {
            let t = ((v - cheek_top) / (nose[1] - cheek_top).max(1.0)).clamp(0.0, 1.0);
            0.30 * unit + t * (at_nose - 0.30 * unit)
        } else {
            let t = ((v - nose[1]) / (mouth_y - nose[1]).max(1.0)).clamp(0.0, 1.0);
            at_nose + t * (at_mouth - at_nose)
        };
        let outside_fold = smoothstep(fold, fold + 0.12 * unit, (u - nose[0]).abs());

        forehead.max(below_eyes * above_mouth * outside_fold)
    }

    /// Image-space position that identifies this face.
    pub fn center(&self) -> [f32; 2] {
        self.center
    }

    /// Small upright portrait of the face, for listing it in the interface.
    pub fn thumbnail(&self, image: &RgbImage, size: u32) -> RgbImage {
        let (width, height) = image.dimensions();
        RgbImage::from_fn(size, size, |i, j| {
            let to_crop =
                |t: u32| ((t as f32 + 0.5) / size as f32 * 0.6 + 0.2) * PARSER_SIZE as f32;
            let [x, y] = self.crop_to_image(to_crop(i), to_crop(j));
            if x >= 0.0 && y >= 0.0 && x < width as f32 && y < height as f32 {
                *image.get_pixel(x as u32, y as u32)
            } else {
                image::Rgb([0, 0, 0])
            }
        })
    }

    /// Image-space bounding box of the analyzed crop: min x, min y, max x, max y.
    pub fn bounds(&self) -> [f32; 4] {
        let size = PARSER_SIZE as f32;
        let corners = [[0.0, 0.0], [size, 0.0], [0.0, size], [size, size]]
            .map(|[u, v]| self.crop_to_image(u, v));
        let mut b = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
        for [x, y] in corners {
            b = [b[0].min(x), b[1].min(y), b[2].max(x), b[3].max(y)];
        }
        b
    }

    fn region_plane(&self, region: FaceRegion) -> Vec<f32> {
        let area = PARSER_SIZE * PARSER_SIZE;
        let mut plane = vec![0.0_f32; area];
        for &class in region.classes() {
            let probs = &self.probs[class * area..(class + 1) * area];
            plane
                .iter_mut()
                .zip(probs)
                .for_each(|(out, &p)| *out += p as f32 / 255.0);
        }
        plane.iter_mut().for_each(|v| *v = v.min(1.0));
        if region == FaceRegion::BlemishZone {
            for (i, value) in plane.iter_mut().enumerate() {
                let (u, v) = ((i % PARSER_SIZE) as f32, (i / PARSER_SIZE) as f32);
                *value *= self.blemish_zone_weight(u + 0.5, v + 0.5);
            }
        }
        plane
    }
}

fn run_detector(session: &Mutex<Session>, canvas: &RgbImage) -> Result<Vec<Detection>> {
    let size = DETECTOR_SIZE as usize;
    let mut input = Array4::<f32>::zeros((1, 3, size, size));
    for (x, y, pixel) in canvas.enumerate_pixels() {
        let (x, y) = (x as usize, y as usize);
        input[[0, 0, y, x]] = pixel[2] as f32;
        input[[0, 1, y, x]] = pixel[1] as f32;
        input[[0, 2, y, x]] = pixel[0] as f32;
    }
    let tensor = Tensor::from_array(input.into_dyn())?;

    let mut session = session.lock().unwrap();
    let outputs = session.run(ort::inputs![tensor])?;

    let mut detections = Vec::new();
    for stride in [8_usize, 16, 32] {
        let cols = size / stride;
        let read = |name: String| -> Result<Vec<f32>> {
            Ok(outputs[name.as_str()]
                .try_extract_array::<f32>()?
                .iter()
                .copied()
                .collect())
        };
        let cls = read(format!("cls_{stride}"))?;
        let obj = read(format!("obj_{stride}"))?;
        let bbox = read(format!("bbox_{stride}"))?;
        let kps = read(format!("kps_{stride}"))?;
        if cls.len() != cols * cols || bbox.len() != cls.len() * 4 || kps.len() != cls.len() * 10 {
            return Err(anyhow!("Unexpected face detector output shape"));
        }

        let stride_f = stride as f32;
        for i in 0..cls.len() {
            let score = (cls[i].clamp(0.0, 1.0) * obj[i].clamp(0.0, 1.0)).sqrt();
            if score < DETECTOR_SCORE_THRESHOLD {
                continue;
            }
            let col = (i % cols) as f32;
            let row = (i / cols) as f32;
            let b = &bbox[i * 4..i * 4 + 4];
            let cx = (col + b[0]) * stride_f;
            let cy = (row + b[1]) * stride_f;
            let w = b[2].exp() * stride_f;
            let h = b[3].exp() * stride_f;

            let k = &kps[i * 10..i * 10 + 10];
            let mut landmarks = [[0.0_f32; 2]; 5];
            for (n, point) in landmarks.iter_mut().enumerate() {
                *point = [(k[n * 2] + col) * stride_f, (k[n * 2 + 1] + row) * stride_f];
            }
            detections.push(Detection {
                score,
                bbox: [cx - w / 2.0, cy - h / 2.0, w, h],
                landmarks,
            });
        }
    }
    Ok(detections)
}

/// Finds faces in any of the four 90 degree orientations, since raw files are analyzed
/// before their orientation is applied.
fn detect_faces(image: &RgbImage, session: &Mutex<Session>) -> Result<Vec<Detection>> {
    let (width, height) = image.dimensions();
    let scale = DETECTOR_SIZE as f32 / width.max(height) as f32;
    let small_w = ((width as f32 * scale).round() as u32).clamp(1, DETECTOR_SIZE);
    let small_h = ((height as f32 * scale).round() as u32).clamp(1, DETECTOR_SIZE);
    let small = imageops::resize(image, small_w, small_h, FilterType::Triangle);
    let (sw, sh) = (small_w as f32, small_h as f32);

    let mut found: Vec<Detection> = Vec::new();
    for turns in 0..4 {
        let rotated = match turns {
            0 => small.clone(),
            1 => imageops::rotate90(&small),
            2 => imageops::rotate180(&small),
            _ => imageops::rotate270(&small),
        };
        let mut canvas = RgbImage::new(DETECTOR_SIZE, DETECTOR_SIZE);
        imageops::replace(&mut canvas, &rotated, 0, 0);

        for detection in run_detector(session, &canvas)? {
            let upright = detection.map_points(|[x, y]| match turns {
                0 => [x, y],
                1 => [y, sh - x],
                2 => [sw - x, sh - y],
                _ => [sw - y, x],
            });
            found.push(upright.map_points(|[x, y]| [x / scale, y / scale]));
        }

        if turns == 0 && found.iter().any(|d| d.score >= DETECTOR_CONFIDENT_SCORE) {
            break;
        }
    }

    found.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut kept: Vec<Detection> = Vec::new();
    for detection in found {
        if kept.iter().all(|k| k.iou(&detection) <= DETECTOR_NMS_IOU) {
            kept.push(detection);
        }
    }

    let min_size = width.max(height) as f32 * 0.02;
    kept.retain(|d| d.bbox[2].max(d.bbox[3]) >= min_size);
    kept.sort_by(|a, b| (b.bbox[2] * b.bbox[3]).total_cmp(&(a.bbox[2] * a.bbox[3])));
    kept.truncate(MAX_FACES);
    Ok(kept)
}

/// Same framing as the aligned portraits the parsing model was trained on.
fn align_face(detection: &Detection) -> ParsedFace {
    let [right_eye, left_eye, _, right_mouth, left_mouth] = detection.landmarks;
    let eye_avg = [
        (right_eye[0] + left_eye[0]) * 0.5,
        (right_eye[1] + left_eye[1]) * 0.5,
    ];
    let mouth_avg = [
        (right_mouth[0] + left_mouth[0]) * 0.5,
        (right_mouth[1] + left_mouth[1]) * 0.5,
    ];
    let eye_to_eye = [left_eye[0] - right_eye[0], left_eye[1] - right_eye[1]];
    let eye_to_mouth = [mouth_avg[0] - eye_avg[0], mouth_avg[1] - eye_avg[1]];

    let x = [
        eye_to_eye[0] + eye_to_mouth[1],
        eye_to_eye[1] - eye_to_mouth[0],
    ];
    let x_len = x[0].hypot(x[1]).max(1e-3);
    let eye_dist = eye_to_eye[0].hypot(eye_to_eye[1]);
    let mouth_dist = eye_to_mouth[0].hypot(eye_to_mouth[1]);

    let mut face = ParsedFace {
        center: [
            eye_avg[0] + eye_to_mouth[0] * 0.1,
            eye_avg[1] + eye_to_mouth[1] * 0.1,
        ],
        x_dir: [x[0] / x_len, x[1] / x_len],
        half: (1.125 * (eye_dist * 2.0).max(mouth_dist * 1.8)).max(8.0),
        width: detection.bbox[2].max(detection.bbox[3] * 0.75),
        landmarks: [[0.0; 2]; 5],
        probs: Vec::new(),
    };
    face.landmarks = detection.landmarks.map(|point| face.image_to_crop(point));
    face
}

fn parse_face(image: &RgbImage, face: &mut ParsedFace, session: &Mutex<Session>) -> Result<()> {
    const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
    const STD: [f32; 3] = [0.229, 0.224, 0.225];

    let (width, height) = image.dimensions();
    let raw = image.as_raw();
    let samples = ((face.half * 2.0 / PARSER_SIZE as f32).ceil() as usize).clamp(1, 4);
    let area = PARSER_SIZE * PARSER_SIZE;

    let mut pixels = vec![[0.0_f32; 3]; area];
    pixels
        .par_chunks_exact_mut(PARSER_SIZE)
        .enumerate()
        .for_each(|(v, row)| {
            for (u, out) in row.iter_mut().enumerate() {
                let mut sum = [0.0_f32; 3];
                for j in 0..samples {
                    for i in 0..samples {
                        let [x, y] = face.crop_to_image(
                            u as f32 + (i as f32 + 0.5) / samples as f32,
                            v as f32 + (j as f32 + 0.5) / samples as f32,
                        );
                        if x >= 0.0 && y >= 0.0 && x < width as f32 && y < height as f32 {
                            let idx = (y as usize * width as usize + x as usize) * 3;
                            for c in 0..3 {
                                sum[c] += raw[idx + c] as f32;
                            }
                        }
                    }
                }
                let norm = 255.0 * (samples * samples) as f32;
                for c in 0..3 {
                    out[c] = (sum[c] / norm - MEAN[c]) / STD[c];
                }
            }
        });

    let mut input = Array4::<f32>::zeros((1, 3, PARSER_SIZE, PARSER_SIZE));
    for (i, pixel) in pixels.iter().enumerate() {
        let (v, u) = (i / PARSER_SIZE, i % PARSER_SIZE);
        for c in 0..3 {
            input[[0, c, v, u]] = pixel[c];
        }
    }
    let tensor = Tensor::from_array(input.into_dyn())?;

    let logits: Vec<f32> = {
        let mut session = session.lock().unwrap();
        let outputs = session.run(ort::inputs![tensor])?;
        outputs[0]
            .try_extract_array::<f32>()?
            .iter()
            .copied()
            .collect()
    };
    if logits.len() != PARSER_CLASSES * area {
        return Err(anyhow!("Unexpected face parsing output shape"));
    }

    let mut probs = vec![0u8; PARSER_CLASSES * area];
    for i in 0..area {
        let mut max = f32::MIN;
        for c in 0..PARSER_CLASSES {
            max = max.max(logits[c * area + i]);
        }
        let mut exp = [0.0_f32; PARSER_CLASSES];
        let mut sum = 0.0;
        for c in 0..PARSER_CLASSES {
            exp[c] = (logits[c * area + i] - max).exp();
            sum += exp[c];
        }
        for c in 0..PARSER_CLASSES {
            probs[c * area + i] = (exp[c] / sum * 255.0).round() as u8;
        }
    }
    face.probs = probs;
    Ok(())
}

pub fn analyze_faces(image: &RgbImage, models: &FaceModels) -> Result<Vec<ParsedFace>> {
    let detections = detect_faces(image, &models.detector)?;
    let mut faces = Vec::with_capacity(detections.len());
    for detection in &detections {
        let mut face = align_face(detection);
        parse_face(image, &mut face, &models.parser)?;
        faces.push(face);
    }
    Ok(faces)
}

/// Renders the probability (0..1) of `region` for the `width` x `height` window of the
/// image whose top-left corner is at `origin`. Faces are combined with a maximum.
pub fn render_region(
    faces: &[ParsedFace],
    region: FaceRegion,
    origin: (u32, u32),
    width: u32,
    height: u32,
) -> Vec<f32> {
    let (w, h) = (width as usize, height as usize);
    let mut out = vec![0.0_f32; w * h];
    let half_size = PARSER_SIZE as f32 / 2.0;
    let last = (PARSER_SIZE - 1) as f32;

    for face in faces {
        let plane = face.region_plane(region);
        let [min_x, min_y, max_x, max_y] = face.bounds();
        let x0 = (min_x.floor() as i64 - origin.0 as i64).clamp(0, w as i64) as usize;
        let x1 = (max_x.ceil() as i64 + 1 - origin.0 as i64).clamp(0, w as i64) as usize;
        let y0 = (min_y.floor() as i64 - origin.1 as i64).clamp(0, h as i64) as usize;
        let y1 = (max_y.ceil() as i64 + 1 - origin.1 as i64).clamp(0, h as i64) as usize;
        if x0 >= x1 || y0 >= y1 {
            continue;
        }
        let y_dir = face.y_dir();

        out[y0 * w..y1 * w]
            .par_chunks_exact_mut(w)
            .enumerate()
            .for_each(|(row_idx, row)| {
                let dy = (y0 + row_idx) as f32 + origin.1 as f32 + 0.5 - face.center[1];
                for (x, value) in row.iter_mut().enumerate().take(x1).skip(x0) {
                    let dx = x as f32 + origin.0 as f32 + 0.5 - face.center[0];
                    let a = (dx * face.x_dir[0] + dy * face.x_dir[1]) / face.half;
                    let b = (dx * y_dir[0] + dy * y_dir[1]) / face.half;
                    let u = (a + 1.0) * half_size - 0.5;
                    let v = (b + 1.0) * half_size - 0.5;
                    if u < -0.5 || v < -0.5 || u > last + 0.5 || v > last + 0.5 {
                        continue;
                    }
                    let (u, v) = (u.clamp(0.0, last), v.clamp(0.0, last));
                    let (u0, v0) = (u as usize, v as usize);
                    let (u1, v1) = ((u0 + 1).min(PARSER_SIZE - 1), (v0 + 1).min(PARSER_SIZE - 1));
                    let (fu, fv) = (u - u0 as f32, v - v0 as f32);
                    let top = plane[v0 * PARSER_SIZE + u0] * (1.0 - fu)
                        + plane[v0 * PARSER_SIZE + u1] * fu;
                    let bottom = plane[v1 * PARSER_SIZE + u0] * (1.0 - fu)
                        + plane[v1 * PARSER_SIZE + u1] * fu;
                    *value = value.max(top * (1.0 - fv) + bottom * fv);
                }
            });
    }
    out
}

#[inline]
fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Narrows a rendered `Teeth` or `EyeWhites` plane down to the bright, neutral pixels of
/// `rgb`, the sRGB pixels the plane is aligned with. Other regions are left untouched.
pub fn keep_bright_neutral(values: &mut [f32], rgb: &[u8], region: FaceRegion) {
    let Some((luma_limits, saturation_limits)) = region.bright_neutral_limits() else {
        return;
    };
    values
        .par_iter_mut()
        .zip(rgb.par_chunks_exact(3))
        .for_each(|(value, px)| {
            if *value <= 0.0 {
                return;
            }
            let [r, g, b] = [px[0], px[1], px[2]].map(|c| c as f32 / 255.0);
            let luma = 0.299 * r + 0.587 * g + 0.114 * b;
            let max = r.max(g).max(b);
            let saturation = if max > 1e-4 {
                (max - r.min(g).min(b)) / max
            } else {
                0.0
            };
            *value *= smoothstep(luma_limits[0], luma_limits[1], luma)
                * (1.0 - smoothstep(saturation_limits[0], saturation_limits[1], saturation));
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detection(landmarks: [[f32; 2]; 5]) -> Detection {
        Detection {
            score: 0.9,
            bbox: [290.0, 250.0, 480.0, 680.0],
            landmarks,
        }
    }

    #[test]
    fn alignment_matches_training_framing() {
        // Landmarks of an aligned 1024px training portrait must map back onto itself.
        let face = align_face(&detection([
            [406.0, 493.0],
            [634.0, 492.0],
            [502.0, 644.0],
            [415.0, 741.0],
            [621.0, 741.0],
        ]));
        assert!((face.half - 512.0).abs() < 20.0, "half {}", face.half);
        assert!((face.center[0] - 512.0).abs() < 20.0);
        assert!((face.center[1] - 512.0).abs() < 20.0);
        assert!(face.x_dir[0] > 0.99);
    }

    #[test]
    fn alignment_follows_sideways_faces() {
        // The same face rotated 90 degrees clockwise.
        let face = align_face(&detection([
            [531.0, 406.0],
            [532.0, 634.0],
            [380.0, 502.0],
            [283.0, 415.0],
            [283.0, 621.0],
        ]));
        assert!(face.x_dir[1] > 0.99, "x_dir {:?}", face.x_dir);
        let top_left = face.crop_to_image(0.0, 0.0);
        assert!(top_left[0] > 900.0 && top_left[1] < 120.0, "{top_left:?}");
    }

    /// Runs the real models. Point `FACE_TEST_DIR` at a folder holding `yunet.onnx`,
    /// `parsing.onnx` and `face.jpg`.
    #[test]
    #[ignore]
    fn finds_a_real_face_in_any_orientation() {
        let dir = std::path::PathBuf::from(std::env::var("FACE_TEST_DIR").unwrap());
        let _ = ort::init().with_name("face-test").commit();
        let models = FaceModels {
            detector: Mutex::new(
                Session::builder()
                    .unwrap()
                    .commit_from_file(dir.join("yunet.onnx"))
                    .unwrap(),
            ),
            parser: Mutex::new(load_face_parser_session(&dir.join("parsing.onnx")).unwrap()),
        };
        let upright = image::open(dir.join("face.jpg")).unwrap().to_rgb8();

        let mut skin_pixels = Vec::new();
        for image in [upright.clone(), imageops::rotate90(&upright)] {
            let faces = analyze_faces(&image, &models).unwrap();
            assert_eq!(faces.len(), 1);
            let (w, h) = image.dimensions();
            let skin = render_region(&faces, FaceRegion::Skin, (0, 0), w, h);
            skin_pixels.push(skin.iter().filter(|&&p| p > 0.5).count());
        }
        assert!(skin_pixels[0] as f32 > 0.03 * (upright.width() * upright.height()) as f32);
        let difference = skin_pixels[0].abs_diff(skin_pixels[1]);
        assert!(difference * 50 < skin_pixels[0], "{skin_pixels:?}");
    }

    #[test]
    fn blemish_zone_is_forehead_and_cheeks_only() {
        let face = align_face(&detection([
            [406.0, 493.0],
            [634.0, 492.0],
            [502.0, 644.0],
            [415.0, 741.0],
            [621.0, 741.0],
        ]));
        // Positions on the aligned 1024px portrait, which is twice the crop size.
        let weight = |x: f32, y: f32| face.blemish_zone_weight(x / 2.0, y / 2.0);

        assert!(weight(512.0, 330.0) > 0.99, "forehead");
        assert!(weight(360.0, 620.0) > 0.99, "right cheek");
        assert!(weight(680.0, 620.0) > 0.99, "left cheek");
        assert!(weight(505.0, 640.0) < 0.01, "nose");
        assert!(weight(505.0, 700.0) < 0.01, "under the nose");
        assert!(weight(430.0, 700.0) < 0.01, "right nasolabial fold");
        assert!(weight(600.0, 700.0) < 0.01, "left nasolabial fold");
        assert!(weight(445.0, 650.0) < 0.01, "wing of the nose");
        assert!(weight(512.0, 860.0) < 0.01, "chin");
        assert!(weight(400.0, 500.0) < 0.01, "eye");
    }

    #[test]
    fn renders_region_back_into_image_space() {
        let mut face = align_face(&detection([
            [406.0, 493.0],
            [634.0, 492.0],
            [502.0, 644.0],
            [415.0, 741.0],
            [621.0, 741.0],
        ]));
        let area = PARSER_SIZE * PARSER_SIZE;
        face.probs = vec![0u8; PARSER_CLASSES * area];
        for v in 200..300 {
            for u in 100..200 {
                face.probs[SKIN * area + v * PARSER_SIZE + u] = 255;
            }
        }

        let [inside_x, inside_y] = face.crop_to_image(150.0, 250.0);
        let [outside_x, outside_y] = face.crop_to_image(400.0, 250.0);
        let origin = (40_u32, 60_u32);
        let rendered = render_region(&[face], FaceRegion::Skin, origin, 1000, 900);
        let at = |x: f32, y: f32| {
            rendered[(y as usize - origin.1 as usize) * 1000 + (x as usize - origin.0 as usize)]
        };
        assert!(at(inside_x, inside_y) > 0.99);
        assert!(at(outside_x, outside_y) < 0.01);
    }
}
