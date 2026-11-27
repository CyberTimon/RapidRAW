use crate::effects::motion_blur::Shutter;
use crate::merge::raster::{Raster, Tiling, gaussian_blur};
use crate::render::color_space::{TransferCurve, luminance};
use crate::render::gpu::compute::{Slot, upload_image};
use crate::render::gpu::context::{GpuContext, shared_gpu_context};
use crate::render::gpu::processor::read_texture_rows;
use crate::render::image_processing::smoothstep;
use crate::video::engine::decode::{Neighbour, Neighbours};
use crate::video::engine::flow::FlowCache;
use crate::video::engine::shutter::{self, ShutterInput};
use half::f16;
use half::slice::HalfFloatSliceExt;
use image::{DynamicImage, ImageBuffer};
use rayon::prelude::*;

const TILING: Tiling = Tiling {
    size: 2560,
    margin: 256,
    ramp: 64,
};
const KEPT_BYTES: usize = 448 << 20;
const STREAM: u64 = 1;
const TEXEL: usize = 4;
const SETTLE_WINDOW: f32 = 2.0;
const SETTLE_FLOOR: f32 = 0.02;
const SETTLE_STILL: f32 = 0.015;
const SETTLE_MOVING: f32 = 0.05;
const FULL_INTERVAL: Shutter = Shutter {
    angle: 360.0,
    highlights: 0.0,
    footage: true,
};

#[derive(Clone, Copy)]
struct Tile {
    columns: (usize, usize),
    rows: (usize, usize),
}

impl Tile {
    fn whole(image: &Raster) -> Self {
        Tile {
            columns: (0, image.width),
            rows: (0, image.height),
        }
    }
}

pub struct Trails {
    context: GpuContext,
    gain: f32,
    decoded: Vec<f32>,
    uploads: Vec<Vec<(u64, Slot)>>,
}

impl Trails {
    pub fn new(gain: f32) -> Option<Self> {
        shared_gpu_context()
            .map(|context| {
                let inverse = 1.0 / gain;
                let decoded = (0..=u16::MAX)
                    .map(|bits| f16::from_bits(bits).to_f32())
                    .map(|encoded| TransferCurve::SRGB.decode(encoded) * inverse)
                    .collect();
                Trails {
                    context,
                    gain,
                    decoded,
                    uploads: Vec::new(),
                }
            })
            .map_err(|e| log::warn!("merge: smooth motion is unavailable: {}", e))
            .ok()
    }

    fn encode(&self, image: &Raster, area: Tile) -> Vec<f16> {
        let transfer = TransferCurve::SRGB;
        let (x0, columns) = area.columns;
        let (y0, rows) = area.rows;
        let row = columns * 3;
        let mut encoded = vec![f16::ZERO; row * rows];
        encoded.par_chunks_mut(row).enumerate().for_each_init(
            || vec![0.0f32; row],
            |values, (y, halves)| {
                let start = image.index(x0, y0 + y);
                for (value, &v) in values.iter_mut().zip(&image.data[start..start + row]) {
                    *value = transfer.encode(v * self.gain);
                }
                halves.convert_from_f32_slice(values);
            },
        );
        encoded
    }

    fn upload(&self, encoded: &[f16], area: Tile, tile: Tile) -> Slot {
        let (x0, columns) = tile.columns;
        let (y0, rows) = tile.rows;
        let width = area.columns.1;
        let mut data = vec![0.0f32; columns * rows * 3];
        data.par_chunks_mut(columns * 3)
            .enumerate()
            .for_each(|(y, row)| {
                let start = ((y0 - area.rows.0 + y) * width + x0 - area.columns.0) * 3;
                encoded[start..start + columns * 3].convert_to_f32_slice(row);
            });
        let buffer = ImageBuffer::from_raw(columns as u32, rows as u32, data)
            .expect("tile buffer matches its size");
        upload_image(&self.context, &DynamicImage::ImageRgb32F(buffer))
    }

