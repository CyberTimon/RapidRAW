use image::GenericImageView;
fn linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}
fn lab(rgb: [f32; 3]) -> [f32; 3] {
    let [r, g, b] = rgb.map(linear);
    let l = (0.41222146 * r + 0.53633255 * g + 0.051445995 * b).cbrt();
    let m = (0.2119035 * r + 0.6806995 * g + 0.10739696 * b).cbrt();
    let s = (0.08830246 * r + 0.28171885 * g + 0.6299787 * b).cbrt();
    [
        0.21045426 * l + 0.7936178 * m - 0.004072047 * s,
        1.9779985 * l - 2.4285922 * m + 0.4505937 * s,
        0.025904037 * l + 0.78277177 * m - 0.80867577 * s,
    ]
}

fn difference(actual: &DynamicImage, baseline: &DynamicImage) -> Result<image::RgbaImage, String> {
    if actual.dimensions() != baseline.dimensions() {
        return Err("Comparison geometry differs".into());
    }
    let a = actual.to_rgba32f();
    let b = baseline.to_rgba32f();
    Ok(image::RgbaImage::from_fn(a.width(), a.height(), |x, y| {
        let a = a.get_pixel(x, y).0;
        let b = b.get_pixel(x, y).0;
        if a[3] <= 0. || b[3] <= 0. {
            return image::Rgba([0, 0, 0, 0]);
        }
        let aa = [a[0], a[1], a[2]];
        let bb = [b[0], b[1], b[2]];
        let d = lab(aa)
            .iter()
            .zip(lab(bb))
            .map(|(a, b)| (a - b).powi(2))
            .sum::<f32>()
            .sqrt();
        let v = (d / (d + 0.05) * 255.).round() as u8;
        image::Rgba([v, v, v, 255])
    }))
}

