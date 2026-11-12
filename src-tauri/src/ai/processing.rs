use std::sync::Mutex;

use anyhow::Result;
use image::imageops::{self, FilterType};
use image::{DynamicImage, GenericImageView, GrayImage, ImageBuffer, Luma, RgbaImage};
use ndarray::{Array, Array4, ArrayViewD, IxDyn, s};
use ort::session::Session;
use ort::value::{Tensor, TensorRef};
use serde::{Deserialize, Serialize};

use crate::ai::guided_filter::{edt_2d, fast_color_guided_filter, fast_guided_filter};
use crate::ai::models::{Esam3Prompt, gpu_inference};

const SAM_INPUT_SIZE: u32 = 1024;

const BIREFNET_INPUT_SIZE: u32 = 1024;
const BIREFNET_ZOOM_MIN_IOU: f32 = 0.75;

const ZOOM_MARGIN: f32 = 0.15;
const ZOOM_MAX_FRACTION: f32 = 0.6;
const ZOOM_MIN_SIDE: f32 = 1024.0;
const ZOOM_FEATHER: f32 = 0.1;

const ESAM3_INPUT_SIZE: u32 = 1008;
const ESAM3_INPUT_PADDING: u32 = 30;
const ESAM3_EXEMPLAR_SLOTS: usize = 8;
pub const ESAM3_SKY_SCORE_THRESHOLD: f32 = 0.6;
pub const ESAM3_TEXT_SCORE_THRESHOLD: f32 = 0.3;
pub const ESAM3_FACE_SCORE_THRESHOLD: f32 = 0.3;
const ESAM3_MASK_LOW: f32 = 0.3;
const ESAM3_MASK_HIGH: f32 = 0.7;
const ESAM3_REFINE_SIZE: u32 = 1024;
const ESAM3_REFINE_RADIUS: usize = 16;
pub const ESAM3_SKY_REFINE_EPS: f32 = 0.001;
pub const ESAM3_TEXT_REFINE_EPS: f32 = 0.01;
const ESAM3_ZOOM_MIN_IOU: f32 = 0.3;

const DEPTH_INPUT_SIZE: u32 = 518;

const NORMAL_MAX_SIZE: u32 = 768;
const NORMAL_NUM_TOKENS: i64 = 2500;

pub struct Esam3Features {
    pub path_hash: String,
    pub fpn: [Array<f32, IxDyn>; 3],
    pub pos: Array<f32, IxDyn>,
}

#[derive(Clone)]
pub struct ImageEmbeddings {
    pub path_hash: String,
    pub embeddings: Array<f32, IxDyn>,
    pub original_size: (u32, u32),
}

#[derive(Clone)]
pub struct CachedDepthMap {
    pub path_hash: String,
    pub depth_image: GrayImage,
    pub original_size: (u32, u32),
}

pub fn generate_image_embeddings(
    image: &DynamicImage,
    encoder: &Mutex<Session>,
) -> Result<ImageEmbeddings> {
    let (orig_width, orig_height) = image.dimensions();

    let long_side = orig_width.max(orig_height) as f32;
    let scale = SAM_INPUT_SIZE as f32 / long_side;
    let new_width = (orig_width as f32 * scale).round() as u32;
    let new_height = (orig_height as f32 * scale).round() as u32;

    let resized_image = image.resize(new_width, new_height, FilterType::Triangle);
    let rgb_image = resized_image.into_rgb8();
    let (actual_width, actual_height) = rgb_image.dimensions();
    let raw_pixels = rgb_image.as_raw();

    let mut input_tensor: Array<u8, _> =
        Array::zeros((1, 3, SAM_INPUT_SIZE as usize, SAM_INPUT_SIZE as usize));

    let w_usize = actual_width as usize;
    for y in 0..(actual_height as usize) {
        for x in 0..w_usize {
            let idx = (y * w_usize + x) * 3;
            input_tensor[[0, 0, y, x]] = raw_pixels[idx];
            input_tensor[[0, 1, y, x]] = raw_pixels[idx + 1];
            input_tensor[[0, 2, y, x]] = raw_pixels[idx + 2];
        }
    }

    let input_tensor_dyn = input_tensor.into_dyn();
    let input_values = input_tensor_dyn.as_standard_layout();
    let input_tensor_ort = Tensor::from_array(input_values.into_owned())?;
    let mut session = encoder.lock().unwrap();
    let outputs = session.run(ort::inputs![input_tensor_ort])?;

    let embeddings = outputs[0].try_extract_array::<f32>()?.to_owned();

    Ok(ImageEmbeddings {
        path_hash: "".to_string(),
        embeddings: embeddings.into_dyn(),
        original_size: (orig_width, orig_height),
    })
}

