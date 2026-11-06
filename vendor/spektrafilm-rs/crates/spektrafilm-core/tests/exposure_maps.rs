//! Fork-extension verification: per-pixel exposure maps.
//!
//! Renders a uniform mid-gray image through the CPU pipeline with
//! (a) no maps, (b) a print exposure map of +1 EV on the right half
//! (burn) / -1 EV on the left half (dodge), and (c) a film exposure
//! map of +1 EV on the right half. Asserts directionality and
//! approximate magnitude of the resulting left/right asymmetry.

use spektrafilm_core::pipeline::{ExposureMaps, Pipeline};
use spektrafilm_core::params::RuntimeParams;
use spektrafilm_core::profile::load_profile;
use spektrafilm_gpu::cpu_backend::CpuBackend;
use spektrafilm_gpu::wgpu_backend::WgpuBackend;
use spektrafilm_gpu::ComputeBackend;
use spektrafilm_math::image::ImageBuf;
use std::path::Path;

fn load_pipeline(data: &Path) -> Pipeline {
    let film = load_profile(&data.join("profiles").join("kodak_portra_400.json")).unwrap();
    let print = load_profile(
        &data
            .join("profiles")
            .join("fujifilm_crystal_archive_typeii.json"),
    )
    .unwrap();
    let mut params = RuntimeParams::default();
    // Deterministic, effects off: we only want to see the exposure maps.
    params.camera.auto_exposure = false;
    params.film_render.grain.active = false;
    params.film_render.halation.active = false;
    params.film_render.dir_couplers.active = false;
    params.film_render.glare.active = false;
    params.print_render.glare.active = false;
    params.io.output_gamut_compress.algorithm = "off".into();
    Pipeline::new_with_spectral(film, print, params, data).unwrap()
}

fn gray_image(w: u32, h: u32, v: f32) -> ImageBuf {
    ImageBuf::from_data(w, h, vec![v; (w * h * 3) as usize])
}

fn mean_region(img: &ImageBuf, x0: u32, x1: u32) -> f32 {
    let mut sum = 0.0f32;
    let mut n = 0u32;
    for y in 0..img.height {
        for x in x0..x1 {
            let base = ((y * img.width + x) * 3) as usize;
            sum += img.data[base] + img.data[base + 1] + img.data[base + 2];
            n += 3;
        }
    }
    sum / n as f32
}

#[test]
fn exposure_maps_dodge_and_burn() {
    let data = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data");
    let mut pipe = load_pipeline(&data);
    let backend = CpuBackend;

    let (w, h) = (64u32, 32u32);
    let input = gray_image(w, h, 0.18);

    // Baseline
    let base = pipe.process(input.clone(), &backend);
    let base_l = mean_region(&base, 0, w / 2);
    let base_r = mean_region(&base, w / 2, w);
    assert!(
        (base_l - base_r).abs() < 1e-4,
        "baseline must be symmetric: {base_l} vs {base_r}"
    );

    // Print exposure map: dodge left (-1 EV => brighter print),
    // burn right (+1 EV => darker print).
    let n = (w * h) as usize;
    let mut print_ev = vec![0.0f32; n];
    let mut film_ev = vec![0.0f32; n];
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) as usize;
            if x < w / 2 {
                print_ev[i] = -1.0;
                film_ev[i] = -1.0;
            } else {
                print_ev[i] = 1.0;
                film_ev[i] = 1.0;
            }
        }
    }
    pipe.set_exposure_maps(Some(ExposureMaps {
        film_ev: vec![0.0; n], // isolate print path first
        print_ev,
        width: w,
        height: h,
    }));
    let out = pipe.process(input.clone(), &backend);
    let l = mean_region(&out, 0, w / 2);
    let r = mean_region(&out, w / 2, w);
    assert!(
        l > base_l + 0.01,
        "dodged (-1 EV print) half should brighten: {l} vs base {base_l}"
    );
    assert!(
        r < base_r - 0.01,
        "burned (+1 EV print) half should darken: {r} vs base {base_r}"
    );

    // Film exposure map (negative -> print inversion): +1 EV on the film
    // => denser negative => less light reaches the paper => LIGHTER print.
    // -1 EV => thin negative => DARKER print.
    pipe.set_exposure_maps(Some(ExposureMaps {
        film_ev,
        print_ev: vec![0.0; n],
        width: w,
        height: h,
    }));
    let out2 = pipe.process(input, &backend);
    let l2 = mean_region(&out2, 0, w / 2);
    let r2 = mean_region(&out2, w / 2, w);
    assert!(
        r2 > base_r + 0.01,
        "+1 EV film exposure should lighten the print (dense negative): {r2} vs base {base_r}"
    );
    assert!(
        l2 < base_l - 0.01,
        "-1 EV film exposure should darken the print (thin negative): {l2} vs base {base_l}"
    );

    // Clearing the maps must restore the baseline.
    pipe.set_exposure_maps(None);
    let base2 = pipe.process(gray_image(w, h, 0.18), &backend);
    let l3 = mean_region(&base2, 0, w / 2);
    assert!((l3 - base_l).abs() < 1e-4, "maps cleared: {l3} vs {base_l}");
}

/// Same dodge/burn semantics through the GPU-resident chain (skipped when
/// no GPU adapter is available, e.g. headless CI).
#[test]
fn exposure_maps_gpu_resident() {
    let Some(gpu) = WgpuBackend::new() else {
        eprintln!("no GPU adapter, skipping");
        return;
    };
    let backend: &dyn ComputeBackend = &gpu;
    let data = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data");
    let mut pipe = load_pipeline(&data);

    let (w, h) = (64u32, 32u32);
    let n = (w * h) as usize;
    let input = gray_image(w, h, 0.18);

    let base = pipe.process(input.clone(), backend);
    let base_l = mean_region(&base, 0, w / 2);
    let base_r = mean_region(&base, w / 2, w);
    assert!((base_l - base_r).abs() < 1e-3, "GPU baseline symmetric: {base_l} vs {base_r}");

    let mut print_ev = vec![0.0f32; n];
    let mut film_ev = vec![0.0f32; n];
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) as usize;
            if x < w / 2 {
                print_ev[i] = -1.0;
                film_ev[i] = -1.0;
            } else {
                print_ev[i] = 1.0;
                film_ev[i] = 1.0;
            }
        }
    }

    // Print map: dodge left brightens, burn right darkens.
    pipe.set_exposure_maps(Some(ExposureMaps {
        film_ev: vec![0.0; n],
        print_ev,
        width: w,
        height: h,
    }));
    let out = pipe.process(input.clone(), backend);
    let l = mean_region(&out, 0, w / 2);
    let r = mean_region(&out, w / 2, w);
    assert!(l > base_l + 0.005, "GPU dodge brightens: {l} vs {base_l}");
    assert!(r < base_r - 0.005, "GPU burn darkens: {r} vs {base_r}");

    // Film map (negative inverts): +1 EV film => lighter print.
    pipe.set_exposure_maps(Some(ExposureMaps {
        film_ev,
        print_ev: vec![0.0; n],
        width: w,
        height: h,
    }));
    let out2 = pipe.process(input, backend);
    let r2 = mean_region(&out2, w / 2, w);
    assert!(r2 > base_r + 0.005, "GPU film +1 EV lightens print: {r2} vs {base_r}");
}
