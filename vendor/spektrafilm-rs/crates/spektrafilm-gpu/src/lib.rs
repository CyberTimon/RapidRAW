pub mod cpu_backend;
#[cfg(feature = "cuda-backend")]
pub mod cuda_backend;
#[cfg(feature = "wgpu-backend")]
pub mod wgpu_backend;

use spektrafilm_math::image::ImageBuf;

/// Compute backend abstraction. Each method corresponds to a GPU-friendly
/// operation in the film simulation pipeline.
///
/// Default implementations fall back to CPU. GPU backends override the
/// spectral methods for massive speedups.
pub trait ComputeBackend: Send + Sync {
    fn colorspace_convert(&self, img: &ImageBuf, matrix: &[[f32; 3]; 3]) -> ImageBuf;
    fn cctf_encode_srgb(&self, img: &ImageBuf) -> ImageBuf;
    fn cctf_decode_srgb(&self, img: &ImageBuf) -> ImageBuf;
    fn gaussian_blur(&self, img: &ImageBuf, sigma: f32) -> ImageBuf;

    /// Blur `img` with each of `sigmas`, returning one image per sigma.
    /// GPU backends fuse the work into a single command buffer (one upload,
    /// one submit, one readback) — much cheaper than N independent
    /// `gaussian_blur` calls when N > 1. Default implementation calls the
    /// per-sigma kernel in a loop.
    fn gaussian_blur_multi(&self, img: &ImageBuf, sigmas: &[f32]) -> Vec<ImageBuf> {
        sigmas.iter().map(|&s| self.gaussian_blur(img, s)).collect()
    }
    fn table_lookup(&self, img: &ImageBuf, table_x: &[f32], table_y: &[[f32; 3]]) -> ImageBuf;
    fn lut3d_interp(&self, img: &ImageBuf, lut: &Lut3D) -> ImageBuf;

    /// Spectral scanning: density CMY → RGB via spectral integration.
    /// GPU backends override this with a compute shader.
    ///
    /// The `cat` and `xyz_to_rgb` matrices are kept separate so the CPU
    /// path can apply them as two sequential matmuls (matching Python's
    /// `colour.XYZ_to_RGB` step-by-step). Pre-combining loses ~1 ULP per
    /// output channel which compounds to ~5e-6 of drift in the bare
    /// chain. GPU may collapse for performance.
    fn scan_spectral(
        &self,
        density_cmy: &ImageBuf,
        channel_density: &[[f64; 3]],
        base_density: &[f64],
        illuminant: &[f64],
        normalization: f64,
        cat: &[[f64; 3]; 3],
        xyz_to_rgb: &[[f64; 3]; 3],
    ) -> ImageBuf {
        cpu_backend::scan_spectral_cpu(
            density_cmy,
            channel_density,
            base_density,
            illuminant,
            normalization,
            cat,
            xyz_to_rgb,
        )
    }

    /// Spectral printing: film density CMY → print log-exposure via spectral integration.
    /// GPU backends override this with a compute shader.
    fn print_spectral(
        &self,
        density_cmy: &ImageBuf,
        channel_density: &[[f64; 3]],
        base_density: &[f64],
        illuminant: &[f64],
        sensitivity: &[[f64; 3]],
        normalization_factor: f64,
        preflash: [f64; 3],
    ) -> ImageBuf {
        cpu_backend::print_spectral_cpu(
            density_cmy,
            channel_density,
            base_density,
            illuminant,
            sensitivity,
            normalization_factor,
            preflash,
        )
    }

    /// Hanatos2025 RGB → film raw exposure (the per-pixel bicubic LUT lookup).
    ///
    /// CPU implementation does the two-step CAT02 adaptation (RGB → native
    /// XYZ, then CAT02 adapt) per pixel for bit-exact Python parity —
    /// fusing both matrices into a single matmul gives a different ULP than
    /// applying them sequentially. GPU backends override and may collapse
    /// the two into a single matrix per the precision budget for live preview.
    fn hanatos2025_rgb_to_raw(
        &self,
        image: &ImageBuf,
        tc_lut: &spektrafilm_math::spectral::TcLut,
        color_space: &str,
        ref_illuminant: &[f32],
        cat16: bool,
    ) -> ImageBuf {
        spektrafilm_math::spectral::hanatos2025_rgb_to_raw(
            image,
            tc_lut,
            color_space,
            ref_illuminant,
            cat16,
        )
    }

