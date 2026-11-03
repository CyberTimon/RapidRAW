use nalgebra::{Matrix3, Point3};

const MAX_AREA_EXPANSION: u64 = 8;
const MAX_WORKING_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MIN_RELATIVE_DENOMINATOR: f64 = 1e-8;

pub struct CanvasInput {
    pub width: u32,
    pub height: u32,
    pub homography: Matrix3<f64>,
}

pub struct CanvasPlan {
    pub width: u32,
    pub height: u32,
    pub offset_x: f64,
    pub offset_y: f64,
    pub working_bytes: u64,
    pub memory_limit: u64,
    pub inverses: Vec<Matrix3<f64>>,
}

pub fn plan_canvas(inputs: &[CanvasInput], available_memory: u64) -> Result<CanvasPlan, String> {
    if inputs.is_empty() {
        return Err("No matched images are available to stitch.".to_string());
    }
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    let mut input_pixels = 0_u64;
    let mut inverses = Vec::with_capacity(inputs.len());

    for input in inputs {
        if input.width == 0 || input.height == 0 {
            return Err("Cannot stitch an image with empty dimensions.".to_string());
        }
        input_pixels = input_pixels
            .checked_add(u64::from(input.width) * u64::from(input.height))
            .ok_or("The panorama input dimensions are too large.")?;
        let h = &input.homography;
        if !h.iter().all(|value| value.is_finite()) {
            return Err("Panorama alignment contains non-finite values.".to_string());
        }
        let inverse = h
            .try_inverse()
            .filter(|matrix| matrix.iter().all(|value| value.is_finite()))
            .ok_or("Panorama alignment is singular or cannot be inverted reliably.")?;
        inverses.push(inverse);

        let corners = [
            Point3::new(0.0, 0.0, 1.0),
            Point3::new(f64::from(input.width), 0.0, 1.0),
            Point3::new(f64::from(input.width), f64::from(input.height), 1.0),
            Point3::new(0.0, f64::from(input.height), 1.0),
        ];
        let projected = corners.map(|point| h * point);
        if !projected
            .iter()
            .all(|point| point.coords.iter().all(|value| value.is_finite()))
        {
            return Err(
                "Panorama alignment produces non-finite projected coordinates.".to_string(),
            );
        }
        let denominator_scale = projected
            .iter()
            .map(|point| point.z.abs())
            .fold(0.0, f64::max);
        let negative = projected[0].z.is_sign_negative();
        // A denominator changing sign across the image places the projective horizon inside it.
        // Relative magnitudes keep the check independent of the homography's arbitrary scale.
        if projected.iter().any(|point| {
            point.z.abs() <= denominator_scale * MIN_RELATIVE_DENOMINATOR
                || point.z.is_sign_negative() != negative
        }) {
            return Err("Panorama alignment projects an image at or across the horizon. Try images with more overlap.".to_string());
        }
        for point in projected {
            let x = point.x / point.z;
            let y = point.y / point.z;
            if !x.is_finite() || !y.is_finite() {
                return Err("Panorama alignment produces non-finite canvas bounds.".to_string());
            }
            min_x = min_x.min(x);
            max_x = max_x.max(x);
            min_y = min_y.min(y);
            max_y = max_y.max(y);
        }
    }

    let width = (max_x - min_x).ceil();
    let height = (max_y - min_y).ceil();
    if !width.is_finite()
        || !height.is_finite()
        || width < 1.0
        || height < 1.0
        || width > f64::from(i32::MAX)
        || height > f64::from(i32::MAX)
    {
        return Err(
            "Panorama alignment produces invalid or oversized canvas dimensions.".to_string(),
        );
    }
    let width = width as u32;
    let height = height as u32;
    let pixels = u64::from(width) * u64::from(height);
    if pixels > input_pixels.saturating_mul(MAX_AREA_EXPANSION) {
        return Err(format!(
            "Panorama canvas {width}x{height} is too large relative to the input images. Try a smaller group with more overlap."
        ));
    }

    // RGB float canvas + mask + the seam's f64 costs and i32 paths, row headers and seam coordinates.
    let row_headers = u64::from(height) * (2 * size_of::<Vec<u8>>()) as u64;
    let seam_bytes = u64::from(width.max(height)) * size_of::<i32>() as u64;
    let working_bytes = pixels
        .checked_mul(25)
        .and_then(|bytes| bytes.checked_add(row_headers))
        .and_then(|bytes| bytes.checked_add(seam_bytes))
        .ok_or("The panorama working memory estimate overflowed.")?;
    let canvas_bytes = pixels
        .checked_mul(12)
        .ok_or("The panorama canvas size overflowed.")?;
    if canvas_bytes > isize::MAX as u64 {
        return Err("The panorama canvas exceeds this platform's allocation limit.".to_string());
    }
    let memory_limit = MAX_WORKING_BYTES.min(available_memory / 2);
    if working_bytes > memory_limit {
        return Err(format!(
            "Panorama canvas {width}x{height} needs approximately {} MiB of working memory; the limit is {} MiB. Try a smaller group of images or free memory.",
            working_bytes.div_ceil(1024 * 1024),
            memory_limit / (1024 * 1024),
        ));
    }

    Ok(CanvasPlan {
        width,
        height,
        offset_x: -min_x,
        offset_y: -min_y,
        working_bytes,
        memory_limit,
        inverses,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const AVAILABLE: u64 = 16 * 1024 * 1024 * 1024;

    fn input(width: u32, height: u32, homography: Matrix3<f64>) -> CanvasInput {
        CanvasInput {
            width,
            height,
            homography,
        }
    }

    #[test]
    fn identity_and_translations_preserve_canvas_geometry() {
        let inputs = [
            input(100, 80, Matrix3::identity()),
            input(
                100,
                80,
                Matrix3::new(1.0, 0.0, -40.0, 0.0, 1.0, 10.0, 0.0, 0.0, 1.0),
            ),
        ];
        let plan = plan_canvas(&inputs, AVAILABLE).unwrap();
        assert_eq!((plan.width, plan.height), (140, 90));
        assert_eq!((plan.offset_x, plan.offset_y), (40.0, 0.0));
        assert_eq!(plan.inverses.len(), 2);
        for (image, inverse) in inputs.iter().zip(&plan.inverses) {
            assert!((image.homography * inverse - Matrix3::identity()).norm() < 1e-12);
        }
    }

    #[test]
    fn homogeneous_scale_and_sign_do_not_reject_valid_alignments() {
        for scale in [1.0, -1.0, 1e-8, -1e-8, 1e8, -1e8] {
            let inputs = [input(100, 80, Matrix3::identity() * scale)];
            assert!(plan_canvas(&inputs, AVAILABLE).is_ok(), "scale {scale}");
        }
    }

    #[test]
    fn normal_perspective_alignment_is_accepted() {
        let inputs = [input(
            100,
            80,
            Matrix3::new(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.001, 0.0, 1.0),
        )];
        let plan = plan_canvas(&inputs, AVAILABLE).unwrap();
        assert_eq!((plan.width, plan.height), (91, 80));
    }

    #[test]
    fn empty_inputs_and_zero_sized_images_are_rejected() {
        assert!(plan_canvas(&[], AVAILABLE).is_err());
        for dimensions in [(0, 80), (100, 0), (0, 0)] {
            assert!(
                plan_canvas(
                    &[input(dimensions.0, dimensions.1, Matrix3::identity())],
                    AVAILABLE
                )
                .is_err()
            );
        }
    }

    #[test]
    fn singular_non_finite_and_overflowing_projections_are_rejected() {
        for matrix in [
            Matrix3::zeros(),
            Matrix3::new(f64::NAN, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0),
            Matrix3::new(f64::INFINITY, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0),
            Matrix3::new(f64::MAX, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0),
        ] {
            assert!(plan_canvas(&[input(100, 80, matrix)], AVAILABLE).is_err());
        }
    }

    #[test]
    fn projective_horizon_inside_or_at_the_image_is_rejected() {
        for coefficient in [-0.02, -0.01, -0.00999999999] {
            let matrix = Matrix3::new(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, coefficient, 0.0, 1.0);
            let error = plan_canvas(&[input(100, 80, matrix)], AVAILABLE)
                .err()
                .unwrap();
            assert!(error.contains("horizon"));
        }
    }

    #[test]
    fn reported_88_gigapixel_canvas_is_rejected_without_image_allocations() {
        let mut inputs: Vec<_> = (0..7)
            .map(|_| input(3072, 4096, Matrix3::identity()))
            .collect();
        inputs[6].homography[(0, 2)] = 396_205.0 - 3072.0;
        inputs[6].homography[(1, 2)] = 222_245.0 - 4096.0;
        let error = plan_canvas(&inputs, AVAILABLE).err().unwrap();
        assert!(error.contains("396205x222245"));
        assert!(error.contains("relative to the input"));
    }

    #[test]
    fn seam_matrices_and_row_storage_are_included_in_the_memory_budget() {
        let inputs = [input(100, 80, Matrix3::identity())];
        let plan = plan_canvas(&inputs, AVAILABLE).unwrap();
        let expected = 100 * 80 * 25 + 80 * (2 * size_of::<Vec<u8>>()) as u64 + 100 * 4;
        assert_eq!(plan.working_bytes, expected);
        assert!(plan_canvas(&inputs, expected * 2).is_ok());
        assert!(plan_canvas(&inputs, expected * 2 - 1).is_err());
        assert!(plan_canvas(&inputs, 0).is_err());
    }

    #[test]
    fn the_fixed_memory_ceiling_applies_even_on_large_memory_machines() {
        let error = plan_canvas(&[input(20_000, 10_000, Matrix3::identity())], u64::MAX)
            .err()
            .unwrap();
        assert!(error.contains("working memory"));
        assert!(error.contains("4096 MiB"));
    }

    #[test]
    fn dimension_and_memory_arithmetic_do_not_wrap() {
        let inputs = [input(i32::MAX as u32, i32::MAX as u32, Matrix3::identity())];
        assert!(plan_canvas(&inputs, u64::MAX).is_err());
        let inputs = [input(u32::MAX, u32::MAX, Matrix3::identity())];
        assert!(plan_canvas(&inputs, u64::MAX).is_err());
        let inputs = [
            input(u32::MAX, u32::MAX, Matrix3::identity() * 1e-8),
            input(u32::MAX, u32::MAX, Matrix3::identity() * 1e-8),
        ];
        assert!(plan_canvas(&inputs, u64::MAX).is_err());
    }
}