    fn input(
        &self,
        slots: &mut Vec<(u64, Slot)>,
        encoded: &[(u64, Vec<f16>)],
        index: u64,
        current: &Raster,
        [previous, next]: [Option<&Raster>; 2],
        tile: Tile,
    ) -> (Slot, ShutterInput) {
        let mut slot = |image: &Raster, key: u64| {
            if let Some((_, slot)) = slots.iter().find(|(at, _)| *at == key) {
                return slot.clone();
            }
            let slot = match encoded.iter().find(|(at, _)| *at == key) {
                Some((_, frame)) => self.upload(frame, Tile::whole(image), tile),
                None => self.upload(&self.encode(image, tile), tile, tile),
            };
            slots.push((key, slot.clone()));
            slot
        };
        let current = slot(current, index + 1);
        let mut neighbour = |image: Option<&Raster>, key: u64| {
            image.map(|image| Neighbour {
                slot: slot(image, key),
                key,
                gap: 1.0,
            })
        };
        let around = Neighbours {
            stream: STREAM,
            key: index + 1,
            previous: neighbour(previous, index),
            next: neighbour(next, index + 2),
        };
        let input = ShutterInput {
            key: String::new(),
            around,
            advance: 1.0,
            shutter: FULL_INTERVAL,
            steady: None,
        };
        (current, input)
    }

    fn read(
        &self,
        output: &Slot,
        tile: Tile,
        (width, height): (usize, usize),
    ) -> Result<Vec<f16>, String> {
        let xs = TILING.covered(tile.columns, width);
        let ys = TILING.covered(tile.rows, height);
        if xs.is_empty() || ys.is_empty() {
            return Ok(Vec::new());
        }
        let row = xs.len() * TEXEL;
        read_texture_rows(
            &self.context.device,
            &self.context.queue,
            &output.texture,
            wgpu::Origin3d {
                x: xs.start as u32,
                y: ys.start as u32,
                z: 0,
            },
            wgpu::Extent3d {
                width: xs.len() as u32,
                height: ys.len() as u32,
                depth_or_array_layers: 1,
            },
            (TEXEL * size_of::<f16>()) as u32,
            |mapped, stride| {
                let mut texels = vec![f16::ZERO; row * ys.len()];
                texels
                    .par_chunks_mut(row)
                    .zip(mapped.par_chunks(stride))
                    .for_each(|(texels, mapped)| {
                        texels.copy_from_slice(bytemuck::cast_slice(
                            &mapped[..row * size_of::<f16>()],
                        ))
                    });
                texels
            },
        )
    }

    fn add(&self, texels: &[f16], tile: Tile, sum: &mut Raster, weights: &mut [f32]) {
        if texels.is_empty() {
            return;
        }
        let (width, height) = (sum.width, sum.height);
        let xs = TILING.covered(tile.columns, width);
        let ys = TILING.covered(tile.rows, height);
        let (top, bottom) = (tile.rows.0 + ys.start, tile.rows.0 + ys.end);
        let (left, right) = (tile.columns.0 + xs.start, tile.columns.0 + xs.end);
        let across: Vec<f32> = (left..right)
            .map(|x| TILING.weight(x, tile.columns, width))
            .collect();
        sum.data[top * width * 3..bottom * width * 3]
            .par_chunks_mut(width * 3)
            .zip(weights[top * width..bottom * width].par_chunks_mut(width))
            .zip(texels.par_chunks(xs.len() * TEXEL))
            .enumerate()
            .for_each(|(y, ((out, weight), row))| {
                let wy = TILING.weight(top + y, tile.rows, height);
                for ((pixel, total), (texel, wx)) in out[left * 3..right * 3]
                    .as_chunks_mut::<3>()
                    .0
                    .iter_mut()
                    .zip(&mut weight[left..right])
                    .zip(row.as_chunks::<TEXEL>().0.iter().zip(&across))
                {
                    let w = wy * wx;
                    for c in 0..3 {
                        pixel[c] += w * self.decoded[texel[c].to_bits() as usize];
                    }
                    *total += w;
                }
            });
    }

