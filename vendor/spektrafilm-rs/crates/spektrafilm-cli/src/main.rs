use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use spektrafilm_core::params::RuntimeParams;
use spektrafilm_core::pipeline::Pipeline;
use spektrafilm_core::profile;
use spektrafilm_math::image::ImageBuf;

#[derive(Parser)]
#[command(
    name = "spektrafilm",
    about = "Physically-based spectral film emulation"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Process an image through the film simulation pipeline.
    Process {
        /// Input image (TIFF, EXR, or PNG).
        input: PathBuf,
        /// Output image path.
        #[arg(short, long)]
        output: PathBuf,
        /// Film stock name (e.g. kodak_portra_400).
        #[arg(long)]
        film: String,
        /// Paper stock name (e.g. fujifilm_crystal_archive_typeii).
        /// If omitted and --scan-film is not set, uses the film's target_print.
        #[arg(long)]
        paper: Option<String>,
        /// Scan film directly (skip printing stage).
        #[arg(long)]
        scan_film: bool,
        /// Print per-stage timing information.
        #[arg(long)]
        timings: bool,
        /// Path to JSON params file for overrides.
        #[arg(long)]
        params: Option<PathBuf>,
        /// Dump the raw f64 output buffer (HxWx3, row-major, channel-interleaved)
        /// before sRGB encoding/clipping. Used for bit-exact parity comparison.
        #[arg(long)]
        raw_out: Option<PathBuf>,
        /// Run the pipeline N times in the same process. Each iteration is
        /// timed individually so you can see cold-start vs warm-cache speed.
        /// Default: 1 (no repetition).
        #[arg(long, default_value = "1")]
        iters: usize,
        /// Path to the data directory.
        #[arg(long, default_value = "data")]
        data_dir: PathBuf,
    },
    /// List available film and paper profiles.
    ListProfiles {
        /// Path to the data directory.
        #[arg(long, default_value = "data")]
        data_dir: PathBuf,
    },
    /// Export a 3D CUBE LUT for use in other software.
    ExportLut {
        /// Film stock name.
        #[arg(long)]
        film: String,
        /// Paper stock name.
        #[arg(long)]
        paper: Option<String>,
        /// LUT cube size (e.g. 33, 65).
        #[arg(long, default_value = "33")]
        size: u32,
        /// Output .cube file path.
        #[arg(short, long)]
        output: PathBuf,
        /// Path to the data directory.
        #[arg(long, default_value = "data")]
        data_dir: PathBuf,
    },
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();

    match cli.command {
        Commands::Process {
            input,
            output,
            film,
            paper,
            scan_film,
            timings,
            params: params_file,
            raw_out,
            iters,
            data_dir,
        } => {
            cmd_process(
                &input,
                &output,
                &film,
                paper.as_deref(),
                scan_film,
                timings,
                params_file.as_deref(),
                raw_out.as_deref(),
                iters,
                &data_dir,
            )?;
        }
        Commands::ListProfiles { data_dir } => {
            cmd_list_profiles(&data_dir);
        }
        Commands::ExportLut {
            film,
            paper,
            size,
            output,
            data_dir,
        } => {
            cmd_export_lut(&film, paper.as_deref(), size, &output, &data_dir)?;
        }
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn cmd_process(
    input: &Path,
    output: &Path,
    film_name: &str,
    paper_name: Option<&str>,
    scan_film: bool,
    show_timings: bool,
    params_file: Option<&Path>,
    raw_out: Option<&Path>,
    iters: usize,
    data_dir: &Path,
) -> Result<()> {
    let total_start = Instant::now();

    // Load profiles
    let t = Instant::now();
    let film = profile::load_profile_by_name(data_dir, film_name)
        .with_context(|| format!("loading film profile: {film_name}"))?;

    let print_stock = if scan_film {
        film_name.to_string()
    } else if let Some(p) = paper_name {
        p.to_string()
    } else if let Some(ref target) = film.info.target_print {
        target.clone()
    } else {
        bail!("no paper specified and film has no target_print — use --paper or --scan-film");
    };

    let print = profile::load_profile_by_name(data_dir, &print_stock)
        .with_context(|| format!("loading print profile: {print_stock}"))?;
    eprintln!("Profiles loaded: {} ms", t.elapsed().as_millis());

    // Load params (defaults + optional overrides)
    let mut params = if let Some(pf) = params_file {
        let f = std::fs::File::open(pf)
            .with_context(|| format!("opening params file: {}", pf.display()))?;
        serde_json::from_reader(std::io::BufReader::new(f))
            .with_context(|| "parsing params file")?
    } else {
        RuntimeParams::default()
    };
    params.io.scan_film = scan_film;

    // Auto-detect input color space from file extension
    let ext = input
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext == "png"
        || matches!(
            ext.as_str(),
            "dng"
                | "cr2"
                | "cr3"
                | "nef"
                | "nrw"
                | "arw"
                | "srf"
                | "sr2"
                | "raf"
                | "orf"
                | "rw2"
                | "pef"
                | "srw"
                | "x3f"
                | "iiq"
                | "3fr"
                | "crw"
                | "rwl"
                | "mrw"
                | "mef"
                | "kdc"
                | "ari"
                | "bay"
                | "dcr"
                | "drf"
                | "erf"
                | "fff"
                | "k25"
                | "mos"
                | "ptx"
        )
    {
        // PNG and RAW both deliver linear sRGB after our loader's
        // sRGB-decode (PNG) or disabled-basecurve+gamma (RAW) step.
        // Tell the pipeline so it doesn't decode gamma a second time.
        params.io.input_color_space = "sRGB".to_string();
        params.io.input_cctf_decoding = false;
    }

    // Load image
    let t = Instant::now();
    let image = load_image(input)?;
    eprintln!(
        "Image loaded: {}x{} ({} MP), {} ms",
        image.width,
        image.height,
        (image.pixel_count() as f64 / 1e6 * 10.0).round() / 10.0,
        t.elapsed().as_millis()
    );

    // Select backend
    let backend = spektrafilm_gpu::select_backend();
    eprintln!("Backend: {}", backend.name());

    // Run pipeline (with full Hanatos2025 spectral upsampling)
    let t = Instant::now();
    let pipeline = Pipeline::new_with_spectral(film, print, params, data_dir).unwrap_or_else(|e| {
        eprintln!("Warning: spectral LUT not available ({e}), using simplified path");
        Pipeline::new(
            profile::load_profile_by_name(data_dir, film_name).unwrap(),
            profile::load_profile_by_name(data_dir, &print_stock).unwrap(),
            {
                let mut p = RuntimeParams::default();
                p.io.scan_film = scan_film;
                if ext == "png" {
                    p.io.input_color_space = "sRGB".to_string();
                }
                p
            },
        )
    });
    let result = if iters > 1 {
        // Warm-cache bench: process the image `iters` times in the same backend
        // instance. The first iteration pays shader-compile cost; subsequent ones
        // hit the cache and reflect "GUI live preview" performance.
        let mut last = pipeline.process(image.clone(), backend.as_ref());
        let iter1_ms = t.elapsed().as_millis();
        eprintln!("Pipeline (iter 1): {} ms (cold)", iter1_ms);
        for i in 2..=iters {
            let ti = Instant::now();
            last = pipeline.process(image.clone(), backend.as_ref());
            eprintln!(
                "Pipeline (iter {}): {} ms (warm)",
                i,
                ti.elapsed().as_millis()
            );
        }
        last
    } else {
        let r = pipeline.process(image, backend.as_ref());
        eprintln!("Pipeline: {} ms", t.elapsed().as_millis());
        r
    };

    // Save output
    let t = Instant::now();
    save_image(&result, output)?;
    eprintln!(
        "Saved: {} ({}x{}), {} ms",
        output.display(),
        result.width,
        result.height,
        t.elapsed().as_millis()
    );

    // Optional raw f64 dump for bit-exact parity comparison.
    if let Some(p) = raw_out {
        use std::io::Write;
        let buf: Vec<f64> = result.data.iter().map(|&v| v as f64).collect();
        let bytes = bytemuck_cast_f64_to_bytes(&buf);
        let mut f = std::fs::File::create(p)
            .with_context(|| format!("creating raw_out file: {}", p.display()))?;
        f.write_all(bytes)?;
        eprintln!("raw f64 buffer: {} ({} values)", p.display(), buf.len());
    }

    if show_timings {
        eprintln!("Total: {} ms", total_start.elapsed().as_millis());
    }

    Ok(())
}

fn bytemuck_cast_f64_to_bytes(v: &[f64]) -> &[u8] {
    unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, std::mem::size_of_val(v)) }
}

