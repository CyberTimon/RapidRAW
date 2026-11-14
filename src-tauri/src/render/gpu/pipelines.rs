use crate::render::uniforms::{AllAdjustments, HslColor, MAX_MASKS, MaskAdjustments};
use std::collections::HashMap;
use std::sync::Arc;

pub struct HighPrecisionPipeline {
    pub bgl: wgpu::BindGroupLayout,
    pub pipeline: wgpu::ComputePipeline,
    pub shader: wgpu::ShaderModule,
    pub layout: wgpu::PipelineLayout,
}

type SpecializedPipelines =
    Arc<std::sync::Mutex<HashMap<(bool, u32), Option<wgpu::ComputePipeline>>>>;

pub const ALL_SHADER_FEATURES: u32 = u32::MAX;

const F_NOISE_REDUCTION: u32 = 1;

const F_HSL: u32 = 2;

const F_MASKS: u32 = 4;

const F_SHARPEN: u32 = 8;

const F_DEHAZE: u32 = 16;

const F_GLOW_HALATION_FLARE: u32 = 32;

const F_GRAIN: u32 = 64;

const F_VIGNETTE: u32 = 128;

const F_LUT: u32 = 256;

const F_CA: u32 = 512;

const F_AGX: u32 = 1024;

const F_MONOCHROME: u32 = 2048;

pub fn shader_features(adjustments: &AllAdjustments) -> u32 {
    let g = &adjustments.global;
    let masks = &adjustments.mask_adjustments[..(adjustments.mask_count as usize).min(MAX_MASKS)];
    let any = |global: f32, pick: fn(&MaskAdjustments) -> f32| {
        global != 0.0 || masks.iter().any(|m| pick(m) != 0.0)
    };
    let hsl_nonzero = |hsl: &[HslColor; 8]| {
        bytemuck::cast_slice::<_, f32>(hsl)
            .iter()
            .any(|&v| v != 0.0)
    };

    let mut features = 0;
    let mut set = |flag: u32, on: bool| {
        if on {
            features |= flag;
        }
    };
    set(
        F_NOISE_REDUCTION,
        any(g.luma_noise_reduction, |m| m.luma_noise_reduction)
            || any(g.color_noise_reduction, |m| m.color_noise_reduction),
    );
    set(
        F_HSL,
        hsl_nonzero(&g.hsl) || masks.iter().any(|m| hsl_nonzero(&m.hsl)),
    );
    set(F_MASKS, adjustments.mask_count > 0);
    set(F_SHARPEN, any(g.sharpness, |m| m.sharpness));
    set(F_DEHAZE, any(g.dehaze, |m| m.dehaze));
    set(
        F_GLOW_HALATION_FLARE,
        any(g.glow_amount, |m| m.glow_amount)
            || any(g.halation_amount, |m| m.halation_amount)
            || any(g.flare_amount, |m| m.flare_amount),
    );
    set(F_GRAIN, g.grain_amount > 0.0);
    set(F_VIGNETTE, g.vignette_amount != 0.0);
    set(F_LUT, g.has_lut == 1);
    set(
        F_CA,
        g.chromatic_aberration_red_cyan.abs() > 0.000001
            || g.chromatic_aberration_blue_yellow.abs() > 0.000001,
    );
    set(F_AGX, g.tonemapper_mode == 1);
    set(F_MONOCHROME, g.monochrome.enabled == 1);
    features
}

pub fn high_precision_shader_source() -> String {
    include_str!("../../shaders/shader.wgsl").replace("rgba8unorm, write>", "rgba16float, write>")
}

pub struct GpuPipelines {
    pub blur_bgl: wgpu::BindGroupLayout,
    pub h_blur_pipeline: wgpu::ComputePipeline,
    pub v_blur_pipeline: wgpu::ComputePipeline,
    pub h_blur_direct_pipeline: wgpu::ComputePipeline,
    pub v_blur_direct_pipeline: wgpu::ComputePipeline,

    pub light_sampler: wgpu::Sampler,

