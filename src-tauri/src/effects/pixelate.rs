use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use crate::render::gpu::compute::{Bind, ComputeEncoder, Grid, Group, IMAGE_FORMAT, Out, Slot};
use crate::render::uniforms::{AllAdjustments, MAX_MASKS};

const MAX_CELL_SHARE: f32 = 0.08;
const MIN_CELL: f32 = 2.0;
const CELL_GROUPS: usize = MAX_MASKS / 4;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    grid: Grid,
    global: [f32; 4],
    cells: [[f32; 4]; CELL_GROUPS],
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pixelation {
    global: f32,
    cells: [f32; MAX_MASKS],
    count: u32,
}

impl Pixelation {
    pub fn new(adjustments: &AllAdjustments, size: (u32, u32), mask_layers: u32) -> Option<Self> {
        let long_edge = size.0.max(size.1) as f32;
        let cell = |amount: f32| {
            let cell = amount.clamp(0.0, 100.0) / 100.0 * MAX_CELL_SHARE * long_edge;
            if cell >= MIN_CELL { cell } else { 0.0 }
        };
        let count = adjustments
            .mask_count
            .min(mask_layers)
            .min(MAX_MASKS as u32);
        let mut cells = [0.0; MAX_MASKS];
        for (index, slot) in cells.iter_mut().enumerate().take(count as usize) {
            *slot = cell(adjustments.mask_adjustments[index].pixelate);
        }
        let global = cell(adjustments.global.pixelate);
        (global > 0.0 || cells.iter().any(|cell| *cell > 0.0)).then_some(Self {
            global,
            cells,
            count,
        })
    }

    pub fn cache_key(&self, input_id: u64, mask_key: u64) -> u64 {
        let mut hasher = DefaultHasher::new();
        (input_id, mask_key, self.global.to_bits(), self.count).hash(&mut hasher);
        self.cells
            .iter()
            .for_each(|cell| cell.to_bits().hash(&mut hasher));
        hasher.finish()
    }

    pub fn encode(
        &self,
        enc: &mut ComputeEncoder,
        source: &wgpu::TextureView,
        size: (u32, u32),
        masks: &wgpu::TextureView,
    ) -> Slot {
        let mut cells = [[0.0; 4]; CELL_GROUPS];
        for (index, cell) in self.cells.iter().enumerate() {
            cells[index / 4][index % 4] = *cell;
        }
        let params = Params {
            grid: Grid::new(size),
            global: [self.global, self.count as f32, 0.0, 0.0],
            cells,
        };
        let output = enc.texture("Pixelate", size, IMAGE_FORMAT);
        enc.run(
            Group::Pixelate,
            "px_apply",
            &params,
            size,
            &[source],
            Out::F16(&output.view),
            Bind {
                layers: Some(masks),
                ..Default::default()
            },
        );
        output.detach()
    }
}
