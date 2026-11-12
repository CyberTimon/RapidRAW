use crate::export::settings::{
    BorderBasis, BorderOptions, ExportSettings, PadOptions, ResizeMode, ResizeOptions,
};
use crate::export::watermark::apply_watermark;
use image::{DynamicImage, GenericImageView, ImageBuffer, imageops};
use serde_json::Value;

const PAD_RATIO_EPSILON: f64 = 0.001;

const MAX_PAD_DIMENSION: u32 = 65_535;

const MAX_BORDER_PERCENT: f64 = 100.0;

#[derive(Debug, Clone, Copy)]
pub(crate) struct ExportGeometry {
    pub canvas_w: u32,
    pub canvas_h: u32,
    pub photo_w: u32,
    pub photo_h: u32,
    pub offset_x: u32,
    pub offset_y: u32,
    pub border_x: u32,
    pub border_y: u32,
}

impl ExportGeometry {
    fn has_border(&self) -> bool {
        self.border_x > 0 || self.border_y > 0
    }

    pub fn is_identity(&self) -> bool {
        self.canvas_w == self.photo_w && self.canvas_h == self.photo_h
    }
}

fn calculate_resize_target(
    current_w: u32,
    current_h: u32,
    resize_opts: &ResizeOptions,
) -> (u32, u32) {
    if resize_opts.dont_enlarge {
        let exceeds = match resize_opts.mode {
            ResizeMode::LongEdge => current_w.max(current_h) > resize_opts.value,
            ResizeMode::ShortEdge => current_w.min(current_h) > resize_opts.value,
            ResizeMode::Width => current_w > resize_opts.value,
            ResizeMode::Height => current_h > resize_opts.value,
        };
        if !exceeds {
            return (current_w, current_h);
        }
    }

    let fix_width = match resize_opts.mode {
        ResizeMode::LongEdge => current_w >= current_h,
        ResizeMode::ShortEdge => current_w <= current_h,
        ResizeMode::Width => true,
        ResizeMode::Height => false,
    };

    let value = resize_opts.value;
    if fix_width {
        let h = (value as f32 * (current_h as f32 / current_w as f32)).round() as u32;
        (value, h)
    } else {
        let w = (value as f32 * (current_w as f32 / current_h as f32)).round() as u32;
        (w, value)
    }
}

fn parse_hex_color(hex: &str) -> Option<[u8; 3]> {
    let raw = hex.trim().trim_start_matches('#');
    let normalized: String = match raw.len() {
        3 => raw.chars().flat_map(|c| [c, c]).collect(),
        6 => raw.to_string(),
        8 => raw[..6].to_string(),
        _ => return None,
    };
    Some([
        u8::from_str_radix(&normalized[0..2], 16).ok()?,
        u8::from_str_radix(&normalized[2..4], 16).ok()?,
        u8::from_str_radix(&normalized[4..6], 16).ok()?,
    ])
}

fn fill_color(hex: Option<&str>) -> [u8; 3] {
    hex.and_then(parse_hex_color).unwrap_or([0, 0, 0])
}

fn resize_target(width: u32, height: u32, resize_opts: Option<&ResizeOptions>) -> (u32, u32) {
    match resize_opts {
        Some(opts) => calculate_resize_target(width, height, opts),
        None => (width, height),
    }
}

fn bordered_size(width: u32, height: u32, border_x: u32, border_y: u32) -> (u32, u32) {
    (
        width.saturating_add(border_x.saturating_mul(2)),
        height.saturating_add(border_y.saturating_mul(2)),
    )
}

fn exceeds_max_dimension(label: &str, width: u32, height: u32) -> bool {
    let exceeds = width > MAX_PAD_DIMENSION || height > MAX_PAD_DIMENSION;
    if exceeds {
        log::warn!(
            "{} {}x{} exceeds the maximum supported dimension; skipping.",
            label,
            width,
            height
        );
    }
    exceeds
}