pub fn run_sam_decoder(
    decoder: &Mutex<Session>,
    embeddings: &ImageEmbeddings,
    start_point: (f64, f64),
    end_point: (f64, f64),
    original_image: Option<&DynamicImage>,
) -> Result<GrayImage> {
    let (orig_width, orig_height) = embeddings.original_size;
    let long_side = orig_width.max(orig_height) as f64;
    let scale = SAM_INPUT_SIZE as f64 / long_side;

    let iters = 2;

    let is_point =
        (start_point.0 - end_point.0).abs() < 1e-6 && (start_point.1 - end_point.1).abs() < 1e-6;
    let mut point_coords = Vec::new();
    let mut point_labels = Vec::new();

    if is_point {
        point_coords.push((
            (start_point.0 * scale) as f32,
            (start_point.1 * scale) as f32,
        ));
        point_labels.push(1.0f32);
    } else {
        let x1 = (start_point.0.min(end_point.0) * scale) as f32;
        let y1 = (start_point.1.min(end_point.1) * scale) as f32;
        let x2 = (start_point.0.max(end_point.0) * scale) as f32;
        let y2 = (start_point.1.max(end_point.1) * scale) as f32;
        point_coords.push((x1, y1));
        point_coords.push((x2, y2));
        point_labels.push(2.0f32);
        point_labels.push(3.0f32);
    }

    let mut mask_input = Array::zeros((1, 1, 256, 256)).into_dyn();
    let mut has_mask_input = 0.0f32;

    let orig_im_size =
        Array::from_shape_vec((2,), vec![orig_height as f32, orig_width as f32])?.into_dyn();

    let mut final_mask_data: Vec<u8> = Vec::new();
    let mut final_w = 0;
    let mut final_h = 0;

    for i in 0..iters {
        let pc_len = point_coords.len();
        let pl_len = point_labels.len();

        let coords_flat: Vec<f32> = point_coords.iter().flat_map(|&(x, y)| vec![x, y]).collect();
        let coords_array = Array::from_shape_vec((1, pc_len, 2), coords_flat)?.into_dyn();
        let labels_array = Array::from_shape_vec((1, pl_len), point_labels.clone())?.into_dyn();

        let t_embeddings = Tensor::from_array(
            embeddings
                .embeddings
                .clone()
                .as_standard_layout()
                .into_owned(),
        )?;
        let t_point_coords = Tensor::from_array(coords_array.as_standard_layout().into_owned())?;
        let t_point_labels = Tensor::from_array(labels_array.as_standard_layout().into_owned())?;
        let t_mask_input =
            Tensor::from_array(mask_input.clone().as_standard_layout().into_owned())?;
        let t_has_mask = Tensor::from_array(
            Array::from_elem((1,), has_mask_input)
                .into_dyn()
                .as_standard_layout()
                .into_owned(),
        )?;
        let t_orig_im_size =
            Tensor::from_array(orig_im_size.clone().as_standard_layout().into_owned())?;

        let mask_tensor = {
            let mut session = decoder.lock().unwrap();
            let outputs = session.run(ort::inputs![
                t_embeddings,
                t_point_coords,
                t_point_labels,
                t_mask_input,
                t_has_mask,
                t_orig_im_size
            ])?;
            outputs[0].try_extract_array::<f32>()?.to_owned()
        };

        let mask_dims = mask_tensor.shape();
        let h = mask_dims[2];
        let w = mask_dims[3];
        let area = h * w;

        let mask_slice = mask_tensor.as_slice().unwrap();
        let first_mask_slice = &mask_slice[0..area];

        if i == iters - 1 {
            final_mask_data = first_mask_slice
                .iter()
                .map(|&val| if val > 0.0 { 255 } else { 0 })
                .collect();
            final_w = w;
            final_h = h;
            break;
        }

        let mut binary_mask = vec![false; area];
        let mut mask_area = 0.0;
        let mut min_x = w;
        let mut min_y = h;
        let mut max_x = 0;
        let mut max_y = 0;

        for (idx, &val) in first_mask_slice.iter().enumerate() {
            if val > 0.0 {
                binary_mask[idx] = true;
                let x = idx % w;
                let y = idx / w;
                min_x = min_x.min(x);
                max_x = max_x.max(x);
                min_y = min_y.min(y);
                max_y = max_y.max(y);
                mask_area += 1.0;
            }
        }

        if mask_area == 0.0 || min_x > max_x {
            final_mask_data = first_mask_slice
                .iter()
                .map(|&val| if val > 0.0 { 255 } else { 0 })
                .collect();
            final_w = w;
            final_h = h;
            break;
        }

        let dt_in = edt_2d(&binary_mask, w, h);
        let mut max_in = 0.0;
        let mut pos_idx = 0;
        for (idx, &v) in dt_in.iter().enumerate() {
            if v > max_in {
                max_in = v;
                pos_idx = idx;
            }
        }
        let pos_y = pos_idx / w;
        let pos_x = pos_idx % w;

        let mut rev_mask = vec![false; area];
        for (idx, is_true) in binary_mask.iter().enumerate() {
            rev_mask[idx] = !is_true;
        }
        let mut dt_out = edt_2d(&rev_mask, w, h);

        for y in 0..h {
            for x in 0..w {
                if x < min_x || x > max_x || y < min_y || y > max_y {
                    dt_out[y * w + x] = 0.0;
                }
            }
        }

        let mut max_out = 0.0;
        let mut neg_idx = 0;
        for (idx, &v) in dt_out.iter().enumerate() {
            if v > max_out {
                max_out = v;
                neg_idx = idx;
            }
        }
        let neg_y = neg_idx / w;
        let neg_x = neg_idx % w;

        point_coords.clear();
        point_labels.clear();

        point_coords.push(((pos_x as f64 * scale) as f32, (pos_y as f64 * scale) as f32));
        point_labels.push(1.0);
        point_coords.push(((neg_x as f64 * scale) as f32, (neg_y as f64 * scale) as f32));
        point_labels.push(0.0);
        point_coords.push(((min_x as f64 * scale) as f32, (min_y as f64 * scale) as f32));
        point_labels.push(2.0);
        point_coords.push(((max_x as f64 * scale) as f32, (max_y as f64 * scale) as f32));
        point_labels.push(3.0);

        let mut gaus_dt = vec![0.0f32; area];
        let variance = (mask_area / 4.0_f32).max(1.0_f32);
        for (idx, &is_true) in binary_mask.iter().enumerate() {
            if is_true {
                let diff = dt_in[idx] - max_in;
                gaus_dt[idx] = (-(diff * diff) / variance).exp();
            }
        }

        let mask_f32_vec: Vec<f32> = first_mask_slice
            .iter()
            .map(|&v| if v > 0.0 { 15.0 } else { -15.0 })
            .collect();

        let img_mask_f32 =
            ImageBuffer::<Luma<f32>, Vec<f32>>::from_raw(w as u32, h as u32, mask_f32_vec).unwrap();
        let img_gaus_f32 =
            ImageBuffer::<Luma<f32>, Vec<f32>>::from_raw(w as u32, h as u32, gaus_dt).unwrap();

        let resized_mask = imageops::resize(&img_mask_f32, 256, 256, FilterType::Triangle);
        let resized_gaus = imageops::resize(&img_gaus_f32, 256, 256, FilterType::Triangle);

        let rm_raw = resized_mask.as_raw();
        let rg_raw = resized_gaus.as_raw();
        let mut mask_input_flat = vec![0.0f32; 256 * 256];

        for i in 0..(256 * 256) {
            let m_val = rm_raw[i];
            let mut g_val = rg_raw[i];
            if g_val <= 0.0 {
                g_val = 1.0;
            }
            mask_input_flat[i] = m_val * g_val;
        }

        mask_input = Array::from_shape_vec((1, 1, 256, 256), mask_input_flat)
            .unwrap()
            .into_dyn();
        has_mask_input = 1.0;
    }

    let gray_mask = GrayImage::from_raw(final_w as u32, final_h as u32, final_mask_data)
        .ok_or_else(|| anyhow::anyhow!("Failed to create mask image from raw data"))?;

    if let Some(img) = original_image {
        let (orig_width, orig_height) = img.dimensions();
        let guide_hr = img.to_luma8();

        let long_edge = orig_width.max(orig_height) as f32;
        let radius = (long_edge * 0.0075).clamp(8.0, 24.0);

        let resized_coarse_mask =
            image::imageops::resize(&gray_mask, orig_width, orig_height, FilterType::Triangle);

        let feathered_coarse_mask = image::imageops::blur(&resized_coarse_mask, radius / 3.0);

        let mut refined_mask =
            fast_guided_filter(&guide_hr, &feathered_coarse_mask, radius as usize, 0.01);

        for p in refined_mask.pixels_mut() {
            let v = p[0] as f32 / 255.0;
            p[0] = (((v - 0.03) / 0.94).clamp(0.0, 1.0) * 255.0).round() as u8;
        }

        Ok(refined_mask)
    } else {
        let feathered_mask = image::imageops::blur(&gray_mask, 2.0);
        let (orig_width, orig_height) = embeddings.original_size;
        let final_mask = image::imageops::resize(
            &feathered_mask,
            orig_width,
            orig_height,
            FilterType::Triangle,
        );

        Ok(final_mask)
    }
}

