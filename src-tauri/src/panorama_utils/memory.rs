const SOURCE_BYTES_PER_PIXEL: u64 = 12;
const TILE_BYTES_PER_PIXEL: u64 = 16;
const CANVAS_BYTES_PER_PIXEL: u64 = 16;

const PYRAMID_BYTES_PER_PIXEL: u64 = 22;
const LABEL_BYTES_PER_PIXEL: u64 = 6;

const OVERHEAD_NUMERATOR: u64 = 102;
const OVERHEAD_DENOMINATOR: u64 = 100;

const REGISTRATION_FIXED_PER_FRAME: u64 = 36_000_000;
const REGISTRATION_BYTES_PER_PIXEL: u64 = 13;

pub fn registration_bytes(n: u32, width: u32, height: u32) -> u64 {
    let pix = (width as u64).saturating_mul(height as u64);
    (n.max(1) as u64)
        .saturating_mul(REGISTRATION_FIXED_PER_FRAME)
        .saturating_add(
            (n.max(1) as u64)
                .saturating_mul(pix)
                .saturating_mul(REGISTRATION_BYTES_PER_PIXEL),
        )
}

#[derive(Clone, Copy, Debug, Default)]
pub struct StitchCost {

    pub sources: u64,
    pub registration: u64,
    pub resident: u64,
    pub spillable: u64,
}

impl StitchCost {

    pub fn total(&self, canvas_pixels: u64) -> u64 {
        let canvas_bytes = canvas_pixels.saturating_mul(CANVAS_BYTES_PER_PIXEL);
        let label_out = canvas_pixels.saturating_mul(2);
        let during_register = self.sources.saturating_add(self.registration);
        let during_blend = self.sources.saturating_add(self.spillable);
        let during_finish = self
            .sources
            .saturating_add(canvas_bytes)
            .saturating_add(self.resident)
            .saturating_add(label_out);
        let peak = during_register
            .saturating_add(during_blend)
            .max(during_finish);
        peak.saturating_mul(OVERHEAD_NUMERATOR) / OVERHEAD_DENOMINATOR
    }
}

pub fn stitch_cost(
    n: u32,
    width: u32,
    height: u32,
    tile_pixels: u64,
    canvas_pixels: u64,
) -> StitchCost {
    let sources = stitch_resident_bytes(n, width, height);
    let resident = canvas_pixels.saturating_mul(CANVAS_BYTES_PER_PIXEL);
    let tiles = tile_pixels.saturating_mul(TILE_BYTES_PER_PIXEL);
    let internal = canvas_pixels
        .saturating_mul(PYRAMID_BYTES_PER_PIXEL)
        .saturating_add(canvas_pixels.saturating_mul(LABEL_BYTES_PER_PIXEL));
    StitchCost {
        sources,
        registration: registration_bytes(n, width, height),
        resident,
        spillable: tiles.saturating_add(internal),
    }
}

pub fn stitch_resident_bytes(n: u32, width: u32, height: u32) -> u64 {
    let frame_pix = (width as u64).saturating_mul(height as u64);
    (n.max(1) as u64)
        .saturating_mul(frame_pix)
        .saturating_mul(SOURCE_BYTES_PER_PIXEL)
}
