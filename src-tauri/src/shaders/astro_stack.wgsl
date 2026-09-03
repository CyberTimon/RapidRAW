struct AstroStackParams {
    total_frames: u32,
    kappa: f32,
    width: u32,
    height: u32,
}

@group(0) @binding(0) var output_texture: texture_storage_2d<rgba32float, write>;
@group(0) @binding(1) var<storage, read> frame_buffer: array<f32>;
@group(0) @binding(2) var<uniform> params: AstroStackParams;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= params.width || id.y >= params.height) {
        return;
    }

    let pixel_idx = (id.y * params.width + id.x) * 3u;
    let n = params.total_frames;
    let frame_stride = params.width * params.height * 3u;

    var sum_rgb = vec3<f32>(0.0);

    for (var c = 0u; c < 3u; c = c + 1u) {
        var mean_val = 0.0;
        for (var f = 0u; f < n; f = f + 1u) {
            let idx = f * frame_stride + pixel_idx + c;
            mean_val = mean_val + frame_buffer[idx];
        }
        mean_val = mean_val / f32(n);

        var var_val = 0.0;
        for (var f = 0u; f < n; f = f + 1u) {
            let idx = f * frame_stride + pixel_idx + c;
            let diff = frame_buffer[idx] - mean_val;
            var_val = var_val + diff * diff;
        }
        let std_val = sqrt(var_val / max(f32(n - 1u), 1.0));
        let clip_thresh = params.kappa * std_val;

        var acc = 0.0;
        var valid_cnt = 0.0;
        for (var f = 0u; f < n; f = f + 1u) {
            let idx = f * frame_stride + pixel_idx + c;
            let val = frame_buffer[idx];
            if (abs(val - mean_val) <= clip_thresh) {
                acc = acc + val;
                valid_cnt = valid_cnt + 1.0;
            }
        }

        if (valid_cnt > 0.0) {
            sum_rgb[c] = acc / valid_cnt;
        } else {
            sum_rgb[c] = mean_val;
        }
    }

    textureStore(output_texture, id.xy, vec4<f32>(sum_rgb, 1.0));
}