fn sigmoid(value: f32) -> f32 {
    1.0 / (1.0 + (-value).exp())
}

pub fn run_esam3_image_encoder(
    image: &DynamicImage,
    encoder_session: &Mutex<Session>,
) -> Result<Esam3Features> {
    let size = ESAM3_INPUT_SIZE as usize;
    let padding = ESAM3_INPUT_PADDING as i64;
    let inner = ESAM3_INPUT_SIZE - 2 * ESAM3_INPUT_PADDING;
    let resized_rgb = image
        .resize_exact(inner, inner, FilterType::Triangle)
        .into_rgb8();

    let reflect = |i: usize| -> u32 {
        let (i, n) = (i as i64 - padding, inner as i64);
        let i = if i < 0 { -i } else { i };
        (if i >= n { 2 * n - 2 - i } else { i }) as u32
    };
    let mut input_tensor = Array4::<f32>::zeros((1, 3, size, size));
    for y in 0..size {
        let src_y = reflect(y);
        for x in 0..size {
            let pixel = resized_rgb.get_pixel(reflect(x), src_y);
            for c in 0..3 {
                input_tensor[[0, c, y, x]] = pixel[c] as f32 / 127.5 - 1.0;
            }
        }
    }

    let mut session = encoder_session.lock().unwrap();
    let outputs =
        gpu_inference(session.run(ort::inputs!["image" => Tensor::from_array(input_tensor)?]))?;
    let extract = |name: &str| -> Result<Array<f32, IxDyn>> {
        Ok(outputs[name].try_extract_array::<f32>()?.to_owned())
    };

    Ok(Esam3Features {
        path_hash: String::new(),
        fpn: [extract("fpn_0")?, extract("fpn_1")?, extract("fpn_2")?],
        pos: extract("pos_2")?,
    })
}