    /// log_raw → density_cmy via per-channel curve interpolation.
    ///
    /// Called twice per render (filming.develop + printing.develop). GPU
    /// backends override with `density_curve_interp.wgsl`; CPU falls back to
    /// the f64 reference (`interpolate_exposure_to_density_f64`).
    fn density_curve_interp(
        &self,
        log_raw: &ImageBuf,
        log_exposure: &[f64],
        density_curves: &[[f64; 3]],
        gamma_factor: f64,
    ) -> ImageBuf {
        // CPU fallback — uses the f64 reference (`fast_interp_image_f64`).
        // Scalar gamma is broadcast to all channels; we just stretch the x-axis once.
        let scaled: Vec<f64> = if (gamma_factor - 1.0).abs() < 1e-12 {
            log_exposure.to_vec()
        } else {
            log_exposure.iter().map(|&v| v / gamma_factor).collect()
        };
        spektrafilm_math::interp::fast_interp_image_f64(log_raw, &scaled, density_curves)
    }

    /// Optional fused fast-path: runs filming + printing + scanning as a single
    /// GPU-resident command buffer (one upload at start, one readback at end).
    /// Returns `None` to fall back to per-stage trait methods. CPU backend
    /// always returns `None`; wgpu implements it.
    fn try_run_film_chain(&self, _params: &FilmChainParams<'_>) -> Option<ImageBuf> {
        None
    }

    /// True when `try_run_film_chain` returns the same post-scan output that
    /// `Pipeline::apply_post_scan` would produce (final clamp and optional
    /// sRGB encoding). Backends default to returning linear RGB and letting
    /// the pipeline apply the final CPU pass.
    fn resident_chain_applies_post_scan(&self) -> bool {
        false
    }

    /// True for f32 GPU backends where effects may trade exactness for
    /// speed (the diffusion filter uses a downsampled sum-of-Gaussians
    /// instead of the exact FFT convolution). CPU keeps the exact path.
    fn is_gpu(&self) -> bool {
        false
    }

    fn name(&self) -> &str;
}

