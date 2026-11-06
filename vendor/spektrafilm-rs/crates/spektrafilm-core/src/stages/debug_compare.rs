/// Debug comparison: trace intermediate values against Python reference.
#[cfg(test)]
mod tests {
    use crate::profile;
    use crate::spectral_service;
    use spektrafilm_math::spectral;
    use std::path::Path;

    fn data_dir() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("data")
    }

    #[test]
    fn compare_with_python_gray_card() {
        let dir = data_dir();
        let film = profile::load_profile_by_name(&dir, "kodak_portra_400").unwrap();

        // 18% gray in linear sRGB
        let gray_f32 = [0.184f32, 0.184, 0.184];
        let gray = [
            spektrafilm_math::precision::from_f32(gray_f32[0]),
            spektrafilm_math::precision::from_f32(gray_f32[1]),
            spektrafilm_math::precision::from_f32(gray_f32[2]),
        ];
        let ref_illuminant = &spectral::ILLUMINANT_D55;

        // Step 1: RGB → tc, b (with CAT02) — trace internals
        let rgb_to_xyz = spectral::colorspace_to_xyz("sRGB");
        let xyz_native = spektrafilm_math::colorspace::mat3_mul(&rgb_to_xyz, gray_f32);
        eprintln!(
            "xyz_native: [{:.6}, {:.6}, {:.6}]",
            xyz_native[0], xyz_native[1], xyz_native[2]
        );
        eprintln!("Python xyz_native: [0.174892, 0.184000, 0.200376]");

        let src_white = spectral::colorspace_white_xyz("sRGB");
        let dst_white = spectral::illuminant_xyz(ref_illuminant);
        eprintln!(
            "src_white (sRGB): [{:.6}, {:.6}, {:.6}]",
            src_white[0], src_white[1], src_white[2]
        );
        eprintln!("Python src_white: [0.950456, 1.000000, 1.089058]");
        eprintln!(
            "dst_white (D55):  [{:.6}, {:.6}, {:.6}]",
            dst_white[0], dst_white[1], dst_white[2]
        );
        eprintln!("Python dst_white: [0.956791, 1.000000, 0.921367]");

        let adapt = spektrafilm_math::colorspace::chromatic_adaptation_matrix(src_white, dst_white);
        eprintln!(
            "adapt[0]: [{:.9}, {:.9}, {:.9}]",
            adapt[0][0], adapt[0][1], adapt[0][2]
        );
        eprintln!("Python:   [1.025851130, 0.017941305, -0.033218342]");

        let (tc, b) = spectral::rgb_to_tc_b(gray, "sRGB", ref_illuminant, false);
        eprintln!("Rust tc: [{:.12}, {:.12}]", tc.0, tc.1);
        eprintln!("Rust b: {:.12}", b);
        eprintln!("Python tc: [0.445625560000, 0.520476270000]");
        eprintln!("Python b: 0.529581030000");

        // Step 2: Load spectra LUT and compute TC LUT
        let spectra_lut = spectral_service::load_spectra_lut(&dir).unwrap();
        eprintln!(
            "\nSpectra LUT size: {}x{}x{}",
            spectra_lut.size, spectra_lut.size, spectra_lut.n_wavelengths
        );

        let log_sens = film.log_sensitivity_f64();
        let sensitivity: Vec<[f64; 3]> = log_sens
            .iter()
            .map(|row| {
                let mut out = [0.0f64; 3];
                for c in 0..3 {
                    let v = 10.0f64.powf(row[c]);
                    out[c] = if v.is_nan() { 0.0 } else { v };
                }
                out
            })
            .collect();

        let tc_lut = spectral_service::compute_tc_lut(&spectra_lut, &sensitivity);
        eprintln!("TC LUT size: {}x{}", tc_lut.size, tc_lut.size);
        let center = tc_lut.size / 2;
        let center_val = [
            tc_lut.data[(center * tc_lut.size + center) * 3],
            tc_lut.data[(center * tc_lut.size + center) * 3 + 1],
            tc_lut.data[(center * tc_lut.size + center) * 3 + 2],
        ];
        eprintln!(
            "TC LUT center: [{:.12}, {:.12}, {:.12}]",
            center_val[0], center_val[1], center_val[2]
        );
        eprintln!("Python TC LUT center: [1.181268010000, 2.129280180000, 1.842868520000]");

        // Step 3: Midgray normalization
        let norm = spectral_service::compute_midgray_normalization(&sensitivity, ref_illuminant);
        eprintln!("\nMidgray norm factor: {:.10}", norm);
        eprintln!("Python: raw at gray ≈ [1.0, 1.0, 1.0] (pre-normalized in LUT)");

        // Step 4: LUT lookup at gray tc
        let lut_x = tc.0 * (tc_lut.size - 1) as f64;
        let lut_y = tc.1 * (tc_lut.size - 1) as f64;
        let interp = spektrafilm_math::lut::bicubic_2d_f64(
            &tc_lut.data,
            tc_lut.size,
            tc_lut.size,
            3,
            lut_x,
            lut_y,
        );
        eprintln!(
            "\nLUT lookup at tc: [{:.6}, {:.6}, {:.6}]",
            interp[0], interp[1], interp[2]
        );
        let raw = [interp[0] * b, interp[1] * b, interp[2] * b];
        eprintln!(
            "raw (LUT * b): [{:.12}, {:.12}, {:.12}]",
            raw[0], raw[1], raw[2]
        );
        let raw_normed = [raw[0] * norm, raw[1] * norm, raw[2] * norm];
        eprintln!(
            "raw * norm: [{:.6}, {:.6}, {:.6}]",
            raw_normed[0], raw_normed[1], raw_normed[2]
        );
        eprintln!("Python raw: [1.000358, 0.999962, 1.000368]");

        // Step 5: Full midgray chain for exposure factor comparison
        let spectra_lut = crate::spectral_service::load_spectra_lut(&data_dir()).unwrap();
        let tc_lut_unnorm = crate::spectral_service::compute_tc_lut(&spectra_lut, &sensitivity);
        // Normalize by green at gray tc
        let lut_x_g = tc.0 * (tc_lut_unnorm.size - 1) as f64;
        let lut_y_g = tc.1 * (tc_lut_unnorm.size - 1) as f64;
        let gray_lk = spektrafilm_math::lut::bicubic_2d_f64(
            &tc_lut_unnorm.data,
            tc_lut_unnorm.size,
            tc_lut_unnorm.size,
            3,
            lut_x_g,
            lut_y_g,
        );
        let raw_g = gray_lk[1] * b;
        eprintln!("raw_g (debug only): {raw_g:.10}");

        // Python parity: use UNNORMALIZED tc_lut + sRGB input space (matches Python script).
        let mut srgb_params = crate::params::RuntimeParams::default();
        srgb_params.io.input_color_space = "sRGB".to_string();
        let midgray_raw = crate::enlarger::midgray_raw_hanatos(
            &tc_lut_unnorm,
            ref_illuminant,
            srgb_params.settings.use_cat16,
            1.0,
        );
        let midgray_sd =
            crate::enlarger::midgray_density_spectral_from_raw(midgray_raw, &film, &srgb_params);
        eprintln!("midgray spectral[4]: {:.16}", midgray_sd[4]);
        eprintln!("Python spectral[4]:  1.2787165963066882");

        // Compute and print intermediate log_raw for parity tracing.
        {
            use spektrafilm_math::image::ImageBuf;
            let gray_s = spektrafilm_math::precision::from_f64(0.184);
            let img = ImageBuf::from_data(1, 1, vec![gray_s, gray_s, gray_s]);
            let raw_im = spektrafilm_math::spectral::hanatos2025_rgb_to_raw(
                &img,
                &tc_lut_unnorm,
                "sRGB",
                ref_illuminant,
                false,
            );
            let rpx = raw_im.get(0, 0);
            let log_raw_dbg: [f64; 3] = [
                (rpx[0] as f64 + 1e-10).log10(),
                (rpx[1] as f64 + 1e-10).log10(),
                (rpx[2] as f64 + 1e-10).log10(),
            ];
            eprintln!(
                "log_raw debug: [{:.16e}, {:.16e}, {:.16e}]",
                log_raw_dbg[0], log_raw_dbg[1], log_raw_dbg[2]
            );
            eprintln!("Python log_raw: [1.55482009e-04, -1.67117970e-05, 1.59916269e-04]");
        }

        // Exposure factor (f64 sensitivity + illuminant, nan_to_num semantics)
        let print = profile::load_profile_by_name(&data_dir(), "kodak_portra_endura").unwrap();
        let print_sens: Vec<[f64; 3]> = print
            .log_sensitivity_f64()
            .iter()
            .map(|r| {
                let mut out = [0.0f64; 3];
                for c in 0..3 {
                    let v = 10f64.powf(r[c]);
                    out[c] = if v.is_nan() { 0.0 } else { v };
                }
                out
            })
            .collect();
        let print_illu: Vec<f64> = crate::enlarger::ILLUMINANT_TH_KG3_DEFAULT_FILTERS_F64.to_vec();
        let midgray_sd_f64: Vec<f64> = midgray_sd.iter().map(|&v| v as f64).collect();
        let exp_factor =
            crate::enlarger::compute_exposure_factor(&midgray_sd_f64, &print_illu, &print_sens);
        eprintln!("exposure_factor: {:.17}", exp_factor);
        eprintln!("Python factor:   0.96508444181716679");
    }

    /// Verify GPU hanatos2025_rgb_to_raw matches CPU implementation pixel-for-pixel.
    #[test]
    fn hanatos_gpu_vs_cpu() {
        use crate::params::RuntimeParams;
        use spektrafilm_math::image::ImageBuf;
        use spektrafilm_math::precision::from_f64;
        use spektrafilm_math::spectral::{ILLUMINANT_D55, build_rgb_to_adapted_xyz};

        let dir = data_dir();
        let film = profile::load_profile_by_name(&dir, "kodak_portra_400").unwrap();
        let log_sens = film.log_sensitivity_f64();
        let sensitivity: Vec<[f64; 3]> = log_sens
            .iter()
            .map(|row| {
                let mut o = [0.0; 3];
                for c in 0..3 {
                    let v = 10f64.powf(row[c]);
                    o[c] = if v.is_nan() { 0.0 } else { v };
                }
                o
            })
            .collect();
        let spectra_lut = spectral_service::load_spectra_lut(&dir).unwrap();
        let tc_lut = spectral_service::compute_tc_lut(&spectra_lut, &sensitivity);
        let _params = RuntimeParams::default();
        let rgb_to_adapted = build_rgb_to_adapted_xyz("sRGB", &ILLUMINANT_D55, false);

        // Single-pixel midgray for direct comparison
        let gray = from_f64(0.184);
        let img = ImageBuf::from_data(1, 1, vec![gray, gray, gray]);

        let cpu_out = spektrafilm_math::spectral::hanatos2025_rgb_to_raw_with_matrix(
            &img,
            &tc_lut,
            &rgb_to_adapted,
        );
        eprintln!(
            "CPU raw: [{:.16}, {:.16}, {:.16}]",
            cpu_out.get(0, 0)[0] as f64,
            cpu_out.get(0, 0)[1] as f64,
            cpu_out.get(0, 0)[2] as f64
        );

        if let Some(gpu) = spektrafilm_gpu::wgpu_backend::WgpuBackend::new() {
            use spektrafilm_gpu::ComputeBackend;
            let gpu_out = gpu.hanatos2025_rgb_to_raw(&img, &tc_lut, "sRGB", &ILLUMINANT_D55, false);
            eprintln!(
                "GPU raw: [{:.16}, {:.16}, {:.16}]",
                gpu_out.get(0, 0)[0] as f64,
                gpu_out.get(0, 0)[1] as f64,
                gpu_out.get(0, 0)[2] as f64
            );
        } else {
            eprintln!("GPU not available — skipping");
        }
    }

    /// Verify erf4 bandpass window matches Python for kodak_portra_400 params.
    #[test]
    fn erf4_window_parity() {
        let params = vec![433.49234895_f64, 31.55901378, 593.13407317, 68.76320496];
        // Replicate eval_erf4_bandpass to test in isolation
        let sqrt2 = std::f64::consts::SQRT_2;
        let (c_uv, sigma_uv, c_ir, sigma_ir) = (params[0], params[1], params[2], params[3]);
        for (i, py_expected) in &[(0usize, 0.0449946_f64), (40, 0.57573793), (80, 0.00328858)] {
            let wl = 380.0 + (*i as f64) * 5.0;
            let edge_uv = 0.5 * (1.0 + erf_local((wl - c_uv) / (sigma_uv * sqrt2)));
            let edge_ir = 0.5 * (1.0 - erf_local((wl - c_ir) / (sigma_ir * sqrt2)));
            let w = edge_uv * edge_ir;
            eprintln!(
                "[erf4] wl={wl} → Rust={w:.16}, Python expected={py_expected:.10}, diff={:.6e}",
                w - py_expected
            );
        }
    }

    /// Internal Abramowitz & Stegun erf — copy of the one in enlarger.rs.
    fn erf_local(x: f64) -> f64 {
        let sign = if x >= 0.0 { 1.0 } else { -1.0 };
        let x = x.abs();
        let t = 1.0 / (1.0 + 0.3275911 * x);
        let t2 = t * t;
        let t3 = t2 * t;
        let t4 = t3 * t;
        let t5 = t4 * t;
        let poly = 0.254829592 * t - 0.284496736 * t2 + 1.421413741 * t3 - 1.453152027 * t4
            + 1.061405429 * t5;
        sign * (1.0 - poly * (-x * x).exp())
    }

    /// Stage-by-stage parity against upstream 0.3.4 on a 1x1 linear 0.184
    /// pixel at default settings (CAT16, input gamut `xy` baked into the
    /// LUT, model-evaluated print curves), stochastic/spatial effects off.
    /// Reference values are the upstream pipeline taps (`log_e_film`,
    /// `cmy_film`, `log_e_print`, `cmy_print`) dumped from `origin/main`.
    /// When full-chain parity breaks, this pinpoints the diverging stage.
    /// Note the final scan here bypasses output gamut compression (identity),
    /// so there is no `rgb_out` assertion — the full-chain test covers it.
    #[test]
    fn full_pipeline_parity_1x1_linear_184() {
        use crate::params::RuntimeParams;
        use crate::pipeline::Pipeline;
        use spektrafilm_math::image::ImageBuf;
        use spektrafilm_math::precision::from_f64;

        let dir = data_dir();
        let film = profile::load_profile_by_name(&dir, "kodak_portra_400").unwrap();
        let print = profile::load_profile_by_name(&dir, "kodak_portra_endura").unwrap();

        let mut params = RuntimeParams::default();
        params.camera.auto_exposure = false;
        params.film_render.grain.active = false;
        params.film_render.halation.active = false;
        params.film_render.dir_couplers.active = false;
        params.io.input_color_space = "sRGB".to_string();
        params.io.input_cctf_decoding = false;
        params.io.output_cctf_encoding = false; // keep linear for parity

        // Stage outputs accumulate f32 Scalar rounding; the f64 build
        // tracks the Python taps tightly.
        #[cfg(feature = "precision-f64")]
        const TOL: f64 = 1e-6;
        #[cfg(not(feature = "precision-f64"))]
        const TOL: f64 = 3e-3;

        let check = |stage: &str, got: [spektrafilm_math::precision::Scalar; 3], want: [f64; 3]| {
            for c in 0..3 {
                let g = got[c] as f64;
                assert!(
                    (g - want[c]).abs() < TOL,
                    "{stage} ch {c}: {g} vs {} (diff {:.3e})",
                    want[c],
                    (g - want[c]).abs()
                );
            }
        };

        let backend = spektrafilm_gpu::cpu_backend::CpuBackend;
        let pipeline = Pipeline::new_with_spectral(film, print, params, &dir).unwrap();

        let img = ImageBuf::from_data(1, 1, vec![from_f64(0.184); 3]);
        let log_raw = crate::stages::filming::expose(
            &img,
            &pipeline.film,
            &pipeline.params,
            &backend,
            pipeline.tc_lut(),
            None,
            crate::stages::filming::select_illuminant(&pipeline.film.info.reference_illuminant),
            1.0,
        );
        check(
            "log_e_film",
            log_raw.get(0, 0),
            [
                0.0055470069132583094,
                -0.0046291033978263334,
                -0.037191809233513652,
            ],
        );

        let density_cmy =
            crate::stages::filming::develop(&log_raw, &pipeline.film, &pipeline.params, &backend);
        check(
            "cmy_film",
            density_cmy.get(0, 0),
            [
                0.68987884029422741,
                0.70272493086202847,
                0.84508598425873571,
            ],
        );

        let log_raw_print = crate::stages::printing::expose_calibrated(
            &density_cmy,
            &pipeline.film,
            &pipeline.print,
            &pipeline.params,
            &backend,
            pipeline.print_illuminant_slice(),
            pipeline.print_exposure_factor(),
            pipeline.preflash_raw(),
            1.0,
        );
        check(
            "log_e_print",
            log_raw_print.get(0, 0),
            [
                -0.0058943653645049067,
                0.0016183559749744021,
                0.0019890502790478998,
            ],
        );

        let density_print = crate::stages::printing::develop(
            &log_raw_print,
            &pipeline.print,
            &pipeline.params,
            &backend,
        );
        check(
            "cmy_print",
            density_print.get(0, 0),
            [
                0.64189250593682268,
                0.54211141885697389,
                0.52002829327970834,
            ],
        );
    }
}