    fn smeared(&mut self, index: usize, frames: [Option<&Raster>; 3]) -> Result<Raster, String> {
        let [previous, current, next] = frames;
        let current = current.ok_or("smooth motion needs a frame")?;
        let size = (current.width, current.height);
        let tiles: Vec<Tile> = TILING
            .spans(size.0)
            .into_iter()
            .flat_map(|columns| {
                TILING
                    .spans(size.1)
                    .into_iter()
                    .map(move |rows| Tile { columns, rows })
            })
            .collect();
        let kept = tiles
            .iter()
            .scan(0, |total, tile| {
                *total += 2 * tile.columns.1 * tile.rows.1 * TEXEL * size_of::<f16>();
                Some(*total)
            })
            .take_while(|&total| total <= KEPT_BYTES)
            .count();
        let mut uploads = std::mem::take(&mut self.uploads);
        uploads.resize_with(tiles.len(), Vec::new);
        let key = index as u64;
        let missing = |at: &u64| !uploads[0].iter().any(|(cached, _)| cached == at);
        let encoded: Vec<(u64, Vec<f16>)> =
            [(key, previous), (key + 1, Some(current)), (key + 2, next)]
                .into_iter()
                .filter_map(|(at, image)| Some((at, image?)))
                .filter(|(at, _)| kept > 0 && missing(at))
                .map(|(at, image)| (at, self.encode(image, Tile::whole(image))))
                .collect();
        let mut sum = Raster::new(size.0, size.1, 3);
        let mut weights = vec![0.0f32; size.0 * size.1];
        let mut pending: Option<(Slot, Tile)> = None;
        for (number, (&tile, slots)) in tiles.iter().zip(&mut uploads).enumerate() {
            let (slot, input) = self.input(slots, &encoded, key, current, [previous, next], tile);
            let finished = pending
                .take()
                .map(|(output, at)| self.read(&output, at, size).map(|texels| (texels, at)))
                .transpose()?;
            let output = shutter::render(&self.context, &mut FlowCache::default(), &slot, &input)?;
            if number < kept {
                slots.retain(|(at, _)| *at > key);
            } else {
                slots.clear();
            }
            if let Some((texels, at)) = finished {
                self.add(&texels, at, &mut sum, &mut weights);
            }
            pending = Some((output, tile));
        }
        if let Some((output, at)) = pending {
            let texels = self.read(&output, at, size)?;
            self.add(&texels, at, &mut sum, &mut weights);
        }
        drop(encoded);
        self.uploads = uploads;
        sum.data
            .par_chunks_mut(3)
            .zip(weights.par_iter())
            .for_each(|(p, &w)| p.iter_mut().for_each(|v| *v /= w.max(1e-6)));
        Ok(sum)
    }

    pub fn smear(&mut self, index: usize, frames: [Option<&Raster>; 3]) -> Option<Raster> {
        let current = frames[1]?;
        let (smeared, level) = rayon::join(
            || self.smeared(index, frames),
            || gaussian_blur(current, SETTLE_WINDOW),
        );
        match smeared {
            Ok(smeared) => Some(self.settled(current, smeared, &level)),
            Err(e) => {
                log::warn!("merge: smooth motion failed: {}", e);
                None
            }
        }
    }

    fn settled(&self, current: &Raster, mut smeared: Raster, level: &Raster) -> Raster {
        let difference = Raster::from_data(
            current.width,
            current.height,
            3,
            smeared
                .data
                .par_iter()
                .zip(current.data.par_iter())
                .map(|(s, c)| s - c)
                .collect(),
        );
        let change = gaussian_blur(&difference, SETTLE_WINDOW);
        let floor = SETTLE_FLOOR / self.gain;
        smeared
            .data
            .par_chunks_mut(3)
            .zip(current.data.par_chunks(3))
            .zip(change.data.par_chunks(3).zip(level.data.par_chunks(3)))
            .for_each(|((s, c), (d, l))| {
                let moved = luminance(&[d[0].abs(), d[1].abs(), d[2].abs()])
                    / (luminance(l).max(0.0) + floor);
                let t = smoothstep(SETTLE_STILL, SETTLE_MOVING, moved);
                for k in 0..3 {
                    s[k] = c[k] + t * (s[k] - c[k]);
                }
            });
        smeared
    }
}
