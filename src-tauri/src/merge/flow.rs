use crate::merge::align::{apply, warp, warp_with};
use crate::merge::raster::{Interpolation, Raster, Tiling, gaussian_blur};
use crate::render::gpu::compute;
use crate::render::gpu::context::{GpuContext, shared_gpu_context};
use crate::render::gpu::processor::read_texture_rows;
use crate::video::engine::flow::{FlowCache, Frame, base_size};
use nalgebra::Matrix3;
use rayon::prelude::*;

const OVERLAP: usize = 96;
const CONSISTENCY_SLACK: f32 = 0.5;
const CONSISTENCY_RATIO: f32 = 0.01;
const PREFILTER: f32 = 1.0;

pub struct FlowField {
    width: usize,
    height: usize,
    vectors: Vec<[f32; 2]>,
}

impl FlowField {
    fn sample(&self, x: f32, y: f32) -> [f32; 2] {
        let x = x.clamp(0.0, (self.width - 1) as f32);
        let y = y.clamp(0.0, (self.height - 1) as f32);
        let (x0, y0) = (x.floor() as usize, y.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(self.width - 1), (y0 + 1).min(self.height - 1));
        let (fx, fy) = (x - x0 as f32, y - y0 as f32);
        let at = |xx: usize, yy: usize| self.vectors[yy * self.width + xx];
        let (a, b, c, d) = (at(x0, y0), at(x1, y0), at(x0, y1), at(x1, y1));
        [0, 1].map(|k| {
            let top = a[k] + (b[k] - a[k]) * fx;
            let bottom = c[k] + (d[k] - c[k]) * fx;
            top + (bottom - top) * fy
        })
    }

    fn displacement(
        &self,
        width: usize,
        height: usize,
    ) -> impl Fn(f64, f64) -> (f64, f64) + Sync + '_ {
        let sx = self.width as f64 / width as f64;
        let sy = self.height as f64 / height as f64;
        move |x, y| {
            let v = self.sample(((x + 0.5) * sx - 0.5) as f32, ((y + 0.5) * sy - 0.5) as f32);
            (x + v[0] as f64 / sx, y + v[1] as f64 / sy)
        }
    }
}

pub fn warp_along(
    source: &Raster,
    transform: &Matrix3<f64>,
    flow: &FlowField,
    interpolation: Interpolation,
) -> (Raster, Vec<f32>) {
    let (width, height) = (source.width, source.height);
    let shift = flow.displacement(width, height);
    warp_with(source, width, height, interpolation, |x, y| {
        let (u, v) = shift(x, y);
        apply(transform, u, v)
    })
}

pub fn align(
    image: Raster,
    transform: &Matrix3<f64>,
    flow: Option<&FlowField>,
    interpolation: Interpolation,
) -> (Raster, Vec<f32>) {
    let (width, height) = (image.width, image.height);
    match flow {
        Some(flow) => warp_along(&image, transform, flow, interpolation),
        None if *transform == Matrix3::identity() => (image, vec![1.0; width * height]),
        None => warp(&image, transform, width, height, interpolation),
    }
}

fn rgba(gray: &Raster, (x0, width): (usize, usize), (y0, height): (usize, usize)) -> Vec<f32> {
    let mut data = vec![1.0f32; width * height * 4];
    data.par_chunks_mut(width * 4)
        .enumerate()
        .for_each(|(y, row)| {
            let source = &gray.data[(y0 + y) * gray.width + x0..][..width];
            for (texel, &value) in row.as_chunks_mut::<4>().0.iter_mut().zip(source) {
                texel[..3].fill(value);
            }
        });
    data
}

fn consistency(forward: [f32; 2], backward: [f32; 2]) -> f32 {
    let miss = (forward[0] + backward[0]).powi(2) + (forward[1] + backward[1]).powi(2);
    let bound = CONSISTENCY_RATIO
        * (forward[0].powi(2) + forward[1].powi(2) + backward[0].powi(2) + backward[1].powi(2))
        + CONSISTENCY_SLACK;
    let t = ((miss - bound) / (3.0 * bound)).clamp(0.0, 1.0);
    1.0 - t * t * (3.0 - 2.0 * t)
}

