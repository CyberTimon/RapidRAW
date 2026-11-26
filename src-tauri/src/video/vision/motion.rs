use serde::{Deserialize, Serialize};

use super::features::detect;
use super::flow::track;
use super::frame::{GrayFrame, Pyramid, from_level};
use super::geometry::{Transform, ransac};

pub const ANALYSIS_SIDE: u32 = 640;
const LEVELS: usize = 5;
const DETECTION_LEVEL: usize = 1;
const FEATURES: usize = 160;
const GRID: usize = 8;
const SPACING: f32 = 1.0 / 60.0;
const INLIER_DISTANCE: f32 = 1.0 / 320.0;
const MIN_INLIERS: usize = 12;
const MIN_INLIER_RATIO: f32 = 0.25;

#[derive(Clone, Copy, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Similarity {
    pub dx: f32,
    pub dy: f32,
    pub angle: f32,
    pub scale: f32,
}

impl Similarity {
    pub const IDENTITY: Self = Self {
        dx: 0.0,
        dy: 0.0,
        angle: 0.0,
        scale: 1.0,
    };

    pub(super) fn from_transform(transform: &Transform, units: [f32; 2]) -> Self {
        Self {
            dx: transform.tx / units[0],
            dy: transform.ty / units[1],
            angle: transform.angle(),
            scale: transform.scale(),
        }
    }

    pub(super) fn transform(&self, units: [f32; 2]) -> Transform {
        Transform::from_parts(
            self.scale,
            self.angle,
            [self.dx * units[0], self.dy * units[1]],
        )
    }
}

pub struct MotionFrame {
    pyramid: Pyramid,
    points: Vec<[f32; 2]>,
}

impl MotionFrame {
    pub fn new(frame: GrayFrame) -> Self {
        let pyramid = Pyramid::new(frame, LEVELS);
        let base = &pyramid.0[0];
        let longest = base.width.max(base.height) as f32;
        let level = (pyramid.0.len() - 1).min(DETECTION_LEVEL);
        let detection = &pyramid.0[level];
        let points = detect(
            detection,
            [0.0, 0.0, detection.width as f32, detection.height as f32],
            FEATURES,
            longest * SPACING / (1u32 << level) as f32,
            GRID,
            |_| true,
        )
        .into_iter()
        .map(|point| from_level(point, level))
        .collect();
        Self { pyramid, points }
    }
}

pub fn estimate_motion(previous: &MotionFrame, next: &MotionFrame) -> Option<Similarity> {
    let (from, to) = (&previous.pyramid.0[0], &next.pyramid.0[0]);
    if from.width != to.width || from.height != to.height {
        return None;
    }
    let (width, height) = (from.width as f32, from.height as f32);
    let center = [(width - 1.0) * 0.5, (height - 1.0) * 0.5];
    let centered = |point: [f32; 2]| [point[0] - center[0], point[1] - center[1]];
    let pairs: Vec<_> = previous
        .points
        .iter()
        .zip(track(
            &previous.pyramid,
            &next.pyramid,
            0,
            &previous.points,
            [0.0; 2],
        ))
        .filter_map(|(&from, to)| Some((centered(from), centered(to?))))
        .collect();
    let longest = width.max(height);
    let (transform, inliers) = ransac::<Transform>(&pairs, longest * INLIER_DISTANCE)?;
    let reliable =
        inliers >= MIN_INLIERS && inliers as f32 >= MIN_INLIER_RATIO * pairs.len() as f32;
    reliable.then(|| Similarity::from_transform(&transform, [width, height]))
}
