// Decode a camera RAW file with the SAME rawler settings the GUI uses,
// and write the linear-sRGB result as a 32-bit float TIFF. This lets
// the parity harness drive both pipelines (Python and Rust) from the
// pixels the GUI actually sees, isolating any RAW-decoder differences
// out of the comparison.
//
// Usage:
//   decode_raw_gui <input.orf> <output.tif>
//
// Linear sRGB primaries, AlphaMode::None, no gamma. The pipeline will
// decode the input as `input_color_space = "sRGB"` with
// `input_cctf_decoding = false` (matches the GUI defaults for RAW).

use std::fs::File;
use std::io::BufWriter;
use std::path::Path;

use anyhow::{Context, Result, anyhow};
use rawler::{
    decode_file,
    imgop::develop::{Intermediate, ProcessingStep, RawDevelop},
};
use tiff::encoder::{TiffEncoder, colortype::RGB32Float};

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let input = args
        .next()
        .ok_or_else(|| anyhow!("usage: decode_raw_gui <input.raw> <output.tif>"))?;
    let output = args
        .next()
        .ok_or_else(|| anyhow!("usage: decode_raw_gui <input.raw> <output.tif>"))?;
    let input = Path::new(&input);
    let output = Path::new(&output);

    eprintln!("[decode_raw_gui] decoding {} via rawler …", input.display());
    let raw = decode_file(input).map_err(|e| anyhow!("RAW decode failed: {e:?}"))?;
    let mut dev = RawDevelop::default();
    dev.steps.retain(|s| !matches!(s, ProcessingStep::SRgb));
    let intermediate = dev
        .develop_intermediate(&raw)
        .map_err(|e| anyhow!("RAW develop failed: {e:?}"))?;
    let (w, h, floats) = intermediate_to_rgb32f(intermediate);
    eprintln!("[decode_raw_gui] decoded {}×{} → linear sRGB", w, h);

    let f = File::create(output).with_context(|| format!("creating {}", output.display()))?;
    let mut encoder = TiffEncoder::new(BufWriter::new(f)).context("init TiffEncoder")?;
    encoder
        .write_image::<RGB32Float>(w, h, &floats)
        .context("write TIFF image")?;
    eprintln!("[decode_raw_gui] wrote {}", output.display());
    Ok(())
}

fn intermediate_to_rgb32f(intermediate: Intermediate) -> (u32, u32, Vec<f32>) {
    let floor = |v: f32| v.max(0.0);
    match intermediate {
        Intermediate::Monochrome(pixels) => {
            let mut out = Vec::with_capacity(pixels.data.len() * 3);
            for v in pixels.data {
                let v = floor(v);
                out.extend_from_slice(&[v, v, v]);
            }
            (pixels.width as u32, pixels.height as u32, out)
        }
        Intermediate::ThreeColor(pixels) => {
            let mut out = Vec::with_capacity(pixels.data.len() * 3);
            for px in pixels.data {
                out.extend_from_slice(&[floor(px[0]), floor(px[1]), floor(px[2])]);
            }
            (pixels.width as u32, pixels.height as u32, out)
        }
        Intermediate::FourColor(pixels) => {
            let mut out = Vec::with_capacity(pixels.data.len() * 3);
            for px in pixels.data {
                out.extend_from_slice(&[floor(px[0]), floor(px[1]), floor(px[2])]);
            }
            (pixels.width as u32, pixels.height as u32, out)
        }
    }
}
