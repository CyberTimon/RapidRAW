// Separable Gaussian blur — horizontal and vertical passes.
// Metal compute shader with threadgroup shared memory for the sliding window.

#include <metal_stdlib>
using namespace metal;

struct BlurParams {
    uint width;
    uint height;
    uint radius;
    uint channel;     // 0, 1, or 2
    uint horizontal;  // 1 = horizontal pass, 0 = vertical pass
    uint _pad0;
    uint _pad1;
    uint _pad2;
};

kernel void gaussian_blur_pass(
    device const float* input           [[buffer(0)]],
    constant BlurParams& params         [[buffer(1)]],
    device const float* kernel_weights  [[buffer(2)]],  // [2*radius+1]
    device float* output                [[buffer(3)]],
    uint gid [[thread_position_in_grid]]
) {
    uint w = params.width;
    uint h = params.height;
    uint total = w * h;
    if (gid >= total) return;

    uint x = gid % w;
    uint y = gid / w;
    uint c = params.channel;
    int r = int(params.radius);

    float sum = 0.0;
    int kernel_size = 2 * r + 1;

    if (params.horizontal == 1) {
        for (int k = 0; k < kernel_size; k++) {
            int sx = clamp(int(x) + k - r, 0, int(w) - 1);
            sum += input[(y * w + uint(sx)) * 3 + c] * kernel_weights[k];
        }
    } else {
        for (int k = 0; k < kernel_size; k++) {
            int sy = clamp(int(y) + k - r, 0, int(h) - 1);
            sum += input[(uint(sy) * w + x) * 3 + c] * kernel_weights[k];
        }
    }

    output[(y * w + x) * 3 + c] = sum;
}
