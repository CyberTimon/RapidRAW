use crate::video::compose::{LayerPass, TextEdge};
use crate::video::model::{Direction, Motion, MotionKind};

const ITEM_SLIDE: f32 = 0.25;
const ZOOM_START: f32 = 0.5;
const SPIN_DEGREES: f32 = 180.0;
const BLUR_AMOUNT: f32 = 60.0;
const BACK_OVERSHOOT: f32 = 1.701_58;
const REVEAL_SOFTNESS: f32 = 0.02;
const WORD_FADE: f32 = 1.5;

#[derive(Clone, Copy, Debug)]
pub struct MotionState {
    pub opacity: f32,
    pub dx: f32,
    pub dy: f32,
    pub scale: f32,
    pub rotation: f32,
    blur: f32,
    reveal: Option<(Direction, f32, bool)>,
}

impl Default for MotionState {
    fn default() -> Self {
        Self {
            opacity: 1.0,
            dx: 0.0,
            dy: 0.0,
            scale: 1.0,
            rotation: 0.0,
            blur: 0.0,
            reveal: None,
        }
    }
}

fn ease_out_cubic(t: f32) -> f32 {
    1.0 - (1.0 - t).powi(3)
}

fn ease_out_back(t: f32) -> f32 {
    let lift = BACK_OVERSHOOT + 1.0;
    1.0 + lift * (t - 1.0).powi(3) + BACK_OVERSHOOT * (t - 1.0).powi(2)
}

fn edge_state(motion: Option<Motion>, t: f32, entering: bool, full_frame: bool) -> MotionState {
    let t = t.clamp(0.0, 1.0);
    let eased = ease_out_cubic(t);
    let away = 1.0 - eased;
    let kind = motion.map_or(MotionKind::Fade, |motion| motion.kind);
    let direction = motion
        .and_then(|motion| motion.direction)
        .unwrap_or_default();
    let mut state = MotionState::default();
    match kind {
        MotionKind::Fade => state.opacity = t,
        MotionKind::Slide => {
            let [x, y] = direction.axis();
            let distance = if full_frame { 1.0 } else { ITEM_SLIDE };
            let sign = if entering { -1.0 } else { 1.0 };
            state.dx = sign * x * away * distance;
            state.dy = sign * y * away * distance;
            if !full_frame {
                state.opacity = eased;
            }
        }
        MotionKind::Zoom => {
            state.scale = ZOOM_START + (1.0 - ZOOM_START) * eased;
            state.opacity = eased;
        }
        MotionKind::Pop => {
            state.scale = ease_out_back(t).max(0.01);
            state.opacity = (t * 3.0).min(1.0);
        }
        MotionKind::Blur => {
            state.blur = away;
            state.opacity = eased;
        }
        MotionKind::Wipe => state.reveal = Some((direction, eased, entering)),
        MotionKind::Spin => {
            state.rotation = if entering { -1.0 } else { 1.0 } * SPIN_DEGREES * away;
            state.scale = ZOOM_START + (1.0 - ZOOM_START) * eased;
            state.opacity = eased;
        }
        MotionKind::Typewriter | MotionKind::Words => {}
    }
    state
}

fn text_edge(motion: Option<Motion>, t: Option<f32>, units: (u32, u32)) -> Option<TextEdge> {
    let t = t?.clamp(0.0, 1.0);
    match motion?.kind {
        MotionKind::Typewriter => Some(TextEdge {
            shown: (t * units.0 as f32).floor(),
            sharpness: 1.0,
            by_word: false,
        }),
        MotionKind::Words => Some(TextEdge {
            shown: t * (units.1.max(1) as f32 - 1.0 + WORD_FADE),
            sharpness: 1.0 / WORD_FADE,
            by_word: true,
        }),
        _ => None,
    }
}

#[derive(Clone, Copy)]
pub struct MotionSpan {
    pub local: i64,
    pub duration: i64,
    pub fade_in: i64,
    pub fade_out: i64,
    pub anim_in: Option<Motion>,
    pub anim_out: Option<Motion>,
    pub full_frame: bool,
}

impl MotionSpan {
    pub const STILL: Self = Self {
        local: 0,
        duration: 0,
        fade_in: 0,
        fade_out: 0,
        anim_in: None,
        anim_out: None,
        full_frame: false,
    };

    fn entering(&self) -> Option<f32> {
        (self.fade_in > 0 && self.local < self.fade_in)
            .then(|| self.local.max(0) as f32 / self.fade_in as f32)
    }

    fn leaving(&self) -> Option<f32> {
        (self.fade_out > 0 && self.local > self.duration - self.fade_out)
            .then(|| (self.duration - self.local).max(0) as f32 / self.fade_out as f32)
    }

    pub fn text_reveal(&self, units: (u32, u32)) -> Option<[TextEdge; 2]> {
        let entering = text_edge(self.anim_in, self.entering(), units);
        let leaving = text_edge(self.anim_out, self.leaving(), units);
        (entering.is_some() || leaving.is_some()).then(|| {
            [
                entering.unwrap_or(TextEdge::ALL),
                leaving.unwrap_or(TextEdge::ALL),
            ]
        })
    }

    pub fn state(&self) -> MotionState {
        let mut state = MotionState::default();
        if let Some(t) = self.entering() {
            state = edge_state(self.anim_in, t, true, self.full_frame);
        }
        if let Some(t) = self.leaving() {
            let out = edge_state(self.anim_out, t, false, self.full_frame);
            state = MotionState {
                opacity: state.opacity * out.opacity,
                dx: state.dx + out.dx,
                dy: state.dy + out.dy,
                scale: state.scale * out.scale,
                rotation: state.rotation + out.rotation,
                blur: state.blur.max(out.blur),
                reveal: out.reveal.or(state.reveal),
            };
        }
        state
    }
}

impl MotionState {
    pub fn passes(&self) -> Vec<LayerPass> {
        let blur = (self.blur > 0.0).then_some(LayerPass::Blur(self.blur * BLUR_AMOUNT));
        let reveal = self
            .reveal
            .map(|(direction, visible, entering)| LayerPass::Reveal {
                direction,
                visible,
                entering,
                softness: REVEAL_SOFTNESS,
            });
        blur.into_iter().chain(reveal).collect()
    }
}