fn calculate_pad_target(current_w: u32, current_h: u32, pad: &PadOptions) -> Option<(u32, u32)> {
    let ratio_w = pad.ratio_width as f64;
    let ratio_h = pad.ratio_height as f64;
    if !ratio_w.is_finite() || !ratio_h.is_finite() || ratio_w <= 0.0 || ratio_h <= 0.0 {
        return None;
    }

    let target_ratio = ratio_w / ratio_h;
    let original_ratio = current_w as f64 / current_h as f64;
    if (original_ratio - target_ratio).abs() < PAD_RATIO_EPSILON {
        return None;
    }

    let (new_w, new_h) = if original_ratio > target_ratio {
        (current_w, (current_w as f64 / target_ratio).round() as u32)
    } else {
        ((current_h as f64 * target_ratio).round() as u32, current_h)
    };

    let new_w = new_w.max(current_w);
    let new_h = new_h.max(current_h);

    if exceeds_max_dimension("Pad target", new_w, new_h)
        || (new_w == current_w && new_h == current_h)
    {
        return None;
    }

    Some((new_w, new_h))
}

fn calculate_border_thickness(
    src_w: u32,
    src_h: u32,
    border: &BorderOptions,
) -> Option<(u32, u32)> {
    let horizontal = border.horizontal_percent as f64;
    let vertical = border.vertical_percent as f64;
    if !horizontal.is_finite() || !vertical.is_finite() {
        return None;
    }

    if horizontal < 0.0
        || vertical < 0.0
        || horizontal > MAX_BORDER_PERCENT
        || vertical > MAX_BORDER_PERCENT
    {
        log::warn!(
            "Border percentages {}/{} are outside 0..={}; skipping border.",
            horizontal,
            vertical,
            MAX_BORDER_PERCENT
        );
        return None;
    }

    let (basis_x, basis_y) = match border.basis {
        BorderBasis::LongEdge => {
            let edge = src_w.max(src_h) as f64;
            (edge, edge)
        }
        BorderBasis::ShortEdge => {
            let edge = src_w.min(src_h) as f64;
            (edge, edge)
        }
        BorderBasis::EachEdge => (src_w as f64, src_h as f64),
    };

    let border_x = (basis_x * horizontal / 100.0).round() as u32;
    let border_y = (basis_y * vertical / 100.0).round() as u32;

    if border_x == 0 && border_y == 0 {
        return None;
    }

    let (bordered_w, bordered_h) = bordered_size(src_w, src_h, border_x, border_y);
    if exceeds_max_dimension("Bordered size", bordered_w, bordered_h) {
        return None;
    }

    Some((border_x, border_y))
}

fn compute_export_geometry(
    src_w: u32,
    src_h: u32,
    settings: &ExportSettings,
) -> Option<ExportGeometry> {
    if src_w == 0 || src_h == 0 {
        return None;
    }

    let border = settings
        .border
        .as_ref()
        .and_then(|border| calculate_border_thickness(src_w, src_h, border));
    let (border_src_x, border_src_y) = border.unwrap_or((0, 0));
    let (bordered_w, bordered_h) = bordered_size(src_w, src_h, border_src_x, border_src_y);

    let pad_target = settings
        .pad
        .as_ref()
        .and_then(|pad| calculate_pad_target(bordered_w, bordered_h, pad));

    if border.is_none() && pad_target.is_none() {
        return None;
    }

    let (canvas_w, canvas_h) = pad_target.unwrap_or((bordered_w, bordered_h));

    Some(compute_fused_geometry(
        src_w,
        src_h,
        border_src_x,
        border_src_y,
        canvas_w,
        canvas_h,
        settings.resize.as_ref(),
    ))
}

#[allow(clippy::too_many_arguments)]
fn compute_fused_geometry(
    src_w: u32,
    src_h: u32,
    border_src_x: u32,
    border_src_y: u32,
    canvas_w: u32,
    canvas_h: u32,
    resize_opts: Option<&ResizeOptions>,
) -> ExportGeometry {
    let (final_w, final_h) = resize_target(canvas_w, canvas_h, resize_opts);
    let (final_w, final_h) = (final_w.max(1), final_h.max(1));

    let photo_w =
        ((src_w as f64 * final_w as f64 / canvas_w as f64).round() as u32).clamp(1, final_w);
    let photo_h =
        ((src_h as f64 * final_h as f64 / canvas_h as f64).round() as u32).clamp(1, final_h);

    let border_x = ((border_src_x as f64 * final_w as f64 / canvas_w as f64).round() as u32)
        .min(final_w.saturating_sub(photo_w) / 2);
    let border_y = ((border_src_y as f64 * final_h as f64 / canvas_h as f64).round() as u32)
        .min(final_h.saturating_sub(photo_h) / 2);

    ExportGeometry {
        canvas_w: final_w,
        canvas_h: final_h,
        photo_w,
        photo_h,
        offset_x: (final_w - photo_w) / 2,
        offset_y: (final_h - photo_h) / 2,
        border_x,
        border_y,
    }
}

