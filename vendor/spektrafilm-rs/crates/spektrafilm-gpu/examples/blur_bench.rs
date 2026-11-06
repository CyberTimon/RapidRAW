// Measure GPU blur overhead: 1 blur vs N blurs (individually vs fused).
//
// Run with:
//   cargo run --release -p spektrafilm-gpu --example blur_bench

use spektrafilm_gpu::ComputeBackend;
use spektrafilm_gpu::wgpu_backend::WgpuBackend;
use spektrafilm_math::image::ImageBuf;
use spektrafilm_math::precision::from_f32;
use std::time::Instant;

fn make_image(w: u32, h: u32) -> ImageBuf {
    let n = (w as usize) * (h as usize) * 3;
    let data: Vec<_> = (0..n).map(|i| from_f32((i as f32) * 0.001 % 1.0)).collect();
    ImageBuf::from_data(w, h, data)
}

fn time<F: FnOnce()>(label: &str, f: F) {
    let t = Instant::now();
    f();
    let dt = t.elapsed();
    println!("{label:30} {:>8.2} ms", dt.as_secs_f64() * 1000.0);
}

fn main() {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .init();
    let backend = WgpuBackend::new().expect("wgpu");
    let img = make_image(3000, 2000); // 6 MP
    // Three sigmas keeps the combined multi-readback under wgpu's 256 MB
    // single-buffer cap (3 × 72 MB = 216 MB).
    let sigmas = [3.0_f32, 6.0, 12.0];

    // Warm up shader cache + driver.
    let _ = backend.gaussian_blur(&img, 3.0);
    let _ = backend.gaussian_blur_multi(&img, &sigmas);

    println!("--- 6 MP, sigmas = {:?} ---", sigmas);

    for sigma in sigmas {
        time(&format!("single blur sigma={sigma:.0}"), || {
            let _ = backend.gaussian_blur(&img, sigma);
        });
    }

    time("3 separate blurs (loop)", || {
        for &s in &sigmas {
            let _ = backend.gaussian_blur(&img, s);
        }
    });

    time("3 fused blurs (multi)", || {
        let _ = backend.gaussian_blur_multi(&img, &sigmas);
    });
}
