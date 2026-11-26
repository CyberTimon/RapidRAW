use serde::Deserialize;
use wgpu::util::DeviceExt;

use crate::effects::motion_blur::{self, Flow, MotionBlurPipelines};
use crate::render::gpu::compute::{
    self, Bind, ComputeEncoder, Grid, Group, IMAGE_FORMAT, Out, Slot, Tex,
};
use crate::render::gpu::context::GpuContext;
use crate::video::ffmpeg::PixelLayout;
use crate::video::gpu::luma_weights;
use crate::video::model::{Direction, Transition, TransitionKind};

const MAX_LAYER_TAPS: f32 = 4.0;
const MAX_PIN_TAPS: u32 = 8;
const MIN_DEPTH: f64 = 1e-9;
const MIN_REDUCED_SIGMA: f32 = 3.0;
const TRANSITION_BLUR_SIGMA: f32 = 24.0;
const WHIP_BLUR_SIGMA: f32 = 40.0;
const BACKDROP_SIGMA: f32 = 0.03;
const BACKDROP_DIM: f32 = 0.35;
const IRIS_FEATHER: f32 = 3.0;
const SPIN_ANGLE: f32 = std::f32::consts::FRAC_PI_2;
const SQRT3_HALF: f32 = 0.866_025_4;
const PACK_ROW_WORDS: u32 = 4096;
const PACK_RGBA8: u32 = 0;
const PACK_RGB48: u32 = 1;
const PACK_YUV_PLANAR: u32 = 2;
const PACK_YUV_INTERLEAVED: u32 = 3;
const SCRATCH_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba32Float;
const STILL_REACH: f64 = 0.5;
const BLUR_MARGIN: f64 = 0.6;
const SERIES_LIMIT: f64 = 1.0e-4;
const WINDOW_STEP: u32 = 256;

