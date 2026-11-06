// Separable Gaussian blur — horizontal pass.
//
// Each thread reads `2*radius+1` samples from a row of the input image and
// writes the convolved value to the output. Boundary handling clamps indices.
//
// Pair this with `gaussian_blur_v.wgsl` for the full 2D blur. Kernel weights
// are pre-computed on CPU (see `gaussian_kernel` in spektrafilm-math).

struct Params {
    width: u32,
    height: u32,
    radius: u32,
    _pad: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input: array<f32>;   // [H*W*3]
@group(0) @binding(2) var<storage, read> kernel_buf: array<f32>;  // [2*radius+1]
@group(0) @binding(3) var<storage, read_write> output: array<f32>; // [H*W*3]

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if x >= params.width || y >= params.height {
        return;
    }

    var sum = vec3<f32>(0.0, 0.0, 0.0);
    let kernel_size = 2u * params.radius + 1u;
    let w_i32 = i32(params.width);
    for (var k = 0u; k < kernel_size; k++) {
        let dx = i32(k) - i32(params.radius);
        let sx_signed = i32(x) + dx;
        let sx = u32(clamp(sx_signed, 0i, w_i32 - 1i));
        let idx = (y * params.width + sx) * 3u;
        let w = kernel_buf[k];
        sum.x += w * input[idx];
        sum.y += w * input[idx + 1u];
        sum.z += w * input[idx + 2u];
    }

    let out_idx = (y * params.width + x) * 3u;
    output[out_idx] = sum.x;
    output[out_idx + 1u] = sum.y;
    output[out_idx + 2u] = sum.z;
}