fn run_esam3_queries<T>(
    decoder_session: &Mutex<Session>,
    features: &Esam3Features,
    prompt: &Esam3Prompt,
    read: impl FnOnce(Vec<f32>, ArrayViewD<f32>, ArrayViewD<f32>) -> T,
) -> Result<T> {
    let exemplar_boxes = Array::<f32, _>::zeros((ESAM3_EXEMPLAR_SLOTS, 1, 4));
    let exemplar_labels = Array::<i64, _>::zeros((ESAM3_EXEMPLAR_SLOTS, 1));
    let exemplar_mask = Array::<f32, _>::ones((1, ESAM3_EXEMPLAR_SLOTS));

    let mut session = decoder_session.lock().unwrap();
    let outputs = gpu_inference(session.run(ort::inputs![
        "fpn_0" => TensorRef::from_array_view(&features.fpn[0])?,
        "fpn_1" => TensorRef::from_array_view(&features.fpn[1])?,
        "fpn_2" => TensorRef::from_array_view(&features.fpn[2])?,
        "pos_2" => TensorRef::from_array_view(&features.pos)?,
        "language_features" => TensorRef::from_array_view(&prompt.features)?,
        "language_padding" => TensorRef::from_array_view(&prompt.padding)?,
        "exemplar_boxes" => Tensor::from_array(exemplar_boxes)?,
        "exemplar_labels" => Tensor::from_array(exemplar_labels)?,
        "exemplar_mask" => Tensor::from_array(exemplar_mask)?,
    ]))?;

    let presence = outputs["presence_logit"]
        .try_extract_array::<f32>()?
        .iter()
        .next()
        .map_or(0.0, |&v| sigmoid(v));
    let scores = outputs["pred_logits"]
        .try_extract_array::<f32>()?
        .iter()
        .map(|&logit| sigmoid(logit) * presence)
        .collect();
    Ok(read(
        scores,
        outputs["pred_boxes"].try_extract_array::<f32>()?,
        outputs["pred_masks"].try_extract_array::<f32>()?,
    ))
}

pub fn run_esam3_boxes(
    decoder_session: &Mutex<Session>,
    features: &Esam3Features,
    prompt: &Esam3Prompt,
    score_threshold: f32,
) -> Result<Vec<(f32, [f32; 4])>> {
    let mut detections =
        run_esam3_queries(decoder_session, features, prompt, |scores, boxes, _| {
            scores
                .iter()
                .enumerate()
                .filter(|&(_, &score)| score > score_threshold)
                .map(|(query, &score)| {
                    let size = ESAM3_INPUT_SIZE as f32;
                    let padding = ESAM3_INPUT_PADDING as f32;
                    let inner = size - 2.0 * padding;
                    let [cx, cy, w, h]: [f32; 4] = std::array::from_fn(|i| {
                        let v = boxes[[0, query, i]] * size;
                        if i < 2 {
                            (v - padding) / inner
                        } else {
                            v / inner
                        }
                    });
                    (
                        score,
                        [cx - w / 2.0, cy - h / 2.0, cx + w / 2.0, cy + h / 2.0],
                    )
                })
                .collect::<Vec<_>>()
        })?;
    detections.sort_by(|a, b| b.0.total_cmp(&a.0));
    Ok(detections)
}