fn cmd_list_profiles(data_dir: &Path) {
    let profiles_dir = data_dir.join("profiles");
    let mut names = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&profiles_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy().to_string();
            if name.ends_with(".json") {
                names.push(name.trim_end_matches(".json").to_string());
            }
        }
    } else {
        eprintln!("Profile directory not found: {}", profiles_dir.display());
        return;
    }
    names.sort();
    for name in &names {
        // Try to load and show the human-readable name
        if let Ok(p) = profile::load_profile_by_name(data_dir, name) {
            let display_name = p.info.name.as_deref().unwrap_or(name);
            let film_type = &p.info.film_type;
            let support = &p.info.support;
            println!("{name:<40} {display_name:<30} ({film_type}, {support})");
        } else {
            println!("{name}");
        }
    }
}

fn cmd_export_lut(
    film_name: &str,
    paper_name: Option<&str>,
    size: u32,
    output: &Path,
    data_dir: &Path,
) -> Result<()> {
    let film = profile::load_profile_by_name(data_dir, film_name)
        .with_context(|| format!("loading film profile: {film_name}"))?;

    let print_stock = if let Some(p) = paper_name {
        p.to_string()
    } else if let Some(ref target) = film.info.target_print {
        target.clone()
    } else {
        bail!("no paper specified and film has no target_print");
    };
    let print = profile::load_profile_by_name(data_dir, &print_stock)
        .with_context(|| format!("loading print profile: {print_stock}"))?;

    let mut params = RuntimeParams::default();
    params.film_render.grain.active = false;
    params.film_render.halation.active = false;
    params.film_render.dir_couplers.active = false;
    params.camera.auto_exposure = false;

    let backend = spektrafilm_gpu::select_backend();
    let pipeline = Pipeline::new(film, print, params);

    // Generate LUT: sample the pipeline on a uniform grid
    let s = size as usize;
    let mut cube_data = String::new();
    cube_data.push_str(&format!("# Created by spektrafilm-rs\n"));
    cube_data.push_str(&format!(
        "TITLE \"spektrafilm {film_name} → {print_stock}\"\n"
    ));
    cube_data.push_str(&format!("LUT_3D_SIZE {size}\n"));
    cube_data.push_str("\n");

    eprintln!("Generating {s}x{s}x{s} CUBE LUT...");

    for bi in 0..s {
        for gi in 0..s {
            for ri in 0..s {
                let r = ri as f32 / (s - 1) as f32;
                let g = gi as f32 / (s - 1) as f32;
                let b = bi as f32 / (s - 1) as f32;

                let img = ImageBuf::from_data(
                    1,
                    1,
                    vec![
                        spektrafilm_math::precision::from_f32(r),
                        spektrafilm_math::precision::from_f32(g),
                        spektrafilm_math::precision::from_f32(b),
                    ],
                );
                let out = pipeline.process(img, backend.as_ref());
                let px = out.get(0, 0);
                cube_data.push_str(&format!("{:.6} {:.6} {:.6}\n", px[0], px[1], px[2]));
            }
        }
    }

    std::fs::write(output, &cube_data)
        .with_context(|| format!("writing CUBE file: {}", output.display()))?;
    eprintln!("LUT saved: {}", output.display());
    Ok(())
}

