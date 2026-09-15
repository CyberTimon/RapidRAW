struct AstroStackParams {
    total_frames: u32,
    kappa: f32,
    width: u32,
    height: u32,
}

@group(0) @binding(0) var<storage, read_write> output_buffer: array<f32>;
@group(0) @binding(1) var<storage, read> frame_buffer: array<f32>;
@group(0) @binding(2) var<uniform> params: AstroStackParams;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= params.width || id.y >= params.height) {
        return;
    }

    let pixel_idx = (id.y * params.width + id.x) * 3u;
    let n = min(params.total_frames, 128u);
    let frame_stride = params.width * params.height * 3u;

    if (n <= 2u) {
        for (var c = 0u; c < 3u; c = c + 1u) {
            var sum_val = 0.0;
            for (var f = 0u; f < n; f = f + 1u) {
                sum_val = sum_val + frame_buffer[f * frame_stride + pixel_idx + c];
            }
            output_buffer[pixel_idx + c] = sum_val / max(f32(n), 1.0);
        }
        return;
    }

    for (var c = 0u; c < 3u; c = c + 1u) {
        var vals: array<f32, 128>;
        for (var f = 0u; f < n; f = f + 1u) {
            vals[f] = frame_buffer[f * frame_stride + pixel_idx + c];
        }

        // Insertion sort vals[0..n]
        for (var i = 1u; i < n; i = i + 1u) {
            let key = vals[i];
            var j = i;
            while (j > 0u && vals[j - 1u] > key) {
                vals[j] = vals[j - 1u];
                j = j - 1u;
            }
            vals[j] = key;
        }

        let median = vals[n / 2u];

        // Compute deviations from median
        var dev: array<f32, 128>;
        for (var i = 0u; i < n; i = i + 1u) {
            dev[i] = abs(vals[i] - median);
        }

        // Insertion sort deviations
        for (var i = 1u; i < n; i = i + 1u) {
            let key = dev[i];
            var j = i;
            while (j > 0u && dev[j - 1u] > key) {
                dev[j] = dev[j - 1u];
                j = j - 1u;
            }
            dev[j] = key;
        }

        let mad = dev[n / 2u];
        let robust_sigma = max(1.4826 * mad, 0.0001);

        let low_thr = median - (params.kappa * 1.2) * robust_sigma;
        let high_thr = median + params.kappa * robust_sigma;

        var acc = 0.0;
        var valid_cnt = 0.0;
        for (var i = 0u; i < n; i = i + 1u) {
            let v = vals[i];
            if (v >= low_thr && v <= high_thr) {
                acc = acc + v;
                valid_cnt = valid_cnt + 1.0;
            }
        }

        if (valid_cnt > 0.0) {
            output_buffer[pixel_idx + c] = acc / valid_cnt;
        } else {
            output_buffer[pixel_idx + c] = median;
        }
    }
}