type Affine = [[f64; 3]; 2];
type Projective = [[f64; 3]; 3];
type Rect = [f64; 4];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BlendMode {
    #[default]
    Normal,
    Multiply,
    Screen,
    Overlay,
    SoftLight,
    Add,
    Difference,
    Darken,
    Lighten,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placement {
    pub canvas_to_layer: [[f32; 3]; 2],
    pub perspective: Option<[f32; 3]>,
    pub opacity: f32,
    pub blend: BlendMode,
}

impl Placement {
    pub fn fit(canvas: (u32, u32), layer: (u32, u32)) -> Self {
        Self::centered(canvas, layer, f32::min)
    }

    pub fn cover(canvas: (u32, u32), layer: (u32, u32)) -> Self {
        Self::centered(canvas, layer, f32::max)
    }

    fn centered(canvas: (u32, u32), layer: (u32, u32), pick: fn(f32, f32) -> f32) -> Self {
        let scale = pick(
            canvas.0 as f32 / layer.0.max(1) as f32,
            canvas.1 as f32 / layer.1.max(1) as f32,
        );
        let offset = |canvas: u32, layer: u32| (canvas as f32 - layer as f32 * scale) * 0.5;
        Self {
            canvas_to_layer: [
                [1.0 / scale, 0.0, -offset(canvas.0, layer.0) / scale],
                [0.0, 1.0 / scale, -offset(canvas.1, layer.1) / scale],
            ],
            perspective: None,
            opacity: 1.0,
            blend: BlendMode::Normal,
        }
    }

    pub fn projective(canvas_to_layer: Projective, opacity: f32, blend: BlendMode) -> Self {
        let largest = canvas_to_layer
            .iter()
            .flatten()
            .fold(0.0f64, |largest, value| largest.max(value.abs()))
            .max(MIN_DEPTH);
        let [x, y, w] = canvas_to_layer.map(|row| row.map(|value| (value / largest) as f32));
        Self {
            canvas_to_layer: [x, y],
            perspective: Some(w),
            opacity,
            blend,
        }
    }

    fn matrix(&self) -> Projective {
        let [x, y] = self.canvas_to_layer.map(|row| row.map(f64::from));
        [
            x,
            y,
            self.perspective
                .map_or([0.0, 0.0, 1.0], |row| row.map(f64::from)),
        ]
    }

    fn shifted(&self, [ox, oy]: [f32; 2]) -> Self {
        let [x, y] = self.canvas_to_layer;
        let w = self.perspective.unwrap_or([0.0, 0.0, 1.0]);
        let shift =
            |row: [f32; 3], by: f32| std::array::from_fn(|index| row[index] - by * w[index]);
        Self {
            canvas_to_layer: [shift(x, ox), shift(y, oy)],
            ..*self
        }
    }
}

#[derive(Clone, Copy)]
enum Mask {
    Uniform,
    Line([f32; 4]),
    Circle([f32; 4]),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TextEdge {
    pub shown: f32,
    pub sharpness: f32,
    pub by_word: bool,
}

impl TextEdge {
    pub const ALL: Self = Self {
        shown: 1.0e9,
        sharpness: 1.0,
        by_word: false,
    };
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LayerPass {
    Blur(f32),
    Reveal {
        direction: Direction,
        visible: f32,
        entering: bool,
        softness: f32,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Subsampling {
    LeftSited,
    Swscale,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Packing {
    Rgba8,
    Rgb48,
    Yuv {
        layout: PixelLayout,
        matrix: Option<&'static str>,
        subsampling: Subsampling,
    },
}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    grid: Grid,
    values: [[f32; 4]; 4],
    modes: [[u32; 4]; 2],
}

impl Params {
    fn new(size: (u32, u32)) -> Self {
        Self::grid(Grid::new(size))
    }

    fn grid(grid: Grid) -> Self {
        Self {
            grid,
            ..Default::default()
        }
    }

    fn with(mut self, index: usize, values: [f32; 4]) -> Self {
        self.values[index] = values;
        self
    }

    fn modes(mut self, index: usize, modes: [u32; 4]) -> Self {
        self.modes[index] = modes;
        self
    }
}

fn dispatch(
    enc: &mut ComputeEncoder,
    entry: &str,
    inputs: &[&wgpu::TextureView],
    mut params: Params,
    format: wgpu::TextureFormat,
) -> Tex {
    let size = (params.grid.dst[0], params.grid.dst[1]);
    let out = enc.texture("Video Compose", size, format);
    params.grid.flags = (format == SCRATCH_FORMAT) as u32;
    let target = match format {
        SCRATCH_FORMAT => Out::F32(&out.view),
        _ => Out::F16(&out.view),
    };
    enc.run(
        Group::VideoCompose,
        entry,
        &params,
        size,
        inputs,
        target,
        Bind::default(),
    );
    out
}

fn pass(
    enc: &mut ComputeEncoder,
    entry: &str,
    inputs: &[&wgpu::TextureView],
    params: Params,
) -> Tex {
    dispatch(enc, entry, inputs, params, IMAGE_FORMAT)
}

fn scratch(
    enc: &mut ComputeEncoder,
    entry: &str,
    inputs: &[&wgpu::TextureView],
    params: Params,
) -> Tex {
    dispatch(enc, entry, inputs, params, SCRATCH_FORMAT)
}

fn smooth(x: f32) -> f32 {
    x * x * (3.0 - 2.0 * x)
}

pub fn fill(enc: &mut ComputeEncoder, size: (u32, u32), rgba: [f32; 4]) -> Tex {
    let [r, g, b, a] = rgba;
    pass(
        enc,
        "vc_fill",
        &[],
        Params::new(size).with(0, [r * a, g * a, b * a, a]),
    )
}

pub fn composite(
    enc: &mut ComputeEncoder,
    canvas: &Slot,
    layer: &Slot,
    placement: &Placement,
) -> Tex {
    if let Some(perspective) = placement.perspective {
        return pinned_composite(enc, canvas, layer, placement, perspective);
    }
    let [x, y] = placement.canvas_to_layer;
    let reach = |a: f32, b: f32| 1.0 / a.hypot(b).max(1e-6);
    let taps = |a: f32, b: f32| a.hypot(b).ceil().clamp(1.0, MAX_LAYER_TAPS) as u32;
    pass(
        enc,
        "vc_composite",
        &[&canvas.view, &layer.view],
        Params::new(canvas.size)
            .with(0, [x[0], x[1], x[2], placement.opacity.clamp(0.0, 1.0)])
            .with(1, [y[0], y[1], y[2], 0.0])
            .with(2, [reach(x[0], x[1]), reach(y[0], y[1]), 0.0, 0.0])
            .modes(
                0,
                [
                    placement.blend as u32,
                    taps(x[0], y[0]),
                    taps(x[1], y[1]),
                    0,
                ],
            ),
    )
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum MatteSource {
    Alpha,
    Luma([f32; 3]),
}

pub struct Matte<'a> {
    pub shape: &'a Slot,
    pub source: MatteSource,
    pub invert: bool,
}

pub fn matte(
    enc: &mut ComputeEncoder,
    canvas: &Slot,
    layer: &Slot,
    matte: Matte,
    blend: BlendMode,
) -> Tex {
    let (luma, [r, g, b]) = match matte.source {
        MatteSource::Alpha => (0, [0.0; 3]),
        MatteSource::Luma(weights) => (1, weights),
    };
    pass(
        enc,
        "vc_matte",
        &[&canvas.view, &layer.view, &matte.shape.view],
        Params::new(canvas.size)
            .with(0, [r, g, b, 0.0])
            .modes(0, [blend as u32, luma, matte.invert as u32, 0]),
    )
}

fn project(m: &Projective, [x, y]: [f64; 2]) -> Option<([f64; 2], f64)> {
    let depth = m[2][0] * x + m[2][1] * y + m[2][2];
    (depth.abs() > MIN_DEPTH).then(|| {
        (
            [
                (m[0][0] * x + m[0][1] * y + m[0][2]) / depth,
                (m[1][0] * x + m[1][1] * y + m[1][2]) / depth,
            ],
            depth,
        )
    })
}

fn inverse(m: &Projective) -> Option<Projective> {
    let cofactor = |row: usize, column: usize| {
        let (r0, r1) = ((row + 1) % 3, (row + 2) % 3);
        let (c0, c1) = ((column + 1) % 3, (column + 2) % 3);
        m[r0][c0] * m[r1][c1] - m[r0][c1] * m[r1][c0]
    };
    let determinant: f64 = (0..3)
        .map(|column| m[0][column] * cofactor(0, column))
        .sum();
    (determinant.abs() > MIN_DEPTH * MIN_DEPTH).then(|| {
        std::array::from_fn(|row| std::array::from_fn(|column| cofactor(column, row) / determinant))
    })
}

fn linear_at(m: &Projective, point: [f64; 2]) -> Option<Affine> {
    let ([lx, ly], depth) = project(m, point)?;
    let derivative = |row: usize, axis: usize, at: f64| (m[row][axis] - at * m[2][axis]) / depth;
    let jacobian = [
        [derivative(0, 0, lx), derivative(0, 1, lx)],
        [derivative(1, 0, ly), derivative(1, 1, ly)],
    ];
    Some(std::array::from_fn(|row| {
        let [a, b] = jacobian[row];
        [a, b, [lx, ly][row] - a * point[0] - b * point[1]]
    }))
}

fn affine(placement: &Placement) -> Affine {
    placement.canvas_to_layer.map(|row| row.map(f64::from))
}

fn affine_near(placement: &Placement, layer: (u32, u32)) -> Affine {
    if placement.perspective.is_none() {
        return affine(placement);
    }
    let matrix = placement.matrix();
    inverse(&matrix)
        .and_then(|to_canvas| project(&to_canvas, [layer.0 as f64 * 0.5, layer.1 as f64 * 0.5]))
        .and_then(|(centre, _)| linear_at(&matrix, centre))
        .unwrap_or_else(|| affine(placement))
}

fn footprint(m: &Projective, point: [f64; 2]) -> Option<f64> {
    let [[a, b, _], [c, d, _]] = linear_at(m, point)?;
    Some(a.hypot(c).max(b.hypot(d)))
}

fn pinned_composite(
    enc: &mut ComputeEncoder,
    canvas: &Slot,
    layer: &Slot,
    placement: &Placement,
    perspective: [f32; 3],
) -> Tex {
    let matrix = placement.matrix();
    let (width, height) = (layer.size.0 as f64, layer.size.1 as f64);
    let least = inverse(&matrix)
        .and_then(|to_canvas| {
            [
                [0.5, 0.5],
                [width - 0.5, 0.5],
                [width - 0.5, height - 0.5],
                [0.5, height - 0.5],
                [width * 0.5, height * 0.5],
            ]
            .into_iter()
            .filter_map(|point| project(&to_canvas, point).filter(|(_, depth)| *depth > 0.0))
            .filter_map(|(at, _)| footprint(&matrix, at))
            .reduce(f64::min)
        })
        .unwrap_or(1.0);
    let mut reduced: Option<Tex> = None;
    let mut factor = 1u32;
    while least / factor as f64 > MAX_PIN_TAPS as f64 {
        let input = reduced.as_deref().unwrap_or(layer);
        if input.size.0.min(input.size.1) < 2 {
            break;
        }
        let size = (input.size.0.div_ceil(2), input.size.1.div_ceil(2));
        reduced = Some(scratch(
            enc,
            "vc_half",
            &[&input.view],
            Params::grid(Grid::new(size).with_src(input.size)),
        ));
        factor *= 2;
    }
    let source = reduced.as_deref().unwrap_or(layer);
    let scale = 1.0 / factor as f32;
    let [x, y] = placement
        .canvas_to_layer
        .map(|row| row.map(|value| value * scale));
    let [wx, wy, wz] = perspective;
    pass(
        enc,
        "vc_pin",
        &[&canvas.view, &source.view],
        Params::new(canvas.size)
            .with(0, [x[0], x[1], x[2], placement.opacity.clamp(0.0, 1.0)])
            .with(1, [y[0], y[1], y[2], 0.0])
            .with(2, [wx, wy, wz, 0.0])
            .with(3, [width as f32 * scale, height as f32 * scale, 0.0, 0.0])
            .modes(0, [placement.blend as u32, MAX_PIN_TAPS, 0, 0]),
    )
}

fn apply(m: &Affine, [x, y]: [f64; 2]) -> [f64; 2] {
    [
        m[0][0] * x + m[0][1] * y + m[0][2],
        m[1][0] * x + m[1][1] * y + m[1][2],
    ]
}

fn invert(m: &Affine) -> Affine {
    let det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
    let (a, b, c, d) = (m[1][1] / det, -m[0][1] / det, -m[1][0] / det, m[0][0] / det);
    [
        [a, b, -(a * m[0][2] + b * m[1][2])],
        [c, d, -(c * m[0][2] + d * m[1][2])],
    ]
}

fn chain(first: &Affine, second: &Affine) -> Affine {
    let row = |r: [f64; 3]| {
        [
            r[0] * first[0][0] + r[1] * first[1][0],
            r[0] * first[0][1] + r[1] * first[1][1],
            r[0] * first[0][2] + r[1] * first[1][2] + r[2],
        ]
    };
    [row(second[0]), row(second[1])]
}

fn corners([x0, y0, x1, y1]: Rect) -> [[f64; 2]; 4] {
    [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]
}

fn bounds(points: [[f64; 2]; 4]) -> Rect {
    points.iter().fold(
        [f64::MAX, f64::MAX, f64::MIN, f64::MIN],
        |[x0, y0, x1, y1], [x, y]| [x0.min(*x), y0.min(*y), x1.max(*x), y1.max(*y)],
    )
}

fn intersect(a: Rect, b: Rect) -> Option<Rect> {
    let rect = [
        a[0].max(b[0]),
        a[1].max(b[1]),
        a[2].min(b[2]),
        a[3].min(b[3]),
    ];
    (rect[2] > rect[0] && rect[3] > rect[1]).then_some(rect)
}

fn grow([x0, y0, x1, y1]: Rect, [bx, by]: [f64; 2]) -> Rect {
    [x0 - bx, y0 - by, x1 + bx, y1 + by]
}

fn complex_mul(a: [f64; 2], b: [f64; 2]) -> [f64; 2] {
    [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]]
}

struct LayerFlow {
    flow: Flow,
    origin: [i64; 2],
    size: (u32, u32),
}

fn layer_flow(
    canvas: (u32, u32),
    layer: (u32, u32),
    [open, centre, close]: [&Placement; 3],
    limit: u32,
) -> Option<LayerFlow> {
    let centre = affine_near(centre, layer);
    let motion = chain(
        &invert(&affine_near(open, layer)),
        &affine_near(close, layer),
    );
    let extent = [0.0, 0.0, layer.0 as f64, layer.1 as f64];
    let view =
        bounds(corners([0.0, 0.0, canvas.0 as f64, canvas.1 as f64]).map(|p| apply(&centre, p)));
    let to_canvas = invert(&centre);
    let (mut reach, mut seen, mut spread) = (0.0f64, 0.0f64, [0.0f64; 2]);
    for p in corners(intersect(view, extent).unwrap_or(extent)) {
        let moved = apply(&motion, p);
        let delta = [moved[0] - p[0], moved[1] - p[1]];
        reach = reach.max(delta[0].hypot(delta[1]));
        spread = [spread[0].max(delta[0].abs()), spread[1].max(delta[1].abs())];
        seen = seen.max(
            (to_canvas[0][0] * delta[0] + to_canvas[0][1] * delta[1])
                .hypot(to_canvas[1][0] * delta[0] + to_canvas[1][1] * delta[1]),
        );
    }
    if !seen.is_finite() || seen < STILL_REACH {
        return None;
    }
    let margin = spread.map(|along| (BLUR_MARGIN * along).ceil() + 2.0);
    let region = intersect(grow(view, margin), grow(extent, margin))?;
    let origin = [region[0].floor() as i64, region[1].floor() as i64];
    let size = |from: i64, to: f64| {
        ((to.ceil() as i64 - from).clamp(1, limit as i64) as u32)
            .next_multiple_of(WINDOW_STEP)
            .min(limit)
    };
    let [[a, b, e], [c, d, f]] = motion;
    let [ox, oy] = origin.map(|value| value as f64);
    let shift = [a * ox + b * oy + e - ox, c * ox + d * oy + f - oy];
    let (cosine, sine) = ((a + d) * 0.5, (c - b) * 0.5);
    let lambda = [cosine.hypot(sine).ln(), sine.atan2(cosine)];
    let norm = lambda[0] * lambda[0] + lambda[1] * lambda[1];
    let factor = if norm < SERIES_LIMIT {
        let square = complex_mul(lambda, lambda);
        [
            1.0 - lambda[0] * 0.5 + square[0] / 12.0,
            -lambda[1] * 0.5 + square[1] / 12.0,
        ]
    } else {
        let grown = lambda[0].exp();
        let g = [grown * lambda[1].cos() - 1.0, grown * lambda[1].sin()];
        let scale = g[0] * g[0] + g[1] * g[1];
        [
            (lambda[0] * g[0] + lambda[1] * g[1]) / scale,
            (lambda[1] * g[0] - lambda[0] * g[1]) / scale,
        ]
    };
    let drift = complex_mul(shift, factor);
    Some(LayerFlow {
        flow: Flow {
            zoom: lambda[0] as f32,
            turn: lambda[1] as f32,
            drift: [drift[0] as f32, drift[1] as f32],
            reach: reach.max(1.0) as f32,
        },
        origin,
        size: (size(origin[0], region[2]), size(origin[1], region[3])),
    })
}

pub fn blurred_composite(
    enc: &mut ComputeEncoder,
    blurs: &MotionBlurPipelines,
    canvas: &Slot,
    layer: &Slot,
    [open, placement, close]: [Placement; 3],
) -> Tex {
    let limit = enc.device.limits().max_texture_dimension_2d;
    let Some(LayerFlow { flow, origin, size }) =
        layer_flow(canvas.size, layer.size, [&open, &placement, &close], limit)
    else {
        return composite(enc, canvas, layer, &placement);
    };
    let [ox, oy] = origin.map(|value| value as f32);
    let window = pass(
        enc,
        "vc_window",
        &[&layer.view],
        Params::new(size).with(0, [ox, oy, 0.0, 0.0]),
    );
    let spare = enc.texture("Video Motion Blur", size, IMAGE_FORMAT);
    let result = motion_blur::flow_blur(
        blurs,
        enc.device,
        &mut enc.encoder,
        flow,
        [&window.view, &spare.view],
        size,
    );
    composite(
        enc,
        canvas,
        [&window, &spare][result],
        &placement.shifted([ox, oy]),
    )
}

pub fn text_reveal(
    enc: &mut ComputeEncoder,
    glyphs: &Slot,
    units: &Slot,
    edges: [TextEdge; 2],
) -> Tex {
    let [entering, leaving] = edges;
    pass(
        enc,
        "vc_text_reveal",
        &[&glyphs.view, &units.view],
        Params::new(glyphs.size)
            .with(
                0,
                [
                    entering.shown,
                    entering.sharpness,
                    leaving.shown,
                    leaving.sharpness,
                ],
            )
            .modes(0, [entering.by_word as u32, leaving.by_word as u32, 0, 0]),
    )
}

fn crossfade(
    enc: &mut ComputeEncoder,
    from: &Slot,
    to: &Slot,
    outgoing: [f32; 4],
    incoming: [f32; 4],
    mask: Mask,
    angles: [f32; 2],
) -> Tex {
    let (mode, shape) = match mask {
        Mask::Uniform => (0, [0.0; 4]),
        Mask::Line(line) => (1, line),
        Mask::Circle(circle) => (2, circle),
    };
    pass(
        enc,
        "vc_transition",
        &[&from.view, &to.view],
        Params::new(from.size)
            .with(0, outgoing)
            .with(1, incoming)
            .with(2, shape)
            .with(3, [angles[0], angles[1], 0.0, 0.0])
            .modes(0, [mode, 0, 0, 0]),
    )
}

fn directional_blur(enc: &mut ComputeEncoder, src: &Slot, sigma: f32, vertical: bool) -> Tex {
    let params = Params::new(src.size)
        .with(0, [-0.5 / (sigma * sigma), 0.0, 0.0, 0.0])
        .modes(0, [vertical as u32, (3.0 * sigma).ceil() as u32, 0, 0]);
    pass(enc, "vc_gauss", &[&src.view], params)
}

fn sweep(
    enc: &mut ComputeEncoder,
    from: &Slot,
    to: &Slot,
    direction: Direction,
    progress: f32,
    moves: (bool, bool),
) -> Tex {
    let [x, y] = direction.axis();
    let (width, height) = (from.size.0 as f32, from.size.1 as f32);
    let extent = if y == 0.0 { width } else { height };
    let origin = if x + y < 0.0 { extent } else { 0.0 };
    let edge = progress * extent;
    let shift = |distance: f32, moving: bool| {
        let distance = if moving { distance } else { 0.0 };
        [1.0, x * distance, y * distance, 0.0]
    };
    crossfade(
        enc,
        from,
        to,
        shift(edge, moves.0),
        shift(edge - extent, moves.1),
        Mask::Line([x, y, origin, edge]),
        [0.0; 2],
    )
}

fn still(weight: f32) -> [f32; 4] {
    [1.0, 0.0, 0.0, weight]
}

pub fn dissolve(enc: &mut ComputeEncoder, from: &Slot, to: &Slot, progress: f32) -> Tex {
    crossfade(
        enc,
        from,
        to,
        still(progress.clamp(0.0, 1.0)),
        still(0.0),
        Mask::Uniform,
        [0.0; 2],
    )
}

pub fn transition(
    enc: &mut ComputeEncoder,
    from: &Slot,
    to: &Slot,
    transition: Transition,
    progress: f32,
    scale: f32,
) -> Tex {
    let progress = progress.clamp(0.0, 1.0);
    let direction = transition.direction.unwrap_or_default();
    match transition.kind {
        TransitionKind::Dissolve => dissolve(enc, from, to, progress),
        TransitionKind::Wipe => sweep(enc, from, to, direction, progress, (false, false)),
        TransitionKind::Push => sweep(enc, from, to, direction, progress, (true, true)),
        TransitionKind::Slide => sweep(enc, from, to, direction, progress, (false, true)),
        TransitionKind::Zoom | TransitionKind::Spin => {
            let eased = smooth(progress);
            let angles = match transition.kind {
                TransitionKind::Spin => [SPIN_ANGLE * eased, SPIN_ANGLE * (eased - 1.0)],
                _ => [0.0; 2],
            };
            crossfade(
                enc,
                from,
                to,
                [1.0 / (1.0 + progress), 0.0, 0.0, eased],
                [1.0 / (2.0 - progress), 0.0, 0.0, 0.0],
                Mask::Uniform,
                angles,
            )
        }
        TransitionKind::Blur => {
            let mixed = dissolve(enc, from, to, smooth(progress));
            let sigma = TRANSITION_BLUR_SIGMA * scale * (1.0 - (2.0 * progress - 1.0).abs());
            if sigma < 0.5 {
                mixed
            } else {
                blur(enc, &mixed, sigma)
            }
        }
        TransitionKind::DipToBlack => dip(enc, from, to, [0.0; 3], progress),
        TransitionKind::DipToWhite => dip(enc, from, to, [1.0; 3], progress),
        TransitionKind::Iris => {
            let (width, height) = (from.size.0 as f32, from.size.1 as f32);
            let radius = smooth(progress) * (width.hypot(height) * 0.5 + IRIS_FEATHER * scale);
            crossfade(
                enc,
                from,
                to,
                still(0.0),
                still(0.0),
                Mask::Circle([width * 0.5, height * 0.5, radius, IRIS_FEATHER * scale]),
                [0.0; 2],
            )
        }
        TransitionKind::Whip => {
            let pushed = sweep(
                enc,
                from,
                to,
                direction,
                smooth(smooth(progress)),
                (true, true),
            );
            let sigma = WHIP_BLUR_SIGMA * scale * (std::f32::consts::PI * progress).sin();
            if sigma < 0.5 {
                pushed
            } else {
                directional_blur(
                    enc,
                    &pushed,
                    sigma,
                    matches!(direction, Direction::Up | Direction::Down),
                )
            }
        }
    }
}

fn dip(enc: &mut ComputeEncoder, from: &Slot, to: &Slot, color: [f32; 3], progress: f32) -> Tex {
    if progress < 0.5 {
        wash(enc, from, color, progress * 2.0)
    } else {
        wash(enc, to, color, 2.0 - progress * 2.0)
    }
}

fn wash(enc: &mut ComputeEncoder, src: &Slot, color: [f32; 3], amount: f32) -> Tex {
    let [r, g, b] = color;
    pass(
        enc,
        "vc_wash",
        &[&src.view],
        Params::new(src.size).with(0, [r, g, b, amount.clamp(0.0, 1.0)]),
    )
}

fn gaussian(enc: &mut ComputeEncoder, src: &Slot, sigma: f32) -> (Tex, f32) {
    let mut reduced: Option<Tex> = None;
    let mut factor = 1u32;
    while sigma >= MIN_REDUCED_SIGMA * (factor * 2) as f32
        && src.size.0.min(src.size.1) >= factor * 2
    {
        let input = reduced.as_deref().unwrap_or(src);
        let size = (input.size.0.div_ceil(2), input.size.1.div_ceil(2));
        let half = scratch(
            enc,
            "vc_half",
            &[&input.view],
            Params::grid(Grid::new(size).with_src(input.size)),
        );
        reduced = Some(half);
        factor *= 2;
    }
    let factor = factor as f32;
    let variance = if factor > 1.0 {
        (sigma * sigma - (factor * factor - 1.0) / 4.0) / (factor * factor) - 1.0 / 6.0
    } else {
        sigma * sigma
    };
    let reduced_sigma = variance.max(1e-4).sqrt();
    let radius = (3.0 * reduced_sigma).ceil() as u32;
    let input = reduced.as_deref().unwrap_or(src);
    let params = |vertical: u32| {
        Params::new(input.size)
            .with(0, [-0.5 / (reduced_sigma * reduced_sigma), 0.0, 0.0, 0.0])
            .modes(0, [vertical, radius, 0, 0])
    };
    let format = if factor > 1.0 {
        SCRATCH_FORMAT
    } else {
        IMAGE_FORMAT
    };
    let horizontal = dispatch(enc, "vc_gauss", &[&input.view], params(0), format);
    let vertical = dispatch(enc, "vc_gauss", &[&horizontal.view], params(1), format);
    (vertical, 1.0 / factor)
}

fn blur_mix(
    enc: &mut ComputeEncoder,
    src: &Slot,
    blurred: &Slot,
    ratio: f32,
    weights: [f32; 4],
) -> Tex {
    pass(
        enc,
        "vc_blur_mix",
        &[&src.view, &blurred.view],
        Params::new(src.size)
            .with(0, [ratio, 0.0, 0.0, 0.0])
            .with(1, weights),
    )
}

fn blur(enc: &mut ComputeEncoder, src: &Slot, sigma: f32) -> Tex {
    let (blurred, ratio) = gaussian(enc, src, sigma);
    blur_mix(enc, src, &blurred, ratio, [0.0, 1.0, 0.0, 1.0])
}

pub fn backdrop(enc: &mut ComputeEncoder, canvas: (u32, u32), layer: &Slot) -> Tex {
    let sigma = BACKDROP_SIGMA * layer.size.0.max(layer.size.1) as f32;
    let (blurred, _) = gaussian(enc, layer, sigma);
    let dimmed = wash(enc, &blurred, [0.0; 3], BACKDROP_DIM);
    let clear = fill(enc, canvas, [0.0; 4]);
    composite(enc, &clear, &dimmed, &Placement::cover(canvas, dimmed.size))
}

pub fn fit_window(canvas: (u32, u32), layer: (u32, u32), base_scale: f32) -> Rect {
    let whole = [0.0, 0.0, layer.0 as f64, layer.1 as f64];
    let per_canvas = 1.0 / f64::from(base_scale).max(1e-6);
    let margin = per_canvas + 1.0;
    let half = [
        canvas.0 as f64 * per_canvas * 0.5 + margin,
        canvas.1 as f64 * per_canvas * 0.5 + margin,
    ];
    let centre = [whole[2] * 0.5, whole[3] * 0.5];
    let framed = [
        centre[0] - half[0],
        centre[1] - half[1],
        centre[0] + half[0],
        centre[1] + half[1],
    ];
    intersect(whole, framed).unwrap_or(whole)
}

pub fn round(enc: &mut ComputeEncoder, src: &Slot, radius: f32, window: Rect) -> Option<Tex> {
    let [x0, y0, x1, y1] = window.map(|value| value as f32);
    let pixels = radius.clamp(0.0, 1.0) * 0.5 * (x1 - x0).min(y1 - y0);
    (pixels > 0.0).then(|| {
        pass(
            enc,
            "vc_round",
            &[&src.view],
            Params::new(src.size)
                .with(0, [x0, y0, x1, y1])
                .with(1, [pixels, 0.0, 0.0, 0.0]),
        )
    })
}

pub fn layer_pass(
    enc: &mut ComputeEncoder,
    src: &Slot,
    layer: LayerPass,
    scale: f32,
) -> Option<Tex> {
    match layer {
        LayerPass::Blur(amount) => {
            let sigma = amount * scale;
            (sigma >= 0.5).then(|| blur(enc, src, sigma))
        }
        LayerPass::Reveal {
            direction,
            visible,
            entering,
            softness,
        } => Some(pass(
            enc,
            "vc_reveal",
            &[&src.view],
            Params::new(src.size)
                .with(
                    0,
                    [
                        visible.clamp(0.0, 1.0),
                        softness.clamp(0.001, 1.0),
                        0.0,
                        0.0,
                    ],
                )
                .modes(0, [direction as u32, entering as u32, 0, 0]),
        )),
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ColorKey {
    pub hue: f32,
    pub tolerance: f32,
    pub softness: f32,
    pub spill: f32,
}

fn hue_rgb(hue: f32) -> [f32; 3] {
    let channel = |n: f32| {
        let k = (n + hue / 60.0) % 6.0;
        1.0 - k.min(4.0 - k).clamp(0.0, 1.0)
    };
    [channel(5.0), channel(3.0), channel(1.0)]
}

pub fn crop(enc: &mut ComputeEncoder, layer: &Slot, origin: (u32, u32), size: (u32, u32)) -> Tex {
    let out = enc.texture("Video Cell", size, layer.texture.format());
    enc.encoder.copy_texture_to_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &layer.texture,
            mip_level: 0,
            origin: wgpu::Origin3d {
                x: origin.0,
                y: origin.1,
                z: 0,
            },
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyTextureInfo {
            texture: &out.texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::Extent3d {
            width: size.0,
            height: size.1,
            depth_or_array_layers: 1,
        },
    );
    out
}

pub fn cutout(
    enc: &mut ComputeEncoder,
    layer: &Slot,
    masks: &wgpu::TextureView,
    key: Option<ColorKey>,
) -> Tex {
    let params = Params::new(layer.size);
    let params = match key {
        Some(key) => {
            let (sin, cos) = key.hue.to_radians().sin_cos();
            let [r, g, b] = hue_rgb(key.hue);
            let along = (r - 0.5 * (g + b)) * cos + SQRT3_HALF * (g - b) * sin;
            let threshold = 1.0 - key.tolerance;
            params
                .with(0, [cos, sin, threshold - key.softness, threshold])
                .with(1, [r / along, g / along, b / along, key.spill])
                .modes(0, [1, 0, 0, 0])
        }
        None => params,
    };
    pass(enc, "vc_cutout", &[&layer.view, masks], params)
}

pub fn premultiply(
    enc: &mut ComputeEncoder,
    straight: &wgpu::TextureView,
    size: (u32, u32),
) -> Tex {
    pass(enc, "vc_premultiply", &[straight], Params::new(size))
}

pub fn upload_rgba8(
    context: &GpuContext,
    size: (u32, u32),
    straight_rgba: &[u8],
) -> Result<Slot, String> {
    if size.0 == 0 || size.1 == 0 || straight_rgba.len() != size.0 as usize * size.1 as usize * 4 {
        return Err(format!(
            "Overlay of {}x{} does not match {} bytes",
            size.0,
            size.1,
            straight_rgba.len()
        ));
    }
    let texture = context.device.create_texture_with_data(
        &context.queue,
        &wgpu::TextureDescriptor {
            label: Some("Video Overlay"),
            size: wgpu::Extent3d {
                width: size.0,
                height: size.1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        },
        wgpu::util::TextureDataOrder::MipMajor,
        straight_rgba,
    );
    let view = texture.create_view(&Default::default());
    compute::encode(context, |enc| premultiply(enc, &view, size).detach())
}

pub struct PackedFrame {
    readback: wgpu::Buffer,
    submission: wgpu::SubmissionIndex,
    mapped: std::sync::mpsc::Receiver<Result<(), wgpu::BufferAsyncError>>,
    length: usize,
}

impl PackedFrame {
    pub fn read(self, context: &GpuContext) -> Result<Vec<u8>, String> {
        context
            .device
            .poll(wgpu::PollType::Wait {
                submission_index: Some(self.submission),
                timeout: Some(std::time::Duration::from_secs(60)),
            })
            .map_err(|e| format!("Failed while polling packed frame: {}", e))?;
        self.mapped
            .recv()
            .map_err(|e| format!("Failed receiving packed frame: {}", e))?
            .map_err(|e| e.to_string())?;
        let bytes = self.readback.slice(..).get_mapped_range()[..self.length].to_vec();
        self.readback.unmap();
        Ok(bytes)
    }
}

pub fn pack(context: &GpuContext, canvas: &Slot, packing: Packing) -> Result<Vec<u8>, String> {
    pack_frame(context, canvas, packing)?.read(context)
}

pub fn pack_frame(
    context: &GpuContext,
    canvas: &Slot,
    packing: Packing,
) -> Result<PackedFrame, String> {
    let (width, height) = canvas.size;
    let pixels = width as u64 * height as u64;
    let (kind, bits, chroma_rows, shift, matrix, swscale) = match packing {
        Packing::Rgba8 => (PACK_RGBA8, 8, 0, 0, None, false),
        Packing::Rgb48 => (PACK_RGB48, 16, 0, 0, None, false),
        Packing::Yuv {
            layout,
            matrix,
            subsampling,
        } => (
            if layout.interleaved {
                PACK_YUV_INTERLEAVED
            } else {
                PACK_YUV_PLANAR
            },
            layout.sample_bytes() as u64 * 8,
            1 << layout.chroma_shift.1,
            layout.sample_shift(),
            matrix,
            subsampling == Subsampling::Swscale,
        ),
    };
    let chroma = match chroma_rows {
        0 => (0, 0),
        rows => (width.div_ceil(2), height.div_ceil(rows)),
    };
    let samples = match kind {
        0 => pixels * 4,
        1 => pixels * 3,
        _ => pixels + 2 * chroma.0 as u64 * chroma.1 as u64,
    };
    let per_word = 32 / bits;
    let words = samples.div_ceil(per_word);
    if samples > u32::MAX as u64 || words * 4 > context.limits.max_buffer_size {
        return Err(format!(
            "Frame of {}x{} is too large to pack",
            width, height
        ));
    }

    let (kr, kb) = luma_weights(matrix);
    let step = if bits == 16 { 4.0 } else { 1.0 };
    let range = if swscale { step * 256.0 / 255.0 } else { step };
    let params = Params::grid(Grid::new((PACK_ROW_WORDS, 0)).with_src(canvas.size))
        .with(0, [kr, 1.0 - kr - kb, kb, 255.0 * step + step - 1.0])
        .with(1, [16.0 * step, 219.0 * range, 128.0 * step, 224.0 * range])
        .with(2, [0.5 / (1.0 - kb), 0.5 / (1.0 - kr), 0.0, 0.0])
        .with(3, [shift as f32, if swscale { 1.0 } else { 0.0 }, 0.0, 0.0])
        .modes(0, [kind, per_word as u32, chroma.0, chroma.1]);

    let readback = context.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Packed Frame Readback"),
        size: words * 4,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let row = PACK_ROW_WORDS as u64;
    let chunk = (context.limits.max_storage_buffer_binding_size / 4 / row * row).max(row);
    let ((), submission) = compute::encode_submitted(context, |enc| {
        for base in (0..words).step_by(chunk as usize) {
            let count = chunk.min(words - base);
            let rows = count.div_ceil(row) as u32;
            let output = enc.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Packed Frame"),
                size: count * 4,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            });
            let mut params =
                params.modes(1, [base as u32, count as u32, samples as u32, chroma_rows]);
            params.grid.dst[1] = rows;
            enc.run(
                Group::VideoCompose,
                "vc_pack",
                &params,
                (PACK_ROW_WORDS, rows),
                &[&canvas.view],
                Out::None,
                Bind {
                    scratch: Some(&output),
                    ..Default::default()
                },
            );
            enc.encoder
                .copy_buffer_to_buffer(&output, 0, &readback, base * 4, count * 4);
        }
    })?;
    let (sender, mapped) = std::sync::mpsc::channel();
    readback
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |result| {
            let _ = sender.send(result);
        });
    Ok(PackedFrame {
        readback,
        submission,
        mapped,
        length: (samples * bits / 8) as usize,
    })
}