use super::*;
#[test]
fn same_length_asset_replacements_invalidate_source_caches() {
    let mut recipe = json!({"fogDepthMap":"abcd", "aiPatches":[{"patchData":{"color":"abcd"}}]});
    let first = source_content_hash(&recipe);
    recipe["fogDepthMap"] = json!("abce");
    assert_ne!(first, source_content_hash(&recipe));
    let second = source_content_hash(&recipe);
    recipe["aiPatches"][0]["patchData"]["color"] = json!("abce");
    assert_ne!(second, source_content_hash(&recipe));
}
#[test]
#[ignore = "same-machine diagnostic latency benchmark"]
fn diagnostic_benchmark() {
    let context = gpu_context();
    println!("adapter: {:?}", context.adapter_info);
    for (width, height) in [(960, 640), (1920, 1280)] {
        let mut gpu =
            crate::gpu_processing::DiagnosticGpu::new(context.clone(), width, height).unwrap();
        let image =
            DynamicImage::ImageRgb32F(image::Rgb32FImage::from_fn(width, height, |x, y| {
                image::Rgb([x as f32 / width as f32, y as f32 / height as f32, 0.25])
            }));
        let recipe = crate::image_processing::default_adjustments();
        let adjustments = crate::image_processing::get_all_adjustments_from_json(
            &recipe,
            false,
            crate::as_shot::AsShot::reference(),
            crate::image_processing::resolve_render_options(&crate::AppSettings::default(), false),
        );
        let mut timings = Vec::new();
        for cycle in 0..12 {
            let started = std::time::Instant::now();
            let frame = gpu
                .render(
                    &image,
                    1,
                    crate::gpu_processing::RenderRequest {
                        adjustments,
                        mask_bitmaps: &[],
                        mask_cache_key: None,
                        lut: None,
                        roi: None,
                    },
                    Some([1, cycle % 8, 0, u32::MAX]),
                    &|| false,
                )
                .unwrap();
            let _map = gpu.compose(&frame, &frame, 3, Some(&frame), None).unwrap();
            let elapsed = started.elapsed().as_secs_f64() * 1000.;
            if cycle == 0 {
                println!("{width}x{height} cold_ms={elapsed:.2}");
            }
            if cycle >= 2 {
                timings.push(elapsed);
            }
        }
        timings.sort_by(f64::total_cmp);
        println!(
            "{width}x{height} warm_median_ms={:.2} warm_p95_ms={:.2}",
            timings[timings.len() / 2],
            timings[timings.len() - 1]
        );
    }
}
#[test]
fn availability_respects_parent_bypass_and_monochrome_state() {
    let mut recipe = crate::image_processing::default_adjustments();
    assert!(
        validate_availability(
            &recipe,
            &Target::MonochromeMix {
                band: "reds".into()
            }
        )
        .is_err()
    );
    for control in [
        "negativeExposure",
        "relightAmbient",
        "fogTemperature",
        "aiDenoiseDetail",
    ] {
        assert!(
            validate_availability(
                &recipe,
                &Target::Parameter {
                    control: control.into()
                }
            )
            .is_err()
        );
    }
    recipe["monochromeEnabled"] = json!(true);
    assert!(
        validate_availability(
            &recipe,
            &Target::MonochromeMix {
                band: "reds".into()
            }
        )
        .is_ok()
    );
}
#[test]
fn preparation_cancellation_leaves_private_caches_empty() {
    let stages = Stages::default();
    let loaded = LoadedImage {
        path: "synthetic.png".into(),
        image: Arc::new(DynamicImage::ImageRgb32F(image::Rgb32FImage::new(33, 17))),
        is_raw: false,
        as_shot: crate::as_shot::AsShot::reference(),
    };
    assert!(
        stages
            .prepare(
                &loaded,
                &crate::image_processing::default_adjustments(),
                960,
                &|| true
            )
            .is_err()
    );
    assert!(stages.patched.lock().unwrap().is_none());
    assert!(stages.working.lock().unwrap().is_none());
    assert!(stages.warped.lock().unwrap().is_none());
    assert!(stages.effects.lock().unwrap().is_none());
}
#[test]
fn gpu_metric_matches_cpu_oracle_including_colour_and_alpha() {
    let mut gpu = crate::gpu_processing::DiagnosticGpu::new(gpu_context(), 33, 17).unwrap();
    let a = image::Rgba32FImage::from_fn(33, 17, |x, y| {
        image::Rgba([
            x as f32 / 32.,
            y as f32 / 16.,
            0.25,
            if x == 0 { 0. } else { 1. },
        ])
    });
    let b = image::Rgba32FImage::from_fn(33, 17, |x, y| {
        image::Rgba([y as f32 / 16., x as f32 / 32., 0.5, 1.])
    });
    let aa = gpu.upload_frame(&a);
    let bb = gpu.upload_frame(&b);
    {
        let actual = gpu.compose(&aa, &bb, 0, None, None).unwrap();
        let expected = difference(
            &DynamicImage::ImageRgba32F(a.clone()),
            &DynamicImage::ImageRgba32F(b.clone()),
        )
        .unwrap();
        let mut max_error = 0;
        for (a, b) in actual.pixels().zip(expected.pixels()) {
            assert_eq!(a[3], b[3]);
            if a[3] > 0 {
                for c in 0..3 {
                    max_error = max_error.max(a[c].abs_diff(b[c]));
                }
            }
        }
        assert!(max_error <= 2, "GPU metric byte error {max_error}");
    }
}
fn data_url(image: DynamicImage) -> String {
    use base64::Engine;
    let mut data = std::io::Cursor::new(Vec::new());
    image.write_to(&mut data, image::ImageFormat::Png).unwrap();
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(data.into_inner())
    )
}
#[test]
fn mask_operations_keep_engine_order_and_byte_rounding() {
    let definition = json!({"id":"m","name":"test","visible":true,"invert":true,"opacity":50,"adjustments":{},"subMasks":[
        {"id":"a","type":"all","visible":true,"invert":false,"opacity":60,"mode":"additive","parameters":{}},
        {"id":"b","type":"all","visible":true,"invert":false,"opacity":20,"mode":"subtractive","parameters":{}},
        {"id":"c","type":"all","visible":true,"invert":false,"opacity":30,"mode":"intersect","parameters":{}}
    ]});
    let definition = serde_json::from_value(definition).unwrap();
    let bitmap =
        crate::mask_generation::generate_mask_bitmap(&definition, 13, 9, 1., (0., 0.), None)
            .unwrap();
    assert!(bitmap.pixels().all(|p| p[0] == 89));
}
#[test]
fn relight_reach_is_defined_at_zero_intensity() {
    let image =
        DynamicImage::ImageRgb32F(image::Rgb32FImage::from_pixel(32, 24, image::Rgb([0.2; 3])));
    let mut recipe = crate::image_processing::default_adjustments();
    recipe["relightEnabled"] = json!(true);
    recipe["relightNormalMap"] = json!(data_url(DynamicImage::ImageRgba8(
        image::RgbaImage::from_pixel(16, 12, image::Rgba([128, 128, 255, 128]))
    )));
    recipe["relightLights"] = json!([{"id":"l","type":"directional","intensity":0,"angle":0,"elevation":90,"color":"#ffffff"}]);
    let reach = crate::relight::diagnose_relight(&image, &recipe, 0).to_rgb32f();
    assert!(reach.pixels().any(|p| p[0] > 0.));
}
#[test]
fn fog_coverage_survives_zero_strength() {
    let image =
        DynamicImage::ImageRgb32F(image::Rgb32FImage::from_pixel(32, 24, image::Rgb([0.2; 3])));
    let depth = data_url(DynamicImage::ImageLuma8(GrayImage::from_fn(
        16,
        12,
        |x, _| image::Luma([if x < 8 { 0 } else { 128 }]),
    )));
    let mut recipe = crate::image_processing::default_adjustments();
    recipe["fogEnabled"] = json!(true);
    recipe["fogDepthMap"] = json!(depth);
    recipe["fogAmount"] = json!(0);
    let map = crate::fog::diagnose_fog(&image, &recipe).to_rgb32f();
    assert!(map.pixels().any(|p| p[0] > 0.));
    assert_eq!(
        crate::fog::apply_fog(std::borrow::Cow::Borrowed(&image), &recipe)
            .as_ref()
            .as_bytes(),
        image.as_bytes()
    );
}
fn gpu_context() -> crate::image_processing::GpuContext {
    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = pollster::block_on(instance.request_adapter(&Default::default()))
        .expect("GPU tests require an adapter");
    let limits = adapter.limits();
    let adapter_info = adapter.get_info();
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        required_limits: limits.clone(),
        ..Default::default()
    }))
    .unwrap();
    crate::image_processing::GpuContext {
        instance,
        adapter,
        device: Arc::new(device),
        queue: Arc::new(queue),
        limits,
        adapter_info,
        display: Arc::new(Mutex::new(None)),
        viewer_display: Arc::new(Mutex::new(None)),
        pipelines: Arc::new(std::sync::OnceLock::new()),
    }
}
#[test]
fn gpu_difference_and_zero_strength_selection() {
    let context = gpu_context();
    let mut gpu = crate::gpu_processing::DiagnosticGpu::new(context, 33, 17).unwrap();
    let image = DynamicImage::ImageRgb32F(image::Rgb32FImage::from_fn(33, 17, |x, _| {
        if x < 16 {
            image::Rgb([0.8, 0.1, 0.1])
        } else {
            image::Rgb([0.3; 3])
        }
    }));
    let recipe = crate::image_processing::default_adjustments();
    let options =
        crate::image_processing::resolve_render_options(&crate::AppSettings::default(), false);
    let adjustments = crate::image_processing::get_all_adjustments_from_json(
        &recipe,
        false,
        crate::as_shot::AsShot::reference(),
        options,
    );
    let request = || crate::gpu_processing::RenderRequest {
        adjustments,
        mask_bitmaps: &[],
        mask_cache_key: None,
        lut: None,
        roi: None,
    };
    let a = gpu.render(&image, 1, request(), None, &|| false).unwrap();
    let b = gpu.render(&image, 1, request(), None, &|| false).unwrap();
    assert!(
        gpu.compose(&a, &b, 0, None, None)
            .unwrap()
            .pixels()
            .all(|p| p.0[..3] == [0, 0, 0])
    );
    let selected = gpu
        .render(&image, 1, request(), Some([1, 0, 0, u32::MAX]), &|| false)
        .unwrap();
    let map = gpu
        .compose(&selected, &selected, 3, Some(&selected), None)
        .unwrap();
    assert!(
        map.get_pixel(8, 8)[0] > 100,
        "Red selection missing at zero HSL values"
    );
    assert_eq!(map.get_pixel(24, 8)[0], 0, "Grey must not be hue-selected");
    let cue = gpu.compose(&a, &b, 2, Some(&selected), None).unwrap();
    assert!(
        cue.get_pixel(8, 8)[0] > 0,
        "Neutral must retain normal selected-colour visibility"
    );
    assert_eq!(cue.get_pixel(24, 8).0[..3], [0, 0, 0]);
    let mut changed = adjustments;
    changed.global.exposure = 1.;
    let c = gpu
        .render(
            &image,
            1,
            crate::gpu_processing::RenderRequest {
                adjustments: changed,
                ..request()
            },
            None,
            &|| false,
        )
        .unwrap();
    assert!(
        gpu.compose(&c, &a, 0, None, None)
            .unwrap()
            .pixels()
            .any(|p| p[0] > 0)
    );
    assert!(gpu.render(&image, 1, request(), None, &|| true).is_err());
}
fn fixture_frame(
    gpu: &mut crate::gpu_processing::DiagnosticGpu,
    image: &DynamicImage,
    recipe: &Value,
    probe: Option<[u32; 4]>,
) -> crate::gpu_processing::DiagnosticFrame {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    image.as_bytes().hash(&mut h);
    let adjustments = crate::image_processing::get_all_adjustments_from_json(
        recipe,
        false,
        crate::as_shot::AsShot::reference(),
        Default::default(),
    );
    gpu.render(
        image,
        h.finish(),
        crate::gpu_processing::RenderRequest {
            adjustments,
            mask_bitmaps: &[],
            mask_cache_key: None,
            lut: None,
            roi: None,
        },
        probe,
        &|| false,
    )
    .unwrap()
}
#[test]
fn isolated_hsl_luminance_and_saturation_follow_direction_through_zero() {
    let mut gpu = crate::gpu_processing::DiagnosticGpu::new(gpu_context(), 33, 17).unwrap();
    let image = DynamicImage::ImageRgb32F(image::Rgb32FImage::from_fn(33, 17, |x, _| {
        image::Rgb(if x < 16 {
            [0.08, 0.35, 0.08]
        } else {
            [0.25; 3]
        })
    }));
    let recipe = crate::image_processing::default_adjustments();
    for component in ["luminance", "saturation"] {
        let support = fixture_frame(
            &mut gpu,
            &image,
            &recipe,
            Some([1, 3, if component == "luminance" { 2 } else { 0 }, u32::MAX]),
        );
        let mut values = Vec::new();
        for value in [-50, 0, 50] {
            let mut edited = recipe.clone();
            edited["hsl"]["greens"][component] = json!(value);
            let actual = fixture_frame(&mut gpu, &image, &edited, None);
            let map = gpu
                .compose(&actual, &actual, 2, Some(&support), None)
                .unwrap();
            let p = map.get_pixel(8, 8);
            assert!(p[1] > 0, "Selection must not vanish at neutral");
            assert_eq!(
                map.get_pixel(24, 8).0[..3],
                [0, 0, 0],
                "Unselected greys must remain black"
            );
            values.push(if component == "luminance" {
                p[0] as f32 + p[1] as f32 + p[2] as f32
            } else {
                (p[1] as f32 - p[0] as f32) / p[1].max(1) as f32
            });
        }
        assert!(
            values[0] < values[1] && values[1] < values[2],
            "{component}: {values:?}"
        );
    }
    let support = fixture_frame(&mut gpu, &image, &recipe, Some([1, 3, 0, u32::MAX]));
    let mut edited = recipe.clone();
    edited["hsl"]["greens"]["hue"] = json!(60);
    let actual = fixture_frame(&mut gpu, &image, &edited, None);
    let map = gpu
        .compose(&actual, &actual, 2, Some(&support), None)
        .unwrap();
    let p = map.get_pixel(8, 8);
    assert!(
        p[2] > p[0] * 2,
        "Edited greens must shift towards blue/cyan: {p:?}"
    );
}
#[test]
fn isolated_tonal_sliders_darken_and_lighten_with_fixed_response_coverage() {
    let mut gpu = crate::gpu_processing::DiagnosticGpu::new(gpu_context(), 33, 17).unwrap();
    for (control, input) in [
        ("blacks", 0.04),
        ("shadows", 0.1),
        ("highlights", 0.5),
        ("whites", 0.7),
    ] {
        let image = DynamicImage::ImageRgb32F(image::Rgb32FImage::from_pixel(
            33,
            17,
            image::Rgb([input; 3]),
        ));
        let recipe = crate::image_processing::default_adjustments();
        let mut low = recipe.clone();
        low[control] = json!(-50);
        let mut high = recipe.clone();
        high[control] = json!(50);
        let before = fixture_frame(&mut gpu, &image, &low, None);
        let after = fixture_frame(&mut gpu, &image, &high, None);
        let mut values = Vec::new();
        for value in [-50, 0, 50] {
            let mut edited = recipe.clone();
            edited[control] = json!(value);
            let actual = fixture_frame(&mut gpu, &image, &edited, None);
            let map = gpu
                .compose(&actual, &actual, 1, Some(&after), Some(&before))
                .unwrap();
            let p = map.get_pixel(8, 8);
            assert_eq!(p[0], p[1]);
            assert_eq!(p[1], p[2]);
            values.push(p[0]);
        }
        assert!(
            values[0] < values[1] && values[1] < values[2],
            "{control}: {values:?}"
        );
    }
}
#[test]
fn isolated_coverage_preserves_soft_masks_and_parametric_colour() {
    let mut gpu = crate::gpu_processing::DiagnosticGpu::new(gpu_context(), 33, 17).unwrap();
    let support = gpu.upload_frame(&image::Rgba32FImage::from_fn(33, 17, |x, _| {
        image::Rgba(
            [if x < 8 {
                0.0
            } else if x < 16 {
                0.25
            } else {
                1.0
            }; 4],
        )
    }));
    let actual = gpu.upload_frame(&image::Rgba32FImage::from_pixel(
        33,
        17,
        image::Rgba([0.8, 0.2, 0.1, 1.0]),
    ));
    let map = gpu
        .compose(&actual, &actual, 2, Some(&support), None)
        .unwrap();
    assert_eq!(map.get_pixel(3, 8).0, [0, 0, 0, 255]);
    assert!(map.get_pixel(10, 8)[0] < map.get_pixel(24, 8)[0]);
    assert!(map.get_pixel(10, 8)[0] > map.get_pixel(10, 8)[1]);
    let coverage = gpu
        .compose(&actual, &actual, 3, Some(&support), None)
        .unwrap();
    assert_eq!(coverage.get_pixel(3, 8)[0], 0);
    assert!((coverage.get_pixel(10, 8)[0] as i32 - 64).abs() <= 1);
    assert_eq!(coverage.get_pixel(24, 8)[0], 255);
}
#[test]
fn monochrome_mix_and_grading_luminance_follow_rendered_direction() {
    let mut gpu = crate::gpu_processing::DiagnosticGpu::new(gpu_context(), 33, 17).unwrap();
    for mono in [false, true] {
        let image = DynamicImage::ImageRgb32F(image::Rgb32FImage::from_pixel(
            33,
            17,
            image::Rgb(if mono { [0.4, 0.05, 0.05] } else { [0.1; 3] }),
        ));
        let mut recipe = crate::image_processing::default_adjustments();
        recipe["monochromeEnabled"] = json!(mono);
        let support = fixture_frame(
            &mut gpu,
            &image,
            &recipe,
            Some(if mono {
                [1, 0, 2, u32::MAX]
            } else {
                [2, 0, 0, u32::MAX]
            }),
        );
        let mut values = Vec::new();
        for value in [-30, 0, 30] {
            let mut edited = recipe.clone();
            if mono {
                edited["monochromeMix"]["reds"] = json!(value);
            } else {
                edited["colorGrading"]["shadows"]["luminance"] = json!(value);
            }
            let actual = fixture_frame(&mut gpu, &image, &edited, None);
            let map = gpu
                .compose(
                    &actual,
                    &actual,
                    if mono { 1 } else { 2 },
                    Some(&support),
                    None,
                )
                .unwrap();
            values.push(map.get_pixel(8, 8)[0]);
        }
        assert!(
            values[0] < values[1] && values[1] < values[2],
            "mono={mono}: {values:?}"
        );
    }
}
#[test]
fn vignette_amount_tracks_tone_and_shape_coverage_survives_zero_amount() {
    let mut gpu = crate::gpu_processing::DiagnosticGpu::new(gpu_context(), 33, 17).unwrap();
    let image =
        DynamicImage::ImageRgb32F(image::Rgb32FImage::from_pixel(33, 17, image::Rgb([0.3; 3])));
    let recipe = crate::image_processing::default_adjustments();
    let support = fixture_frame(&mut gpu, &image, &recipe, Some([3, 0, 0, u32::MAX]));
    let mut values = Vec::new();
    for value in [-60, 0, 60] {
        let mut edited = recipe.clone();
        edited["vignetteAmount"] = json!(value);
        let actual = fixture_frame(&mut gpu, &image, &edited, None);
        values.push(
            gpu.compose(&actual, &actual, 1, Some(&support), None)
                .unwrap()
                .get_pixel(0, 0)[0],
        );
    }
    assert!(values[0] < values[1] && values[1] < values[2], "{values:?}");
    let mut coverages = Vec::new();
    for midpoint in [20, 80] {
        let mut edited = recipe.clone();
        edited["vignetteMidpoint"] = json!(midpoint);
        edited["vignetteFeather"] = json!(0);
        let support = fixture_frame(&mut gpu, &image, &edited, Some([3, 0, 0, u32::MAX]));
        let map = gpu
            .compose(&support, &support, 3, Some(&support), None)
            .unwrap();
        assert!(map.pixels().all(|p| p[0] == 0 || p[0] == 255));
        coverages.push(map.get_pixel(0, 0)[0]);
    }
    assert_ne!(coverages[0], coverages[1]);
}
fn request_fixture(target: Target, control: &str, presentation: u32) -> InfluenceRequest {
    serde_json::from_value(json!({"imagePath":"fixture.png","loadedImageGeneration":1,"clientGeneration":1,"identity":{},"target":target,"targetResolution":960,"jsAdjustments":{},"selectedControl":control,"presentation":presentation})).unwrap()
}
#[test]
fn isolated_references_preserve_siblings_and_have_stable_coverage_keys() {
    let mut recipe = crate::image_processing::default_adjustments();
    recipe["hsl"]["greens"]["saturation"] = json!(25);
    let request = request_fixture(
        Target::Hsl {
            band: "greens".into(),
            component: "luminance".into(),
            scope: Scope::Global,
        },
        "hsl.luminance",
        2,
    );
    let mut keys = Vec::new();
    for value in [-50, 0, 50] {
        recipe["hsl"]["greens"]["luminance"] = json!(value);
        let baseline =
            baseline_recipe(&recipe, &request, crate::as_shot::AsShot::reference()).unwrap();
        assert_eq!(baseline["hsl"]["greens"]["saturation"], json!(25));
        assert_eq!(baseline["hsl"]["greens"]["luminance"], json!(0));
        keys.push(coverage_cache_key(&baseline, &request).unwrap());
    }
    assert!(keys.iter().all(|k| *k == keys[0]));
    recipe["hsl"]["greens"]["saturation"] = json!(30);
    let baseline = baseline_recipe(&recipe, &request, crate::as_shot::AsShot::reference()).unwrap();
    assert_ne!(coverage_cache_key(&baseline, &request).unwrap(), keys[0]);
    let mut request = request_fixture(
        Target::Parametric {
            channel: "luma".into(),
            parameter: "shadows".into(),
            scope: Scope::Global,
        },
        "parametric.shadows",
        1,
    );
    request.baseline_curve = Some(json!([{"x":0,"y":0},{"x":255,"y":255}]));
    request.coverage_curve = Some(json!([{"x":0,"y":0},{"x":128,"y":140},{"x":255,"y":255}]));
    let mut keys = Vec::new();
    for value in [-50, 0, 50] {
        recipe["parametricCurve"]["luma"]["shadows"] = json!(value);
        recipe["curves"]["luma"] = json!([{"x":0,"y":0},{"x":128,"y":128+value},{"x":255,"y":255}]);
        let baseline =
            baseline_recipe(&recipe, &request, crate::as_shot::AsShot::reference()).unwrap();
        keys.push(coverage_cache_key(&baseline, &request).unwrap());
    }
    assert!(keys.iter().all(|k| *k == keys[0]));
    assert!(validate_curve(&json!([{"x":20,"y":0},{"x":10,"y":255}])).is_err());
}
#[test]
fn masked_tonal_coverage_is_the_global_response_intersected_once_with_the_mask() {
    let mut gpu = crate::gpu_processing::DiagnosticGpu::new(gpu_context(), 33, 17).unwrap();
    let image = DynamicImage::ImageRgb32F(image::Rgb32FImage::from_fn(33, 17, |x, _| {
        image::Rgb([if x < 8 { 0.001 } else { 0.5 }; 3])
    }));
    let defaults = crate::image_processing::default_adjustments();
    let mut recipe = defaults.clone();
    recipe["masks"] = json!([{"id":"face","name":"face","visible":true,"invert":false,"opacity":100,"adjustments":defaults,"subMasks":[{"id":"s","type":"all","visible":true,"opacity":100,"mode":"additive","parameters":{}}]}]);
    let mask = GrayImage::from_fn(33, 17, |x, _| {
        image::Luma([if x < 16 {
            255
        } else if x < 24 {
            128
        } else {
            0
        }])
    });
    let filter = gpu.upload_frame(&DynamicImage::ImageLuma8(mask.clone()).to_rgba32f());
    let mut frame = |recipe: &Value, probe: Option<[u32; 4]>| {
        let adjustments = crate::image_processing::get_all_adjustments_from_json(
            recipe,
            false,
            crate::as_shot::AsShot::reference(),
            Default::default(),
        );
        gpu.render(
            &image,
            1,
            crate::gpu_processing::RenderRequest {
                adjustments,
                mask_bitmaps: std::slice::from_ref(&mask),
                mask_cache_key: None,
                lut: None,
                roi: None,
            },
            probe,
            &|| false,
        )
        .unwrap()
    };
    let actual = frame(&recipe, None);
    for control in ["highlights", "shadows", "whites", "blacks"] {
        let global = Target::Scalar {
            control: control.into(),
            scope: Scope::Global,
        };
        let local = Target::Scalar {
            control: control.into(),
            scope: Scope::Mask {
                container_id: "face".into(),
            },
        };
        let (global_low, global_high) = fixed_response_recipes(&recipe, &global, None).unwrap();
        let (local_low, local_high) = fixed_response_recipes(&recipe, &local, None).unwrap();
        let mut frame = |recipe: &Value, probe: Option<[u32; 4]>| {
            let adjustments = crate::image_processing::get_all_adjustments_from_json(
                recipe,
                false,
                crate::as_shot::AsShot::reference(),
                Default::default(),
            );
            gpu.render(
                &image,
                1,
                crate::gpu_processing::RenderRequest {
                    adjustments,
                    mask_bitmaps: std::slice::from_ref(&mask),
                    mask_cache_key: None,
                    lut: None,
                    roi: None,
                },
                probe,
                &|| false,
            )
            .unwrap()
        };
        let before = frame(&global_low, None);
        let after = frame(&global_high, None);
        let probe = response_probe(&local, &recipe).unwrap();
        let local_before = frame(&local_low, probe);
        let local_after = frame(&local_high, probe);
        let full = gpu
            .compose(&actual, &actual, 1, Some(&after), Some(&before))
            .unwrap();
        let local_map = gpu
            .compose_filtered(
                &actual,
                &actual,
                1,
                Some(&local_after),
                Some(&local_before),
                Some(&filter),
            )
            .unwrap();
        assert_eq!(
            local_map.get_pixel(28, 8).0,
            [0, 0, 0, 255],
            "{control}: outside the face"
        );
        assert!(
            local_map.get_pixel(12, 8)[0].abs_diff(full.get_pixel(12, 8)[0]) <= 2,
            "{control}: hard-mask response differs from global"
        );
        let expected = linear(full.get_pixel(20, 8)[0] as f32 / 255.) * 128. / 255.;
        let observed = linear(local_map.get_pixel(20, 8)[0] as f32 / 255.);
        assert!(
            (expected - observed).abs() < 0.006,
            "{control}: soft mask applied more than once: {observed}/{expected}"
        );
        if control == "highlights" {
            assert_eq!(
                local_map.get_pixel(4, 8)[0],
                0,
                "A masked shadow is not a highlight"
            );
            assert!(local_map.get_pixel(12, 8)[0] > 0);
        }
    }
}
#[test]
fn masked_curve_response_uses_the_same_probe_and_single_mask_filter() {
    let mut gpu = crate::gpu_processing::DiagnosticGpu::new(gpu_context(), 33, 17).unwrap();
    let image =
        DynamicImage::ImageRgb32F(image::Rgb32FImage::from_pixel(33, 17, image::Rgb([0.2; 3])));
    let defaults = crate::image_processing::default_adjustments();
    let mut recipe = defaults.clone();
    recipe["masks"] = json!([{"id":"face","name":"face","visible":true,"invert":false,"opacity":100,"adjustments":defaults,"subMasks":[{"id":"s","type":"all","visible":true,"opacity":100,"mode":"additive","parameters":{}}]}]);
    let mask = GrayImage::from_fn(33, 17, |x, _| {
        image::Luma([if x < 8 {
            255
        } else if x < 16 {
            128
        } else {
            0
        }])
    });
    let filter = gpu.upload_frame(&DynamicImage::ImageLuma8(mask.clone()).to_rgba32f());
    let local = Target::CurvePoint {
        channel: "luma".into(),
        index: 1,
        scope: Scope::Mask {
            container_id: "face".into(),
        },
    };
    let global = Target::CurvePoint {
        channel: "luma".into(),
        index: 1,
        scope: Scope::Global,
    };
    let curve = json!([{"x":0,"y":0},{"x":128,"y":170},{"x":255,"y":255}]);
    let (global_low, global_high) = fixed_response_recipes(&recipe, &global, Some(&curve)).unwrap();
    let (local_low, local_high) = fixed_response_recipes(&recipe, &local, Some(&curve)).unwrap();
    let mut frame = |recipe: &Value, probe: Option<[u32; 4]>| {
        let adjustments = crate::image_processing::get_all_adjustments_from_json(
            recipe,
            false,
            crate::as_shot::AsShot::reference(),
            Default::default(),
        );
        gpu.render(
            &image,
            1,
            crate::gpu_processing::RenderRequest {
                adjustments,
                mask_bitmaps: std::slice::from_ref(&mask),
                mask_cache_key: None,
                lut: None,
                roi: None,
            },
            probe,
            &|| false,
        )
        .unwrap()
    };
    let actual = frame(&recipe, None);
    let a = frame(&global_low, None);
    let b = frame(&global_high, None);
    let probe = response_probe(&local, &recipe).unwrap();
    let c = frame(&local_low, probe);
    let d = frame(&local_high, probe);
    let full = gpu
        .compose(&actual, &actual, 1, Some(&b), Some(&a))
        .unwrap();
    let local_map = gpu
        .compose_filtered(&actual, &actual, 1, Some(&d), Some(&c), Some(&filter))
        .unwrap();
    assert!(full.get_pixel(4, 8)[0] > 0);
    assert!(full.get_pixel(4, 8)[0].abs_diff(local_map.get_pixel(4, 8)[0]) <= 2);
    assert_eq!(local_map.get_pixel(24, 8).0, [0, 0, 0, 255]);
    assert!(
        (linear(local_map.get_pixel(12, 8)[0] as f32 / 255.)
            - linear(full.get_pixel(12, 8)[0] as f32 / 255.) * 128. / 255.)
            .abs()
            < 0.006
    );
}
#[test]
fn spatial_control_baselines_keep_the_effect_and_sibling_settings() {
    let defaults = crate::image_processing::default_adjustment_values().unwrap();
    for effect in ["fog", "lensBlur", "vignette"] {
        for (control, default) in defaults
            .iter()
            .filter(|(key, value)| key.starts_with(effect) && value.is_number())
        {
            // Exercise only controls with a diagnostic baseline override.
            if [
                "lensBlurMaxDepth",
                "lensBlurMaxFade",
                "lensBlurMinDepth",
                "lensBlurMinFade",
                "vignetteCenterX",
                "vignetteCenterY",
            ]
            .contains(&control.as_str())
            {
                continue;
            }
            let mut recipe = json!({"fogEnabled":true,"lensBlurEnabled":true,"fogDepthMap":"stored-map","fogAmount":77,"lensBlurAmount":62,"vignetteAmount":-40});
            recipe[control] = json!(83);
            let request = request_fixture(
                Target::Effect {
                    effect: effect.into(),
                },
                control,
                1,
            );
            let baseline =
                baseline_recipe(&recipe, &request, crate::as_shot::AsShot::reference()).unwrap();
            let mut expected = recipe.clone();
            expected[control] = if ["fogAmount", "lensBlurAmount"].contains(&control.as_str()) {
                json!(0)
            } else {
                default.clone()
            };
            assert_eq!(baseline, expected, "{control}");
        }
    }
}
#[test]
fn fog_amount_has_a_stable_nonempty_selection_and_changes_the_isolated_tone() {
    let mut gpu = crate::gpu_processing::DiagnosticGpu::new(gpu_context(), 33, 17).unwrap();
    let loaded = LoadedImage {
        path: "generated-fog.png".into(),
        image: Arc::new(DynamicImage::ImageRgb32F(image::Rgb32FImage::from_fn(
            33,
            17,
            |x, _| image::Rgb([if x < 20 { 0.04 } else { 0.6 }; 3]),
        ))),
        is_raw: false,
        as_shot: crate::as_shot::AsShot::reference(),
    };
    let stages = Stages::default();
    let mut recipe = crate::image_processing::default_adjustments();
    recipe["fogEnabled"] = json!(true);
    recipe["fogDepthMap"] = json!(data_url(DynamicImage::ImageLuma8(GrayImage::from_fn(
        33,
        17,
        |x, _| image::Luma([(x * 255 / 32) as u8])
    ))));
    let request = request_fixture(
        Target::Effect {
            effect: "fog".into(),
        },
        "fogAmount",
        1,
    );
    let baseline = baseline_recipe(&recipe, &request, loaded.as_shot).unwrap();
    assert_eq!(baseline["fogEnabled"], json!(true));
    assert_eq!(baseline["fogAmount"], json!(0));
    let mut potential = baseline.clone();
    potential["fogAmount"] = json!(100);
    let map = spatial_map(
        &loaded,
        &potential,
        &Target::Effect {
            effect: "fog".into(),
        },
        960,
        &stages,
        &|| false,
    )
    .unwrap();
    let support = gpu.upload_frame(&DynamicImage::ImageRgba8(map).to_rgba32f());
    let mut values = Vec::new();
    for amount in [0, 30, 70] {
        recipe["fogAmount"] = json!(amount);
        let (input, _, _) = stages.prepare(&loaded, &recipe, 960, &|| false).unwrap();
        let actual = fixture_frame(&mut gpu, &input, &recipe, None);
        let map = gpu
            .compose(&actual, &actual, 1, Some(&support), None)
            .unwrap();
        values.push(map.get_pixel(4, 8)[0]);
    }
    assert!(
        values[0] > 0 && values[0] < values[1] && values[1] < values[2],
        "Fog amount: {values:?}"
    );
}
#[test]
fn point_curve_references_preserve_siblings_and_relight_parameters_are_available() {
    let mut recipe = crate::image_processing::default_adjustments();
    recipe["curves"]["red"] = json!([{"x":0,"y":0},{"x":128,"y":180},{"x":255,"y":255}]);
    let mut request = request_fixture(
        Target::CurvePoint {
            channel: "red".into(),
            index: 1,
            scope: Scope::Global,
        },
        "curvePoint.red.1",
        2,
    );
    request.baseline_curve = Some(json!([{"x":0,"y":0},{"x":128,"y":128},{"x":255,"y":255}]));
    let baseline = baseline_recipe(&recipe, &request, crate::as_shot::AsShot::reference()).unwrap();
    assert_eq!(baseline["curves"]["green"], recipe["curves"]["green"]);
    assert_eq!(baseline["curves"]["red"][1]["y"], json!(128));
    recipe["relightEnabled"] = json!(true);
    for control in RELIGHT_PARAMETERS {
        assert!(
            validate_availability(
                &recipe,
                &Target::Parameter {
                    control: (*control).into()
                }
            )
            .is_ok()
        );
        assert!(
            neutralize(
                &recipe,
                &Target::Parameter {
                    control: (*control).into()
                },
                crate::as_shot::AsShot::reference(),
                None
            )
            .is_ok()
        );
    }
}
#[test]
fn stage_probes_follow_prior_mask_grading() {
    let mut gpu = crate::gpu_processing::DiagnosticGpu::new(gpu_context(), 33, 17).unwrap();
    let image =
        DynamicImage::ImageRgb32F(image::Rgb32FImage::from_pixel(33, 17, image::Rgb([0.2; 3])));
    let defaults: Value =
        serde_json::from_str(include_str!("../../../src/utils/defaultAdjustments.json")).unwrap();
    let mut recipe = defaults.clone();
    recipe["masks"]=json!((0..2).map(|i|json!({"id":format!("m{i}"),"name":"fixture","invert":false,"visible":true,"opacity":100,"adjustments":defaults,"subMasks":[{"id":format!("s{i}"),"type":"all","invert":false,"visible":true,"opacity":100,"mode":"additive","parameters":{}}]})).collect::<Vec<_>>());
    let masks = vec![GrayImage::from_pixel(33, 17, image::Luma([255])); 2];
    let mut results = Vec::new();
    for luminance in [0, 100] {
        recipe["masks"][0]["adjustments"]["colorGrading"]["global"]["luminance"] = json!(luminance);
        let adjustments = crate::image_processing::get_all_adjustments_from_json(
            &recipe,
            false,
            crate::as_shot::AsShot::reference(),
            Default::default(),
        );
        let frame = gpu
            .render(
                &image,
                1,
                crate::gpu_processing::RenderRequest {
                    adjustments,
                    mask_bitmaps: &masks,
                    mask_cache_key: None,
                    lut: None,
                    roi: None,
                },
                Some([2, 0, 0, 1]),
                &|| false,
            )
            .unwrap();
        results.push(
            gpu.compose(&frame, &frame, 3, Some(&frame), None)
                .unwrap()
                .get_pixel(16, 8)[0],
        );
    }
    assert!(results[0] > 200, "initial shadows selection: {:?}", results);
    assert!(
        results[1] < 10,
        "later mask must see earlier grading: {:?}",
        results
    );
}
#[test]
fn neutralization_preserves_siblings_masks_and_baseline_exposure() {
    let mut recipe = crate::image_processing::default_adjustments();
    recipe["exposure"] = json!(2);
    recipe["contrast"] = json!(30);
    let target = Target::Scalar {
        control: "exposure".into(),
        scope: Scope::Global,
    };
    let baseline = neutralize(&recipe, &target, crate::as_shot::AsShot::reference(), None).unwrap();
    assert_eq!(baseline["exposure"], json!(0));
    assert_eq!(baseline["contrast"], recipe["contrast"]);
    assert_eq!(baseline["baselineExposure"], recipe["baselineExposure"]);
    assert_eq!(baseline["masks"], recipe["masks"]);
}
#[test]
fn diagnostic_shaders_validate_on_adapter() {
    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = pollster::block_on(instance.request_adapter(&Default::default()))
        .expect("GPU validation requires an adapter");
    let (device, _) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        required_limits: adapter.limits(),
        ..Default::default()
    }))
    .unwrap();
    for source in [
        probe_shader_source(
            &include_str!("../shaders/shader.wgsl")
                .replace("rgba8unorm, write>", "rgba16float, write>"),
        ),
        include_str!("../shaders/influence_difference.wgsl").to_string(),
    ] {
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let _ = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("diagnostic validation"),
            source: wgpu::ShaderSource::Wgsl(source.into()),
        });
        assert!(pollster::block_on(scope.pop()).is_none());
    }
}
#[test]
fn perceptual_difference_detects_colour_and_equal_input_is_zero() {
    assert_eq!(lab([0.5; 3]), lab([0.5; 3]));
    assert!(
        lab([1., 0., 0.])
            .iter()
            .zip(lab([0., 1., 0.]))
            .any(|(a, b)| (a - b).abs() > 0.1)
    );
    let image = DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        2,
        3,
        image::Rgba([40, 120, 80, 255]),
    ));
    assert!(
        difference(&image, &image)
            .unwrap()
            .pixels()
            .all(|p| p.0 == [0, 0, 0, 255])
    );
}

