use crate::masks::morphology::for_each_mask_row;
use image::GrayImage;

pub struct TransformParams {
    pub rotation: f32,
    pub flip_horizontal: bool,
    pub flip_vertical: bool,
    pub orientation_steps: u8,
    pub width: u32,
    pub height: u32,
    pub scale: f32,
    pub crop_offset: (f32, f32),
}

pub fn generate_edge_clamped_bitmap(full_map: &GrayImage, tf: &TransformParams) -> GrayImage {
    transform_full_mask(full_map, tf, true)
}

pub fn output_to_source(
    tf: &TransformParams,
    source_w: u32,
    source_h: u32,
) -> impl Fn(f32, f32) -> (f32, f32) + Sync {
    let angle_rad = tf.rotation.to_radians();
    let cos_a = angle_rad.cos();
    let sin_a = angle_rad.sin();

    let (coarse_rotated_w, coarse_rotated_h) = if tf.orientation_steps % 2 == 1 {
        (source_h, source_w)
    } else {
        (source_w, source_h)
    };

    let scaled_coarse_rotated_w = coarse_rotated_w as f32 * tf.scale;
    let scaled_coarse_rotated_h = coarse_rotated_h as f32 * tf.scale;
    let center_x = scaled_coarse_rotated_w / 2.0;
    let center_y = scaled_coarse_rotated_h / 2.0;

    let (scale, crop_offset) = (tf.scale, tf.crop_offset);
    let (flip_horizontal, flip_vertical) = (tf.flip_horizontal, tf.flip_vertical);
    let orientation_steps = tf.orientation_steps;

    move |x_out: f32, y_out: f32| {
        let x_uncrop = x_out + crop_offset.0;
        let y_uncrop = y_out + crop_offset.1;

        let x_centered = x_uncrop - center_x;
        let y_centered = y_uncrop - center_y;

        let x_unrotated = x_centered * cos_a + y_centered * sin_a + center_x;
        let y_unrotated = -x_centered * sin_a + y_centered * cos_a + center_y;

        let x_unflipped = if flip_horizontal {
            scaled_coarse_rotated_w - x_unrotated
        } else {
            x_unrotated
        };
        let y_unflipped = if flip_vertical {
            scaled_coarse_rotated_h - y_unrotated
        } else {
            y_unrotated
        };

        let (x_unrotated_coarse, y_unrotated_coarse) = match orientation_steps {
            0 => (x_unflipped, y_unflipped),
            1 => (y_unflipped, scaled_coarse_rotated_w - x_unflipped),
            2 => (
                scaled_coarse_rotated_w - x_unflipped,
                scaled_coarse_rotated_h - y_unflipped,
            ),
            3 => (scaled_coarse_rotated_h - y_unflipped, x_unflipped),
            _ => (x_unflipped, y_unflipped),
        };

        (x_unrotated_coarse / scale, y_unrotated_coarse / scale)
    }
}

pub fn transform_full_mask(
    full_mask_image: &GrayImage,
    tf: &TransformParams,
    clamp_edges: bool,
) -> GrayImage {
    let (full_mask_w, full_mask_h) = full_mask_image.dimensions();
    let mut final_mask = GrayImage::new(tf.width, tf.height);

    let to_source = output_to_source(tf, full_mask_w, full_mask_h);

    let raw = full_mask_image.as_raw();
    let sample = |(x_src, y_src): (f32, f32)| {
        if clamp_edges
            || (x_src >= 0.0
                && x_src < full_mask_w as f32
                && y_src >= 0.0
                && y_src < full_mask_h as f32)
        {
            let x = (x_src.max(0.0) as usize).min(full_mask_w as usize - 1);
            let y = (y_src.max(0.0) as usize).min(full_mask_h as usize - 1);
            raw[y * full_mask_w as usize + x] as u32
        } else {
            0
        }
    };

    for_each_mask_row(&mut final_mask, |y_out, row| {
        for (x_out, value) in row.iter_mut().enumerate() {
            *value = sample(to_source(x_out as f32, y_out as f32)) as u8;
        }
    });

    let taps = (tf.scale.recip() - 1.0e-3).ceil().max(1.0) as u32;
    if taps == 1 {
        return final_mask;
    }

    let origin = to_source(0.0, 0.0);
    let step_x = to_source(1.0, 0.0);
    let step_y = to_source(0.0, 1.0);
    let (step_x, step_y) = (
        (step_x.0 - origin.0, step_x.1 - origin.1),
        (step_y.0 - origin.0, step_y.1 - origin.1),
    );
    let offsets: Vec<(f32, f32)> = (0..taps * taps)
        .map(|k| {
            let u = ((k % taps) as f32 + 0.5) / taps as f32;
            let v = ((k / taps) as f32 + 0.5) / taps as f32;
            (u * step_x.0 + v * step_y.0, u * step_x.1 + v * step_y.1)
        })
        .collect();
    let count = taps * taps;

    let nearest = final_mask.clone();
    let (width, height) = (tf.width as usize, tf.height as usize);
    let near = nearest.as_raw();
    for_each_mask_row(&mut final_mask, |y_out, row| {
        let y = y_out as usize;
        for (x, value) in row.iter_mut().enumerate() {
            let v = *value;
            let at = |nx: usize, ny: usize| near[ny * width + nx];
            let edge = (v != 0 && v != 255)
                || (x > 0 && at(x - 1, y) != v)
                || (x + 1 < width && at(x + 1, y) != v)
                || (y > 0 && at(x, y - 1) != v)
                || (y + 1 < height && at(x, y + 1) != v);
            if edge {
                let corner = to_source(x as f32, y_out as f32);
                let sum: u32 = offsets
                    .iter()
                    .map(|&(dx, dy)| sample((corner.0 + dx, corner.1 + dy)))
                    .sum();
                *value = ((sum + count / 2) / count) as u8;
            }
        }
    });

    final_mask
}
