//! Verifies the device-sharing mode RapidRAW uses: create a device with
//! RapidRAW-style limits (adapter hardware limits), inject it into
//! WgpuBackend via `from_device`, and run the resident film chain with
//! per-pixel exposure maps.

use spektrafilm_core::params::RuntimeParams;
use spektrafilm_core::pipeline::{ExposureMaps, Pipeline};
use spektrafilm_core::profile::load_profile;
use spektrafilm_gpu::wgpu_backend::WgpuBackend;
use spektrafilm_math::image::ImageBuf;
use std::path::Path;

#[test]
fn shared_device_render_with_exposure_maps() {
    // Device creation mirrors RapidRAW's GpuContext: hardware-level limits,
    // minimal features.
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::PRIMARY,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let Ok(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: None,
        force_fallback_adapter: false,
    })) else {
        eprintln!("no adapter, skipping");
        return;
    };
    let Ok((device, queue)) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("rapidraw-shared"),
        required_features: wgpu::Features::empty(),
        required_limits: adapter.limits(),
        memory_hints: wgpu::MemoryHints::Performance,
        experimental_features: wgpu::ExperimentalFeatures::disabled(),
        trace: wgpu::Trace::Off,
    })) else {
        eprintln!("device request failed, skipping");
        return;
    };

    let backend = WgpuBackend::from_device(device, queue);

    let data = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data");
    let film = load_profile(&data.join("profiles").join("kodak_gold_200.json")).unwrap();
    let print = load_profile(&data.join("profiles").join("kodak_endura_premier.json")).unwrap();
    let mut params = RuntimeParams::default();
    params.camera.auto_exposure = false;
    params.film_render.grain.active = false;
    params.film_render.halation.active = false;
    params.film_render.dir_couplers.active = false;
    params.io.output_gamut_compress.algorithm = "off".into();

    let mut pipe = Pipeline::new_with_spectral(film, print, params, &data).unwrap();

    let (w, h) = (96u32, 48u32);
    let n = (w * h) as usize;
    let img = ImageBuf::from_data(w, h, vec![0.18f32; n * 3]);

    // Dodge left / burn right at print stage.
    let mut print_ev = vec![0.0f32; n];
    let film_ev = vec![0.0f32; n];
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) as usize;
            print_ev[i] = if x < w / 2 { -1.0 } else { 1.0 };
        }
    }
    pipe.set_exposure_maps(Some(ExposureMaps {
        film_ev,
        print_ev,
        width: w,
        height: h,
    }));

    let out = pipe.process(img, &backend);
    assert_eq!((out.width, out.height), (w, h));

    let mean = |x0: u32, x1: u32| {
        let mut s = 0.0f32;
        let mut c = 0u32;
        for y in 0..h {
            for x in x0..x1 {
                let b = ((y * w + x) * 3) as usize;
                s += out.data[b] + out.data[b + 1] + out.data[b + 2];
                c += 3;
            }
        }
        s / c as f32
    };
    let left = mean(0, w / 2);
    let right = mean(w / 2, w);
    assert!(
        left > right + 0.01,
        "shared-device dodge/burn: left {left} should be brighter than right {right}"
    );
}
