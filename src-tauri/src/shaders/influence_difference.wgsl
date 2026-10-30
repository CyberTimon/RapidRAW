@group(0) @binding(0) var actual: texture_2d<f32>;
@group(0) @binding(1) var baseline: texture_2d<f32>;
@group(0) @binding(2) var result: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<uniform> options: vec4<u32>;
@group(0) @binding(4) var support: texture_2d<f32>;
@group(0) @binding(5) var support_reference: texture_2d<f32>;
@group(0) @binding(6) var spatial_filter: texture_2d<f32>;
fn linear(c: vec3<f32>) -> vec3<f32> {
    return select(pow((c + 0.055) / 1.055, vec3<f32>(2.4)), c / 12.92, c <= vec3<f32>(0.04045));
}
fn lab(c: vec3<f32>) -> vec3<f32> {
    let rgb=linear(c);
    let l=pow(max(dot(rgb,vec3<f32>(0.41222146,0.53633255,0.051445995)),0.0),1.0/3.0);
    let m=pow(max(dot(rgb,vec3<f32>(0.2119035,0.6806995,0.10739696)),0.0),1.0/3.0);
    let s=pow(max(dot(rgb,vec3<f32>(0.08830246,0.28171885,0.6299787)),0.0),1.0/3.0);
    return vec3<f32>(0.21045426*l+0.7936178*m-0.004072047*s,1.9779985*l-2.4285922*m+0.4505937*s,0.025904037*l+0.78277177*m-0.80867577*s);
}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3<u32>) {
    if(any(id.xy>=textureDimensions(result))){return;}
    let a=textureLoad(actual,vec2<i32>(id.xy),0);
    let b=textureLoad(baseline,vec2<i32>(id.xy),0);
    let d=distance(lab(a.rgb),lab(b.rgb));
    var rgb=vec3<f32>(d/(d+0.05));
    if(options.x!=0u){
        var weight=0.0;
        if(options.y==1u){weight=clamp(textureLoad(support,vec2<i32>(id.xy),0).r,0.0,1.0);}
        if(options.y==2u){
            let p=textureLoad(support,vec2<i32>(id.xy),0);
            let q=textureLoad(support_reference,vec2<i32>(id.xy),0);
            let response=distance(lab(p.rgb),lab(q.rgb));
            weight=response/(response+0.02);
        }
        if(options.z==1u){weight*=clamp(textureLoad(spatial_filter,vec2<i32>(id.xy),0).r,0.0,1.0);}
        var destination=linear(a.rgb);
        if(options.x==1u){destination=vec3<f32>(dot(destination,vec3<f32>(0.2126,0.7152,0.0722)));}
        let isolated=max(destination*weight,vec3<f32>(0.0));
        rgb=select(1.055*pow(isolated,vec3<f32>(1.0/2.4))-0.055,12.92*isolated,isolated<=vec3<f32>(0.0031308));
        if(options.x==3u){rgb=vec3<f32>(weight);}
    }
    textureStore(result,id.xy,vec4<f32>(rgb,select(min(a.a,b.a),1.0,options.x!=0u)));
}
