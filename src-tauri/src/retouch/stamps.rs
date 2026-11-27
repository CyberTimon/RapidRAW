use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;

use crate::masks::generation::{AiPatchDefinition, MaskDefinition, generate_mask_bitmap};
use crate::masks::shapes::BrushLine;
use crate::render::gpu::compute::{
    Bind, ComputeEncoder, Grid, Group, IMAGE_FORMAT, Out, Slot, Tex,
};
use crate::render::source::SourceTransform;
use crate::retouch::clone_heal::stroke_anchor;

const RING: f64 = 3.0;
const SIZE_STEP: u32 = 32;
const FINE_RELAX: usize = 64;
const COARSE_RELAX: usize = 32;
const MASK_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::R32Float;
const WORK_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba32Float;

type Affine = [[f64; 3]; 2];

const IDENTITY: Affine = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];

fn apply(map: &Affine, (x, y): (f64, f64)) -> (f64, f64) {
    (
        map[0][0] * x + map[0][1] * y + map[0][2],
        map[1][0] * x + map[1][1] * y + map[1][2],
    )
}

fn then(first: &Affine, second: &Affine) -> Affine {
    std::array::from_fn(|row| {
        [
            second[row][0] * first[0][0] + second[row][1] * first[1][0],
            second[row][0] * first[0][1] + second[row][1] * first[1][1],
            second[row][0] * first[0][2] + second[row][1] * first[1][2] + second[row][2],
        ]
    })
}

fn inverse(map: &Affine) -> Affine {
    let det = map[0][0] * map[1][1] - map[0][1] * map[1][0];
    let (a, b, c, d) = (
        map[1][1] / det,
        -map[0][1] / det,
        -map[1][0] / det,
        map[0][0] / det,
    );
    [
        [a, b, -(a * map[0][2] + b * map[1][2])],
        [c, d, -(c * map[0][2] + d * map[1][2])],
    ]
}

#[derive(Clone, Copy, Debug)]
pub struct StampSpace {
    size: (u32, u32),
    extent: (u32, u32),
    scale: f64,
    origin: (f64, f64),
    to_working: Affine,
}