/// Load an image from TIFF or PNG into an ImageBuf (f32, linear, [0-1]).
fn load_image(path: &Path) -> Result<ImageBuf> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "tif" | "tiff" => load_tiff(path),
        "png" => load_png(path),
        // Camera RAW formats — same set as the GUI's loader.
        "dng" | "cr2" | "cr3" | "nef" | "nrw" | "arw" | "srf" | "sr2" | "raf" | "orf" | "rw2"
        | "pef" | "srw" | "x3f" | "iiq" | "3fr" | "crw" | "rwl" | "mrw" | "mef" | "kdc" | "ari"
        | "bay" | "dcr" | "drf" | "erf" | "fff" | "k25" | "mos" | "ptx" => load_raw(path),
        _ => bail!("unsupported image format: .{ext} (supported: tiff, png, raw)"),
    }
}

/// Decode a camera RAW file via `rawler` — same code path the GUI uses
/// (`crates/spektrafilm-gui/src/main.rs::load_raw`). Earlier versions
/// used `imagepipe`+`rawloader` which produces DIFFERENT pixel values
/// for the same ORF (different demosaic algorithm, different camera
/// matrix), giving the f64 CPU export a visible warm/magenta cast vs
/// the GUI preview. They must share a decoder for the export to match
/// the preview byte-for-byte at the input boundary.
fn load_raw(path: &Path) -> Result<ImageBuf> {
    use rawler::{
        decode_file,
        imgop::develop::{ProcessingStep, RawDevelop},
    };
    let raw = decode_file(path).map_err(|e| anyhow::anyhow!("RAW decode failed: {e:?}"))?;
    let mut dev = RawDevelop::default();
    // Drop the sRGB gamma step — we want linear sRGB primaries; the
    // spektrafilm pipeline applies its own sRGB OETF at the very end.
    dev.steps.retain(|s| !matches!(s, ProcessingStep::SRgb));
    let intermediate = dev
        .develop_intermediate(&raw)
        .map_err(|e| anyhow::anyhow!("RAW develop failed: {e:?}"))?;
    rawler_intermediate_to_image_buf(intermediate)
}