pub struct FlowEstimator {
    context: GpuContext,
}

impl FlowEstimator {
    pub fn new() -> Option<Self> {
        shared_gpu_context()
            .map(|context| FlowEstimator { context })
            .map_err(|e| log::warn!("merge: optical flow is unavailable: {}", e))
            .ok()
    }

    fn tile(
        &self,
        reference: &Raster,
        moving: &Raster,
        columns: (usize, usize),
        rows: (usize, usize),
    ) -> Result<[Vec<[f32; 2]>; 2], String> {
        let size = (columns.1 as u32, rows.1 as u32);
        let field = compute::encode(&self.context, |enc| {
            let format = wgpu::TextureFormat::Rgba32Float;
            let from = enc.map(
                "Merge Flow Reference",
                size,
                format,
                &rgba(reference, columns, rows),
            );
            let to = enc.map(
                "Merge Flow Frame",
                size,
                format,
                &rgba(moving, columns, rows),
            );
            FlowCache::default()
                .between(
                    enc,
                    Frame {
                        key: 1,
                        slot: &from,
                    },
                    Frame { key: 2, slot: &to },
                )
                .field
        })?;
        let (width, height) = (columns.1, rows.1);
        read_texture_rows(
            &self.context.device,
            &self.context.queue,
            &field.texture,
            wgpu::Origin3d::ZERO,
            wgpu::Extent3d {
                width: 2 * size.0,
                height: size.1,
                depth_or_array_layers: 1,
            },
            16,
            |mapped, stride| {
                let mut forward = Vec::with_capacity(width * height);
                let mut backward = Vec::with_capacity(width * height);
                for row in mapped.chunks(stride).take(height) {
                    let texels: &[f32] = bytemuck::cast_slice(&row[..2 * width * 16]);
                    for (x, texel) in texels.as_chunks::<4>().0.iter().enumerate() {
                        let target = if x < width {
                            &mut forward
                        } else {
                            &mut backward
                        };
                        target.push([texel[0], texel[1]]);
                    }
                }
                [forward, backward]
            },
        )
    }

    pub fn estimate(&self, reference: &Raster, moving: &Raster) -> Option<FlowField> {
        assert_eq!(reference.channels, 1, "flow expects gray images");
        assert_eq!(
            (reference.width, reference.height),
            (moving.width, moving.height),
            "flow images must match in size"
        );
        let reference = gaussian_blur(reference, PREFILTER);
        let moving = gaussian_blur(moving, PREFILTER);
        let (width, height) = (reference.width, reference.height);
        let tiling = Tiling {
            size: base_size((1 << 20, 1 << 20)).0 as usize,
            margin: 0,
            ramp: OVERLAP,
        };
        let mut sum = vec![[0.0f32; 3]; width * height];
        for columns in tiling.spans(width) {
            for rows in tiling.spans(height) {
                let [forward, backward] = match self.tile(&reference, &moving, columns, rows) {
                    Ok(fields) => fields,
                    Err(e) => {
                        log::warn!("merge: optical flow failed: {}", e);
                        return None;
                    }
                };
                let field = FlowField {
                    width: columns.1,
                    height: rows.1,
                    vectors: backward,
                };
                sum[rows.0 * width..(rows.0 + rows.1) * width]
                    .par_chunks_mut(width)
                    .enumerate()
                    .for_each(|(y, out)| {
                        let wy = tiling.weight(rows.0 + y, rows, height);
                        for x in 0..columns.1 {
                            let f = forward[y * columns.1 + x];
                            let b = field.sample(x as f32 + f[0], y as f32 + f[1]);
                            let w = wy * tiling.weight(columns.0 + x, columns, width);
                            let c = consistency(f, b) * w;
                            let cell = &mut out[columns.0 + x];
                            cell[0] += f[0] * c;
                            cell[1] += f[1] * c;
                            cell[2] += w;
                        }
                    });
            }
        }
        Some(FlowField {
            width,
            height,
            vectors: sum
                .into_par_iter()
                .map(|[x, y, w]| [x / w, y / w])
                .collect(),
        })
    }
}