impl StampSpace {
    pub fn new(
        transform: &SourceTransform,
        source: (u32, u32),
        mask_scale: f32,
        crop_offset: (f32, f32),
    ) -> Self {
        let size = transform.working_size(source);
        let frame = &transform.frame;
        let extent = frame.oriented_size(size);
        let framed = frame.size(size);
        let ratio = framed.0 as f64 / transform.output_size(source).0.max(1) as f64;
        let (crop_x, crop_y, _, _) = frame.crop_rect(extent);
        let rotation = if frame.rotates() {
            let (sin, cos) = (frame.rotation as f64).to_radians().sin_cos();
            let center = (extent.0 as f64 / 2.0, extent.1 as f64 / 2.0);
            [
                [cos, sin, center.0 - (cos * center.0 + sin * center.1)],
                [-sin, cos, center.1 - (-sin * center.0 + cos * center.1)],
            ]
        } else {
            IDENTITY
        };
        let last = (extent.0 as f64 - 1.0, extent.1 as f64 - 1.0);
        let flip = [
            if frame.flip_horizontal {
                [-1.0, 0.0, last.0]
            } else {
                [1.0, 0.0, 0.0]
            },
            if frame.flip_vertical {
                [0.0, -1.0, last.1]
            } else {
                [0.0, 1.0, 0.0]
            },
        ];
        let bottom = (size.0 as f64 - 1.0, size.1 as f64 - 1.0);
        let orientation = match frame.orientation {
            1 => [[0.0, 1.0, 0.0], [-1.0, 0.0, bottom.1]],
            2 => [[-1.0, 0.0, bottom.0], [0.0, -1.0, bottom.1]],
            3 => [[0.0, -1.0, bottom.0], [1.0, 0.0, 0.0]],
            _ => IDENTITY,
        };
        Self {
            size,
            extent,
            scale: mask_scale as f64 * ratio,
            origin: (
                crop_offset.0 as f64 * ratio - crop_x as f64,
                crop_offset.1 as f64 * ratio - crop_y as f64,
            ),
            to_working: then(&then(&rotation, &flip), &orientation),
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    grid: Grid,
    origin: [i32; 2],
    offset: [f32; 2],
    frame: [u32; 2],
    coarsest: u32,
    pad: u32,
    to_mask: [[f32; 4]; 2],
}

#[derive(Deserialize, Default)]
struct Strokes {
    #[serde(default)]
    lines: Vec<BrushLine>,
}

struct Stamp {
    heal: bool,
    origin: (u32, u32),
    size: (u32, u32),
    offset: (f32, f32),
    to_mask: Affine,
    mask_size: (u32, u32),
    alpha: Vec<f32>,
}

pub struct Stamps {
    list: Vec<Stamp>,
    key: u64,
}

fn is_stamp(sub_mask_type: &str) -> bool {
    matches!(sub_mask_type, "clone" | "heal")
}

fn source_point(parameters: &Value) -> Option<(f64, f64)> {
    Some((
        parameters["sourceX"].as_f64()?,
        parameters["sourceY"].as_f64()?,
    ))
}

fn clamped_span(low: f64, high: f64, limit: u32) -> Option<(u32, u32)> {
    let low = low.floor().clamp(0.0, limit as f64) as u32;
    let high = high.ceil().clamp(0.0, limit as f64) as u32;
    (high > low).then_some((low, high - low))
}

fn spot_bounds(lines: &[BrushLine], space: &StampSpace) -> Option<((u32, u32), (u32, u32))> {
    let mut bounds = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for line in lines.iter().filter(|line| line.tool != "eraser") {
        let reach = (line.brush_size as f64 * space.scale / 2.0).max(0.0).ceil() + RING;
        for point in &line.points {
            let x = point.x * space.scale - space.origin.0;
            let y = point.y * space.scale - space.origin.1;
            bounds = (
                bounds.0.min(x - reach),
                bounds.1.min(y - reach),
                bounds.2.max(x + reach),
                bounds.3.max(y + reach),
            );
        }
    }
    let (x, width) = clamped_span(bounds.0, bounds.2, space.extent.0)?;
    let (y, height) = clamped_span(bounds.1, bounds.3, space.extent.1)?;
    Some(((x, y), (width, height)))
}

fn working_bounds(
    space: &StampSpace,
    origin: (u32, u32),
    size: (u32, u32),
) -> Option<((u32, u32), (u32, u32))> {
    let corners = [(0, 0), (size.0, 0), (0, size.1), (size.0, size.1)].map(|(x, y)| {
        apply(
            &space.to_working,
            ((origin.0 + x) as f64, (origin.1 + y) as f64),
        )
    });
    let bound = |pick: fn(&(f64, f64)) -> f64, fold: fn(f64, f64) -> f64, start: f64| {
        corners.iter().map(pick).fold(start, fold)
    };
    let stepped = |(low, span): (u32, u32), limit: u32| {
        let span = span.next_multiple_of(SIZE_STEP).min(limit);
        (low.min(limit - span), span)
    };
    let x = clamped_span(
        bound(|c| c.0, f64::min, f64::INFINITY) - 1.0,
        bound(|c| c.0, f64::max, f64::NEG_INFINITY) + 1.0,
        space.size.0,
    )?;
    let y = clamped_span(
        bound(|c| c.1, f64::min, f64::INFINITY) - 1.0,
        bound(|c| c.1, f64::max, f64::NEG_INFINITY) + 1.0,
        space.size.1,
    )?;
    let (x, width) = stepped(x, space.size.0);
    let (y, height) = stepped(y, space.size.1);
    Some(((x, y), (width, height)))
}

impl Stamp {
    fn new(patch: &AiPatchDefinition, space: &StampSpace) -> Option<Self> {
        if !patch.visible || !patch.sub_masks.iter().any(|sub| is_stamp(&sub.mask_type)) {
            return None;
        }
        let source = patch
            .sub_masks
            .iter()
            .find_map(|sub| source_point(&sub.parameters))?;
        let anchor = stroke_anchor(&patch.sub_masks)?;
        let lines: Vec<BrushLine> = patch
            .sub_masks
            .iter()
            .filter(|sub| sub.visible)
            .flat_map(|sub| {
                serde_json::from_value::<Strokes>(sub.parameters.clone())
                    .unwrap_or_default()
                    .lines
            })
            .collect();
        let (mask_origin, mask_size) = spot_bounds(&lines, space)?;
        let definition = MaskDefinition {
            id: patch.id.clone(),
            name: patch.name.clone(),
            visible: true,
            invert: patch.invert,
            opacity: 100.0,
            adjustments: Value::Null,
            sub_masks: patch.sub_masks.clone(),
        };
        let bitmap = generate_mask_bitmap(
            &definition,
            mask_size.0,
            mask_size.1,
            space.scale as f32,
            (
                (space.origin.0 + mask_origin.0 as f64) as f32,
                (space.origin.1 + mask_origin.1 as f64) as f32,
            ),
            None,
        )?;
        if bitmap.iter().all(|value| *value == 0) {
            return None;
        }
        let (origin, size) = working_bounds(space, mask_origin, mask_size)?;
        let shift = (
            ((source.0 - anchor.0) * space.scale).round(),
            ((source.1 - anchor.1) * space.scale).round(),
        );
        let turn = &space.to_working;
        let mut to_mask = inverse(turn);
        to_mask[0][2] -= mask_origin.0 as f64;
        to_mask[1][2] -= mask_origin.1 as f64;
        Some(Self {
            heal: patch.sub_masks.iter().any(|sub| sub.mask_type == "heal"),
            origin,
            size,
            offset: (
                (turn[0][0] * shift.0 + turn[0][1] * shift.1) as f32,
                (turn[1][0] * shift.0 + turn[1][1] * shift.1) as f32,
            ),
            to_mask,
            mask_size,
            alpha: bitmap.iter().map(|value| *value as f32 / 255.0).collect(),
        })
    }

    fn params(&self, frame: (u32, u32)) -> Params {
        let row = |row: &[f64; 3]| [row[0] as f32, row[1] as f32, row[2] as f32, 0.0];
        Params {
            grid: Grid::new(self.size),
            origin: [self.origin.0 as i32, self.origin.1 as i32],
            offset: [self.offset.0, self.offset.1],
            frame: [frame.0, frame.1],
            to_mask: [row(&self.to_mask[0]), row(&self.to_mask[1])],
            ..Default::default()
        }
    }

    fn encode(&self, enc: &mut ComputeEncoder, frame: &Slot) {
        let mask = enc.map("Stamp Mask", self.mask_size, MASK_FORMAT, &self.alpha);
        let patch = enc.texture("Stamp", self.size, IMAGE_FORMAT);
        let params = self.params(frame.size);
        match self.heal {
            true => {
                let ratio = self.membrane(enc, frame, &mask, &params);
                enc.run(
                    Group::Stamps,
                    "st_heal",
                    &params,
                    self.size,
                    &[&frame.view, &mask.view, &ratio.view],
                    Out::F16(&patch.view),
                    Bind::default(),
                );
            }
            false => enc.run(
                Group::Stamps,
                "st_clone",
                &params,
                self.size,
                &[&frame.view, &mask.view],
                Out::F16(&patch.view),
                Bind::default(),
            ),
        }
        enc.encoder.copy_texture_to_texture(
            patch.texture.as_image_copy(),
            wgpu::TexelCopyTextureInfo {
                texture: &frame.texture,
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: self.origin.0,
                    y: self.origin.1,
                    z: 0,
                },
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::Extent3d {
                width: self.size.0,
                height: self.size.1,
                depth_or_array_layers: 1,
            },
        );
    }

    fn membrane(
        &self,
        enc: &mut ComputeEncoder,
        frame: &Slot,
        mask: &Slot,
        params: &Params,
    ) -> Tex {
        let mut sizes = vec![self.size];
        while let Some(&(width, height)) = sizes.last().filter(|size| **size != (1, 1)) {
            sizes.push((width.div_ceil(2), height.div_ceil(2)));
        }
        let seed = enc.texture("Stamp Level", self.size, WORK_FORMAT);
        enc.run(
            Group::Stamps,
            "st_seed",
            params,
            self.size,
            &[&frame.view, &mask.view],
            Out::F32(&seed.view),
            Bind::default(),
        );
        let mut pushed = vec![seed];
        for pair in sizes.windows(2) {
            let level = enc.texture("Stamp Level", pair[1], WORK_FORMAT);
            enc.run(
                Group::Stamps,
                "st_push",
                &Params {
                    grid: Grid::new(pair[1]).with_src(pair[0]),
                    ..Default::default()
                },
                pair[1],
                &[&pushed.last().unwrap().view],
                Out::F32(&level.view),
                Bind::default(),
            );
            pushed.push(level);
        }
        let mut filled: Option<Tex> = None;
        for (index, sums) in pushed.iter().enumerate().rev() {
            let size = sizes[index];
            let grid = Grid::new(size).with_src(sizes.get(index + 1).copied().unwrap_or(size));
            let mut current = enc.texture("Stamp Fill", size, WORK_FORMAT);
            let coarse = filled.as_ref().map(|coarse| &coarse.view);
            enc.run(
                Group::Stamps,
                "st_pull",
                &Params {
                    grid,
                    coarsest: coarse.is_none() as u32,
                    ..Default::default()
                },
                size,
                &[&sums.view, coarse.unwrap_or(&sums.view)],
                Out::F32(&current.view),
                Bind::default(),
            );
            let relax = if index == 0 { FINE_RELAX } else { COARSE_RELAX };
            let spare = enc.texture("Stamp Fill", size, WORK_FORMAT);
            let settled = enc.iterate(
                Group::Stamps,
                "st_relax",
                &Params {
                    grid: Grid::new(size),
                    ..Default::default()
                },
                size,
                [&current, &spare],
                relax,
            );
            if settled == 1 {
                current = spare;
            }
            filled = Some(current);
        }
        filled.unwrap()
    }
}

impl Stamps {
    fn key_of(patches: &[Value], space: &StampSpace) -> u64 {
        let mut hasher = DefaultHasher::new();
        for (key, value) in patches
            .iter()
            .filter_map(Value::as_object)
            .flatten()
            .filter(|(key, _)| key.as_str() != "patchData")
        {
            (key, value.to_string()).hash(&mut hasher);
        }
        format!("{:?}", space).hash(&mut hasher);
        hasher.finish()
    }

    pub fn new(patches: &[Value], space: &StampSpace) -> Option<Self> {
        let list: Vec<Stamp> = patches
            .iter()
            .filter_map(|patch| serde_json::from_value::<AiPatchDefinition>(patch.clone()).ok())
            .filter_map(|patch| Stamp::new(&patch, space))
            .collect();
        (!list.is_empty()).then(|| Self {
            list,
            key: Self::key_of(patches, space),
        })
    }

    pub fn key(&self) -> u64 {
        self.key
    }

    pub fn encode(&self, enc: &mut ComputeEncoder, src: &Slot, dst: &Slot) {
        enc.run(
            Group::Stamps,
            "st_copy",
            &Params {
                grid: Grid::new(dst.size),
                ..Default::default()
            },
            dst.size,
            &[&src.view],
            Out::F16(&dst.view),
            Bind::default(),
        );
        for stamp in &self.list {
            stamp.encode(enc, dst);
        }
    }
}

#[derive(Default)]
pub struct StampCache {
    key: Option<u64>,
    stamps: Option<Arc<Stamps>>,
}

impl StampCache {
    pub const fn new() -> Self {
        Self {
            key: None,
            stamps: None,
        }
    }

    pub fn get(&mut self, patches: &[Value], space: &StampSpace) -> Option<Arc<Stamps>> {
        let key = Stamps::key_of(patches, space);
        if self.key != Some(key) {
            self.stamps = Stamps::new(patches, space).map(Arc::new);
            self.key = Some(key);
        }
        self.stamps.clone()
    }
}