fn rawler_intermediate_to_image_buf(
    intermediate: rawler::imgop::develop::Intermediate,
) -> Result<ImageBuf> {
    use rayon::prelude::*;
    use rawler::imgop::develop::Intermediate;

    let floor = |v: f32| spektrafilm_math::precision::from_f32(v.max(0.0));
    match intermediate {
        Intermediate::Monochrome(pixels) => {
            let scalars: Vec<spektrafilm_math::precision::Scalar> = pixels
                .data
                .par_iter()
                .flat_map_iter(|&v| {
                    let v = floor(v);
                    [v, v, v]
                })
                .collect();
            Ok(ImageBuf::from_data(
                pixels.width as u32,
                pixels.height as u32,
                scalars,
            ))
        }
        Intermediate::ThreeColor(pixels) => {
            let scalars: Vec<spektrafilm_math::precision::Scalar> = pixels
                .data
                .par_iter()
                .flat_map_iter(|px| [floor(px[0]), floor(px[1]), floor(px[2])])
                .collect();
            Ok(ImageBuf::from_data(
                pixels.width as u32,
                pixels.height as u32,
                scalars,
            ))
        }
        Intermediate::FourColor(pixels) => {
            let scalars: Vec<spektrafilm_math::precision::Scalar> = pixels
                .data
                .par_iter()
                .flat_map_iter(|px| [floor(px[0]), floor(px[1]), floor(px[2])])
                .collect();
            Ok(ImageBuf::from_data(
                pixels.width as u32,
                pixels.height as u32,
                scalars,
            ))
        }
    }
}

/// Decode an image with the decoder's memory limits disabled. The
/// `image` crate caps allocation at 512 MiB by default, which rejects
/// large float TIFFs (a 60 MP 32-bit RGB frame alone is ~720 MiB). We
/// trust local files, so lift the cap.
fn decode_no_limits(path: &Path) -> Result<image::DynamicImage> {
    let mut reader = image::ImageReader::open(path)
        .with_context(|| format!("opening image: {}", path.display()))?
        .with_guessed_format()
        .with_context(|| format!("detecting image format: {}", path.display()))?;
    reader.no_limits();
    reader
        .decode()
        .with_context(|| format!("decoding image: {}", path.display()))
}

