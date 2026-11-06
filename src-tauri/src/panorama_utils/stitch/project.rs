use nalgebra::Vector3;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Projection {
    Spherical,
    Cylindrical,
    Perspective,
}

impl Projection {
    pub const CHOICES: [Projection; 3] = [
        Projection::Spherical,
        Projection::Cylindrical,
        Projection::Perspective,
    ];
    #[inline]
    pub fn forward(self, d: Vector3<f64>, f: f64) -> Option<(f64, f64)> {
        match self {
            Projection::Perspective => {
                if d[2] <= 1e-6 {
                    return None;
                }
                Some((f * d[0] / d[2], f * d[1] / d[2]))
            }
            Projection::Cylindrical => {
                let r = (d[0] * d[0] + d[2] * d[2]).sqrt();
                if r < 1e-12 {
                    return None;
                }
                Some((f * d[0].atan2(d[2]), f * d[1] / r))
            }
            Projection::Spherical => {
                let n = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
                if n < 1e-12 {
                    return None;
                }
                Some((f * d[0].atan2(d[2]), f * (d[1] / n).clamp(-1.0, 1.0).asin()))
            }
        }
    }
    #[inline]
    pub fn column(self, x: f64, f: f64) -> (f64, f64) {
        match self {
            Projection::Perspective => (x / f, 1.0),
            Projection::Cylindrical | Projection::Spherical => (x / f).sin_cos(),
        }
    }
    #[inline]
    pub fn row(self, y: f64, f: f64) -> (f64, f64) {
        match self {
            Projection::Perspective | Projection::Cylindrical => (1.0, y / f),
            Projection::Spherical => {
                let (s, c) = (y / f).sin_cos();
                (c, s)
            }
        }
    }
}
