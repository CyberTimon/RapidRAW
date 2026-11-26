use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::render::source::Frame;
use crate::video::tracking::{Corners, Follow};
use crate::video::vision::{Homography, Similarity};
use crate::video::{VideoState, blocking};

pub const IDENTITY: Homography = Homography([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);

pub fn affine([a, b, c, d, e, f]: [f64; 6]) -> Homography {
    Homography([a, b, c, d, e, f, 0.0, 0.0, 1.0])
}

pub fn shift(x: f64, y: f64) -> Homography {
    affine([1.0, 0.0, x, 0.0, 1.0, y])
}

pub fn scaling(x: f64, y: f64) -> Homography {
    affine([x, 0.0, 0.0, 0.0, y, 0.0])
}

pub fn similarity(scale: f64, angle: f64, center: [f64; 2], offset: [f64; 2]) -> Homography {
    let (sin, cos) = angle.sin_cos();
    let (a, b) = (scale * cos, scale * sin);
    affine([
        a,
        -b,
        center[0] - a * center[0] + b * center[1] + offset[0],
        b,
        a,
        center[1] - b * center[0] - a * center[1] + offset[1],
    ])
}

pub fn map_corners(corners: &Corners, map: &Homography) -> Option<Corners> {
    let mapped = corners.map(|corner| map.apply(corner));
    mapped
        .iter()
        .all(Option::is_some)
        .then(|| mapped.map(Option::unwrap))
}

pub fn cell_crop(size: (u32, u32), aspect: Option<f64>) -> Option<((u32, u32), (u32, u32))> {
    let aspect = aspect.filter(|aspect| aspect.is_finite() && *aspect > 0.0)?;
    let (width, height) = (size.0 as f64, size.1 as f64);
    let cropped = (
        (width.min(height * aspect).round() as u32).clamp(1, size.0.max(1)),
        (height.min(width / aspect).round() as u32).clamp(1, size.1.max(1)),
    );
    (cropped != size).then(|| {
        (
            (
                size.0.saturating_sub(cropped.0) / 2,
                size.1.saturating_sub(cropped.1) / 2,
            ),
            cropped,
        )
    })
}

pub fn oriented(frame: &Frame, size: (u32, u32)) -> (Homography, (u32, u32)) {
    let (width, height) = (size.0 as f64, size.1 as f64);
    let turn = match frame.orientation % 4 {
        1 => affine([0.0, -1.0, height, 1.0, 0.0, 0.0]),
        2 => affine([-1.0, 0.0, width, 0.0, -1.0, height]),
        3 => affine([0.0, 1.0, 0.0, -1.0, 0.0, width]),
        _ => IDENTITY,
    };
    let oriented = frame.oriented_size(size);
    let (across, down) = (oriented.0 as f64, oriented.1 as f64);
    let mirror = |flipped: bool, length: f64| {
        if flipped { (-1.0, length) } else { (1.0, 0.0) }
    };
    let (sx, tx) = mirror(frame.flip_horizontal, across);
    let (sy, ty) = mirror(frame.flip_vertical, down);
    let straighten = if frame.rotates() {
        similarity(
            1.0,
            (frame.rotation as f64).to_radians(),
            [across * 0.5 + 0.5, down * 0.5 + 0.5],
            [0.0, 0.0],
        )
    } else {
        IDENTITY
    };
    (
        scaling(width, height)
            .then(&turn)
            .then(&affine([sx, 0.0, tx, 0.0, sy, ty]))
            .then(&straighten),
        oriented,
    )
}

#[derive(Clone, Copy, Debug)]
pub struct Framing {
    pub map: Homography,
    pub content: (u32, u32),
}

impl Framing {
    pub fn new(
        full: (u32, u32),
        decode: (u32, u32),
        frame: Frame,
        cell_aspect: Option<f64>,
    ) -> Self {
        let frame = frame.scale_crop((decode.0 as f32 / full.0.max(1) as f32) as f64);
        let (map, oriented) = oriented(&frame, decode);
        let (x, y, width, height) = frame.crop_rect(oriented);
        let (cell, content) =
            cell_crop((width, height), cell_aspect).unwrap_or(((0, 0), (width, height)));
        Self {
            map: map.then(&shift(-((x + cell.0) as f64), -((y + cell.1) as f64))),
            content,
        }
    }

    pub fn correction(&self, stabilization: &Homography) -> Option<Similarity> {
        let corrected = self.map.inverse()?.then(stabilization).then(&self.map);
        let m = &corrected.0;
        let (width, height) = (self.content.0 as f64, self.content.1 as f64);
        let center = [width * 0.5, height * 0.5];
        let moved = corrected.apply(center)?;
        Some(Similarity {
            dx: ((moved[0] - center[0]) / width.max(1.0)) as f32,
            dy: ((moved[1] - center[1]) / height.max(1.0)) as f32,
            angle: (m[3] - m[1]).atan2(m[0] + m[4]) as f32,
            scale: (m[0] * m[4] - m[1] * m[3]).abs().sqrt() as f32,
        })
    }
}

pub fn stabilizing(correction: &Similarity, full: (u32, u32)) -> Homography {
    let (width, height) = (full.0.max(1) as f64, full.1.max(1) as f64);
    scaling(width, height)
        .then(&similarity(
            correction.scale as f64,
            correction.angle as f64,
            [width * 0.5, height * 0.5],
            [correction.dx as f64 * width, correction.dy as f64 * height],
        ))
        .then(&scaling(1.0 / width, 1.0 / height))
}

#[derive(Clone, Copy, Debug)]
pub struct ClipGeometry {
    pub source_time: f64,
    pub source: (u32, u32),
    pub framing: Framing,
    pub to_canvas: Homography,
}

impl ClipGeometry {
    pub fn content_to_canvas(&self) -> Option<Homography> {
        Some(self.framing.map.inverse()?.then(&self.to_canvas))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeometryRequest {
    revision: u64,
    time: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipSpace {
    pub media: String,
    pub source_time: f64,
    pub source: [u32; 2],
    pub canvas: [f64; 9],
    pub anchor: [f64; 9],
    pub frame: [f64; 9],
    pub frame_size: [u32; 2],
    pub mirrored: bool,
}

#[derive(Serialize)]
pub struct Point {
    x: f64,
    y: f64,
}

#[derive(Serialize)]
pub struct SimilarityView {
    from: Point,
    to: Point,
    scale: f64,
    angle: f64,
}

#[derive(Serialize)]
pub struct FollowView {
    similarity: Option<SimilarityView>,
    plane: Option<[f64; 9]>,
    corners: Option<Corners>,
}

impl From<&Follow> for FollowView {
    fn from(follow: &Follow) -> Self {
        Self {
            similarity: follow.similar.as_ref().map(|warp| SimilarityView {
                from: Point {
                    x: warp.from.0,
                    y: warp.from.1,
                },
                to: Point {
                    x: warp.to.0,
                    y: warp.to.1,
                },
                scale: warp.scale,
                angle: warp.sin.atan2(warp.cos),
            }),
            plane: follow.plane.map(|plane| plane.0),
            corners: follow.corners,
        }
    }
}

#[derive(Serialize, Default)]
pub struct FrameGeometry {
    pub clips: HashMap<String, ClipSpace>,
    pub follows: HashMap<String, FollowView>,
}

#[tauri::command]
pub async fn video_geometry(
    request: GeometryRequest,
    app_handle: AppHandle,
) -> Result<FrameGeometry, String> {
    blocking(move || {
        let video = app_handle.state::<VideoState>();
        let revision = video.revisions.get(request.revision)?;
        let Some(mut engine) = video.preview(&app_handle)? else {
            return Ok(FrameGeometry::default());
        };
        engine.frame_geometry(&revision.project, request.time)
    })
    .await?
}