    pub gf_bgl: wgpu::BindGroupLayout,
    pub gf_downsample_pipeline: wgpu::ComputePipeline,
    pub gf_box_down_pipeline: wgpu::ComputePipeline,
    pub gf_blur_h_pipeline: wgpu::ComputePipeline,
    pub gf_blur_v_pipeline: wgpu::ComputePipeline,
    pub gf_coeffs_pipeline: wgpu::ComputePipeline,
    pub tb_bilateral_pipeline: wgpu::ComputePipeline,
    pub tb_refine_pipeline: wgpu::ComputePipeline,
    pub tb_decimate_pipeline: wgpu::ComputePipeline,
    pub tb_fit_pipeline: wgpu::ComputePipeline,
    pub tb_merge_pipeline: wgpu::ComputePipeline,
    pub tb_pack_pipeline: wgpu::ComputePipeline,
    pub tb_tone_pipeline: wgpu::ComputePipeline,
    pub tb_peak_pipeline: wgpu::ComputePipeline,
    pub tb_clip_pipeline: wgpu::ComputePipeline,
    pub tb_stamp_pipeline: wgpu::ComputePipeline,
    pub hz_downsample_pipeline: wgpu::ComputePipeline,
    pub hz_airlight_pipeline: wgpu::ComputePipeline,
    pub hz_min_h_pipeline: wgpu::ComputePipeline,
    pub hz_min_v_pipeline: wgpu::ComputePipeline,
    pub hz_max_h_pipeline: wgpu::ComputePipeline,
    pub hz_max_v_pipeline: wgpu::ComputePipeline,
    pub hz_coeffs_pipeline: wgpu::ComputePipeline,
    pub motion_blur: std::sync::OnceLock<crate::effects::motion_blur::MotionBlurPipelines>,

    pub main_bgl: wgpu::BindGroupLayout,
    pub main_pipeline: wgpu::ComputePipeline,
    pub main_shader_module: wgpu::ShaderModule,
    pub main_pipeline_layout: wgpu::PipelineLayout,
    pub specialized_pipelines: SpecializedPipelines,
    pub high_precision_entries: Vec<wgpu::BindGroupLayoutEntry>,
    pub high_precision_pipeline: std::sync::OnceLock<HighPrecisionPipeline>,
    pub hsl_probe_pipeline: std::sync::OnceLock<wgpu::ComputePipeline>,
    pub dummy_blur_view: wgpu::TextureView,
    pub dummy_lut_view: wgpu::TextureView,
    pub dummy_lut_sampler: wgpu::Sampler,
    pub dummy_mask_view: wgpu::TextureView,
}