pub fn run_esam3_decoder(
    decoder_session: &Mutex<Session>,
    features: &Esam3Features,
    prompt: &Esam3Prompt,
    image: &DynamicImage,
    score_threshold: f32,
    refine_eps: f32,
) -> Result<Option<GrayImage>> {
    let (coarse_mask, mask_w, mask_h) =
        run_esam3_queries(decoder_session, features, prompt, |scores, _, masks| {
            let (mask_h, mask_w) = (masks.shape()[2], masks.shape()[3]);
            let mut coarse_mask: Option<Vec<f32>> = None;
            for (query, &score) in scores.iter().enumerate() {
                if score <= score_threshold {
                    continue;
                }
                let combined = coarse_mask.get_or_insert_with(|| vec![0.0; mask_h * mask_w]);
                let query_mask = masks.slice(s![0, query, .., ..]);
                for (out, &value) in combined.iter_mut().zip(query_mask.iter()) {
                    *out = out.max(sigmoid(value));
                }
            }
            (coarse_mask, mask_w, mask_h)
        })?;

    let Some(coarse_mask) = coarse_mask else {
        return Ok(None);
    };

    let coarse_mask = GrayImage::from_raw(
        mask_w as u32,
        mask_h as u32,
        coarse_mask
            .iter()
            .map(|&v| {
                let v = ((v - ESAM3_MASK_LOW) / (ESAM3_MASK_HIGH - ESAM3_MASK_LOW)).clamp(0.0, 1.0);
                (v * 255.0).round() as u8
            })
            .collect(),
    )
    .ok_or_else(|| anyhow::anyhow!("Failed to create mask from EfficientSAM3 output"))?;

    let input_mask = imageops::resize(
        &coarse_mask,
        ESAM3_INPUT_SIZE,
        ESAM3_INPUT_SIZE,
        FilterType::Triangle,
    );
    let inner = ESAM3_INPUT_SIZE - 2 * ESAM3_INPUT_PADDING;
    let image_mask = imageops::crop_imm(
        &input_mask,
        ESAM3_INPUT_PADDING,
        ESAM3_INPUT_PADDING,
        inner,
        inner,
    )
    .to_image();

    let (orig_width, orig_height) = image.dimensions();
    let scale = (ESAM3_REFINE_SIZE as f32 / orig_width.max(orig_height) as f32).min(1.0);
    let refine_w = ((orig_width as f32 * scale).round() as u32).max(1);
    let refine_h = ((orig_height as f32 * scale).round() as u32).max(1);
    let refine_mask = imageops::resize(&image_mask, refine_w, refine_h, FilterType::Triangle);

    Ok(Some(fast_color_guided_filter(
        &image.to_rgb8(),
        &refine_mask,
        ESAM3_REFINE_RADIUS,
        refine_eps,
    )))
}

pub fn run_esam3_zoomed_decoder(
    encoder_session: &Mutex<Session>,
    decoder_session: &Mutex<Session>,
    features: &Esam3Features,
    prompt: &Esam3Prompt,
    image: &DynamicImage,
    score_threshold: f32,
    refine_eps: f32,
) -> Result<Option<GrayImage>> {
    let Some(mut mask) = run_esam3_decoder(
        decoder_session,
        features,
        prompt,
        image,
        score_threshold,
        refine_eps,
    )?
    else {
        return Ok(None);
    };

    let (width, height) = image.dimensions();
    let grid_size = ZOOM_MIN_SIDE as u32;
    let grid = imageops::resize(&mask, grid_size, grid_size, FilterType::Triangle);
    if let Some((x, y, crop_width, crop_height)) = zoom_region(&grid, width, height) {
        let crop = image.crop_imm(x, y, crop_width, crop_height);
        let crop_features = run_esam3_image_encoder(&crop, encoder_session)?;
        if let Some(detail) = run_esam3_decoder(
            decoder_session,
            &crop_features,
            prompt,
            &crop,
            score_threshold,
            refine_eps,
        )? && mask_iou(&mask, &detail, x, y) >= ESAM3_ZOOM_MIN_IOU
        {
            blend_feathered(&mut mask, &detail, x, y);
        }
    }

    Ok(Some(mask))
}

pub fn run_birefnet_model(
    image: &DynamicImage,
    birefnet_session: &Mutex<Session>,
) -> Result<GrayImage> {
    let (width, height) = image.dimensions();
    let mut session = birefnet_session.lock().unwrap();
    let coarse = run_birefnet_pass(image, &mut session)?;
    let mut mask = imageops::resize(&coarse, width, height, FilterType::Triangle);

    if let Some((x, y, crop_width, crop_height)) = zoom_region(&coarse, width, height) {
        let detail =
            run_birefnet_pass(&image.crop_imm(x, y, crop_width, crop_height), &mut session)?;
        let detail = imageops::resize(&detail, crop_width, crop_height, FilterType::Triangle);
        if mask_iou(&mask, &detail, x, y) >= BIREFNET_ZOOM_MIN_IOU {
            blend_feathered(&mut mask, &detail, x, y);
        }
    }

    Ok(mask)
}

fn mask_iou(mask: &GrayImage, detail: &GrayImage, x0: u32, y0: u32) -> f32 {
    let (mut intersection, mut union) = (0u64, 0u64);
    for (u, v, refined) in detail.enumerate_pixels() {
        let base = mask.get_pixel(x0 + u, y0 + v)[0] >= 128;
        let refined = refined[0] >= 128;
        intersection += (base && refined) as u64;
        union += (base || refined) as u64;
    }
    if union == 0 {
        0.0
    } else {
        intersection as f32 / union as f32
    }
}

