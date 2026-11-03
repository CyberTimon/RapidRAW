use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Projection {
    #[default]
    Auto,
    Spherical,
    Cylindrical,
    Perspective,
}

impl Projection {
    pub fn as_str(self) -> &'static str {
        match self {
            Projection::Auto => "auto",
            Projection::Spherical => "spherical",
            Projection::Cylindrical => "cylindrical",
            Projection::Perspective => "perspective",
        }
    }
    pub fn parse(s: &str) -> Option<Projection> {
        match s {
            "auto" => Some(Projection::Auto),
            "spherical" => Some(Projection::Spherical),
            "cylindrical" => Some(Projection::Cylindrical),
            "perspective" | "rectilinear" => Some(Projection::Perspective),
            _ => None,
        }
    }
    #[inline]
    pub fn forward(self, d: [f64; 3], f: f64) -> Option<(f64, f64)> {
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
            Projection::Spherical | Projection::Auto => {
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
            Projection::Cylindrical | Projection::Spherical | Projection::Auto => (x / f).sin_cos(),
        }
    }
    #[inline]
    pub fn row(self, y: f64, f: f64) -> (f64, f64) {
        match self {
            Projection::Perspective | Projection::Cylindrical => (1.0, y / f),
            Projection::Spherical | Projection::Auto => {
                let (s, c) = (y / f).sin_cos();
                (c, s)
            }
        }
    }
    #[inline]
    pub fn inverse(self, x: f64, y: f64, f: f64) -> [f64; 3] {
        let (a, b) = self.column(x, f);
        let (s, t) = self.row(y, f);
        [s * a, t, s * b]
    }
}