pub fn compute_export_output_size(src_w: u32, src_h: u32, settings: &ExportSettings) -> (u32, u32) {
    match compute_export_geometry(src_w, src_h, settings) {
        Some(geometry) => (geometry.canvas_w, geometry.canvas_h),
        None => resize_target(src_w, src_h, settings.resize.as_ref()),
    }
}

trait FillChannel: image::Primitive {
    fn from_u8(value: u8) -> Self;
}

impl FillChannel for u8 {
    fn from_u8(value: u8) -> Self {
        value
    }
}

impl FillChannel for u16 {
    fn from_u8(value: u8) -> Self {
        value as u16 * 257
    }
}

impl FillChannel for f32 {
    fn from_u8(value: u8) -> Self {
        value as f32 / 255.0
    }
}

trait SolidFill: image::Pixel + 'static {
    fn from_rgb8(color: [u8; 3]) -> Self;
}

impl<T: FillChannel> SolidFill for image::Rgb<T>
where
    image::Rgb<T>: image::Pixel<Subpixel = T> + 'static,
{
    fn from_rgb8([r, g, b]: [u8; 3]) -> Self {
        image::Rgb([T::from_u8(r), T::from_u8(g), T::from_u8(b)])
    }
}

impl<T: FillChannel> SolidFill for image::Rgba<T>
where
    image::Rgba<T>: image::Pixel<Subpixel = T> + 'static,
{
    fn from_rgb8([r, g, b]: [u8; 3]) -> Self {
        image::Rgba([
            T::from_u8(r),
            T::from_u8(g),
            T::from_u8(b),
            T::DEFAULT_MAX_VALUE,
        ])
    }
}

fn fill_border_frame<P>(
    canvas: &mut ImageBuffer<P, Vec<P::Subpixel>>,
    geometry: &ExportGeometry,
    fill: P,
) where
    P: image::Pixel + 'static,
    P::Subpixel: 'static,
{
    let box_x = geometry.offset_x.saturating_sub(geometry.border_x);
    let box_y = geometry.offset_y.saturating_sub(geometry.border_y);
    let box_w = geometry
        .photo_w
        .saturating_add(geometry.border_x.saturating_mul(2));
    let below_photo = geometry.offset_y.saturating_add(geometry.photo_h);
    let right_of_photo = geometry.offset_x.saturating_add(geometry.photo_w);

    let strips = [
        (box_x, box_y, box_w, geometry.border_y),
        (box_x, below_photo, box_w, geometry.border_y),
        (
            box_x,
            geometry.offset_y,
            geometry.border_x,
            geometry.photo_h,
        ),
        (
            right_of_photo,
            geometry.offset_y,
            geometry.border_x,
            geometry.photo_h,
        ),
    ];

    for (x, y, width, height) in strips {
        let x_end = x.saturating_add(width).min(canvas.width());
        let y_end = y.saturating_add(height).min(canvas.height());
        for row in y..y_end {
            for col in x..x_end {
                canvas.put_pixel(col, row, fill);
            }
        }
    }
}

pub fn place_photo_on_canvas<P>(
    src: &ImageBuffer<P, Vec<P::Subpixel>>,
    geometry: &ExportGeometry,
    outer_fill: P,
    border_fill: Option<P>,
) -> ImageBuffer<P, Vec<P::Subpixel>>
where
    P: image::Pixel + 'static,
    P::Subpixel: 'static,
{
    let mut canvas = ImageBuffer::from_pixel(geometry.canvas_w, geometry.canvas_h, outer_fill);

    if let Some(fill) = border_fill
        && geometry.has_border()
    {
        fill_border_frame(&mut canvas, geometry, fill);
    }

    imageops::replace(
        &mut canvas,
        src,
        geometry.offset_x as i64,
        geometry.offset_y as i64,
    );
    canvas
}

