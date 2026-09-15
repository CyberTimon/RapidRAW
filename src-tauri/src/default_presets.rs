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
        // 1. Wedding & Portrait Fine-Art
        PresetItem::Folder(PresetFolder {
            id: "folder-wedding".to_string(),
            name: "Wedding & Portrait Fine-Art".to_string(),
            children: vec![
                make_preset("kodak-portra-400nc", "Portra 400NC (Natural Color)", json!({
                    "contrast": -6, "highlights": -14, "shadows": 12, "whites": -2, "blacks": 4,
                    "saturation": -8, "vibrance": 2, "temperature": 3, "tint": 1,
                    "clarity": -2, "grain": 12, "grainSize": 20,
                    "colorGrading": { "shadows": { "hue": 215, "sat": 4, "lum": 2 }, "highlights": { "hue": 42, "sat": 6, "lum": 2 } }
                })),
                make_preset("kodak-portra-160nc", "Portra 160NC (Soft Skin)", json!({
                    "contrast": -8, "highlights": -16, "shadows": 14, "whites": -4, "blacks": 6,
                    "saturation": -10, "vibrance": 0, "temperature": 2, "tint": 0,
                    "clarity": -4, "grain": 6, "grainSize": 16,
                    "colorGrading": { "shadows": { "hue": 210, "sat": 3, "lum": 3 }, "highlights": { "hue": 40, "sat": 5, "lum": 2 } }
                })),
                make_preset("fuji-pro-160ns", "Fujifilm Pro 160NS (Studio Portrait)", json!({
                    "contrast": -4, "highlights": -12, "shadows": 10, "whites": 0, "blacks": 2,
                    "saturation": -4, "vibrance": 4, "temperature": 1, "tint": -1,
                    "clarity": 0, "grain": 7, "grainSize": 16
                })),
                make_preset("ilford-xp2-super", "XP2 Super 400 (C-41 Silky B&W)", json!({
                    "contrast": 10, "highlights": -10, "shadows": 10, "whites": 4, "blacks": -4,
                    "saturation": -100, "vibrance": -100, "clarity": 8, "grain": 12, "grainSize": 20
                })),
            ],
        }),

        // 2. Travel & Street Life
        PresetItem::Folder(PresetFolder {
            id: "folder-travel".to_string(),
            name: "Travel & Street Life".to_string(),
            children: vec![
                make_preset("kodak-ultramax-400", "UltraMax 400 (Vibrant Everyday)", json!({
                    "contrast": 14, "highlights": -4, "shadows": 4, "whites": 8, "blacks": -6,
                    "saturation": 18, "vibrance": 16, "temperature": 4, "tint": 2,
                    "clarity": 10, "grain": 18, "grainSize": 25,
                    "colorGrading": { "shadows": { "hue": 205, "sat": 8, "lum": -2 }, "highlights": { "hue": 46, "sat": 14, "lum": 2 } }
                })),
                make_preset("fuji-sensia-100", "Sensia 100 (Natural Travel Slide)", json!({
                    "contrast": 8, "highlights": -8, "shadows": 6, "whites": 4, "blacks": -4,
                    "saturation": 8, "vibrance": 10, "temperature": 0, "tint": 0,
                    "clarity": 6, "grain": 8, "grainSize": 18
                })),
                make_preset("fuji-superia-xtra-400", "Superia X-TRA 400 (Everyday Street)", json!({
                    "contrast": 15, "highlights": -6, "shadows": 6, "whites": 6, "blacks": -6,
                    "saturation": 12, "vibrance": 14, "temperature": -1, "tint": -2,
                    "clarity": 8, "grain": 18, "grainSize": 24
                })),
            ],
        }),

        // 3. Night Sky & Astrophotography
        PresetItem::Folder(PresetFolder {
            id: "folder-night-astro".to_string(),
            name: "Night Sky & Astrophotography".to_string(),
            children: vec![
                make_preset("kodak-ektachrome-e200", "Ektachrome E200 (Astro H-Alpha)", json!({
                    "contrast": 24, "highlights": -16, "shadows": 14, "whites": 18, "blacks": -18,
                    "saturation": 22, "vibrance": 28, "temperature": -10, "tint": 16,
                    "clarity": 24, "dehaze": 22, "sharpening": 36, "luminanceDenoise": 14, "colorDenoise": 26,
                    "colorGrading": { "shadows": { "hue": 225, "sat": 16, "lum": -8 }, "highlights": { "hue": 348, "sat": 24, "lum": 4 } }
                })),
                make_preset("fuji-provia-400x", "Provia 400X (Star Trails & Nightscapes)", json!({
                    "contrast": 20, "highlights": -14, "shadows": 10, "whites": 16, "blacks": -14,
                    "saturation": 18, "vibrance": 22, "temperature": -8, "tint": 4,
                    "clarity": 20, "dehaze": 18, "sharpening": 34, "luminanceDenoise": 12, "colorDenoise": 22,
                    "colorGrading": { "shadows": { "hue": 230, "sat": 15, "lum": -6 }, "highlights": { "hue": 42, "sat": 16, "lum": 2 } }
                })),
                make_preset("fuji-superia-venus-800", "Superia Venus 800 (Night Street)", json!({
                    "contrast": 18, "highlights": -8, "shadows": 12, "whites": 10, "blacks": -10,
                    "saturation": 14, "vibrance": 16, "temperature": -4, "tint": -5,
                    "clarity": 12, "grain": 26, "grainSize": 30
                })),
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

        // 4. Ultra-High Resolution & Macro Specialists
        PresetItem::Folder(PresetFolder {
            id: "folder-macro-specialists".to_string(),
            name: "Ultra-High Resolution & Macro Specialists".to_string(),
            children: vec![
                make_preset("kodak-ektar-25", "Ektar 25 (Ultra-Fine Color Macro)", json!({
                    "contrast": 20, "highlights": -12, "shadows": -6, "whites": 10, "blacks": -10,
                    "saturation": 26, "vibrance": 20, "temperature": 1, "tint": 2,
                    "clarity": 22, "dehaze": 10, "grain": 2, "grainSize": 8,
                    "colorGrading": { "shadows": { "hue": 235, "sat": 8, "lum": -4 }, "highlights": { "hue": 38, "sat": 12, "lum": 2 } }
                })),
                make_preset("fuji-reala-100", "Fujicolor Reala 100 (4th Layer Botanical)", json!({
                    "contrast": 6, "highlights": -10, "shadows": 8, "whites": 4, "blacks": -4,
                    "saturation": 14, "vibrance": 16, "temperature": -2, "tint": -3,
                    "clarity": 12, "grain": 5, "grainSize": 14
                })),
                make_preset("kodak-kodachrome-25", "Kodachrome 25 (High-Acutance Field Macro)", json!({
                    "contrast": 26, "highlights": -10, "shadows": -12, "whites": 14, "blacks": -14,
                    "saturation": 18, "vibrance": 16, "temperature": 2, "tint": -2,
                    "clarity": 24, "dehaze": 10, "grain": 6, "grainSize": 12
                })),
                make_preset("kodak-epn-100", "Ektachrome EPN 100 (Scientific Neutral)", json!({
                    "contrast": 2, "highlights": -4, "shadows": 2, "whites": 0, "blacks": 0,
                    "saturation": 0, "vibrance": 0, "temperature": 0, "tint": 0,
                    "clarity": 6, "grain": 6, "grainSize": 14
                })),
                make_preset("kodak-e100vs", "Ektachrome 100VS (Vivid Saturation)", json!({
                    "contrast": 22, "highlights": -10, "shadows": -8, "whites": 10, "blacks": -10,
                    "saturation": 28, "vibrance": 22, "temperature": 1, "tint": 1,
                    "clarity": 16, "grain": 8, "grainSize": 16
                })),
                make_preset("kodak-tech-pan-2415", "Technical Pan 2415 (1000 lp/mm B&W)", json!({
                    "contrast": 34, "highlights": -16, "shadows": -12, "whites": 18, "blacks": -18,
                    "saturation": -100, "vibrance": -100, "clarity": 32, "dehaze": 14, "grain": 1, "grainSize": 5
                })),
                make_preset("adox-cms-20-ii", "Adox CMS 20 II Pro (800 lp/mm Micro-film)", json!({
                    "contrast": 30, "highlights": -14, "shadows": -10, "whites": 16, "blacks": -16,
                    "saturation": -100, "vibrance": -100, "clarity": 30, "dehaze": 12, "grain": 1, "grainSize": 4
                })),
                make_preset("adox-silvermax-21", "Adox Silvermax 21 (High Silver Content B&W)", json!({
                    "contrast": 18, "highlights": -8, "shadows": 6, "whites": 10, "blacks": -8,
                    "saturation": -100, "vibrance": -100, "clarity": 16, "grain": 8, "grainSize": 16
                })),
                make_preset("adox-color-mission-200", "Adox Color Mission 200 (Mint & Amber Vintage Color)", json!({
                    "contrast": 14, "highlights": -6, "shadows": 8, "whites": 6, "blacks": -4,
                    "saturation": 16, "vibrance": 18, "temperature": 4, "tint": -6,
                    "clarity": 12, "grain": 16, "grainSize": 22,
                    "colorGrading": { "shadows": { "hue": 160, "sat": 14, "lum": -2 }, "highlights": { "hue": 45, "sat": 16, "lum": 2 } }
                })),
                make_preset("adox-color-implosion-soft", "Adox Color Implosion Soft (Grain & Pastel Shift)", json!({
                    "contrast": 20, "highlights": 8, "shadows": -6, "whites": 12, "blacks": -8,
                    "saturation": 14, "vibrance": 10, "temperature": 8, "tint": 12,
                    "clarity": 14, "grain": 36, "grainSize": 40
                })),
                make_preset("agfa-copex-rapid", "Agfa Copex Rapid (Micro-film High-Res)", json!({
                    "contrast": 26, "highlights": -12, "shadows": -8, "whites": 12, "blacks": -12,
                    "saturation": -100, "vibrance": -100, "clarity": 24, "dehaze": 10, "grain": 3, "grainSize": 8
                })),
                make_preset("agfa-ultra-50", "Agfa Ultra 50 (Hyper-Saturated Color)", json!({
                    "contrast": 24, "highlights": -8, "shadows": -8, "whites": 12, "blacks": -12,
                    "saturation": 36, "vibrance": 28, "temperature": 3, "tint": 4,
                    "clarity": 18, "grain": 6, "grainSize": 14
                })),
            ],
        }),

        // 5. Fujifilm Simulation
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
                make_preset("fuji-instax-mini", "Fujifilm Instax Mini (Vibrant Instant Color)", json!({
                    "contrast": 14, "highlights": -4, "shadows": 8, "whites": 6, "blacks": -2,
                    "saturation": 18, "vibrance": 16, "temperature": 3, "tint": -2,
                    "clarity": 8, "grain": 14, "grainSize": 20,
                    "colorGrading": { "shadows": { "hue": 210, "sat": 8, "lum": 2 }, "highlights": { "hue": 45, "sat": 12, "lum": 1 } }
                })),
                make_preset("fuji-instax-wide", "Fujifilm Instax Wide (Soft Warm Instant)", json!({
                    "contrast": 10, "highlights": -8, "shadows": 12, "whites": 4, "blacks": 0,
                    "saturation": 14, "vibrance": 14, "temperature": 5, "tint": 2,
                    "clarity": 4, "grain": 16, "grainSize": 22,
                    "colorGrading": { "shadows": { "hue": 40, "sat": 10, "lum": 2 }, "highlights": { "hue": 50, "sat": 14, "lum": 0 } }
                })),
                make_preset("fuji-fortia-sp-50", "Fujifilm Fortia SP 50 (Hyper-Vivid Nature & Autumn Slide)", json!({
                    "contrast": 32, "highlights": 10, "shadows": -12, "whites": 18, "blacks": -16,
                    "saturation": 42, "vibrance": 34, "temperature": 3, "tint": 6,
                    "clarity": 22, "dehaze": 14, "grain": 4, "grainSize": 12,
                    "colorGrading": { "shadows": { "hue": 225, "sat": 14, "lum": -4 }, "highlights": { "hue": 35, "sat": 24, "lum": 4 } }
                })),
                make_preset("fuji-velvia-100f", "Fujifilm Velvia 100F (Fidelity Landscape Slide)", json!({
                    "contrast": 26, "highlights": -6, "shadows": -8, "whites": 14, "blacks": -12,
                    "saturation": 30, "vibrance": 24, "temperature": 0, "tint": 2,
                    "clarity": 18, "dehaze": 10, "grain": 5, "grainSize": 14,
                    "colorGrading": { "shadows": { "hue": 220, "sat": 12, "lum": -3 }, "highlights": { "hue": 40, "sat": 16, "lum": 2 } }
                })),
                make_preset("fuji-astia-100f", "Fujifilm Astia 100F (Linear Gradation Macro & Petals)", json!({
                    "contrast": 4, "highlights": -14, "shadows": 10, "whites": -2, "blacks": 2,
                    "saturation": 6, "vibrance": 10, "temperature": 1, "tint": 0,
                    "clarity": 2, "grain": 4, "grainSize": 12,
                    "colorGrading": { "shadows": { "hue": 210, "sat": 6, "lum": 2 }, "highlights": { "hue": 38, "sat": 8, "lum": 1 } }
                })),
                make_preset("fuji-press-800", "Fujicolor Press 800 (Frontline Photojournalism)", json!({
                    "contrast": 16, "highlights": -6, "shadows": 6, "whites": 10, "blacks": -6,
                    "saturation": 16, "vibrance": 18, "temperature": 2, "tint": -1,
                    "clarity": 12, "grain": 24, "grainSize": 28,
                    "colorGrading": { "shadows": { "hue": 200, "sat": 10, "lum": -2 }, "highlights": { "hue": 44, "sat": 14, "lum": 2 } }
                })),
                make_preset("fuji-superia-1600", "Fujicolor Superia 1600 (High-Speed Action & Motorsports)", json!({
                    "contrast": 22, "highlights": 4, "shadows": 6, "whites": 12, "blacks": -10,
                    "saturation": 18, "vibrance": 18, "temperature": -2, "tint": -3,
                    "clarity": 16, "grain": 36, "grainSize": 38,
                    "colorGrading": { "shadows": { "hue": 190, "sat": 12, "lum": -2 }, "highlights": { "hue": 42, "sat": 16, "lum": 2 } }
                })),
                make_preset("fuji-pro-800z", "Fujicolor Pro 800Z (Athletic Action & 4th Layer Color)", json!({
                    "contrast": 12, "highlights": -10, "shadows": 10, "whites": 6, "blacks": -4,
                    "saturation": 12, "vibrance": 14, "temperature": 1, "tint": 1,
                    "clarity": 10, "grain": 22, "grainSize": 26,
                    "colorGrading": { "shadows": { "hue": 210, "sat": 8, "lum": 0 }, "highlights": { "hue": 40, "sat": 10, "lum": 2 } }
                })),
            ],
        }),

        // 6. Kodak Emulation
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
                make_preset("kodak-ebx-100", "Kodak Elite Chrome Extra Color 100 (Sunlit Nature Slide)", json!({
                    "contrast": 26, "highlights": -8, "shadows": -6, "whites": 14, "blacks": -12,
                    "saturation": 32, "vibrance": 24, "temperature": 5, "tint": 2,
                    "clarity": 18, "dehaze": 10, "grain": 6, "grainSize": 16,
                    "colorGrading": { "shadows": { "hue": 220, "sat": 10, "lum": -4 }, "highlights": { "hue": 46, "sat": 20, "lum": 3 } }
                })),
                make_preset("kodak-ektapress-400", "Kodak Ektapress 400 (PJ400 Documentary News)", json!({
                    "contrast": 18, "highlights": -6, "shadows": 6, "whites": 10, "blacks": -8,
                    "saturation": 16, "vibrance": 14, "temperature": 3, "tint": 1,
                    "clarity": 14, "grain": 22, "grainSize": 26,
                    "colorGrading": { "shadows": { "hue": 205, "sat": 8, "lum": -2 }, "highlights": { "hue": 42, "sat": 12, "lum": 2 } }
                })),
                make_preset("kodak-ektapress-1600", "Kodak Ektapress 1600 (PJM Arena Sports Action)", json!({
                    "contrast": 24, "highlights": 6, "shadows": 8, "whites": 14, "blacks": -12,
                    "saturation": 20, "vibrance": 18, "temperature": 2, "tint": 2,
                    "clarity": 18, "grain": 38, "grainSize": 40,
                    "colorGrading": { "shadows": { "hue": 215, "sat": 12, "lum": -2 }, "highlights": { "hue": 40, "sat": 16, "lum": 2 } }
                })),
            ],
        }),

        // 7. Konica Minolta Classics
        PresetItem::Folder(PresetFolder {
            id: "folder-konica-minolta".to_string(),
            name: "Konica Minolta Classics".to_string(),
            children: vec![
                make_preset("konica-impresa-50", "Konica Impresa 50 (Ultra-Fine Grain)", json!({
                    "contrast": 4, "highlights": -10, "shadows": 6, "whites": 2, "blacks": -2,
                    "saturation": 8, "vibrance": 10, "temperature": -1, "tint": -2,
                    "clarity": 18, "grain": 2, "grainSize": 10,
                    "colorGrading": { "shadows": { "hue": 210, "sat": 6, "lum": 0 }, "highlights": { "hue": 38, "sat": 8, "lum": 1 } }
                })),
                make_preset("konica-centuria-200", "Konica Centuria 200 (Warm Skin & Sky Cyan)", json!({
                    "contrast": 10, "highlights": -4, "shadows": 6, "whites": 6, "blacks": -4,
                    "saturation": 12, "vibrance": 14, "temperature": 4, "tint": -2,
                    "clarity": 8, "grain": 16, "grainSize": 22
                })),
                make_preset("sakuracolor-n100", "Sakuracolor N100 (Vintage 1970s)", json!({
                    "contrast": 8, "highlights": 4, "shadows": 8, "whites": -2, "blacks": 4,
                    "saturation": -4, "vibrance": 4, "temperature": 6, "tint": 4,
                    "clarity": 4, "grain": 22, "grainSize": 28
                })),
                make_preset("konica-vx-100", "Konica VX 100 Super (Natural Japanese Color)", json!({
                    "contrast": 8, "highlights": -6, "shadows": 6, "whites": 4, "blacks": -2,
                    "saturation": 10, "vibrance": 12, "temperature": 1, "tint": -1,
                    "clarity": 8, "grain": 12, "grainSize": 18
                })),
                make_preset("konica-centuria-400", "Konica Centuria Super 400 (Vibrant Cyan Skies)", json!({
                    "contrast": 14, "highlights": -4, "shadows": 6, "whites": 8, "blacks": -6,
                    "saturation": 16, "vibrance": 16, "temperature": -2, "tint": 3,
                    "clarity": 10, "grain": 20, "grainSize": 24,
                    "colorGrading": { "shadows": { "hue": 190, "sat": 12, "lum": -2 }, "highlights": { "hue": 40, "sat": 14, "lum": 2 } }
                })),
                make_preset("konica-centuria-800", "Konica Centuria Super 800 (Fast Track & Motorsports)", json!({
                    "contrast": 20, "highlights": 2, "shadows": 8, "whites": 12, "blacks": -10,
                    "saturation": 18, "vibrance": 16, "temperature": -1, "tint": 2,
                    "clarity": 14, "grain": 30, "grainSize": 32,
                    "colorGrading": { "shadows": { "hue": 195, "sat": 14, "lum": -3 }, "highlights": { "hue": 44, "sat": 14, "lum": 2 } }
                })),
            ],
        }),

        // 8. Svema & Eastern Bloc Heritage
        PresetItem::Folder(PresetFolder {
            id: "folder-svema-tasma".to_string(),
            name: "Svema & Eastern Bloc Heritage".to_string(),
            children: vec![
                make_preset("svema-foto-100", "Svema Foto 100 (Silver Contrast B&W)", json!({
                    "contrast": 22, "highlights": -4, "shadows": 6, "whites": 12, "blacks": -10,
                    "saturation": -100, "vibrance": -100, "clarity": 16, "grain": 20, "grainSize": 24
                })),
                make_preset("svema-foto-400", "Svema Foto 400 (Gritty Silver B&W)", json!({
                    "contrast": 26, "highlights": 6, "shadows": -8, "whites": 14, "blacks": -14,
                    "saturation": -100, "vibrance": -100, "clarity": 18, "grain": 34, "grainSize": 36
                })),
                make_preset("svema-mz-3", "Svema MZ-3 (Orthochromatic B&W)", json!({
                    "contrast": 28, "highlights": -10, "shadows": -12, "whites": 14, "blacks": -16,
                    "saturation": -100, "vibrance": -100, "clarity": 22, "grain": 12, "grainSize": 18
                })),
                make_preset("svema-color-125", "Svema Color 125 (Vintage 1980s Color)", json!({
                    "contrast": 6, "highlights": 2, "shadows": 6, "whites": 4, "blacks": 2,
                    "saturation": -12, "vibrance": -4, "temperature": 5, "tint": 6,
                    "clarity": 4, "grain": 24, "grainSize": 30
                })),
                make_preset("tasma-type-42", "Tasma Type-42 (High-Contrast Aerial B&W)", json!({
                    "contrast": 32, "highlights": -14, "shadows": -14, "whites": 18, "blacks": -18,
                    "saturation": -100, "vibrance": -100, "clarity": 26, "dehaze": 12, "grain": 14, "grainSize": 20
                })),
                make_preset("tasma-nk-2", "Tasma NK-2 (Ultra-Fine Document B&W)", json!({
                    "contrast": 26, "highlights": -10, "shadows": -8, "whites": 14, "blacks": -14,
                    "saturation": -100, "vibrance": -100, "clarity": 22, "grain": 8, "grainSize": 14
                })),
                make_preset("tasma-type-25", "Tasma Type-25 (Aero-Recon High-Acutance B&W)", json!({
                    "contrast": 30, "highlights": -12, "shadows": -12, "whites": 16, "blacks": -16,
                    "saturation": -100, "vibrance": -100, "clarity": 28, "dehaze": 10, "grain": 12, "grainSize": 18
                })),
                make_preset("tasma-color-100", "Tasma Color 100 (Warm Muted Vintage Color)", json!({
                    "contrast": 8, "highlights": -4, "shadows": 6, "whites": 4, "blacks": -2,
                    "saturation": 8, "vibrance": 10, "temperature": 6, "tint": 4,
                    "clarity": 6, "grain": 20, "grainSize": 26,
                    "colorGrading": { "shadows": { "hue": 35, "sat": 12, "lum": 0 }, "highlights": { "hue": 48, "sat": 14, "lum": 2 } }
                })),
                make_preset("tasma-color-400", "Tasma Color 400 (Atmospheric Grain Color)", json!({
                    "contrast": 14, "highlights": -2, "shadows": 8, "whites": 6, "blacks": -6,
                    "saturation": 12, "vibrance": 14, "temperature": 4, "tint": 8,
                    "clarity": 8, "grain": 26, "grainSize": 30,
                    "colorGrading": { "shadows": { "hue": 330, "sat": 10, "lum": -2 }, "highlights": { "hue": 40, "sat": 16, "lum": 2 } }
                })),
            ],
        }),

        // 9. European Heritage (Foma, Rollei, Ferrania)
        PresetItem::Folder(PresetFolder {
            id: "folder-euro-classics".to_string(),
            name: "European Heritage".to_string(),
            children: vec![
                make_preset("fomapan-100", "Fomapan 100 Classic (Czech Vintage B&W)", json!({
                    "contrast": 16, "highlights": -6, "shadows": 6, "whites": 8, "blacks": -8,
                    "saturation": -100, "vibrance": -100, "clarity": 12, "grain": 18, "grainSize": 22
                })),
                make_preset("fomapan-400", "Fomapan 400 Action (Gritty Czech B&W)", json!({
                    "contrast": 22, "highlights": 4, "shadows": -6, "whites": 12, "blacks": -12,
                    "saturation": -100, "vibrance": -100, "clarity": 16, "grain": 32, "grainSize": 34
                })),
                make_preset("fomapan-retropan-320", "Retropan 320 Soft (Cinematic B&W)", json!({
                    "contrast": -4, "highlights": -12, "shadows": 10, "whites": -2, "blacks": 4,
                    "saturation": -100, "vibrance": -100, "clarity": -2, "grain": 26, "grainSize": 32
                })),
                make_preset("foma-fomacolor-special", "Fomacolor Special (Vintage Czech Color)", json!({
                    "contrast": 10, "highlights": -6, "shadows": 8, "whites": 4, "blacks": -2,
                    "saturation": 14, "vibrance": 12, "temperature": 4, "tint": -3,
                    "clarity": 8, "grain": 20, "grainSize": 25,
                    "colorGrading": { "shadows": { "hue": 190, "sat": 8, "lum": 0 }, "highlights": { "hue": 42, "sat": 14, "lum": 2 } }
                })),
                make_preset("rollei-retro-80s", "Rollei Retro 80S (Near-IR Deep Contrast)", json!({
                    "contrast": 28, "highlights": 4, "shadows": -12, "whites": 16, "blacks": -16,
                    "saturation": -100, "vibrance": -100, "clarity": 22, "dehaze": 14, "grain": 10, "grainSize": 18
                })),
                make_preset("rollei-ortho-25", "Rollei Ortho 25 (Red-Blind Micro-Contrast)", json!({
                    "contrast": 32, "highlights": -10, "shadows": -14, "whites": 18, "blacks": -18,
                    "saturation": -100, "vibrance": -100, "clarity": 26, "grain": 4, "grainSize": 10
                })),
                make_preset("rollei-infrared-400", "Rollei Infrared 400 (Wood Effect IR)", json!({
                    "contrast": 34, "highlights": 12, "shadows": -16, "whites": 20, "blacks": -20,
                    "saturation": -100, "vibrance": -100, "clarity": 28, "dehaze": 18, "grain": 24, "grainSize": 28
                })),
                make_preset("rollei-crossbird-200", "Rollei Crossbird 200 (Vivid Cross-Process Color)", json!({
                    "contrast": 26, "highlights": 10, "shadows": -8, "whites": 14, "blacks": -12,
                    "saturation": 28, "vibrance": 24, "temperature": -4, "tint": 18,
                    "clarity": 18, "grain": 16, "grainSize": 24,
                    "colorGrading": { "shadows": { "hue": 160, "sat": 22, "lum": -2 }, "highlights": { "hue": 50, "sat": 26, "lum": 4 } }
                })),
                make_preset("rollei-redbird-400", "Rollei Redbird 400 (Redscale Glowing Color)", json!({
                    "contrast": 22, "highlights": -4, "shadows": -8, "whites": 12, "blacks": -10,
                    "saturation": 34, "vibrance": 26, "temperature": 16, "tint": 24,
                    "clarity": 14, "grain": 24, "grainSize": 30,
                    "colorGrading": { "shadows": { "hue": 10, "sat": 28, "lum": -4 }, "highlights": { "hue": 35, "sat": 32, "lum": 4 } }
                })),
                make_preset("rollei-digibase-cn200", "Rollei Digibase CN200 (Unmasked Clean Color)", json!({
                    "contrast": 14, "highlights": -8, "shadows": 6, "whites": 8, "blacks": -6,
                    "saturation": 16, "vibrance": 18, "temperature": 2, "tint": 1,
                    "clarity": 12, "grain": 14, "grainSize": 20
                })),
                make_preset("ferrania-p30", "Film Ferrania P30 (1960s Italian Cinema B&W)", json!({
                    "contrast": 24, "highlights": -8, "shadows": 4, "whites": 12, "blacks": -12,
                    "saturation": -100, "vibrance": -100, "clarity": 18, "grain": 14, "grainSize": 20
                })),
                make_preset("ferrania-orto", "Film Ferrania Orto (Silver Orthochromatic B&W)", json!({
                    "contrast": 30, "highlights": -12, "shadows": -8, "whites": 16, "blacks": -16,
                    "saturation": -100, "vibrance": -100, "clarity": 24, "grain": 8, "grainSize": 14
                })),
                make_preset("ferrania-solaris-200", "Ferrania Solaris 200 (Warm Mediterranean Color)", json!({
                    "contrast": 12, "highlights": -6, "shadows": 6, "whites": 6, "blacks": -4,
                    "saturation": 16, "vibrance": 18, "temperature": 6, "tint": 4,
                    "clarity": 10, "grain": 18, "grainSize": 24,
                    "colorGrading": { "shadows": { "hue": 35, "sat": 12, "lum": -2 }, "highlights": { "hue": 48, "sat": 16, "lum": 2 } }
                })),
                make_preset("ferrania-solaris-fg-100", "Ferrania Solaris FG Plus 100 (Fine Sunlit Color)", json!({
                    "contrast": 10, "highlights": -8, "shadows": 8, "whites": 4, "blacks": -2,
                    "saturation": 14, "vibrance": 16, "temperature": 5, "tint": 3,
                    "clarity": 8, "grain": 12, "grainSize": 18,
                    "colorGrading": { "shadows": { "hue": 40, "sat": 10, "lum": 0 }, "highlights": { "hue": 52, "sat": 14, "lum": 2 } }
                })),
                make_preset("ferrania-solaris-fg-400", "Ferrania Solaris FG Plus 400 (Vibrant Golden Color)", json!({
                    "contrast": 16, "highlights": -4, "shadows": 6, "whites": 8, "blacks": -6,
                    "saturation": 18, "vibrance": 20, "temperature": 7, "tint": 5,
                    "clarity": 10, "grain": 24, "grainSize": 28,
                    "colorGrading": { "shadows": { "hue": 30, "sat": 14, "lum": -2 }, "highlights": { "hue": 45, "sat": 18, "lum": 3 } }
                })),
                make_preset("perutz-primacolor-100", "Perutz Primacolor 100 (West German Pastel)", json!({
                    "contrast": 8, "highlights": -6, "shadows": 6, "whites": 4, "blacks": -2,
                    "saturation": 6, "vibrance": 8, "temperature": -2, "tint": 2,
                    "clarity": 6, "grain": 16, "grainSize": 22
                })),
                make_preset("perutz-peruchrome", "Perutz Peruchrome (Vintage German Slide)", json!({
                    "contrast": 22, "highlights": -10, "shadows": -6, "whites": 12, "blacks": -10,
                    "saturation": 20, "vibrance": 16, "temperature": -1, "tint": 3,
                    "clarity": 14, "grain": 10, "grainSize": 18
                })),
                make_preset("perutz-percolor-200", "Perutz Percolor 200 (Rich Saturated Color)", json!({
                    "contrast": 15, "highlights": -6, "shadows": 6, "whites": 8, "blacks": -6,
                    "saturation": 18, "vibrance": 16, "temperature": 3, "tint": 2,
                    "clarity": 10, "grain": 18, "grainSize": 24
                })),
                make_preset("perutz-peromnia-25", "Perutz Peromnia 25 (Ultra-Sharp Vintage B&W)", json!({
                    "contrast": 26, "highlights": -12, "shadows": -10, "whites": 14, "blacks": -14,
                    "saturation": -100, "vibrance": -100, "clarity": 24, "grain": 4, "grainSize": 10
                })),
            ],
        }),

        // 10. Creative, Shift & Instant
        PresetItem::Folder(PresetFolder {
            id: "folder-creative".to_string(),
            name: "Creative & Instant".to_string(),
            children: vec![
                make_preset("lomochrome-purple", "LomoChrome Purple XR (Color Shift IR)", json!({
                    "contrast": 20, "highlights": -6, "shadows": 4, "whites": 10, "blacks": -8,
                    "saturation": 28, "vibrance": 24, "temperature": -12, "tint": 38,
                    "clarity": 14, "grain": 22, "grainSize": 28,
                    "colorGrading": { "shadows": { "hue": 270, "sat": 28, "lum": -2 }, "highlights": { "hue": 310, "sat": 24, "lum": 4 } }
                })),
                make_preset("lomochrome-metropolis", "LomoChrome Metropolis (Desaturated Industrial)", json!({
                    "contrast": 26, "highlights": 6, "shadows": -10, "whites": 12, "blacks": -12,
                    "saturation": -35, "vibrance": -20, "temperature": 2, "tint": -4,
                    "clarity": 20, "grain": 24, "grainSize": 28
                })),
                make_preset("lomo-color-negative-400", "Lomography Color Tiger 400 (Punchy Saturation)", json!({
                    "contrast": 18, "highlights": -4, "shadows": 6, "whites": 10, "blacks": -8,
                    "saturation": 24, "vibrance": 20, "temperature": 4, "tint": 2,
                    "clarity": 14, "grain": 20, "grainSize": 26,
                    "colorGrading": { "shadows": { "hue": 210, "sat": 8, "lum": -2 }, "highlights": { "hue": 42, "sat": 14, "lum": 2 } }
                })),
                make_preset("lomo-color-negative-800", "Lomography Color 800 (Low-Light Vivid Color)", json!({
                    "contrast": 20, "highlights": 2, "shadows": 8, "whites": 12, "blacks": -10,
                    "saturation": 26, "vibrance": 22, "temperature": 6, "tint": -1,
                    "clarity": 16, "grain": 28, "grainSize": 32,
                    "colorGrading": { "shadows": { "hue": 220, "sat": 10, "lum": -2 }, "highlights": { "hue": 35, "sat": 16, "lum": 3 } }
                })),
                make_preset("harman-phoenix-200", "Harman Phoenix 200 (Halation & Warmth)", json!({
                    "contrast": 22, "highlights": 12, "shadows": -6, "whites": 14, "blacks": -10,
                    "saturation": 24, "vibrance": 18, "temperature": 8, "tint": 12,
                    "clarity": 12, "grain": 32, "grainSize": 34,
                    "colorGrading": { "shadows": { "hue": 15, "sat": 20, "lum": -2 }, "highlights": { "hue": 42, "sat": 22, "lum": 4 } }
                })),
                make_preset("harman-phoenix-warm", "Harman Phoenix Warm Tone (Golden Vintage Color)", json!({
                    "contrast": 20, "highlights": 8, "shadows": -4, "whites": 12, "blacks": -8,
                    "saturation": 22, "vibrance": 20, "temperature": 12, "tint": 16,
                    "clarity": 10, "grain": 30, "grainSize": 32,
                    "colorGrading": { "shadows": { "hue": 25, "sat": 18, "lum": 0 }, "highlights": { "hue": 45, "sat": 24, "lum": 4 } }
                })),
                make_preset("harman-direct-positive", "Harman Direct Positive (High-Contrast B&W)", json!({
                    "contrast": 38, "highlights": 16, "shadows": -18, "whites": 22, "blacks": -22,
                    "saturation": -100, "vibrance": -100, "clarity": 32, "dehaze": 14, "grain": 14, "grainSize": 20
                })),
                make_preset("harman-kentmere-400", "Kentmere Pan 400 (By Harman Smooth B&W)", json!({
                    "contrast": 16, "highlights": -6, "shadows": 6, "whites": 8, "blacks": -8,
                    "saturation": -100, "vibrance": -100, "clarity": 12, "grain": 22, "grainSize": 26
                })),
                make_preset("kodak-aerochrome", "Kodak Aerochrome (IR False-Color Magenta)", json!({
                    "contrast": 24, "highlights": -8, "shadows": -4, "whites": 12, "blacks": -10,
                    "saturation": 36, "vibrance": 30, "temperature": -8, "tint": 45,
                    "clarity": 18, "grain": 16, "grainSize": 22,
                    "colorGrading": { "shadows": { "hue": 320, "sat": 32, "lum": -2 }, "highlights": { "hue": 345, "sat": 36, "lum": 4 } }
                })),
                make_preset("polaroid-sx70", "Polaroid SX-70 (Soft Vintage Instant)", json!({
                    "contrast": -10, "highlights": 12, "shadows": 14, "whites": -10, "blacks": 12,
                    "saturation": -10, "vibrance": 8, "temperature": 8, "tint": 4,
                    "clarity": -6, "grain": 24, "grainSize": 32,
                    "colorGrading": { "shadows": { "hue": 130, "sat": 10, "lum": 4 }, "highlights": { "hue": 42, "sat": 14, "lum": -2 } }
                })),
                make_preset("polaroid-itype-color", "Polaroid i-Type Color (Modern Instant Warmth)", json!({
                    "contrast": -4, "highlights": 8, "shadows": 10, "whites": -6, "blacks": 8,
                    "saturation": 8, "vibrance": 12, "temperature": 4, "tint": 2,
                    "clarity": -2, "grain": 22, "grainSize": 30,
                    "colorGrading": { "shadows": { "hue": 190, "sat": 8, "lum": 2 }, "highlights": { "hue": 40, "sat": 14, "lum": 0 } }
                })),
                make_preset("polaroid-spectra", "Polaroid Spectra (Wide Format Vivid Color)", json!({
                    "contrast": 6, "highlights": 6, "shadows": 4, "whites": 4, "blacks": 2,
                    "saturation": 14, "vibrance": 14, "temperature": 3, "tint": 0,
                    "clarity": 2, "grain": 20, "grainSize": 28,
                    "colorGrading": { "shadows": { "hue": 200, "sat": 10, "lum": 0 }, "highlights": { "hue": 48, "sat": 16, "lum": 2 } }
                })),
                make_preset("lomochrome-turquoise", "LomoChrome Turquoise XR (Teal & Gold Shift)", json!({
                    "contrast": 22, "highlights": -8, "shadows": 6, "whites": 10, "blacks": -8,
                    "saturation": 30, "vibrance": 26, "temperature": -18, "tint": -24,
                    "clarity": 16, "grain": 22, "grainSize": 28,
                    "colorGrading": { "shadows": { "hue": 180, "sat": 30, "lum": -4 }, "highlights": { "hue": 40, "sat": 28, "lum": 4 } }
                })),
                make_preset("adox-color-implosion", "Adox Color Implosion (Grain Explosion)", json!({
                    "contrast": 28, "highlights": 14, "shadows": -12, "whites": 16, "blacks": -14,
                    "saturation": 18, "vibrance": 12, "temperature": 10, "tint": 8,
                    "clarity": 20, "grain": 45, "grainSize": 48
                })),
                make_preset("polaroid-type-55", "Polaroid Type 55 (Fine Grain B&W Positive/Neg)", json!({
                    "contrast": 16, "highlights": -8, "shadows": 8, "whites": 8, "blacks": -8,
                    "saturation": -100, "vibrance": -100, "clarity": 14, "grain": 6, "grainSize": 14
                })),
                make_preset("catlabs-x-80", "CatLABS X Film 80 (Traditional Fine Grain B&W)", json!({
                    "contrast": 20, "highlights": -8, "shadows": 4, "whites": 10, "blacks": -10,
                    "saturation": -100, "vibrance": -100, "clarity": 18, "grain": 6, "grainSize": 14
                })),
                make_preset("catlabs-x-320", "CatLABS X Film 320 (High-Acutance Silver B&W)", json!({
                    "contrast": 26, "highlights": 6, "shadows": -8, "whites": 14, "blacks": -14,
                    "saturation": -100, "vibrance": -100, "clarity": 22, "grain": 20, "grainSize": 26
                })),
                make_preset("catlabs-x-100", "CatLABS X Film 100 (Medium Contrast Portrait B&W)", json!({
                    "contrast": 16, "highlights": -8, "shadows": 6, "whites": 8, "blacks": -6,
                    "saturation": -100, "vibrance": -100, "clarity": 14, "grain": 10, "grainSize": 18
                })),
                make_preset("catlabs-color-100", "CatLABS Color 100 (Studio Saturation)", json!({
                    "contrast": 14, "highlights": -6, "shadows": 6, "whites": 8, "blacks": -6,
                    "saturation": 16, "vibrance": 18, "temperature": 2, "tint": 1,
                    "clarity": 12, "grain": 14, "grainSize": 20,
                    "colorGrading": { "shadows": { "hue": 215, "sat": 8, "lum": -2 }, "highlights": { "hue": 42, "sat": 14, "lum": 2 } }
                })),
                make_preset("catlabs-color-400", "CatLABS Color 400 (Warm Amber Natural Color)", json!({
                    "contrast": 12, "highlights": -4, "shadows": 8, "whites": 6, "blacks": -4,
                    "saturation": 14, "vibrance": 16, "temperature": 6, "tint": 4,
                    "clarity": 10, "grain": 22, "grainSize": 26,
                    "colorGrading": { "shadows": { "hue": 35, "sat": 12, "lum": 0 }, "highlights": { "hue": 48, "sat": 16, "lum": 2 } }
                })),
                make_preset("kono-delight-art-100", "Kono! Delight Art 100 (Warm Tinted Color)", json!({
                    "contrast": 14, "highlights": -4, "shadows": 6, "whites": 8, "blacks": -4,
                    "saturation": 18, "vibrance": 20, "temperature": 8, "tint": 10,
                    "clarity": 10, "grain": 16, "grainSize": 24,
                    "colorGrading": { "shadows": { "hue": 35, "sat": 14, "lum": 0 }, "highlights": { "hue": 45, "sat": 18, "lum": 2 } }
                })),
                make_preset("kono-rotwild-efx", "Kono! Rotwild 400 (Redscale Pre-exposed)", json!({
                    "contrast": 24, "highlights": -6, "shadows": -10, "whites": 12, "blacks": -12,
                    "saturation": 32, "vibrance": 24, "temperature": 18, "tint": 28,
                    "clarity": 16, "grain": 24, "grainSize": 30,
                    "colorGrading": { "shadows": { "hue": 15, "sat": 30, "lum": -4 }, "highlights": { "hue": 30, "sat": 36, "lum": 4 } }
                })),
                make_preset("kono-rekorder-100", "Kono! Rekorder 100 (Pre-Exposed Numbers Color)", json!({
                    "contrast": 16, "highlights": -6, "shadows": 6, "whites": 8, "blacks": -6,
                    "saturation": 16, "vibrance": 18, "temperature": 4, "tint": -2,
                    "clarity": 12, "grain": 18, "grainSize": 24
                })),
                make_preset("kono-kolorit-400", "Kono! Kolorit 400 Tungsten (Moody Teal & Orange)", json!({
                    "contrast": 18, "highlights": 8, "shadows": -4, "whites": 12, "blacks": -8,
                    "saturation": 22, "vibrance": 18, "temperature": -8, "tint": 14,
                    "clarity": 14, "grain": 22, "grainSize": 28,
                    "colorGrading": { "shadows": { "hue": 195, "sat": 24, "lum": -2 }, "highlights": { "hue": 35, "sat": 28, "lum": 4 } }
                })),
                make_preset("kono-monolith-64", "Kono! Monolith 64 (Special Effect B&W)", json!({
                    "contrast": 32, "highlights": 10, "shadows": -14, "whites": 18, "blacks": -18,
                    "saturation": -100, "vibrance": -100, "clarity": 26, "grain": 14, "grainSize": 20
                })),
                make_preset("washi-film-w", "Film Washi W 25 (Handmade Japanese Paper B&W)", json!({
                    "contrast": 34, "highlights": 16, "shadows": -16, "whites": 20, "blacks": -20,
                    "saturation": -100, "vibrance": -100, "clarity": 30, "dehaze": 14, "grain": 40, "grainSize": 45, "grainRoughness": 50
                })),
                make_preset("washi-film-v", "Film Washi V 100 (Handcrafted Fiber Base B&W)", json!({
                    "contrast": 28, "highlights": 8, "shadows": -12, "whites": 16, "blacks": -16,
                    "saturation": -100, "vibrance": -100, "clarity": 24, "grain": 32, "grainSize": 36
                })),
                make_preset("washi-film-x", "Film Washi X 100 (Maskless Technical Color)", json!({
                    "contrast": 18, "highlights": -10, "shadows": 8, "whites": 10, "blacks": -8,
                    "saturation": -12, "vibrance": 6, "temperature": 4, "tint": 12,
                    "clarity": 14, "grain": 18, "grainSize": 24,
                    "colorGrading": { "shadows": { "hue": 330, "sat": 14, "lum": -2 }, "highlights": { "hue": 40, "sat": 16, "lum": 2 } }
                })),
                make_preset("washi-film-f", "Film Washi F 100 (Fluorographic Medical Color)", json!({
                    "contrast": 22, "highlights": 12, "shadows": -8, "whites": 14, "blacks": -12,
                    "saturation": 14, "vibrance": 12, "temperature": -10, "tint": 20,
                    "clarity": 16, "grain": 20, "grainSize": 25,
                    "colorGrading": { "shadows": { "hue": 180, "sat": 18, "lum": 2 }, "highlights": { "hue": 320, "sat": 20, "lum": 2 } }
                })),
                make_preset("washi-film-s", "Film Washi S 50 (Sound Recording Technical Color)", json!({
                    "contrast": 28, "highlights": -6, "shadows": -12, "whites": 16, "blacks": -14,
                    "saturation": 20, "vibrance": 16, "temperature": 2, "tint": -4,
                    "clarity": 22, "grain": 6, "grainSize": 12
                })),
            ],
        }),

        // 11. Ilford Black & White
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
            ],
        }),

        // 12. Cinematic & Vintage
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
                make_preset("cine-cinestill-400d", "CineStill 400D (Dynamic Daylight Cinema)", json!({
                    "contrast": 14, "highlights": -4, "shadows": 6, "whites": 8, "blacks": -4,
                    "saturation": 12, "vibrance": 10, "temperature": 2, "tint": 1,
                    "clarity": 10, "grain": 14, "grainSize": 22,
                    "colorGrading": { "shadows": { "hue": 210, "sat": 6, "lum": -2 }, "highlights": { "hue": 25, "sat": 12, "lum": 2 } }
                })),
                make_preset("cine-cinestill-50d", "CineStill 50D (Daylight Clean)", json!({
                    "contrast": 12, "highlights": -6, "shadows": 6, "whites": 6, "blacks": -4,
                    "saturation": 14, "vibrance": 12, "temperature": 2, "tint": -1,
                    "clarity": 12, "grain": 8, "grainSize": 16,
                    "colorGrading": { "shadows": { "hue": 210, "sat": 8, "lum": -2 }, "highlights": { "hue": 40, "sat": 10, "lum": 2 } }
                })),
                make_preset("cine-cinestill-redscale-400", "CineStill Redscale 400 (Warm Amber Halation)", json!({
                    "contrast": 22, "highlights": -4, "shadows": -8, "whites": 12, "blacks": -10,
                    "saturation": 30, "vibrance": 24, "temperature": 16, "tint": 22,
                    "clarity": 12, "grain": 24, "grainSize": 28,
                    "colorGrading": { "shadows": { "hue": 18, "sat": 28, "lum": -4 }, "highlights": { "hue": 38, "sat": 32, "lum": 4 } }
                })),
                make_preset("cine-cinestill-800t-warm", "CineStill 800T Warm (Street Light Glow)", json!({
                    "contrast": 18, "highlights": 14, "shadows": 6, "whites": 16, "blacks": -8,
                    "saturation": 14, "vibrance": 16, "temperature": -2, "tint": 16,
                    "clarity": 8, "grain": 26, "grainSize": 32,
                    "colorGrading": { "shadows": { "hue": 190, "sat": 14, "lum": 0 }, "highlights": { "hue": 22, "sat": 28, "lum": 4 } }
                })),
                make_preset("cine-eterna-bleach-bypass", "Fujifilm Eterna Bleach Bypass", json!({
                    "contrast": 32, "highlights": 14, "shadows": -16, "whites": 18, "blacks": -18,
                    "saturation": -45, "vibrance": -25, "temperature": -2, "tint": -4,
                    "clarity": 24, "grain": 16, "grainSize": 24
                })),
                make_preset("cine-eastman-5247", "Kodak Eastman 5247 (1970s Hollywood ECN-2)", json!({
                    "contrast": 18, "highlights": -8, "shadows": 6, "whites": 10, "blacks": -8,
                    "saturation": 14, "vibrance": 12, "temperature": 6, "tint": 4,
                    "clarity": 12, "grain": 20, "grainSize": 26,
                    "colorGrading": { "shadows": { "hue": 35, "sat": 12, "lum": -4 }, "highlights": { "hue": 48, "sat": 16, "lum": 2 } }
                })),
                make_preset("cine-vision3-50d", "Kodak Vision3 50D (Fine Grain IMAX)", json!({
                    "contrast": 10, "highlights": -8, "shadows": 4, "whites": 4, "blacks": -4,
                    "saturation": 8, "vibrance": 10, "temperature": 1, "tint": -1,
                    "clarity": 14, "grain": 6, "grainSize": 14
                })),
                make_preset("cine-orwo-nc500", "ORWO Wolfen NC500 (1960s German Cinema)", json!({
                    "contrast": 16, "highlights": -4, "shadows": 8, "whites": 6, "blacks": -6,
                    "saturation": -10, "vibrance": 4, "temperature": 3, "tint": -5,
                    "clarity": 10, "grain": 22, "grainSize": 28
                })),
                make_preset("cine-orwo-nc400", "ORWO Wolfen NC400 (Moody Amber Cine Color)", json!({
                    "contrast": 18, "highlights": -6, "shadows": 6, "whites": 8, "blacks": -8,
                    "saturation": 14, "vibrance": 12, "temperature": 6, "tint": -2,
                    "clarity": 12, "grain": 20, "grainSize": 26,
                    "colorGrading": { "shadows": { "hue": 35, "sat": 14, "lum": -2 }, "highlights": { "hue": 50, "sat": 16, "lum": 2 } }
                })),
                make_preset("cine-orwo-color-qrs", "ORWO Color QRS 100 (Classic European Color)", json!({
                    "contrast": 12, "highlights": -8, "shadows": 10, "whites": 4, "blacks": -2,
                    "saturation": 16, "vibrance": 14, "temperature": 2, "tint": 1,
                    "clarity": 8, "grain": 14, "grainSize": 20
                })),
                make_preset("cine-orwo-np15", "ORWO Wolfen NP15 (Classic German B&W)", json!({
                    "contrast": 24, "highlights": -6, "shadows": 4, "whites": 12, "blacks": -12,
                    "saturation": -100, "vibrance": -100, "clarity": 20, "grain": 10, "grainSize": 16
                })),
                make_preset("cine-orwo-ut18", "ORWO Chrom UT18 (Vintage Chrome Slide)", json!({
                    "contrast": 20, "highlights": -8, "shadows": -6, "whites": 10, "blacks": -8,
                    "saturation": 18, "vibrance": 14, "temperature": 2, "tint": 4,
                    "clarity": 14, "grain": 14, "grainSize": 20
                })),
                make_preset("cine-tarkovsky", "Tarkovsky's (Art-House Cinema)", json!({
                    "contrast": 12, "highlights": -10, "shadows": 10, "whites": 4, "blacks": 0,
                    "saturation": -14, "vibrance": 2, "temperature": 4, "tint": 6,
                    "clarity": 6, "grain": 24, "grainSize": 30,
                    "colorGrading": { "shadows": { "hue": 40, "sat": 10, "lum": 2 }, "highlights": { "hue": 210, "sat": 12, "lum": -2 } }
                })),
                make_preset("cine-eastman-5248", "Eastman Color 5248 (1950s-60s Hollywood)", json!({
                    "contrast": 16, "highlights": -6, "shadows": 4, "whites": 8, "blacks": -6,
                    "saturation": 18, "vibrance": 14, "temperature": 5, "tint": 2,
                    "clarity": 10, "grain": 18, "grainSize": 24,
                    "colorGrading": { "shadows": { "hue": 30, "sat": 10, "lum": -2 }, "highlights": { "hue": 45, "sat": 14, "lum": 2 } }
                })),
                make_preset("cine-plus-x-5231", "Kodak Plus-X Pan 5231 (1940s-50s Hollywood B&W)", json!({
                    "contrast": 18, "highlights": -8, "shadows": 6, "whites": 10, "blacks": -10,
                    "saturation": -100, "vibrance": -100, "clarity": 14, "grain": 16, "grainSize": 22
                })),
                make_preset("cine-super8-k40", "Super 8 Kodachrome 40 (Vintage Home Movie)", json!({
                    "contrast": 22, "highlights": -10, "shadows": -6, "whites": 12, "blacks": -12,
                    "saturation": 20, "vibrance": 18, "temperature": 6, "tint": -2,
                    "clarity": 12, "grain": 28, "grainSize": 34,
                    "colorGrading": { "shadows": { "hue": 210, "sat": 14, "lum": -4 }, "highlights": { "hue": 42, "sat": 16, "lum": 3 } }
                })),
                make_preset("cine-ektachrome-100d", "Kodak Ektachrome 100D (5294 16mm/Super8)", json!({
                    "contrast": 20, "highlights": -12, "shadows": -4, "whites": 10, "blacks": -10,
                    "saturation": 22, "vibrance": 18, "temperature": -2, "tint": 2,
                    "clarity": 16, "grain": 14, "grainSize": 20
                })),
                make_preset("cine-technicolor-3strip", "Technicolor 3-Strip (Process IV Saturated)", json!({
                    "contrast": 26, "highlights": -6, "shadows": -8, "whites": 14, "blacks": -12,
                    "saturation": 36, "vibrance": 28, "temperature": -2, "tint": 12,
                    "clarity": 18, "grain": 12, "grainSize": 18,
                    "colorGrading": { "shadows": { "hue": 210, "sat": 20, "lum": -2 }, "highlights": { "hue": 15, "sat": 32, "lum": 4 } }
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

        // 13. Silberra
        PresetItem::Folder(PresetFolder {
            id: "folder-silberra".to_string(),
            name: "Silberra Analog".to_string(),
            children: vec![
                make_preset("silberra-color-100", "Silberra Color 100 (Warm Muted Cinema)", json!({
                    "contrast": 12, "highlights": -6, "shadows": 6, "whites": 6, "blacks": -4,
                    "saturation": 14, "vibrance": 16, "temperature": 4, "tint": 2,
                    "clarity": 10, "grain": 16, "grainSize": 22,
                    "colorGrading": { "shadows": { "hue": 35, "sat": 12, "lum": 0 }, "highlights": { "hue": 46, "sat": 14, "lum": 2 } }
                })),
                make_preset("silberra-color-160", "Silberra Color 160 (Fine Grain Portrait)", json!({
                    "contrast": 10, "highlights": -8, "shadows": 8, "whites": 4, "blacks": -2,
                    "saturation": 12, "vibrance": 14, "temperature": 2, "tint": -1,
                    "clarity": 8, "grain": 12, "grainSize": 18
                })),
                make_preset("silberra-pan-200", "Silberra Pan 200 (High-Silver Acutance B&W)", json!({
                    "contrast": 22, "highlights": -4, "shadows": 4, "whites": 12, "blacks": -10,
                    "saturation": -100, "vibrance": -100, "clarity": 18, "grain": 14, "grainSize": 20
                })),
                make_preset("silberra-orto-50", "Silberra Orto 50 (Orthochromatic Ultra-Fine B&W)", json!({
                    "contrast": 30, "highlights": -12, "shadows": -10, "whites": 16, "blacks": -16,
                    "saturation": -100, "vibrance": -100, "clarity": 26, "grain": 4, "grainSize": 10
                })),
            ],
        }),

        // 14. Original Wolfen
        PresetItem::Folder(PresetFolder {
            id: "folder-original-wolfen".to_string(),
            name: "Original Wolfen".to_string(),
            children: vec![
                make_preset("original-wolfen-nc500", "Original Wolfen NC500 (Authentic Cine Color)", json!({
                    "contrast": 16, "highlights": -4, "shadows": 8, "whites": 6, "blacks": -6,
                    "saturation": 12, "vibrance": 14, "temperature": 3, "tint": -4,
                    "clarity": 10, "grain": 22, "grainSize": 26,
                    "colorGrading": { "shadows": { "hue": 195, "sat": 10, "lum": -2 }, "highlights": { "hue": 40, "sat": 12, "lum": 2 } }
                })),
                make_preset("original-wolfen-nc400", "Original Wolfen NC400 (Warm Amber Natural)", json!({
                    "contrast": 18, "highlights": -6, "shadows": 6, "whites": 8, "blacks": -8,
                    "saturation": 16, "vibrance": 14, "temperature": 6, "tint": -1,
                    "clarity": 12, "grain": 20, "grainSize": 24,
                    "colorGrading": { "shadows": { "hue": 35, "sat": 14, "lum": -2 }, "highlights": { "hue": 48, "sat": 16, "lum": 2 } }
                })),
                make_preset("original-wolfen-np100", "Original Wolfen NP100 (Fine Grain B&W)", json!({
                    "contrast": 20, "highlights": -8, "shadows": 4, "whites": 10, "blacks": -10,
                    "saturation": -100, "vibrance": -100, "clarity": 16, "grain": 8, "grainSize": 14
                })),
                make_preset("original-wolfen-dp31", "Original Wolfen DP31 (Sound/Motion B&W)", json!({
                    "contrast": 28, "highlights": 6, "shadows": -8, "whites": 14, "blacks": -14,
                    "saturation": -100, "vibrance": -100, "clarity": 22, "grain": 12, "grainSize": 18
                })),
            ],
        }),

        // 15. Yodica
        PresetItem::Folder(PresetFolder {
            id: "folder-yodica".to_string(),
            name: "Yodica Special FX".to_string(),
            children: vec![
                make_preset("yodica-antares", "Yodica Antares (Warm Amber & Orange Burst)", json!({
                    "contrast": 22, "highlights": 10, "shadows": -6, "whites": 14, "blacks": -10,
                    "saturation": 28, "vibrance": 24, "temperature": 18, "tint": 20,
                    "clarity": 12, "grain": 22, "grainSize": 28,
                    "colorGrading": { "shadows": { "hue": 25, "sat": 26, "lum": -2 }, "highlights": { "hue": 40, "sat": 32, "lum": 4 } }
                })),
                make_preset("yodica-sirio", "Yodica Sirio (Cool Cyan & Electric Blue Shift)", json!({
                    "contrast": 20, "highlights": 6, "shadows": -4, "whites": 12, "blacks": -8,
                    "saturation": 26, "vibrance": 22, "temperature": -22, "tint": -14,
                    "clarity": 14, "grain": 20, "grainSize": 26,
                    "colorGrading": { "shadows": { "hue": 210, "sat": 28, "lum": -4 }, "highlights": { "hue": 185, "sat": 30, "lum": 2 } }
                })),
                make_preset("yodica-polaris", "Yodica Polaris (Vivid Violet & Magenta Glow)", json!({
                    "contrast": 24, "highlights": 8, "shadows": -8, "whites": 14, "blacks": -12,
                    "saturation": 30, "vibrance": 26, "temperature": -10, "tint": 36,
                    "clarity": 16, "grain": 24, "grainSize": 30,
                    "colorGrading": { "shadows": { "hue": 280, "sat": 28, "lum": -2 }, "highlights": { "hue": 325, "sat": 32, "lum": 4 } }
                })),
                make_preset("yodica-atlas", "Yodica Atlas (Rainbow Spectrum Color Shift)", json!({
                    "contrast": 26, "highlights": 12, "shadows": -10, "whites": 16, "blacks": -14,
                    "saturation": 32, "vibrance": 28, "temperature": 8, "tint": 18,
                    "clarity": 18, "grain": 26, "grainSize": 32,
                    "colorGrading": { "shadows": { "hue": 160, "sat": 24, "lum": -2 }, "highlights": { "hue": 350, "sat": 28, "lum": 4 } }
                })),
            ],
        }),

        // 16. Luckyfilm
        PresetItem::Folder(PresetFolder {
            id: "folder-luckyfilm".to_string(),
            name: "Luckyfilm Classics".to_string(),
            children: vec![
                make_preset("luckyfilm-color-200", "Luckyfilm Color 200 (Heritage Chinese Color)", json!({
                    "contrast": 14, "highlights": -4, "shadows": 6, "whites": 8, "blacks": -6,
                    "saturation": 16, "vibrance": 18, "temperature": 5, "tint": 3,
                    "clarity": 10, "grain": 18, "grainSize": 24,
                    "colorGrading": { "shadows": { "hue": 30, "sat": 12, "lum": -2 }, "highlights": { "hue": 46, "sat": 14, "lum": 2 } }
                })),
                make_preset("luckyfilm-color-400", "Luckyfilm Color 400 (Atmospheric Street Color)", json!({
                    "contrast": 18, "highlights": 2, "shadows": 6, "whites": 10, "blacks": -8,
                    "saturation": 18, "vibrance": 16, "temperature": 6, "tint": 4,
                    "clarity": 12, "grain": 24, "grainSize": 28
                })),
                make_preset("luckyfilm-shd-100", "Luckyfilm SHD 100 (Classic Silver Acutance B&W)", json!({
                    "contrast": 22, "highlights": -6, "shadows": 4, "whites": 12, "blacks": -10,
                    "saturation": -100, "vibrance": -100, "clarity": 16, "grain": 12, "grainSize": 18
                })),
                make_preset("luckyfilm-shd-400", "Luckyfilm SHD 400 (Gritty Punchy B&W)", json!({
                    "contrast": 26, "highlights": 6, "shadows": -6, "whites": 14, "blacks": -14,
                    "saturation": -100, "vibrance": -100, "clarity": 20, "grain": 28, "grainSize": 32
                })),
            ],
        }),

        // 17. Dubblefilm
        PresetItem::Folder(PresetFolder {
            id: "folder-dubblefilm".to_string(),
            name: "Dubblefilm Creative".to_string(),
            children: vec![
                make_preset("dubblefilm-apollo", "Dubblefilm Apollo (Warm Yellow & Amber Tint)", json!({
                    "contrast": 16, "highlights": 8, "shadows": 4, "whites": 10, "blacks": -6,
                    "saturation": 22, "vibrance": 20, "temperature": 16, "tint": 12,
                    "clarity": 10, "grain": 20, "grainSize": 26,
                    "colorGrading": { "shadows": { "hue": 35, "sat": 22, "lum": 0 }, "highlights": { "hue": 50, "sat": 28, "lum": 4 } }
                })),
                make_preset("dubblefilm-pacific", "Dubblefilm Pacific (Deep Ocean Blue & Cyan)", json!({
                    "contrast": 18, "highlights": -4, "shadows": 6, "whites": 8, "blacks": -8,
                    "saturation": 20, "vibrance": 18, "temperature": -18, "tint": -10,
                    "clarity": 12, "grain": 22, "grainSize": 26,
                    "colorGrading": { "shadows": { "hue": 215, "sat": 24, "lum": -2 }, "highlights": { "hue": 190, "sat": 26, "lum": 2 } }
                })),
                make_preset("dubblefilm-solar", "Dubblefilm Solar (Sunburst Golden Flare)", json!({
                    "contrast": 20, "highlights": 14, "shadows": -4, "whites": 16, "blacks": -8,
                    "saturation": 26, "vibrance": 22, "temperature": 22, "tint": 18,
                    "clarity": 14, "grain": 24, "grainSize": 28,
                    "colorGrading": { "shadows": { "hue": 20, "sat": 28, "lum": -2 }, "highlights": { "hue": 42, "sat": 36, "lum": 6 } }
                })),
                make_preset("dubblefilm-monsoon", "Dubblefilm Monsoon (Moody Muted Turquoise)", json!({
                    "contrast": 14, "highlights": -8, "shadows": 8, "whites": 6, "blacks": -4,
                    "saturation": 14, "vibrance": 16, "temperature": -12, "tint": 10,
                    "clarity": 8, "grain": 22, "grainSize": 26,
                    "colorGrading": { "shadows": { "hue": 180, "sat": 18, "lum": 2 }, "highlights": { "hue": 290, "sat": 16, "lum": 0 } }
                })),
            ],
        }),

        // 18. Amber Film Co.
        PresetItem::Folder(PresetFolder {
            id: "folder-amber-film".to_string(),
            name: "Amber Film Co.".to_string(),
            children: vec![
                make_preset("amber-t800", "Amber T800 (Tungsten Cine Night)", json!({
                    "contrast": 22, "highlights": 12, "shadows": 6, "whites": 14, "blacks": -10,
                    "saturation": 20, "vibrance": 18, "temperature": -14, "tint": 12,
                    "clarity": 14, "grain": 32, "grainSize": 34,
                    "colorGrading": { "shadows": { "hue": 215, "sat": 16, "lum": -4 }, "highlights": { "hue": 35, "sat": 24, "lum": 4 } }
                })),
                make_preset("amber-d400", "Amber D400 (Daylight Warm Cine)", json!({
                    "contrast": 14, "highlights": -6, "shadows": 8, "whites": 8, "blacks": -6,
                    "saturation": 16, "vibrance": 16, "temperature": 6, "tint": 2,
                    "clarity": 10, "grain": 20, "grainSize": 25,
                    "colorGrading": { "shadows": { "hue": 200, "sat": 8, "lum": -1 }, "highlights": { "hue": 45, "sat": 14, "lum": 2 } }
                })),
                make_preset("amber-400-color", "Amber 400 Color (Retro Pastel Street)", json!({
                    "contrast": 12, "highlights": -8, "shadows": 10, "whites": 6, "blacks": -4,
                    "saturation": 14, "vibrance": 16, "temperature": 8, "tint": 4,
                    "clarity": 8, "grain": 22, "grainSize": 26,
                    "colorGrading": { "shadows": { "hue": 160, "sat": 10, "lum": 1 }, "highlights": { "hue": 40, "sat": 16, "lum": 2 } }
                })),
                make_preset("amber-100-fine", "Amber 100 Fine (Sunlit Summer)", json!({
                    "contrast": 16, "highlights": -4, "shadows": 4, "whites": 10, "blacks": -6,
                    "saturation": 22, "vibrance": 20, "temperature": 4, "tint": 0,
                    "clarity": 12, "grain": 10, "grainSize": 18,
                    "colorGrading": { "shadows": { "hue": 210, "sat": 10, "lum": -2 }, "highlights": { "hue": 42, "sat": 18, "lum": 3 } }
                })),
            ],
        }),

        // 19. Candido Film
        PresetItem::Folder(PresetFolder {
            id: "folder-candido".to_string(),
            name: "Candido Film".to_string(),
            children: vec![
                make_preset("candido-200", "Candido 200 (Soft Pastel Everyday)", json!({
                    "contrast": 8, "highlights": -10, "shadows": 12, "whites": 2, "blacks": 2,
                    "saturation": 10, "vibrance": 12, "temperature": 3, "tint": -1,
                    "clarity": 4, "grain": 14, "grainSize": 20,
                    "colorGrading": { "shadows": { "hue": 205, "sat": 6, "lum": 1 }, "highlights": { "hue": 42, "sat": 10, "lum": 2 } }
                })),
                make_preset("candido-400", "Candido 400 (Atmospheric Portrait)", json!({
                    "contrast": 12, "highlights": -6, "shadows": 8, "whites": 6, "blacks": -4,
                    "saturation": 14, "vibrance": 16, "temperature": 5, "tint": 2,
                    "clarity": 8, "grain": 20, "grainSize": 25,
                    "colorGrading": { "shadows": { "hue": 210, "sat": 8, "lum": 0 }, "highlights": { "hue": 38, "sat": 12, "lum": 2 } }
                })),
                make_preset("candido-800", "Candido 800 (Neon Night Street)", json!({
                    "contrast": 20, "highlights": 10, "shadows": 6, "whites": 12, "blacks": -8,
                    "saturation": 22, "vibrance": 20, "temperature": -8, "tint": -4,
                    "clarity": 14, "grain": 32, "grainSize": 35,
                    "colorGrading": { "shadows": { "hue": 220, "sat": 14, "lum": -4 }, "highlights": { "hue": 340, "sat": 18, "lum": 4 } }
                })),
                make_preset("candido-bw-400", "Candido B&W 400 (Classic Silver Monochromatic)", json!({
                    "contrast": 18, "highlights": -8, "shadows": 6, "whites": 10, "blacks": -8,
                    "saturation": -100, "vibrance": -100, "clarity": 14, "grain": 22, "grainSize": 26
                })),
            ],
        }),

        // 20. Kosmo Foto
        PresetItem::Folder(PresetFolder {
            id: "folder-kosmo-foto".to_string(),
            name: "Kosmo Foto".to_string(),
            children: vec![
                make_preset("kosmo-foto-mono-100", "Kosmo Foto Mono 100 (Classic Street B&W)", json!({
                    "contrast": 20, "highlights": -8, "shadows": 4, "whites": 10, "blacks": -10,
                    "saturation": -100, "vibrance": -100, "clarity": 16, "grain": 14, "grainSize": 20
                })),
                make_preset("kosmo-foto-agent-shadow", "Kosmo Foto Agent Shadow 400 (Noir High-Contrast B&W)", json!({
                    "contrast": 30, "highlights": 12, "shadows": -14, "whites": 16, "blacks": -16,
                    "saturation": -100, "vibrance": -100, "clarity": 24, "grain": 34, "grainSize": 36
                })),
                make_preset("kosmo-foto-sky-lite", "Kosmo Foto Sky Lite 100 (Soft Tonal B&W)", json!({
                    "contrast": 12, "highlights": -12, "shadows": 10, "whites": 6, "blacks": -4,
                    "saturation": -100, "vibrance": -100, "clarity": 10, "grain": 10, "grainSize": 18
                })),
            ],
        }),

        // 21. Reflxg Labs
        PresetItem::Folder(PresetFolder {
            id: "folder-reflxg".to_string(),
            name: "Reflxg Labs".to_string(),
            children: vec![
                make_preset("reflxg-pro-100", "Reflxg Pro 100 (Daylight Cinema)", json!({
                    "contrast": 14, "highlights": -8, "shadows": 6, "whites": 8, "blacks": -4,
                    "saturation": 14, "vibrance": 16, "temperature": 0, "tint": -1,
                    "clarity": 10, "grain": 8, "grainSize": 16,
                    "colorGrading": { "shadows": { "hue": 195, "sat": 8, "lum": -1 }, "highlights": { "hue": 40, "sat": 12, "lum": 2 } }
                })),
                make_preset("reflxg-pro-400", "Reflxg Pro 400 (Versatile Cinema Color)", json!({
                    "contrast": 16, "highlights": -6, "shadows": 8, "whites": 10, "blacks": -6,
                    "saturation": 16, "vibrance": 18, "temperature": 3, "tint": 1,
                    "clarity": 12, "grain": 18, "grainSize": 24,
                    "colorGrading": { "shadows": { "hue": 180, "sat": 10, "lum": 0 }, "highlights": { "hue": 44, "sat": 14, "lum": 2 } }
                })),
                make_preset("reflxg-bw-100", "Reflxg B&W 100 (High-Acutance Silver)", json!({
                    "contrast": 22, "highlights": -10, "shadows": 4, "whites": 12, "blacks": -10,
                    "saturation": -100, "vibrance": -100, "clarity": 18, "grain": 6, "grainSize": 14
                })),
            ],
        }),

        // 22. Santacolor
        PresetItem::Folder(PresetFolder {
            id: "folder-santacolor".to_string(),
            name: "Santacolor".to_string(),
            children: vec![
                make_preset("santacolor-100", "SantaColor 100 (Surveillance Ultra-Clear Color)", json!({
                    "contrast": 24, "highlights": -12, "shadows": -6, "whites": 14, "blacks": -12,
                    "saturation": 28, "vibrance": 24, "temperature": -2, "tint": -4,
                    "clarity": 20, "grain": 4, "grainSize": 12,
                    "colorGrading": { "shadows": { "hue": 210, "sat": 12, "lum": -4 }, "highlights": { "hue": 350, "sat": 18, "lum": 2 } }
                })),
                make_preset("santacolor-summer-200", "SantaColor Summer 200 (Vivid Finnish Golden Warmth)", json!({
                    "contrast": 20, "highlights": -8, "shadows": 4, "whites": 12, "blacks": -8,
                    "saturation": 24, "vibrance": 22, "temperature": 8, "tint": 2,
                    "clarity": 16, "grain": 8, "grainSize": 16,
                    "colorGrading": { "shadows": { "hue": 35, "sat": 12, "lum": 0 }, "highlights": { "hue": 48, "sat": 20, "lum": 4 } }
                })),
                make_preset("santacolor-nordic-bw", "SantaColor Nordic Monochromatic", json!({
                    "contrast": 26, "highlights": -10, "shadows": -8, "whites": 14, "blacks": -14,
                    "saturation": -100, "vibrance": -100, "clarity": 22, "grain": 4, "grainSize": 10
                })),
            ],
        }),
    ]
}