fn blend_feathered(mask: &mut GrayImage, detail: &GrayImage, x0: u32, y0: u32) {
    let (width, height) = mask.dimensions();
    let (crop_width, crop_height) = detail.dimensions();
    let feather = (crop_width.min(crop_height) as f32 * ZOOM_FEATHER).max(1.0);
    let ramp = |start: u32, length: u32, extent: u32| -> Vec<f32> {
        (0..length)
            .map(|i| {
                let head = if start == 0 { f32::MAX } else { i as f32 + 0.5 };
                let tail = if start + length == extent {
                    f32::MAX
                } else {
                    (length - i) as f32 - 0.5
                };
                (head.min(tail) / feather).min(1.0)
            })
            .collect()
    };
    let weights_x = ramp(x0, crop_width, width);
    let weights_y = ramp(y0, crop_height, height);

    for (v, weight_y) in weights_y.iter().enumerate() {
        for (u, weight_x) in weights_x.iter().enumerate() {
            let weight = weight_x.min(*weight_y);
            let base = mask.get_pixel(x0 + u as u32, y0 + v as u32)[0] as f32;
            let refined = detail.get_pixel(u as u32, v as u32)[0] as f32;
            mask.put_pixel(
                x0 + u as u32,
                y0 + v as u32,
                Luma([(base + (refined - base) * weight).round() as u8]),
            );
        }
    }
}

fn zoom_region(coarse: &GrayImage, width: u32, height: u32) -> Option<(u32, u32, u32, u32)> {
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (u32::MAX, u32::MAX, 0, 0);
    for (x, y, pixel) in coarse.enumerate_pixels() {
        if pixel[0] >= 128 {
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x + 1);
            max_y = max_y.max(y + 1);
        }
    }
    if min_x == u32::MAX {
        return None;
    }

    let scale_x = width as f32 / coarse.width() as f32;
    let scale_y = height as f32 / coarse.height() as f32;
    let long_side = width.max(height) as f32;
    let subject_side = ((max_x - min_x) as f32 * scale_x).max((max_y - min_y) as f32 * scale_y);
    let side = (subject_side * (1.0 + 2.0 * ZOOM_MARGIN))
        .max(ZOOM_MIN_SIDE)
        .min(long_side);
    if side > ZOOM_MAX_FRACTION * long_side {
        return None;
    }

    let place = |min: u32, max: u32, scale: f32, extent: u32| {
        let center = (min + max) as f32 * 0.5 * scale;
        let length = side.min(extent as f32);
        let start = (center - length * 0.5).clamp(0.0, extent as f32 - length);
        (start as u32, (length as u32).min(extent - start as u32))
    };
    let (x, crop_width) = place(min_x, max_x, scale_x, width);
    let (y, crop_height) = place(min_y, max_y, scale_y, height);
    Some((x, y, crop_width, crop_height))
}

fn run_birefnet_pass(image: &DynamicImage, session: &mut Session) -> Result<GrayImage> {
    let size = BIREFNET_INPUT_SIZE as usize;
    let resized_rgb = image
        .resize_exact(
            BIREFNET_INPUT_SIZE,
            BIREFNET_INPUT_SIZE,
            FilterType::Triangle,
        )
        .into_rgb8();

    let mean = [0.485, 0.456, 0.406];
    let std = [0.229, 0.224, 0.225];

    let mut input_tensor = Array4::<f32>::zeros((1, 3, size, size));
    for (x, y, pixel) in resized_rgb.enumerate_pixels() {
        for c in 0..3 {
            input_tensor[[0, c, y as usize, x as usize]] =
                (pixel[c] as f32 / 255.0 - mean[c]) / std[c];
        }
    }

    let outputs = gpu_inference(session.run(ort::inputs![Tensor::from_array(input_tensor)?]))?;
    let mask_data: Vec<u8> = outputs[0]
        .try_extract_array::<f32>()?
        .iter()
        .map(|&v| (sigmoid(v) * 255.0).round() as u8)
        .collect();

    GrayImage::from_raw(BIREFNET_INPUT_SIZE, BIREFNET_INPUT_SIZE, mask_data)
        .ok_or_else(|| anyhow::anyhow!("Failed to create mask from BiRefNet output"))
}