#[test]
fn broad_global_controls_have_full_coverage_and_follow_the_rendered_result() {
    let mut gpu = crate::gpu_processing::DiagnosticGpu::new(gpu_context(), 33, 17).unwrap();
    let image = DynamicImage::ImageRgb32F(image::Rgb32FImage::from_pixel(
        33,
        17,
        image::Rgb([0.25, 0.12, 0.04]),
    ));
    for control in [
        "exposure",
        "brightness",
        "contrast",
        "hue",
        "saturation",
        "vibrance",
    ] {
        let target = Target::Scalar {
            control: control.into(),
            scope: Scope::Global,
        };
        let recipe = crate::image_processing::default_adjustments();
        let probe = probe_parameters(&target, &recipe).unwrap();
        let support = fixture_frame(&mut gpu, &image, &recipe, Some(probe));
        let selection = gpu
            .compose(&support, &support, 3, Some(&support), None)
            .unwrap();
        assert!(
            selection.pixels().all(|p| p.0 == [255, 255, 255, 255]),
            "{control}"
        );
        let presentation = if ["hue", "saturation", "vibrance"].contains(&control) {
            2
        } else {
            1
        };
        let mut previews = Vec::new();
        for value in [-1.0, 0.0, 1.0] {
            let mut edited = recipe.clone();
            edited[control] = json!(
                value
                    * if ["exposure", "brightness"].contains(&control) {
                        1.0
                    } else {
                        50.0
                    }
            );
            let actual = fixture_frame(&mut gpu, &image, &edited, None);
            let preview = gpu
                .compose(&actual, &actual, presentation, Some(&support), None)
                .unwrap();
            if presentation == 1 {
                assert!(preview.pixels().all(|p| p[0] == p[1] && p[1] == p[2]));
            }
            previews.push(preview);
        }
        assert_ne!(previews[0], previews[1], "{control} negative");
        assert_ne!(previews[1], previews[2], "{control} positive");
    }
}