/// All inputs to the GPU-resident film chain. Bundled into a struct so the
/// trait method stays object-safe and adding more optional stages (halation,
/// DIR couplers, …) doesn't churn every callsite.
pub struct FilmChainParams<'a> {
    pub image: &'a ImageBuf,
    /// RGB → film-raw front pass (the configured upsampler).
    pub front: FrontPass<'a>,
    pub film_log_exposure: &'a [f64],
    pub film_density_curves_normalized: &'a [[f64; 3]],
    pub film_gamma: f64,
    pub film_channel_density: &'a [[f64; 3]],
    pub film_base_density: &'a [f64],
    pub print_illuminant: &'a [f64],
    pub print_sensitivity: &'a [[f64; 3]],
    pub print_normalization_factor: f64,
    pub print_log_exposure: &'a [f64],
    pub print_density_curves: &'a [[f64; 3]],
    pub print_gamma: f64,
    pub print_channel_density: &'a [[f64; 3]],
    pub print_base_density: &'a [f64],
    /// Constant enlarger preflash raw 3-vector, added to the print exposure
    /// before the inner log10 (Python `_compute_raw_preflash`). `[0; 3]` off.
    pub preflash: [f64; 3],
    pub viewing_illuminant: &'a [f64],
    pub scan_normalization: f64,
    pub scan_xyz_to_rgb: &'a [[f64; 3]; 3],
    /// B&W/slide scanner luminance remap `(m, q)` applied per-pixel on the
    /// scan XYZ (`clip(m·Y+q, 0, 1)/(Y+1e-10)`). `None` is identity. The
    /// filming/printing exposure halves of the correction are folded by the
    /// caller into `rgb_to_adapted_xyz` / `print_normalization_factor`.
    pub bw_xyz_remap: Option<(f64, f64)>,
    /// Scan the developed film directly instead of printing onto paper.
    /// When true the print_spectral + print density-curve passes are
    /// skipped and scan_spectral runs on the film density buffer using the
    /// film's `film_channel_density` / `film_base_density` (the caller sets
    /// `viewing_illuminant` / `scan_normalization` / `scan_xyz_to_rgb` from
    /// the film's viewing illuminant). Mirrors the CPU `scan_film` path.
    pub scan_film: bool,
    /// Optional halation pass — when `Some`, inserted on the raw film
    /// exposure buffer between hanatos2025 and log10.
    pub halation: Option<HalationGpuParams>,
    /// Optional DIR (development inhibitor release) couplers pass — when
    /// `Some`, inserted on the film density buffer between filming and
    /// printing. Re-interpolates density curves using `density_curves_0`.
    pub dir_couplers: Option<DirCouplersGpuParams<'a>>,
    /// Optional grain pass — Poisson-binomial particle model on the film
    /// density buffer, after DIR couplers and before print spectral.
    /// Uses normal-approximation sampling on the GPU (matches what the
    /// CPU path does for typical λ > 30 / variance > 9 regimes).
    pub grain: Option<GrainGpuParams>,
    /// Optional viewing glare pass — applied after scan spectral on the
    /// final RGB buffer. Lognormal-distributed per-pixel surface noise +
    /// blur + per-channel illuminant offset.
    pub glare: Option<GlareGpuParams>,
    /// Optional output gamut compression pass — applied after glare on
    /// the final RGB buffer, before unsharp (matching the CPU scanning
    /// order). When set, scan_spectral skips its [0,1] clamp so the
    /// compressor sees the out-of-gamut values it needs.
    pub gamut: Option<GamutGpuParams<'a>>,
    /// Optional unsharp mask pass — applied after glare (last step
    /// before readback). Blur σ in pixels + amount scalar; both come
    /// from `scanner.unsharp_mask`.
    pub unsharp: Option<UnsharpGpuParams>,
    /// Optional camera lens Gaussian blur on the raw film exposure buffer,
    /// after camera diffusion and before halation.
    pub camera_lens_blur_px: Option<f32>,
    /// Optional scanner lens Gaussian blur on the final RGB buffer, after
    /// glare/gamut compression and before unsharp.
    pub scanner_lens_blur_px: Option<f32>,
    /// Optional highlight reconstruction on the raw film exposure buffer,
    /// immediately after the front pass and before optical scatter.
    pub highlight_boost: Option<HighlightBoostGpuParams>,
    /// Optional camera lens diffusion filter — applied on the raw film
    /// exposure buffer right after hanatos2025, before halation (matching
    /// the CPU filming order). A downsampled sum-of-Gaussians; see
    /// `DiffusionGpuPlan`.
    pub diffusion: Option<DiffusionGpuPlan>,
    /// Optional enlarger diffusion filter. Applied in the print stage on
    /// linear print raw between print_spectral and print density curves.
    pub enlarger_diffusion: Option<DiffusionGpuPlan>,
    /// The print_exposure × B&W printing correction scalar. Used by CUDA
    /// when `enlarger_diffusion` is active so it can preserve the CPU
    /// print-stage ordering around preflash.
    pub print_exposure_scale: f64,
    /// Whether the final output should be sRGB-encoded after clamping. Mirrors
    /// `RuntimeParams::io.output_cctf_encoding`.
    pub output_cctf_encoding: bool,
}

/// RGB → film-raw front pass of the GPU-resident chain. Both variants are
/// homogeneous in the input RGB, so the caller folds the exposure scale
/// (auto-exposure × EV compensation × B&W filming correction) into the
/// matrix — no separate scale pass.
pub enum FrontPass<'a> {
    /// Hanatos2025 spectral upsampling: per-pixel chromaticity LUT lookup.
    Hanatos2025 {
        tc_lut: &'a spektrafilm_math::spectral::TcLut,
        /// Combined input-RGB → CAT-adapted-XYZ matrix (row-major).
        rgb_to_adapted_xyz: [[f64; 3]; 3],
    },
    /// Mallett2019 reflectance-basis upsampling: one rgb → raw 3×3 matmul
    /// (`core · M_cs`, see `spektrafilm-core/src/mallett.rs`).
    Mallett2019 { matrix: [[f64; 3]; 3] },
}