pub fn run_depth_anything_model(
    image: &DynamicImage,
    depth_session: &Mutex<Session>,
) -> Result<GrayImage> {
    let resized_image = image.resize(DEPTH_INPUT_SIZE, DEPTH_INPUT_SIZE, FilterType::Triangle);
    let (resized_w, resized_h) = resized_image.dimensions();
    let resized_rgb = resized_image.into_rgb8();
    let raw_pixels = resized_rgb.as_raw();

    let paste_x = ((DEPTH_INPUT_SIZE - resized_w) / 2) as usize;
    let paste_y = ((DEPTH_INPUT_SIZE - resized_h) / 2) as usize;

    let mut input_tensor: Array<f32, _> =
        Array::zeros((1, 3, DEPTH_INPUT_SIZE as usize, DEPTH_INPUT_SIZE as usize));

    let mean = [0.485, 0.456, 0.406];
    let std = [0.229, 0.224, 0.225];

    let rw = resized_w as usize;
    let rh = resized_h as usize;

    for y in 0..rh {
        for x in 0..rw {
            let idx = (y * rw + x) * 3;
            let dest_y = y + paste_y;
            let dest_x = x + paste_x;

            input_tensor[[0, 0, dest_y, dest_x]] =
                (raw_pixels[idx] as f32 / 255.0 - mean[0]) / std[0];
            input_tensor[[0, 1, dest_y, dest_x]] =
                (raw_pixels[idx + 1] as f32 / 255.0 - mean[1]) / std[1];
            input_tensor[[0, 2, dest_y, dest_x]] =
                (raw_pixels[idx + 2] as f32 / 255.0 - mean[2]) / std[2];
        }
    }

    let input_tensor_dyn = input_tensor.into_dyn();
    let t_input = Tensor::from_array(input_tensor_dyn.as_standard_layout().into_owned())?;

    let mut session = depth_session.lock().unwrap();
    let outputs = gpu_inference(session.run(ort::inputs![t_input]))?;
    let output_tensor = outputs[0].try_extract_array::<f32>()?.to_owned();
    let out_slice = output_tensor.as_slice().unwrap();

    let usize_size = DEPTH_INPUT_SIZE as usize;

    let mut min_val = f32::MAX;
    let mut max_val = f32::MIN;
    for y in 0..rh {
        let src_y = y + paste_y;
        for x in 0..rw {
            let src_x = x + paste_x;
            let val = out_slice[src_y * usize_size + src_x];
            min_val = min_val.min(val);
            max_val = max_val.max(val);
        }
    }

    let range = max_val - min_val;
    let scale = if range > 1e-6 { 255.0 / range } else { 0.0 };

    let mut cropped_depth_data = Vec::with_capacity(rw * rh);

    for y in 0..rh {
        let src_y = y + paste_y;
        for x in 0..rw {
            let src_x = x + paste_x;
            let val = out_slice[src_y * usize_size + src_x];
            let pixel = if range > 1e-6 {
                ((val - min_val) * scale) as u8
            } else {
                0
            };
            cropped_depth_data.push(pixel);
        }
    }

    let depth_map = GrayImage::from_raw(resized_w, resized_h, cropped_depth_data)
        .ok_or_else(|| anyhow::anyhow!("Failed to create mask from Depth output"))?;

    Ok(depth_map)
}

fn build_normal_depth(points: &[f32], mask: &[f32]) -> Vec<u8> {
    let valid = |point: &[f32; 3], m: f32| {
        m >= 0.5 && point.iter().all(|v| v.is_finite()) && point[2] > 0.0
    };

    let mut depths: Vec<f32> = points
        .as_chunks::<3>()
        .0
        .iter()
        .zip(mask)
        .filter(|(point, m)| valid(point, **m))
        .map(|(point, _)| point[2])
        .collect();

    if depths.len() < 16 {
        return vec![255; mask.len()];
    }

    depths.sort_unstable_by(|a, b| a.total_cmp(b));
    let percentile = |p: f32| depths[((depths.len() - 1) as f32 * p) as usize];
    let near = percentile(0.005);
    let range = (percentile(0.995) - near).max(1e-6);

    points
        .as_chunks::<3>()
        .0
        .iter()
        .zip(mask)
        .map(|(point, m)| {
            if valid(point, *m) {
                (((point[2] - near) / range).clamp(0.0, 1.0) * 255.0).round() as u8
            } else {
                255
            }
        })
        .collect()
}