impl GpuPipelines {
    pub fn new(device: &wgpu::Device) -> Self {
        const MAX_MASK_BINDINGS: u32 = 1;

        let blur_shader_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Blur Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../../shaders/blur.wgsl").into()),
        });

        let blur_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Blur BGL"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::Rgba16Float,
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        let blur_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Blur Pipeline Layout"),
            bind_group_layouts: &[Some(&blur_bgl)],
            immediate_size: 0,
        });

        let h_blur_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Horizontal Blur Pipeline"),
            layout: Some(&blur_pipeline_layout),
            module: &blur_shader_module,
            entry_point: Some("horizontal_blur"),
            compilation_options: Default::default(),
            cache: None,
        });

        let v_blur_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Vertical Blur Pipeline"),
            layout: Some(&blur_pipeline_layout),
            module: &blur_shader_module,
            entry_point: Some("vertical_blur"),
            compilation_options: Default::default(),
            cache: None,
        });

        let h_blur_direct_pipeline =
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("Horizontal Direct Blur Pipeline"),
                layout: Some(&blur_pipeline_layout),
                module: &blur_shader_module,
                entry_point: Some("horizontal_blur_direct"),
                compilation_options: Default::default(),
                cache: None,
            });

        let v_blur_direct_pipeline =
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("Vertical Direct Blur Pipeline"),
                layout: Some(&blur_pipeline_layout),
                module: &blur_shader_module,
                entry_point: Some("vertical_blur_direct"),
                compilation_options: Default::default(),
                cache: None,
            });

        let light_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Light Sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        let gf_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Guided Filter Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../../shaders/guided.wgsl").into()),
        });

        let gf_texture_entry = |binding: u32| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        };

        let gf_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Guided Filter BGL"),
            entries: &[
                gf_texture_entry(0),
                gf_texture_entry(1),
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::Rgba32Float,
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        let gf_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Guided Filter Pipeline Layout"),
            bind_group_layouts: &[Some(&gf_bgl)],
            immediate_size: 0,
        });

        let gf_pipeline = |entry: &'static str| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(entry),
                layout: Some(&gf_layout),
                module: &gf_shader,
                entry_point: Some(entry),
                compilation_options: Default::default(),
                cache: None,
            })
        };

        let gf_downsample_pipeline = gf_pipeline("gf_downsample");
        let gf_box_down_pipeline = gf_pipeline("gf_box_down");
        let gf_blur_h_pipeline = gf_pipeline("gf_blur_h");
        let gf_blur_v_pipeline = gf_pipeline("gf_blur_v");
        let gf_coeffs_pipeline = gf_pipeline("gf_coeffs");
        let hz_downsample_pipeline = gf_pipeline("hz_downsample");
        let hz_airlight_pipeline = gf_pipeline("hz_airlight");
        let hz_min_h_pipeline = gf_pipeline("hz_min_h");
        let hz_min_v_pipeline = gf_pipeline("hz_min_v");
        let hz_max_h_pipeline = gf_pipeline("hz_max_h");
        let hz_max_v_pipeline = gf_pipeline("hz_max_v");
        let hz_coeffs_pipeline = gf_pipeline("hz_coeffs");
        let tb_bilateral_pipeline = gf_pipeline("tb_bilateral");
        let tb_refine_pipeline = gf_pipeline("tb_refine");
        let tb_decimate_pipeline = gf_pipeline("tb_decimate");
        let tb_fit_pipeline = gf_pipeline("tb_fit");
        let tb_merge_pipeline = gf_pipeline("tb_merge");
        let tb_pack_pipeline = gf_pipeline("tb_pack");
        let tb_tone_pipeline = gf_pipeline("tb_tone");
        let tb_peak_pipeline = gf_pipeline("tb_peak");
        let tb_clip_pipeline = gf_pipeline("tb_clip");
        let tb_stamp_pipeline = gf_pipeline("tb_stamp");

        let shader_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Image Processing Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../../shaders/shader.wgsl").into()),
        });

        let mut bind_group_layout_entries = vec![
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::StorageTexture {
                    access: wgpu::StorageTextureAccess::WriteOnly,
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    view_dimension: wgpu::TextureViewDimension::D2,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: true },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
        ];

        bind_group_layout_entries.push(wgpu::BindGroupLayoutEntry {
            binding: 3,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2Array,
                multisampled: false,
            },
            count: None,
        });

        bind_group_layout_entries.push(wgpu::BindGroupLayoutEntry {
            binding: 3 + MAX_MASK_BINDINGS,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D3,
                multisampled: false,
            },
            count: None,
        });
        bind_group_layout_entries.push(wgpu::BindGroupLayoutEntry {
            binding: 4 + MAX_MASK_BINDINGS,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::NonFiltering),
            count: None,
        });

        bind_group_layout_entries.push(wgpu::BindGroupLayoutEntry {
            binding: 5 + MAX_MASK_BINDINGS,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        });
        bind_group_layout_entries.push(wgpu::BindGroupLayoutEntry {
            binding: 6 + MAX_MASK_BINDINGS,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        });
        bind_group_layout_entries.push(wgpu::BindGroupLayoutEntry {
            binding: 8 + MAX_MASK_BINDINGS,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        });

        bind_group_layout_entries.push(wgpu::BindGroupLayoutEntry {
            binding: 9 + MAX_MASK_BINDINGS,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        });
        bind_group_layout_entries.push(wgpu::BindGroupLayoutEntry {
            binding: 10 + MAX_MASK_BINDINGS,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            count: None,
        });

        bind_group_layout_entries.push(wgpu::BindGroupLayoutEntry {
            binding: 11 + MAX_MASK_BINDINGS,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        });

        for binding in 12..15 {
            bind_group_layout_entries.push(wgpu::BindGroupLayoutEntry {
                binding: binding + MAX_MASK_BINDINGS,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            });
        }

        let main_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Main BGL"),
            entries: &bind_group_layout_entries,
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Pipeline Layout"),
            bind_group_layouts: &[Some(&main_bgl)],
            immediate_size: 0,
        });

        let main_shader_module = shader_module.clone();
        let main_pipeline_layout = pipeline_layout.clone();
        let main_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Compute Pipeline"),
            layout: Some(&pipeline_layout),
            module: &shader_module,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });

        bind_group_layout_entries[1].ty = wgpu::BindingType::StorageTexture {
            access: wgpu::StorageTextureAccess::WriteOnly,
            format: wgpu::TextureFormat::Rgba16Float,
            view_dimension: wgpu::TextureViewDimension::D2,
        };
        let dummy_texture_desc = wgpu::TextureDescriptor {
            label: Some("Dummy Texture"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        };
        let dummy_blur_texture = device.create_texture(&dummy_texture_desc);
        let dummy_blur_view = dummy_blur_texture.create_view(&Default::default());

        let dummy_lut_texture = device.create_texture(&wgpu::TextureDescriptor {
            dimension: wgpu::TextureDimension::D3,
            ..dummy_texture_desc
        });
        let dummy_lut_view = dummy_lut_texture.create_view(&Default::default());
        let dummy_lut_sampler = device.create_sampler(&wgpu::SamplerDescriptor::default());
        let dummy_mask_view = device
            .create_texture(&wgpu::TextureDescriptor {
                label: Some("Dummy Mask Texture Array"),
                size: wgpu::Extent3d {
                    width: 1,
                    height: 1,
                    depth_or_array_layers: 2,
                },
                format: wgpu::TextureFormat::R8Unorm,
                ..dummy_texture_desc
            })
            .create_view(&wgpu::TextureViewDescriptor {
                dimension: Some(wgpu::TextureViewDimension::D2Array),
                ..Default::default()
            });

        Self {
            blur_bgl,
            h_blur_pipeline,
            v_blur_pipeline,
            h_blur_direct_pipeline,
            v_blur_direct_pipeline,
            light_sampler,
            gf_bgl,
            gf_downsample_pipeline,
            gf_box_down_pipeline,
            gf_blur_h_pipeline,
            gf_blur_v_pipeline,
            gf_coeffs_pipeline,
            tb_bilateral_pipeline,
            tb_refine_pipeline,
            tb_decimate_pipeline,
            tb_fit_pipeline,
            tb_merge_pipeline,
            tb_pack_pipeline,
            tb_tone_pipeline,
            tb_peak_pipeline,
            tb_clip_pipeline,
            tb_stamp_pipeline,
            hz_downsample_pipeline,
            hz_airlight_pipeline,
            hz_min_h_pipeline,
            hz_min_v_pipeline,
            hz_max_h_pipeline,
            hz_max_v_pipeline,
            hz_coeffs_pipeline,
            motion_blur: std::sync::OnceLock::new(),
            main_bgl,
            main_pipeline,
            main_shader_module,
            main_pipeline_layout,
            specialized_pipelines: Arc::new(std::sync::Mutex::new(HashMap::new())),
            high_precision_entries: bind_group_layout_entries,
            high_precision_pipeline: std::sync::OnceLock::new(),
            hsl_probe_pipeline: std::sync::OnceLock::new(),
            dummy_blur_view,
            dummy_lut_view,
            dummy_lut_sampler,
            dummy_mask_view,
        }
    }
}