/// Pre-computed plan for the GPU-resident diffusion filter. The per-channel
/// PSF is decomposed into Gaussian components (3 per PSF sub-component) and
/// the whole scattered field is computed on an image downsampled by `d` so
/// the blur σ stay small. `sigmas`/`coeffs` are parallel: component `i`
/// blurs the downsampled image at `sigmas[i]` (working-resolution px) and
/// adds `coeffs[i]` (per-channel) into the accumulator.
#[derive(Debug, Clone)]
pub struct DiffusionGpuPlan {
    pub d: u32,
    pub small_w: u32,
    pub small_h: u32,
    pub p_s: f32,
    pub sigmas: Vec<f32>,
    pub coeffs: Vec<[f32; 3]>,
}

#[derive(Debug, Clone, Copy)]
pub struct HighlightBoostGpuParams {
    pub boost_ev: f32,
    pub boost_range: f32,
    pub protect_ev: f32,
}

/// DIR couplers parameters for the GPU-resident matmul + diffusion + final
/// density-curve re-interpolation pass. Mirrors the CPU
/// `apply_density_correction`.
#[derive(Debug, Clone, Copy)]
pub struct DirCouplersGpuParams<'a> {
    /// Already-scaled `couplers_matrix * amount`, row-major.
    pub couplers_matrix_scaled: [[f32; 3]; 3],
    /// Per-channel max density from the normalized curves (used only when
    /// `is_positive` is true; ignored otherwise).
    pub density_max: [f32; 3],
    pub is_positive: bool,
    pub diffusion_size_px: f32,
    pub diffusion_tail_px: f32,
    pub diffusion_tail_weight: f32,
    /// "Density curves before DIR" — re-interpolated by the final shader
    /// pass with the corrected log-exposure.
    pub density_curves_0: &'a [[f64; 3]],
    pub log_exposure: &'a [f64],
    pub gamma_factor: f64,
}

/// Grain parameters for the GPU-resident Poisson-binomial particle model.
/// Mirrors `apply_grain_to_density`: per-channel n_particles_per_pixel
/// already divided by `n_sub_layers`, density_max already includes
/// `density_min`, etc.
#[derive(Debug, Clone, Copy)]
pub struct GrainGpuParams {
    pub density_min: [f32; 3],
    pub density_max: [f32; 3],
    pub n_particles_per_pixel: [f32; 3],
    pub grain_uniformity: [f32; 3],
    pub n_sub_layers: u32,
    pub base_seed: u32,
    pub grain_blur: f32,
    /// One shared noise field across all channels (B&W single emulsion)
    /// instead of independent per-channel RNG streams.
    pub monochrome: bool,
}

/// Output gamut compression parameters for the GPU-resident per-pixel pass.
/// CPU equivalent: `OutputGamutCompress::compress`. The `C_max(L, h)` table
/// is baked once on the CPU (bisection against the output cube) and uploaded
/// as a storage buffer; the shader only does the per-pixel forward/inverse
/// perceptual transform + Reinhard knee.
#[derive(Debug, Clone, Copy)]
pub struct GamutGpuParams<'a> {
    /// 0 = aces_rgc, 1 = oklch, 2 = oklrab, 3 = cam16ucs — must match the
    /// mode dispatch in `gamut_compress.wgsl`.
    pub mode: u32,
    /// Reinhard knee on normalized chroma: (threshold, limit, power).
    pub knee: [f32; 3],
    /// One-sided lightness compression (threshold, limit, power); `None` off.
    pub lightness: Option<[f32; 3]>,
    /// Perceptual lightness of the output white (1.0 OkLab, ~100 CAM16-UCS).
    pub l_white: f32,
    /// Lightness-axis bounds of the `C_max` table grid.
    pub l_min: f32,
    pub l_max: f32,
    /// `C_max(L, h)` table, row-major `[n_l][n_h]`. Empty for aces_rgc.
    pub cmax: &'a [f64],
    pub n_l: u32,
    pub n_h: u32,
}

