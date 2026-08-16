use crate::file_management::{Preset, PresetFolder, PresetItem};
use serde_json::json;

fn make_preset(id: &str, name: &str, adjustments: serde_json::Value) -> Preset {
    Preset {
        id: id.to_string(),
        name: name.to_string(),
        adjustments,
        include_masks: Some(false),
        include_crop_transform: Some(false),
        preset_type: Some("style".to_string()),
    }
}

pub fn get_default_curated_presets() -> Vec<PresetItem> {
    vec![
        // 1. Fujifilm Simulation
        PresetItem::Folder(PresetFolder {
            id: "folder-fujifilm".to_string(),
            name: "Fujifilm Simulation".to_string(),
            children: vec![
                make_preset("fuji-classic-chrome", "Classic Chrome", json!({
                    "contrast": 12, "highlights": -8, "shadows": 6, "whites": 4, "blacks": -4,
                    "saturation": -15, "vibrance": -8, "temperature": 2, "tint": -1,
                    "clarity": 5, "dehaze": 0, "grain": 12, "grainSize": 25,
                    "colorGrading": { "shadows": { "hue": 210, "sat": 6, "lum": -2 }, "highlights": { "hue": 42, "sat": 8, "lum": 1 } }
                })),
                make_preset("fuji-velvia-50", "Velvia 50 (Vivid)", json!({
                    "contrast": 22, "highlights": -12, "shadows": -6, "whites": 10, "blacks": -10,
                    "saturation": 28, "vibrance": 20, "temperature": -1, "tint": 2,
                    "clarity": 14, "dehaze": 8, "grain": 8, "grainSize": 20,
                    "colorGrading": { "shadows": { "hue": 225, "sat": 10, "lum": -4 }, "highlights": { "hue": 38, "sat": 14, "lum": 3 } }
                })),
                make_preset("fuji-astia-100", "Astia 100 (Soft)", json!({
                    "contrast": -4, "highlights": -14, "shadows": 14, "whites": -2, "blacks": 4,
                    "saturation": 6, "vibrance": 10, "temperature": 3, "tint": 1,
                    "clarity": -3, "dehaze": -2, "grain": 6, "grainSize": 18,
                    "colorGrading": { "shadows": { "hue": 340, "sat": 4, "lum": 2 }, "highlights": { "hue": 50, "sat": 6, "lum": 0 } }
                })),
                make_preset("fuji-provia-100f", "Provia 100F (Standard)", json!({
                    "contrast": 6, "highlights": -6, "shadows": 4, "whites": 2, "blacks": -2,
                    "saturation": 4, "vibrance": 6, "temperature": 0, "tint": 0,
                    "clarity": 4, "dehaze": 2, "grain": 5, "grainSize": 15
                })),
                make_preset("fuji-pro-neg-hi", "Pro Neg. Hi", json!({
                    "contrast": 15, "highlights": -10, "shadows": 8, "whites": 6, "blacks": -6,
                    "saturation": -4, "vibrance": 2, "temperature": 1, "tint": -2,
                    "clarity": 8, "grain": 10, "grainSize": 22
                })),
                make_preset("fuji-pro-neg-std", "Pro Neg. Std", json!({
                    "contrast": -6, "highlights": -8, "shadows": 12, "whites": 0, "blacks": 6,
                    "saturation": -8, "vibrance": 0, "temperature": 2, "tint": -1,
                    "clarity": -2, "grain": 8, "grainSize": 20
                })),
                make_preset("fuji-eterna", "Eterna Cinema", json!({
                    "contrast": -18, "highlights": -20, "shadows": 18, "whites": -10, "blacks": 12,
                    "saturation": -24, "vibrance": -14, "temperature": -2, "tint": -3,
                    "clarity": -6, "grain": 14, "grainSize": 30,
                    "colorGrading": { "shadows": { "hue": 190, "sat": 12, "lum": 4 }, "highlights": { "hue": 45, "sat": 10, "lum": -2 } }
                })),
                make_preset("fuji-acros-std", "Acros B&W (Standard)", json!({
                    "contrast": 16, "highlights": -8, "shadows": 6, "whites": 8, "blacks": -8,
                    "saturation": -100, "vibrance": -100, "clarity": 12, "grain": 18, "grainSize": 22
                })),
                make_preset("fuji-acros-r", "Acros B&W (+Red Filter)", json!({
                    "contrast": 26, "highlights": 4, "shadows": -8, "whites": 14, "blacks": -14,
                    "saturation": -100, "vibrance": -100, "clarity": 18, "dehaze": 10, "grain": 20, "grainSize": 24
                })),
                make_preset("fuji-acros-g", "Acros B&W (+Green Filter)", json!({
                    "contrast": 10, "highlights": -14, "shadows": 14, "whites": 4, "blacks": -2,
                    "saturation": -100, "vibrance": -100, "clarity": 8, "grain": 18, "grainSize": 22
                })),
                make_preset("fuji-acros-ye", "Acros B&W (+Yellow Filter)", json!({
                    "contrast": 18, "highlights": -4, "shadows": 2, "whites": 10, "blacks": -8,
                    "saturation": -100, "vibrance": -100, "clarity": 14, "dehaze": 4, "grain": 18, "grainSize": 22
                })),
                make_preset("fuji-classic-neg", "Classic Negative", json!({
                    "contrast": 20, "highlights": 8, "shadows": -12, "whites": 12, "blacks": -14,
                    "saturation": -10, "vibrance": -4, "temperature": 4, "tint": 8,
                    "clarity": 10, "grain": 16, "grainSize": 28,
                    "colorGrading": { "shadows": { "hue": 165, "sat": 14, "lum": -6 }, "highlights": { "hue": 32, "sat": 16, "lum": 2 } }
                })),
                make_preset("fuji-nostalgic-neg", "Nostalgic Negative", json!({
                    "contrast": 8, "highlights": -12, "shadows": 10, "whites": -4, "blacks": 2,
                    "saturation": -6, "vibrance": 4, "temperature": 6, "tint": 4,
                    "clarity": 2, "grain": 15, "grainSize": 25,
                    "colorGrading": { "shadows": { "hue": 48, "sat": 12, "lum": 2 }, "highlights": { "hue": 35, "sat": 15, "lum": 1 } }
                })),
            ],
        }),

        // 2. Kodak Emulation
        PresetItem::Folder(PresetFolder {
            id: "folder-kodak".to_string(),
            name: "Kodak Emulation".to_string(),
            children: vec![
                make_preset("kodak-portra-160", "Portra 160", json!({
                    "contrast": -2, "highlights": -10, "shadows": 8, "whites": 2, "blacks": -2,
                    "saturation": -4, "vibrance": 6, "temperature": 2, "tint": 1,
                    "clarity": 2, "grain": 8, "grainSize": 18,
                    "colorGrading": { "shadows": { "hue": 215, "sat": 4, "lum": 0 }, "highlights": { "hue": 40, "sat": 6, "lum": 1 } }
                })),
                make_preset("kodak-portra-400", "Portra 400", json!({
                    "contrast": 4, "highlights": -8, "shadows": 10, "whites": 4, "blacks": -4,
                    "saturation": 2, "vibrance": 8, "temperature": 3, "tint": 2,
                    "clarity": 4, "grain": 14, "grainSize": 22,
                    "colorGrading": { "shadows": { "hue": 220, "sat": 6, "lum": -1 }, "highlights": { "hue": 45, "sat": 8, "lum": 2 } }
                })),
                make_preset("kodak-portra-800", "Portra 800", json!({
                    "contrast": 8, "highlights": -6, "shadows": 8, "whites": 6, "blacks": -6,
                    "saturation": 8, "vibrance": 12, "temperature": 4, "tint": 3,
                    "clarity": 6, "grain": 22, "grainSize": 28,
                    "colorGrading": { "shadows": { "hue": 225, "sat": 8, "lum": -2 }, "highlights": { "hue": 42, "sat": 10, "lum": 2 } }
                })),
                make_preset("kodak-tri-x-400", "Tri-X 400 (Classic Grain)", json!({
                    "contrast": 28, "highlights": 10, "shadows": -12, "whites": 15, "blacks": -16,
                    "saturation": -100, "vibrance": -100, "clarity": 20, "dehaze": 6,
                    "grain": 32, "grainSize": 35, "grainRoughness": 40
                })),
                make_preset("kodak-ektar-100", "Ektar 100 (Ultra Vivid)", json!({
                    "contrast": 18, "highlights": -10, "shadows": -4, "whites": 8, "blacks": -8,
                    "saturation": 24, "vibrance": 18, "temperature": 1, "tint": 3,
                    "clarity": 16, "dehaze": 6, "grain": 6, "grainSize": 16,
                    "colorGrading": { "shadows": { "hue": 240, "sat": 10, "lum": -4 }, "highlights": { "hue": 35, "sat": 12, "lum": 2 } }
                })),
                make_preset("kodak-gold-200", "Gold 200 (Warm Nostalgia)", json!({
                    "contrast": 10, "highlights": -6, "shadows": 6, "whites": 4, "blacks": -4,
                    "saturation": 12, "vibrance": 14, "temperature": 7, "tint": 2,
                    "clarity": 6, "grain": 16, "grainSize": 24,
                    "colorGrading": { "shadows": { "hue": 200, "sat": 6, "lum": 0 }, "highlights": { "hue": 48, "sat": 14, "lum": 2 } }
                })),
                make_preset("kodak-colorplus-200", "ColorPlus 200", json!({
                    "contrast": 12, "highlights": 4, "shadows": -2, "whites": 6, "blacks": -6,
                    "saturation": 6, "vibrance": 8, "temperature": 5, "tint": 1,
                    "clarity": 5, "grain": 18, "grainSize": 25,
                    "colorGrading": { "shadows": { "hue": 190, "sat": 8, "lum": -1 }, "highlights": { "hue": 52, "sat": 10, "lum": 1 } }
                })),
                make_preset("kodak-kodachrome-64", "Kodachrome 64 (Heritage)", json!({
                    "contrast": 24, "highlights": -8, "shadows": -10, "whites": 12, "blacks": -12,
                    "saturation": 16, "vibrance": 14, "temperature": 2, "tint": -2,
                    "clarity": 18, "dehaze": 8, "grain": 12, "grainSize": 20,
                    "colorGrading": { "shadows": { "hue": 210, "sat": 12, "lum": -5 }, "highlights": { "hue": 38, "sat": 14, "lum": 3 } }
                })),
                make_preset("kodak-tmax-3200", "T-Max 3200 (High Speed BW)", json!({
                    "contrast": 32, "highlights": 12, "shadows": -14, "whites": 18, "blacks": -18,
                    "saturation": -100, "vibrance": -100, "clarity": 24, "grain": 45, "grainSize": 45
                })),
                make_preset("kodak-royal-gold-400", "Royal Gold 400", json!({
                    "contrast": 14, "highlights": -4, "shadows": 4, "whites": 8, "blacks": -6,
                    "saturation": 16, "vibrance": 16, "temperature": 6, "tint": 2,
                    "clarity": 8, "grain": 18, "grainSize": 26
                })),
            ],
        }),

        // 3. Ilford Black & White
        PresetItem::Folder(PresetFolder {
            id: "folder-ilford".to_string(),
            name: "Ilford Black & White".to_string(),
            children: vec![
                make_preset("ilford-hp5-plus-400", "HP5 Plus 400 (Versatile)", json!({
                    "contrast": 18, "highlights": -6, "shadows": 8, "whites": 10, "blacks": -10,
                    "saturation": -100, "vibrance": -100, "clarity": 14, "grain": 24, "grainSize": 28
                })),
                make_preset("ilford-fp4-plus-125", "FP4 Plus 125 (Fine Grain)", json!({
                    "contrast": 12, "highlights": -8, "shadows": 6, "whites": 6, "blacks": -6,
                    "saturation": -100, "vibrance": -100, "clarity": 10, "grain": 10, "grainSize": 18
                })),
                make_preset("ilford-delta-100", "Delta 100 (Modern Sharp)", json!({
                    "contrast": 14, "highlights": -10, "shadows": 4, "whites": 8, "blacks": -8,
                    "saturation": -100, "vibrance": -100, "clarity": 16, "grain": 6, "grainSize": 14
                })),
                make_preset("ilford-delta-400", "Delta 400 (Rich Tones)", json!({
                    "contrast": 20, "highlights": -4, "shadows": 6, "whites": 12, "blacks": -12,
                    "saturation": -100, "vibrance": -100, "clarity": 16, "grain": 18, "grainSize": 24
                })),
                make_preset("ilford-delta-3200", "Delta 3200 (Atmospheric Grain)", json!({
                    "contrast": 26, "highlights": 8, "shadows": -6, "whites": 16, "blacks": -16,
                    "saturation": -100, "vibrance": -100, "clarity": 22, "grain": 48, "grainSize": 50
                })),
                make_preset("ilford-pan-f-plus-50", "Pan F Plus 50 (Ultra Smooth)", json!({
                    "contrast": 22, "highlights": -12, "shadows": -2, "whites": 10, "blacks": -10,
                    "saturation": -100, "vibrance": -100, "clarity": 18, "grain": 4, "grainSize": 10
                })),
                make_preset("ilford-xp2-super", "XP2 Super 400 (C-41 Smooth)", json!({
                    "contrast": 10, "highlights": -10, "shadows": 10, "whites": 4, "blacks": -4,
                    "saturation": -100, "vibrance": -100, "clarity": 8, "grain": 12, "grainSize": 20
                })),
            ],
        }),

        // 4. Cinematic & Vintage
        PresetItem::Folder(PresetFolder {
            id: "folder-cinematic".to_string(),
            name: "Cinematic & Vintage".to_string(),
            children: vec![
                make_preset("cine-cinestill-800t", "CineStill 800T (Tungsten Halation)", json!({
                    "contrast": 16, "highlights": 12, "shadows": 8, "whites": 14, "blacks": -6,
                    "saturation": 8, "vibrance": 14, "temperature": -8, "tint": 12,
                    "clarity": 6, "grain": 24, "grainSize": 30,
                    "colorGrading": { "shadows": { "hue": 195, "sat": 18, "lum": 2 }, "highlights": { "hue": 15, "sat": 24, "lum": 4 } }
                })),
                make_preset("cine-cinestill-50d", "CineStill 50D (Daylight Clean)", json!({
                    "contrast": 12, "highlights": -6, "shadows": 6, "whites": 6, "blacks": -4,
                    "saturation": 14, "vibrance": 12, "temperature": 2, "tint": -1,
                    "clarity": 12, "grain": 8, "grainSize": 16,
                    "colorGrading": { "shadows": { "hue": 210, "sat": 8, "lum": -2 }, "highlights": { "hue": 40, "sat": 10, "lum": 2 } }
                })),
                make_preset("cine-agfa-vista-200", "Agfa Vista 200 (Punchy Reds)", json!({
                    "contrast": 14, "highlights": -4, "shadows": 4, "whites": 8, "blacks": -8,
                    "saturation": 18, "vibrance": 16, "temperature": 3, "tint": 6,
                    "clarity": 10, "grain": 16, "grainSize": 24,
                    "colorGrading": { "shadows": { "hue": 210, "sat": 10, "lum": -2 }, "highlights": { "hue": 25, "sat": 14, "lum": 2 } }
                })),
                make_preset("cine-agfa-vista-400", "Agfa Vista 400", json!({
                    "contrast": 16, "highlights": -2, "shadows": 6, "whites": 10, "blacks": -10,
                    "saturation": 20, "vibrance": 18, "temperature": 4, "tint": 7,
                    "clarity": 12, "grain": 22, "grainSize": 28
                })),
                make_preset("cine-polaroid-600", "Polaroid 600 (Instant Nostalgia)", json!({
                    "contrast": -8, "highlights": 14, "shadows": 16, "whites": -12, "blacks": 14,
                    "saturation": -12, "vibrance": 6, "temperature": 6, "tint": 5,
                    "clarity": -4, "grain": 28, "grainSize": 36,
                    "colorGrading": { "shadows": { "hue": 120, "sat": 12, "lum": 6 }, "highlights": { "hue": 45, "sat": 16, "lum": -2 } }
                })),
                make_preset("cine-bleach-bypass", "Bleach Bypass (Gritty)", json!({
                    "contrast": 36, "highlights": 16, "shadows": -18, "whites": 20, "blacks": -20,
                    "saturation": -48, "vibrance": -30, "clarity": 28, "dehaze": 14,
                    "grain": 20, "grainSize": 26
                })),
                make_preset("cine-technicolor-2strip", "Technicolor 2-Strip", json!({
                    "contrast": 22, "highlights": -4, "shadows": -6, "whites": 12, "blacks": -10,
                    "saturation": 26, "vibrance": 22, "temperature": -4, "tint": 18,
                    "clarity": 16, "grain": 14, "grainSize": 22,
                    "colorGrading": { "shadows": { "hue": 175, "sat": 24, "lum": -2 }, "highlights": { "hue": 20, "sat": 26, "lum": 2 } }
                })),
                make_preset("cine-cross-process", "Cross Process (E-6 to C-41)", json!({
                    "contrast": 28, "highlights": 12, "shadows": -8, "whites": 14, "blacks": -12,
                    "saturation": 30, "vibrance": 20, "temperature": -6, "tint": 22,
                    "clarity": 18, "grain": 20, "grainSize": 28,
                    "colorGrading": { "shadows": { "hue": 140, "sat": 26, "lum": -4 }, "highlights": { "hue": 55, "sat": 28, "lum": 4 } }
                })),
            ],
        }),

        // 5. Astro & Night Sky
        PresetItem::Folder(PresetFolder {
            id: "folder-astro".to_string(),
            name: "Astro & Night Sky".to_string(),
            children: vec![
                make_preset("astro-canon-halpha", "Canon Astro H-Alpha Boost", json!({
                    "contrast": 18, "highlights": -14, "shadows": 12, "whites": 16, "blacks": -14,
                    "saturation": 16, "vibrance": 24, "temperature": -8, "tint": 14,
                    "clarity": 22, "dehaze": 20, "sharpening": 35, "luminanceDenoise": 15, "colorDenoise": 25,
                    "colorGrading": { "shadows": { "hue": 220, "sat": 14, "lum": -8 }, "highlights": { "hue": 350, "sat": 22, "lum": 4 } }
                })),
                make_preset("astro-starfield-contrast", "Starfield Contrast & Core", json!({
                    "contrast": 26, "highlights": -20, "shadows": 8, "whites": 22, "blacks": -20,
                    "saturation": 12, "vibrance": 18, "temperature": -12, "tint": 6,
                    "clarity": 28, "dehaze": 26, "sharpening": 40, "luminanceDenoise": 18, "colorDenoise": 30,
                    "colorGrading": { "shadows": { "hue": 235, "sat": 18, "lum": -10 }, "highlights": { "hue": 40, "sat": 16, "lum": 2 } }
                })),
                make_preset("astro-milkyway-core", "Milky Way Core Glow", json!({
                    "contrast": 22, "highlights": -10, "shadows": 14, "whites": 18, "blacks": -16,
                    "saturation": 20, "vibrance": 26, "temperature": -6, "tint": 10,
                    "clarity": 25, "dehaze": 22, "sharpening": 38, "luminanceDenoise": 16, "colorDenoise": 28,
                    "colorGrading": { "shadows": { "hue": 215, "sat": 16, "lum": -6 }, "highlights": { "hue": 35, "sat": 25, "lum": 6 } }
                })),
            ],
        }),
    ]
}
