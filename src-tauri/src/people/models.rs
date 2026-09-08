use super::{geometry, types::Detection};
use anyhow::{Result, ensure};
use image::RgbImage;
use ndarray::Array4;
use ort::{session::Session, value::Tensor};

pub struct Models {
    detector: Session,
    recognizer: Session,
}

impl Models {
    pub async fn load(app: &tauri::AppHandle) -> Result<Self> {
        let dir = crate::ai_processing::get_models_dir(app)?;
        for (file, url, hash, name) in [
            (
                "face_detection_yunet_2023mar.onnx",
                "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
                "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
                "YuNet",
            ),
            (
                "face_recognition_sface_2021dec.onnx",
                "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
                "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
                "SFace",
            ),
        ] {
            crate::ai_processing::download_and_verify_model(app, &dir, file, url, hash, name)
                .await?;
        }
        Self::from_dir(&dir)
    }

    pub fn from_dir(dir: &std::path::Path) -> Result<Self> {
        Ok(Self {
            detector: Session::builder()?
                .with_intra_threads(1)?
                .commit_from_file(dir.join("face_detection_yunet_2023mar.onnx"))?,
            recognizer: Session::builder()?
                .with_intra_threads(1)?
                .commit_from_file(dir.join("face_recognition_sface_2021dec.onnx"))?,
        })
    }

    pub fn detect(&mut self, image: &RgbImage) -> Result<Vec<Detection>> {
        let (w, h) = (image.width() as usize, image.height() as usize);
        let mut faces = Vec::new();
        // The pinned model has a fixed 640 input. Overlapping tiles retain small faces
        // in a 1280 preview without modifying the model's verified bytes.
        for oy in tile_origins(h) {
            for ox in tile_origins(w) {
                let (tw, th) = ((w - ox).min(640), (h - oy).min(640));
                let mut input = Array4::<f32>::zeros((1, 3, 640, 640));
                for y in 0..th {
                    for x in 0..tw {
                        let p = image.get_pixel((x + ox) as u32, (y + oy) as u32);
                        for c in 0..3 {
                            input[[0, c, y, x]] = p[2 - c] as f32;
                        }
                    }
                }
                let outputs = self
                    .detector
                    .run(ort::inputs![Tensor::from_array(input)?])?;
                for stride in [8, 16, 32] {
                    let get = |name: &str| -> Result<Vec<f32>> {
                        Ok(outputs
                            .get(format!("{name}_{stride}").as_str())
                            .ok_or_else(|| anyhow::anyhow!("Missing YuNet output"))?
                            .try_extract_array::<f32>()?
                            .iter()
                            .copied()
                            .collect())
                    };
                    for mut face in decode(
                        stride,
                        640,
                        tw,
                        th,
                        &get("cls")?,
                        &get("obj")?,
                        &get("bbox")?,
                        &get("kps")?,
                    )? {
                        face.bounds = [
                            (face.bounds[0] * tw as f32 + ox as f32) / w as f32,
                            (face.bounds[1] * th as f32 + oy as f32) / h as f32,
                            face.bounds[2] * tw as f32 / w as f32,
                            face.bounds[3] * th as f32 / h as f32,
                        ];
                        face.landmarks = face.landmarks.map(|p| {
                            [
                                (p[0] * tw as f32 + ox as f32) / w as f32,
                                (p[1] * th as f32 + oy as f32) / h as f32,
                            ]
                        });
                        faces.push(face);
                    }
                }
            }
        }
        let mut faces = geometry::suppress(faces);
        for face in &mut faces {
            let points = face.landmarks.map(|p| [p[0] * w as f32, p[1] * h as f32]);
            let aligned = geometry::align(image, &points)?;
            let mut tensor = Array4::<f32>::zeros((1, 3, 112, 112));
            for (x, y, p) in aligned.enumerate_pixels() {
                for c in 0..3 {
                    tensor[[0, c, y as usize, x as usize]] = p[c] as f32;
                }
            }
            let output = self
                .recognizer
                .run(ort::inputs![Tensor::from_array(tensor)?])?;
            face.embedding = output[0]
                .try_extract_array::<f32>()?
                .iter()
                .copied()
                .collect();
            ensure!(
                face.embedding.len() == 128,
                "Unexpected SFace embedding size"
            );
            geometry::normalize(&mut face.embedding)?;
        }
        Ok(faces)
    }
}

fn tile_origins(size: usize) -> Vec<usize> {
    if size <= 640 {
        return vec![0];
    }
    let mut positions = (0..size - 640).step_by(480).collect::<Vec<_>>();
    positions.push(size - 640);
    positions
}

fn decode(
    stride: usize,
    pw: usize,
    w: usize,
    h: usize,
    cls: &[f32],
    obj: &[f32],
    bbox: &[f32],
    kps: &[f32],
) -> Result<Vec<Detection>> {
    ensure!(
        obj.len() == cls.len() && bbox.len() == cls.len() * 4 && kps.len() == cls.len() * 10,
        "Invalid YuNet outputs"
    );
    let mut faces = Vec::new();
    for i in 0..cls.len() {
        let score = (cls[i].clamp(0.0, 1.0) * obj[i].clamp(0.0, 1.0)).sqrt();
        if !score.is_finite() || score < 0.85 {
            continue;
        }
        let (x, y) = ((i % (pw / stride)) as f32, (i / (pw / stride)) as f32);
        let s = stride as f32;
        let (bw, bh) = (bbox[i * 4 + 2].exp() * s, bbox[i * 4 + 3].exp() * s);
        let (cx, cy) = ((x + bbox[i * 4]) * s, (y + bbox[i * 4 + 1]) * s);
        let (left, top) = ((cx - bw / 2.0).max(0.0), (cy - bh / 2.0).max(0.0));
        let (right, bottom) = ((cx + bw / 2.0).min(w as f32), (cy + bh / 2.0).min(h as f32));
        if ![left, top, right, bottom].iter().all(|v| v.is_finite())
            || right - left < 40.0
            || bottom - top < 40.0
        {
            continue;
        }
        let landmarks = std::array::from_fn(|j| {
            [
                (kps[i * 10 + j * 2] + x) * s / w as f32,
                (kps[i * 10 + j * 2 + 1] + y) * s / h as f32,
            ]
        });
        if !landmarks.iter().flatten().all(|v| v.is_finite()) {
            continue;
        }
        faces.push(Detection {
            bounds: [
                left / w as f32,
                top / h as f32,
                (right - left) / w as f32,
                (bottom - top) / h as f32,
            ],
            landmarks,
            confidence: score,
            embedding: Vec::new(),
        });
    }
    Ok(faces)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decode_boxes_and_threshold() {
        let faces = decode(
            8,
            64,
            64,
            64,
            &[1.0],
            &[1.0],
            &[4.0, 4.0, (6.0f32).ln(), (6.0f32).ln()],
            &[0.0; 10],
        )
        .unwrap();
        assert_eq!(faces.len(), 1);
        assert!((faces[0].bounds[2] - 0.75).abs() < 1e-6);
        assert!(
            decode(8, 64, 64, 64, &[0.5], &[1.0], &[0.0; 4], &[0.0; 10])
                .unwrap()
                .is_empty()
        );
    }
}