/// Unsharp mask parameters: blur sigma in pixels and amount.
#[derive(Debug, Clone, Copy)]
pub struct UnsharpGpuParams {
    pub sigma_px: f32,
    pub amount: f32,
}

/// Viewing glare parameters for the GPU-resident lognormal + blur + apply
/// pass. CPU equivalent: `compute_random_glare_amount` followed by
/// `add_glare_with_amount`.
#[derive(Debug, Clone, Copy)]
pub struct GlareGpuParams {
    /// LogNormal μ and σ derived on the CPU from `percent` + `roughness`.
    pub mu: f32,
    pub sigma: f32,
    pub blur_px: f32,
    pub base_seed: u32,
    /// `(XYZ→RGB) * illuminant_xyz`, pre-divided by 100. The shader
    /// just multiplies the lognormal scalar by this per-channel offset.
    pub rgb_offset: [f32; 3],
}

/// Halation parameters for the GPU-resident scatter + multi-bounce pass.
/// Mirrors the field layout of the CPU `apply_halation_um`, but pre-converts
/// the per-channel µm sigmas to a single pixel-space sigma (the GPU path
/// uses the average across channels, matching the existing CPU impl).
#[derive(Debug, Clone, Copy)]
pub struct HalationGpuParams {
    pub scatter_amount: f32,
    pub scatter_core_px: f32,
    pub scatter_tail_px: f32,
    /// Per-channel tail weight. Python applies these per channel
    /// (Portra 0.78 / 0.65 / 0.67); averaging is a noticeable
    /// chromatic drift.
    pub scatter_tail_weight: [f32; 3],
    pub halation_amount: f32,
    pub halation_strength_avg: f32,
    /// Per-channel `halation_strength[c] * halation_amount`. Used only
    /// for the renormalize pass (which is per-channel even though the
    /// blur/add use the averaged scalar). When `halation_renormalize`
    /// is false this is ignored.
    pub halation_a_tot: [f32; 3],
    pub halation_first_sigma_px: f32,
    pub halation_n_bounces: u32,
    pub halation_bounce_decay: f32,
    pub halation_renormalize: bool,
}

pub struct Lut3D {
    pub size: u32,
    pub data: Vec<f32>,
}

/// Select the best available backend at runtime.
///
/// Honors `SPEKTRAFILM_BACKEND=cpu|cuda|wgpu` when the requested backend is compiled in.
/// Useful for benchmarking and for f64 mode where the GPU shaders truncate to f32.
pub fn select_backend() -> Box<dyn ComputeBackend> {
    let requested = std::env::var("SPEKTRAFILM_BACKEND")
        .ok()
        .map(|v| v.to_ascii_lowercase());

    if requested.as_deref() == Some("cpu") {
        tracing::info!("using CPU backend");
        return Box::new(cpu_backend::CpuBackend);
    }

    #[cfg(feature = "cuda-backend")]
    {
        if requested.as_deref() == Some("cuda") {
            if let Some(cuda) = cuda_backend::CudaBackend::new() {
                tracing::info!("using CUDA GPU backend");
                return Box::new(cuda);
            }
            tracing::warn!("CUDA backend requested but unavailable; falling back");
        }
    }

    #[cfg(not(feature = "cuda-backend"))]
    if requested.as_deref() == Some("cuda") {
        tracing::warn!("CUDA backend requested but spektrafilm-gpu was built without cuda-backend");
    }

    #[cfg(feature = "wgpu-backend")]
    {
        if requested.as_deref().is_none() || requested.as_deref() == Some("wgpu") {
            if let Some(gpu) = wgpu_backend::WgpuBackend::new() {
                tracing::info!("using wgpu GPU backend");
                return Box::new(gpu);
            }
            if requested.as_deref() == Some("wgpu") {
                tracing::warn!("wgpu backend requested but unavailable; falling back");
            }
        }
    }
    tracing::info!("using CPU backend");
    Box::new(cpu_backend::CpuBackend)
}
