"""Run with 'python -m pip install wgpu numpy' and 'python bench/check-tiff-precision.py'.

Check the final edited TIFF store on the default WebGPU adapter independently
of camera decoding and earlier half-float working buffers.
"""
from pathlib import Path

import numpy as np
import wgpu

shaders = Path(__file__).resolve().parents[1] / "src-tauri/src/shaders"
device = wgpu.gpu.request_adapter_sync().request_device_sync()
store = (shaders / "output_u16.wgsl").read_text()
kernel = """
@compute @workgroup_size(8, 8)
fn ramp(@builtin(global_invocation_id) p: vec3<u32>) {
    let code = p.y * 256u + p.x;
    let v = f32(code) / 65535.0;
    store_output(p.xy, vec4<f32>(v, 1.0 - v, -0.1, 1.1));
}
"""
module = device.create_shader_module(code=store + kernel)
pipeline = device.create_compute_pipeline(
    layout="auto", compute={"module": module, "entry_point": "ramp"}
)
texture = device.create_texture(
    size=(256, 256, 1), format="rgba16uint",
    usage=wgpu.TextureUsage.STORAGE_BINDING | wgpu.TextureUsage.COPY_SRC,
)
group = device.create_bind_group(
    layout=pipeline.get_bind_group_layout(0),
    entries=[{"binding": 1, "resource": texture.create_view()}],
)
encoder = device.create_command_encoder()
compute = encoder.begin_compute_pass()
compute.set_pipeline(pipeline)
compute.set_bind_group(0, group)
compute.dispatch_workgroups(32, 32, 1)
compute.end()
device.queue.submit([encoder.finish()])
raw = device.queue.read_texture(
    {"texture": texture}, {"bytes_per_row": 2048, "rows_per_image": 256}, (256, 256, 1)
)
pixels = np.frombuffer(raw, dtype="<u2").reshape(-1, 4)
expected = np.arange(65536, dtype=np.uint16)
np.testing.assert_array_equal(pixels[:, 0], expected)
np.testing.assert_array_equal(pixels[:, 1], expected[::-1])
np.testing.assert_equal(pixels[:, 2].max(), 0)
np.testing.assert_equal(pixels[:, 3].min(), 65535)
print("PASS: all 65536 channel codes, reversed ramp, and clamped endpoints")