pub fn run_normal_model(
    image: &DynamicImage,
    normal_session: &Mutex<Session>,
) -> Result<RgbaImage> {
    let resized_image = if image.width().max(image.height()) > NORMAL_MAX_SIZE {
        image.resize(NORMAL_MAX_SIZE, NORMAL_MAX_SIZE, FilterType::Triangle)
    } else {
        image.clone()
    };
    let (resized_w, resized_h) = resized_image.dimensions();
    let resized_rgb = resized_image.into_rgb8();
    let raw_pixels = resized_rgb.as_raw();

    let rw = resized_w as usize;
    let rh = resized_h as usize;

    let mut input_tensor: Array<f32, _> = Array::zeros((1, 3, rh, rw));
    for y in 0..rh {
        for x in 0..rw {
            let idx = (y * rw + x) * 3;
            input_tensor[[0, 0, y, x]] = raw_pixels[idx] as f32 / 255.0;
            input_tensor[[0, 1, y, x]] = raw_pixels[idx + 1] as f32 / 255.0;
            input_tensor[[0, 2, y, x]] = raw_pixels[idx + 2] as f32 / 255.0;
        }
    }

    let t_image = Tensor::from_array(input_tensor.into_dyn())?;
    let t_num_tokens = Tensor::from_array(ndarray::arr0(NORMAL_NUM_TOKENS))?;

    let mut session = normal_session.lock().unwrap();
    let outputs = gpu_inference(session.run(ort::inputs![
        "image" => t_image,
        "num_tokens" => t_num_tokens,
    ]))?;

    let normal_tensor = outputs["normal"].try_extract_array::<f32>()?;
    let mask_tensor = outputs["mask"].try_extract_array::<f32>()?;
    let points_tensor = outputs["points"].try_extract_array::<f32>()?;

    if normal_tensor.shape() != [1, rh, rw, 3]
        || mask_tensor.shape() != [1, rh, rw]
        || points_tensor.shape() != [1, rh, rw, 3]
    {
        return Err(anyhow::anyhow!(
            "Unexpected normal model output shape: {:?} / {:?} / {:?}",
            normal_tensor.shape(),
            mask_tensor.shape(),
            points_tensor.shape()
        ));
    }

    let normals = normal_tensor.as_standard_layout();
    let normals = normals.as_slice().unwrap();
    let mask = mask_tensor.as_standard_layout();
    let mask = mask.as_slice().unwrap();
    let points = points_tensor.as_standard_layout();
    let depth = build_normal_depth(points.as_slice().unwrap(), mask);

    let pack = |v: f32| ((v * 0.5 + 0.5).clamp(0.0, 1.0) * 255.0).round() as u8;

    let mut normal_data = Vec::with_capacity(rw * rh * 4);
    for (n, d) in normals.as_chunks::<3>().0.iter().zip(depth) {
        let (nx, ny, nz) = (n[0], -n[1], -n[2]);
        let len = (nx * nx + ny * ny + nz * nz).sqrt();
        if len.is_finite() && len > 1e-6 {
            normal_data.extend_from_slice(&[pack(nx / len), pack(ny / len), pack(nz / len)]);
        } else {
            normal_data.extend_from_slice(&[128, 128, 255]);
        }
        normal_data.push(d);
    }

    RgbaImage::from_raw(resized_w, resized_h, normal_data)
        .ok_or_else(|| anyhow::anyhow!("Failed to create normal map from model output"))
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiSubjectMaskParameters {
    pub start_x: f64,
    pub start_y: f64,
    pub end_x: f64,
    pub end_y: f64,
    #[serde(default)]
    pub mask_data_base64: Option<String>,
    #[serde(default)]
    pub rotation: Option<f32>,
    #[serde(default)]
    pub flip_horizontal: Option<bool>,
    #[serde(default)]
    pub flip_vertical: Option<bool>,
    #[serde(default)]
    pub orientation_steps: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub box_space_width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub box_space_height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_source: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiSkyMaskParameters {
    #[serde(default)]
    pub mask_data_base64: Option<String>,
    #[serde(default)]
    pub rotation: Option<f32>,
    #[serde(default)]
    pub flip_horizontal: Option<bool>,
    #[serde(default)]
    pub flip_vertical: Option<bool>,
    #[serde(default)]
    pub orientation_steps: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_source: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiTextMaskParameters {
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub mask_data_base64: Option<String>,
    #[serde(default)]
    pub rotation: Option<f32>,
    #[serde(default)]
    pub flip_horizontal: Option<bool>,
    #[serde(default)]
    pub flip_vertical: Option<bool>,
    #[serde(default)]
    pub orientation_steps: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_source: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiFaceMaskParameters {
    #[serde(default)]
    pub parts: Vec<String>,
    #[serde(default)]
    pub mask_data_base64: Option<String>,
    #[serde(default)]
    pub rotation: Option<f32>,
    #[serde(default)]
    pub flip_horizontal: Option<bool>,
    #[serde(default)]
    pub flip_vertical: Option<bool>,
    #[serde(default)]
    pub orientation_steps: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_source: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiForegroundMaskParameters {
    #[serde(default)]
    pub mask_data_base64: Option<String>,
    #[serde(default)]
    pub rotation: Option<f32>,
    #[serde(default)]
    pub flip_horizontal: Option<bool>,
    #[serde(default)]
    pub flip_vertical: Option<bool>,
    #[serde(default)]
    pub orientation_steps: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_source: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiDepthMaskParameters {
    #[serde(default)]
    pub min_depth: f32,
    #[serde(default)]
    pub max_depth: f32,
    #[serde(default)]
    pub min_fade: f32,
    #[serde(default)]
    pub max_fade: f32,
    #[serde(default)]
    pub feather: f32,
    #[serde(default)]
    pub mask_data_base64: Option<String>,
    #[serde(default)]
    pub rotation: Option<f32>,
    #[serde(default)]
    pub flip_horizontal: Option<bool>,
    #[serde(default)]
    pub flip_vertical: Option<bool>,
    #[serde(default)]
    pub orientation_steps: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_source: Option<String>,
}