fn load_tiff(path: &Path) -> Result<ImageBuf> {
    let img = decode_no_limits(path)?;
    let rgb = img.to_rgb32f();
    let (w, h) = (rgb.width(), rgb.height());
    let data: Vec<f32> = rgb.into_raw();
    let scalars: Vec<spektrafilm_math::precision::Scalar> = data
        .into_iter()
        .map(spektrafilm_math::precision::from_f32)
        .collect();
    Ok(ImageBuf::from_data(w, h, scalars))
}

fn load_png(path: &Path) -> Result<ImageBuf> {
    let img = decode_no_limits(path)?;
    let rgb = img.to_rgb32f();
    let (w, h) = (rgb.width(), rgb.height());
    let data: Vec<f32> = rgb.into_raw();
    // PNG is sRGB gamma-encoded — promote to Scalar then decode to linear
    let scalars: Vec<spektrafilm_math::precision::Scalar> = data
        .into_iter()
        .map(|v| spektrafilm_math::precision::srgb_decode(spektrafilm_math::precision::from_f32(v)))
        .collect();
    Ok(ImageBuf::from_data(w, h, scalars))
}

/// Save an ImageBuf to TIFF (16-bit) or PNG (8-bit).
fn save_image(img: &ImageBuf, path: &Path) -> Result<()> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "tif" | "tiff" => save_tiff(img, path),
        "png" => save_png(img, path),
        "jpg" | "jpeg" => save_jpeg(img, path),
        _ => bail!("unsupported output format: .{ext} (supported: tiff, png, jpg)"),
    }
}

fn save_tiff(img: &ImageBuf, path: &Path) -> Result<()> {
    // Convert to 16-bit
    let data_u16: Vec<u16> = img
        .data
        .iter()
        .map(|&v| ((v.clamp(0.0, 1.0) * 65535.0).round_ties_even()) as u16)
        .collect();

    let buf: image::ImageBuffer<image::Rgb<u16>, Vec<u16>> =
        image::ImageBuffer::from_raw(img.width, img.height, data_u16)
            .context("creating image buffer")?;

    buf.save(path)
        .with_context(|| format!("saving TIFF: {}", path.display()))?;
    Ok(())
}

fn save_jpeg(img: &ImageBuf, path: &Path) -> Result<()> {
    // Same 8-bit quantize as PNG; round_ties_even keeps the pre-encode
    // pixel values numpy-identical. Quality 95 — defending the f64
    // export path against silent quality loss; `image`'s default of 75
    // would defeat the point of running the pipeline at f64.
    use image::ImageEncoder;
    let data_u8: Vec<u8> = img
        .data
        .iter()
        .map(|&v| ((v.clamp(0.0, 1.0) * 255.0).round_ties_even()) as u8)
        .collect();
    let mut file = std::io::BufWriter::new(
        std::fs::File::create(path)
            .with_context(|| format!("creating JPEG: {}", path.display()))?,
    );
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut file, 95)
        .write_image(
            &data_u8,
            img.width,
            img.height,
            image::ExtendedColorType::Rgb8,
        )
        .with_context(|| format!("saving JPEG: {}", path.display()))?;
    Ok(())
}

fn save_png(img: &ImageBuf, path: &Path) -> Result<()> {
    // Python: `np.round(x * 255).astype(np.uint8)`. Numpy uses
    // round-half-to-even (banker's rounding), *not* round-half-up.
    // `f64::round()` in Rust is round-half-away-from-zero so it
    // disagrees with numpy at exact x.5 inputs — a rare but real
    // diff that prevented the bare-chain output from being
    // bit-identical with Python. `round_ties_even` (stable since
    // Rust 1.77) matches numpy literally.
    let data_u8: Vec<u8> = img
        .data
        .iter()
        .map(|&v| ((v.clamp(0.0, 1.0) * 255.0).round_ties_even()) as u8)
        .collect();

    let buf: image::ImageBuffer<image::Rgb<u8>, Vec<u8>> =
        image::ImageBuffer::from_raw(img.width, img.height, data_u8)
            .context("creating image buffer")?;

    buf.save(path)
        .with_context(|| format!("saving PNG: {}", path.display()))?;
    Ok(())
}
