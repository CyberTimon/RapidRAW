struct Params {
    grid: Grid,
    global: vec4<f32>,
    cells: array<vec4<f32>, 8>,
}

@group(0) @binding(7) var<uniform> params: Params;

const SAMPLES: u32 = 4u;

fn mosaic(p: vec2<u32>, cell: f32) -> vec4<f32> {
    let last = vec2<f32>(params.grid.dst) - 1.0;
    let origin = floor(vec2<f32>(p) / cell) * cell;
    let step = cell / f32(SAMPLES);
    var sum = vec4<f32>(0.0);
    for (var j = 0u; j < SAMPLES; j = j + 1u) {
        for (var i = 0u; i < SAMPLES; i = i + 1u) {
            let q = min(origin + (vec2<f32>(f32(i), f32(j)) + 0.5) * step, last);
            sum = sum + textureLoad(t0, vec2<u32>(q), 0);
        }
    }
    return sum / f32(SAMPLES * SAMPLES);
}

fn cell_of(index: u32) -> f32 {
    let group = params.cells[index / 4u];
    switch index % 4u {
        case 0u: { return group.x; }
        case 1u: { return group.y; }
        case 2u: { return group.z; }
        default: { return group.w; }
    }
}

@compute @workgroup_size(8, 8, 1)
fn px_apply(@builtin(global_invocation_id) id: vec3<u32>) {
    if (outside(id)) { return; }
    var color = textureLoad(t0, id.xy, 0);
    if (params.global.x > 1.0) {
        color = mosaic(id.xy, params.global.x);
    }
    let last = vec2<f32>(params.grid.dst) - 1.0;
    for (var index = 0u; index < u32(params.global.y); index = index + 1u) {
        let cell = cell_of(index);
        if (cell > 1.0) {
            let center = min((floor(vec2<f32>(id.xy) / cell) + 0.5) * cell, last);
            let weight = textureLoad(layers, vec2<u32>(center), i32(index), 0).r;
            if (weight > 0.0) {
                color = mix(color, mosaic(id.xy, cell), weight);
            }
        }
    }
    textureStore(out_f16, id.xy, color);
}
