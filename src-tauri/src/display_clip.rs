// The shader maps WebView coordinates onto the native surface. The scissor
// rectangle must use the same mapping, including after resize or DPI changes.
pub fn surface_clip(clip: [f32; 4], window: [f32; 2], surface: [u32; 2]) -> Option<[u32; 4]> {
    if window
        .iter()
        .any(|value| !value.is_finite() || *value <= 0.0)
        || clip.iter().any(|value| !value.is_finite())
        || clip[2] <= 0.0
        || clip[3] <= 0.0
    {
        return None;
    }

    let scale_x = surface[0] as f32 / window[0];
    let scale_y = surface[1] as f32 / window[1];
    let left = (clip[0] * scale_x).floor().clamp(0.0, surface[0] as f32) as u32;
    let top = (clip[1] * scale_y).floor().clamp(0.0, surface[1] as f32) as u32;
    let right = ((clip[0] + clip[2]) * scale_x)
        .ceil()
        .clamp(0.0, surface[0] as f32) as u32;
    let bottom = ((clip[1] + clip[3]) * scale_y)
        .ceil()
        .clamp(0.0, surface[1] as f32) as u32;
    let width = right.saturating_sub(left);
    let height = bottom.saturating_sub(top);
    (width > 0 && height > 0).then_some([left, top, width, height])
}

#[cfg(test)]
mod tests {
    use super::surface_clip;

    #[test]
    fn matching_coordinates_preserve_clip() {
        assert_eq!(
            surface_clip([200.0, 100.0, 800.0, 600.0], [1200.0, 800.0], [1200, 800]),
            Some([200, 100, 800, 600])
        );
    }

    #[test]
    fn retina_webview_clip_scales_down_with_shader_geometry() {
        assert_eq!(
            surface_clip(
                [400.0, 200.0, 1600.0, 1200.0],
                [2400.0, 1600.0],
                [1200, 800]
            ),
            Some([200, 100, 800, 600])
        );
    }

    #[test]
    fn resize_scales_axes_independently() {
        assert_eq!(
            surface_clip([200.0, 100.0, 800.0, 600.0], [1200.0, 800.0], [2400, 1200]),
            Some([400, 150, 1600, 900])
        );
    }

    #[test]
    fn clips_to_surface_and_rejects_hidden_or_invalid_regions() {
        assert_eq!(
            surface_clip([-10.0, -20.0, 1500.0, 1000.0], [1200.0, 800.0], [1200, 800]),
            Some([0, 0, 1200, 800])
        );
        assert_eq!(
            surface_clip([-100.0, -100.0, 1.0, 1.0], [1200.0, 800.0], [1200, 800]),
            None
        );
        assert_eq!(surface_clip([0.0; 4], [0.0; 2], [1200, 800]), None);
    }
}
