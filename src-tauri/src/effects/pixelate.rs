use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use crate::render::gpu::compute::{Bind, ComputeEncoder, Grid, Group, IMAGE_FORMAT, Out, Slot};
use crate::render::uniforms::{AllAdjustments, MAX_MASKS};

const MAX_CELL_SHARE: f32 = 0.08;
const MIN_CELL: f32 = 2.0;
const CELL_GROUPS: usize = MAX_MASKS / 4;
const PHASE_GROUPS: usize = MAX_MASKS / 2;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    grid: Grid,
    global: [f32; 4],
    cells: [[f32; 4]; CELL_GROUPS],
    phases: [[f32; 4]; PHASE_GROUPS],
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pixelation {
    global: f32,
    global_phase: [f32; 2],
    cells: [f32; MAX_MASKS],
    phases: [[f32; 2]; MAX_MASKS],
    count: u32,
}

fn phase(amount: f32) -> [f32; 2] {
    let mut state = (amount.to_bits() as u64).wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut next = || {
        state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        ((z ^ (z >> 31)) >> 40) as f32 / (1u64 << 24) as f32
    };
    [next(), next()]
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
        let mut phases = [[0.0; 2]; MAX_MASKS];
        for index in 0..count as usize {
            let amount = adjustments.mask_adjustments[index].pixelate;
            cells[index] = cell(amount);
            phases[index] = phase(amount);
        }
        let global = cell(adjustments.global.pixelate);
        (global > 0.0 || cells.iter().any(|cell| *cell > 0.0)).then_some(Self {
            global,
            global_phase: phase(adjustments.global.pixelate),
            cells,
            phases,
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
        let mut phases = [[0.0; 4]; PHASE_GROUPS];
        for (index, phase) in self.phases.iter().enumerate() {
            phases[index / 2][index % 2 * 2] = phase[0];
            phases[index / 2][index % 2 * 2 + 1] = phase[1];
        }
        let params = Params {
            grid: Grid::new(size),
            global: [
                self.global,
                self.count as f32,
                self.global_phase[0],
                self.global_phase[1],
            ],
            cells,
            phases,
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