fn compose_image_on_canvas(
    image: &DynamicImage,
    geometry: &ExportGeometry,
    pad_color: [u8; 3],
    border_color: [u8; 3],
) -> DynamicImage {
    fn compose<P: SolidFill>(
        src: &ImageBuffer<P, Vec<P::Subpixel>>,
        geometry: &ExportGeometry,
        pad_color: [u8; 3],
        border_color: [u8; 3],
    ) -> ImageBuffer<P, Vec<P::Subpixel>>
    where
        P::Subpixel: 'static,
    {
        place_photo_on_canvas(
            src,
            geometry,
            P::from_rgb8(pad_color),
            Some(P::from_rgb8(border_color)),
        )
    }

    match image {
        DynamicImage::ImageRgb8(buffer) => {
            DynamicImage::ImageRgb8(compose(buffer, geometry, pad_color, border_color))
        }
        DynamicImage::ImageRgba8(buffer) => {
            DynamicImage::ImageRgba8(compose(buffer, geometry, pad_color, border_color))
        }
        DynamicImage::ImageRgb16(buffer) => {
            DynamicImage::ImageRgb16(compose(buffer, geometry, pad_color, border_color))
        }
        DynamicImage::ImageRgba16(buffer) => {
            DynamicImage::ImageRgba16(compose(buffer, geometry, pad_color, border_color))
        }
        DynamicImage::ImageRgb32F(buffer) => {
            DynamicImage::ImageRgb32F(compose(buffer, geometry, pad_color, border_color))
        }
        DynamicImage::ImageRgba32F(buffer) => {
            DynamicImage::ImageRgba32F(compose(buffer, geometry, pad_color, border_color))
        }
        other => DynamicImage::ImageRgba8(compose(
            &other.to_rgba8(),
            geometry,
            pad_color,
            border_color,
        )),
    }
}

fn apply_export_geometry(
    mut image: DynamicImage,
    export_settings: &ExportSettings,
) -> Result<(DynamicImage, ExportGeometry), String> {
    let (src_w, src_h) = image.dimensions();

    match compute_export_geometry(src_w, src_h, export_settings) {
        None => {
            let (target_w, target_h) = resize_target(src_w, src_h, export_settings.resize.as_ref());
            if target_w != src_w || target_h != src_h {
                image = image.resize(target_w, target_h, imageops::FilterType::Lanczos3);
            }

            let (width, height) = image.dimensions();
            Ok((
                image,
                ExportGeometry {
                    canvas_w: width,
                    canvas_h: height,
                    photo_w: width,
                    photo_h: height,
                    offset_x: 0,
                    offset_y: 0,
                    border_x: 0,
                    border_y: 0,
                },
            ))
        }
        Some(geometry) => {
            if geometry.photo_w != src_w || geometry.photo_h != src_h {
                image = image.resize_exact(
                    geometry.photo_w,
                    geometry.photo_h,
                    imageops::FilterType::Lanczos3,
                );
            }

            let pad_color = fill_color(export_settings.pad.as_ref().map(|pad| pad.color.as_str()));
            let border_color = fill_color(
                export_settings
                    .border
                    .as_ref()
                    .map(|border| border.color.as_str()),
            );

            Ok((
                compose_image_on_canvas(&image, &geometry, pad_color, border_color),
                geometry,
            ))
        }
    }
}

pub fn apply_export_geometry_and_watermark(
    image: DynamicImage,
    export_settings: &ExportSettings,
) -> Result<(DynamicImage, ExportGeometry), String> {
    let (mut image, geometry) = apply_export_geometry(image, export_settings)?;

    if let Some(watermark_settings) = &export_settings.watermark {
        apply_watermark(&mut image, watermark_settings)?;
    }
    Ok((image, geometry))
}

pub fn upscale_factor(adjustments: &Value) -> u32 {
    if crate::ai::upscale::is_enabled(adjustments) {
        crate::ai::upscale::FACTOR
    } else {
        1
    }
}
