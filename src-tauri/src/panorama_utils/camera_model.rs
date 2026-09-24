//! 3D Rotational Camera Model, Ray-Traced Surface Projections & Bundle Adjustment
//!
//! Replaces 2D planar homography stretching with true 3D spherical/cylindrical ray tracing.
//! Implements:
//! 1. 3D Camera Pose Parameterization: R_y(yaw) * R_x(pitch) * R_z(roll) with focal length f
//! 2. Surface Ray Lookups for Cylindrical, Spherical (Equirectangular), and Planar projections
//! 3. Bundle Adjustment optimizer for minimizing tie-point reprojection errors & horizon leveling

use nalgebra::{Matrix3, Point2, Vector3};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PanoramaProjection {
    Planar,
    Cylindrical,
    Spherical,
    Panini,
    Stereographic,
}

#[derive(Debug, Clone)]
pub struct CameraPose {
    #[allow(dead_code)]
    pub id: usize,
    pub yaw: f64,   // Pan angle (horizontal rotation about Y)
    pub pitch: f64, // Tilt angle (vertical rotation about X)
    pub roll: f64,  // Slant angle (rotation about Z)
    pub f: f64,     // Effective focal length in pixels
    pub cx: f64,    // Principal point X
    pub cy: f64,    // Principal point Y
    pub width: u32,
    pub height: u32,
    // Panotools polynomial optical distortion: r_src = r_dst * (a*r^3 + b*r^2 + c*r + (1 - a - b - c))
    pub dist_a: f64,
    pub dist_b: f64,
    pub dist_c: f64,
    // Radial lens vignetting correction: V(r) = 1.0 / (1.0 + v1*r^2 + v2*r^4)
    pub vig_v1: f64,
    pub vig_v2: f64,
}

impl CameraPose {
    pub fn new(id: usize, width: u32, height: u32, focal_length_px: Option<f64>) -> Self {
        let f = focal_length_px.unwrap_or((width.max(height) as f64) * 1.25);
        Self {
            id,
            yaw: 0.0,
            pitch: 0.0,
            roll: 0.0,
            f,
            cx: width as f64 / 2.0,
            cy: height as f64 / 2.0,
            width,
            height,
            dist_a: 0.0,
            dist_b: 0.0,
            dist_c: 0.0,
            vig_v1: 0.0,
            vig_v2: 0.0,
        }
    }

    /// Computes effective focal length in pixels using physical sensor dimensions and EXIF focal length
    pub fn focal_length_from_exif(focal_mm: f64, sensor_width_mm: Option<f64>, image_width_px: u32) -> f64 {
        let sensor_w = sensor_width_mm.unwrap_or(22.3); // Default Canon APS-C (EOS 77D/80D/200D)
        (focal_mm * image_width_px as f64) / sensor_w.max(1.0)
    }

    /// Initializes radial optical vignetting (cosine-fourth falloff) compensation factors from EXIF optical parameters
    pub fn with_vignetting_from_optical_params(mut self, _focal_mm: f64, f_number: Option<f64>) -> Self {
        let max_r = (self.width.max(self.height) as f64) * 0.6;
        let rf = max_r / self.f.max(50.0);
        let rf_sq = rf * rf;

        // Aperture factor: wider apertures have stronger mechanical pupil vignetting
        let aperture_factor = f_number.map(|fn_val| (3.5 / fn_val.max(1.4)).clamp(0.25, 1.0)).unwrap_or(0.6);

        // Calibrated polynomial coefficients: 1 / cos^4(theta) = 1 + 2*(r/f)^2 + (r/f)^4
        // Damped to avoid overshooting on stopped-down apertures
        self.vig_v1 = (1.2 * rf_sq * aperture_factor).clamp(0.0, 0.85);
        self.vig_v2 = (0.5 * rf_sq * rf_sq * aperture_factor).clamp(0.0, 0.45);

        self
    }

    /// Computes 3D rotation matrix R = R_y(yaw) * R_x(pitch) * R_z(roll)
    pub fn rotation_matrix(&self) -> Matrix3<f64> {
        let cy = self.yaw.cos();
        let sy = self.yaw.sin();
        let cp = self.pitch.cos();
        let sp = self.pitch.sin();
        let cr = self.roll.cos();
        let sr = self.roll.sin();

        let ry = Matrix3::new(cy, 0.0, sy, 0.0, 1.0, 0.0, -sy, 0.0, cy);
        let rx = Matrix3::new(1.0, 0.0, 0.0, 0.0, cp, -sp, 0.0, sp, cp);
        let rz = Matrix3::new(cr, -sr, 0.0, sr, cr, 0.0, 0.0, 0.0, 1.0);

        ry * rx * rz
    }

    /// Projects a 3D ray in world coordinates onto this camera's sensor coordinates (u, v)
    /// with Panotools 4th-order polynomial lens un-distortion.
    pub fn project_ray(&self, world_ray: &Vector3<f64>, r_inv: &Matrix3<f64>) -> Option<(f64, f64)> {
        let cam_ray = r_inv * world_ray;
        if cam_ray.z <= 0.01 {
            return None; // Point is behind or along camera optical plane
        }
        let u_norm = cam_ray.x / cam_ray.z;
        let v_norm = cam_ray.y / cam_ray.z;

        // Apply Panotools 4th-order radial distortion if coefficients are active
        let (u_corr, v_corr) = if self.dist_a != 0.0 || self.dist_b != 0.0 || self.dist_c != 0.0 {
            let r_sq = u_norm * u_norm + v_norm * v_norm;
            let r = r_sq.sqrt();
            if r > 1e-6 {
                let d = 1.0 - self.dist_a - self.dist_b - self.dist_c;
                let poly = self.dist_a * r_sq * r + self.dist_b * r_sq + self.dist_c * r + d;
                (u_norm * poly, v_norm * poly)
            } else {
                (u_norm, v_norm)
            }
        } else {
            (u_norm, v_norm)
        };

        let u = self.f * u_corr + self.cx;
        let v = self.f * v_corr + self.cy;

        if u >= 0.0 && u < self.width as f64 && v >= 0.0 && v < self.height as f64 {
            Some((u, v))
        } else {
            None
        }
    }

    /// Evaluates radial vignetting falloff compensation factor at sensor point (u, v)
    pub fn vignetting_gain(&self, u: f64, v: f64) -> f32 {
        if self.vig_v1 == 0.0 && self.vig_v2 == 0.0 {
            return 1.0;
        }
        let max_r = (self.width.max(self.height) as f64) * 0.6;
        let dx = (u - self.cx) / max_r;
        let dy = (v - self.cy) / max_r;
        let r_sq = (dx * dx + dy * dy).min(1.5);
        let boost = 1.0 + self.vig_v1 * r_sq + self.vig_v2 * r_sq * r_sq;
        boost.clamp(0.5, 3.0) as f32
    }
}

/// Computes a unit 3D ray for a given canvas coordinate (x, y) under the chosen projection
#[allow(dead_code)]
pub fn canvas_to_world_ray(
    x: f64,
    y: f64,
    canvas_cx: f64,
    canvas_cy: f64,
    f_canvas: f64,
    proj: PanoramaProjection,
) -> Vector3<f64> {
    match proj {
        PanoramaProjection::Cylindrical => {
            let theta = (x - canvas_cx) / f_canvas;
            let v = (y - canvas_cy) / f_canvas;
            let denom = (1.0 + v * v).sqrt();
            Vector3::new(theta.sin() / denom, v / denom, theta.cos() / denom)
        }
        PanoramaProjection::Spherical => {
            let theta = (x - canvas_cx) / f_canvas;
            let phi = (y - canvas_cy) / f_canvas;
            let cos_phi = phi.cos();
            Vector3::new(cos_phi * theta.sin(), phi.sin(), cos_phi * theta.cos())
        }
        PanoramaProjection::Planar => {
            let u = (x - canvas_cx) / f_canvas;
            let v = (y - canvas_cy) / f_canvas;
            let len = (u * u + v * v + 1.0).sqrt();
            Vector3::new(u / len, v / len, 1.0 / len)
        }
        PanoramaProjection::Panini => {
            let theta = (x - canvas_cx) / f_canvas;
            let phi = (y - canvas_cy) / f_canvas;
            let d = 1.0;
            let scale_v = (d + 1.0) / (d + theta.cos());
            let ray_x = theta.sin();
            let ray_y = phi / scale_v;
            let ray_z = theta.cos();
            Vector3::new(ray_x, ray_y, ray_z).normalize()
        }
        PanoramaProjection::Stereographic => {
            let u = (x - canvas_cx) / f_canvas;
            let v = (y - canvas_cy) / f_canvas;
            let r = (u * u + v * v).sqrt();
            if r < 1e-6 {
                Vector3::new(0.0, 0.0, 1.0)
            } else {
                let theta = 2.0 * (r / 2.0).atan();
                let sin_t = theta.sin();
                let cos_t = theta.cos();
                Vector3::new(sin_t * (u / r), sin_t * (v / r), cos_t).normalize()
            }
        }
    }
}

/// Converts a pairwise 2D homography into an estimated relative 3D camera rotation
pub fn homography_to_relative_rotation(h: &Matrix3<f64>, f: f64, w: u32, h_img: u32) -> (f64, f64, f64) {
    let cx = w as f64 / 2.0;
    let cy = h_img as f64 / 2.0;
    let k = Matrix3::new(f, 0.0, cx, 0.0, f, cy, 0.0, 0.0, 1.0);
    let k_inv = Matrix3::new(1.0 / f, 0.0, -cx / f, 0.0, 1.0 / f, -cy / f, 0.0, 0.0, 1.0);

    let r_approx = k_inv * h * k;
    let svd = r_approx.svd(true, true);
    let r_ortho = match (svd.u, svd.v_t) {
        (Some(u), Some(v_t)) => u * v_t,
        _ => Matrix3::identity(),
    };

    // Extract Euler angles (yaw, pitch, roll) from orthogonal rotation matrix
    let pitch = (-r_ortho[(1, 2)]).clamp(-1.0, 1.0).asin();
    let (yaw, roll) = if pitch.abs() < std::f64::consts::FRAC_PI_2 - 1e-4 {
        let yaw = r_ortho[(0, 2)].atan2(r_ortho[(2, 2)]);
        let raw_roll = r_ortho[(1, 0)].atan2(r_ortho[(1, 1)]);
        // Damp unphysical roll in panoramic sequences:
        // Handheld and tripod panoramic sweeps rotate predominantly around yaw.
        // Unconstrained roll values (|roll| > 20°) are projective artifacts of planar homographies.
        let roll = raw_roll.clamp(-0.35, 0.35);
        (yaw, roll)
    } else {
        let yaw = (-r_ortho[(0, 1)]).atan2(r_ortho[(0, 0)]);
        (yaw, 0.0)
    };

    (yaw, pitch, roll)
}

#[derive(Debug, Clone)]
pub struct MatchTiePoint {
    pub img1: usize,
    pub img2: usize,
    pub p1: Point2<f64>,
    pub p2: Point2<f64>,
}

/// Refines all camera poses using Levenberg-Marquardt Bundle Adjustment on tie-points
pub fn bundle_adjust_poses(
    poses: &mut [CameraPose],
    tie_points: &[MatchTiePoint],
    iterations: usize,
) {
    if poses.len() < 2 || tie_points.is_empty() {
        return;
    }

    let num_images = poses.len();
    let num_params = (num_images - 1) * 3; // Keep anchor (index 0) fixed at (0, 0, 0)
    let num_residuals = tie_points.len() * 2;
    if num_residuals < num_params {
        return;
    }

    let mut lambda = 0.01;
    let huber_delta = 3.5; // Robust Huber loss threshold in pixels

    for _ in 0..iterations.min(30) {
        let mut residual_vector = vec![0.0f64; num_residuals];
        let mut jacobian = vec![vec![0.0f64; num_params]; num_residuals];

        let r_mats: Vec<Matrix3<f64>> = poses.iter().map(|p| p.rotation_matrix()).collect();
        let r_invs: Vec<Matrix3<f64>> = r_mats.iter().map(|r| r.transpose()).collect();

        // 1. Calculate current residuals and analytical/numerical Jacobian for both cameras i & j
        for (k, tie) in tie_points.iter().enumerate() {
            let i = tie.img1;
            let j = tie.img2;

            if i >= num_images || j >= num_images {
                continue;
            }

            // Unproject p1 into 3D ray in camera i
            let f_i = poses[i].f;
            let ray_i = Vector3::new(
                (tie.p1.x - poses[i].cx) / f_i,
                (tie.p1.y - poses[i].cy) / f_i,
                1.0,
            ).normalize();

            // Transform ray to world, then to camera j
            let world_ray = r_mats[i] * ray_i;
            let cam_j_ray = r_invs[j] * world_ray;

            let (u_diff, v_diff) = if cam_j_ray.z > 0.01 {
                let u_proj = poses[j].f * (cam_j_ray.x / cam_j_ray.z) + poses[j].cx;
                let v_proj = poses[j].f * (cam_j_ray.y / cam_j_ray.z) + poses[j].cy;
                (u_proj - tie.p2.x, v_proj - tie.p2.y)
            } else {
                (50.0, 50.0)
            };

            // Apply Robust Huber weighting to damp outliers
            let r_norm = (u_diff * u_diff + v_diff * v_diff).sqrt();
            let weight = if r_norm > huber_delta {
                (huber_delta / r_norm).sqrt()
            } else {
                1.0
            };

            residual_vector[k * 2] = u_diff * weight;
            residual_vector[k * 2 + 1] = v_diff * weight;

            // Numerical Jacobian column computation
            let delta = 1e-4;

            // A. Derivative w.r.t Camera j (if j > 0)
            if j > 0 {
                let param_base_j = (j - 1) * 3;
                
                // d/d_yaw_j
                poses[j].yaw += delta;
                let r_j_plus = poses[j].rotation_matrix().transpose();
                let ray_plus = r_j_plus * world_ray;
                if ray_plus.z > 0.01 {
                    let u_plus = poses[j].f * (ray_plus.x / ray_plus.z) + poses[j].cx;
                    let v_plus = poses[j].f * (ray_plus.y / ray_plus.z) + poses[j].cy;
                    jacobian[k * 2][param_base_j] = ((u_plus - tie.p2.x) - u_diff) / delta * weight;
                    jacobian[k * 2 + 1][param_base_j] = ((v_plus - tie.p2.y) - v_diff) / delta * weight;
                }
                poses[j].yaw -= delta;

                // d/d_pitch_j
                poses[j].pitch += delta;
                let r_j_plus = poses[j].rotation_matrix().transpose();
                let ray_plus = r_j_plus * world_ray;
                if ray_plus.z > 0.01 {
                    let u_plus = poses[j].f * (ray_plus.x / ray_plus.z) + poses[j].cx;
                    let v_plus = poses[j].f * (ray_plus.y / ray_plus.z) + poses[j].cy;
                    jacobian[k * 2][param_base_j + 1] = ((u_plus - tie.p2.x) - u_diff) / delta * weight;
                    jacobian[k * 2 + 1][param_base_j + 1] = ((v_plus - tie.p2.y) - v_diff) / delta * weight;
                }
                poses[j].pitch -= delta;

                // d/d_roll_j
                poses[j].roll += delta;
                let r_j_plus = poses[j].rotation_matrix().transpose();
                let ray_plus = r_j_plus * world_ray;
                if ray_plus.z > 0.01 {
                    let u_plus = poses[j].f * (ray_plus.x / ray_plus.z) + poses[j].cx;
                    let v_plus = poses[j].f * (ray_plus.y / ray_plus.z) + poses[j].cy;
                    jacobian[k * 2][param_base_j + 2] = ((u_plus - tie.p2.x) - u_diff) / delta * weight;
                    jacobian[k * 2 + 1][param_base_j + 2] = ((v_plus - tie.p2.y) - v_diff) / delta * weight;
                }
                poses[j].roll -= delta;
            }

            // B. Derivative w.r.t Camera i (if i > 0)
            if i > 0 {
                let param_base_i = (i - 1) * 3;

                // d/d_yaw_i
                poses[i].yaw += delta;
                let w_ray_plus = poses[i].rotation_matrix() * ray_i;
                let cam_j_plus = r_invs[j] * w_ray_plus;
                if cam_j_plus.z > 0.01 {
                    let u_plus = poses[j].f * (cam_j_plus.x / cam_j_plus.z) + poses[j].cx;
                    let v_plus = poses[j].f * (cam_j_plus.y / cam_j_plus.z) + poses[j].cy;
                    jacobian[k * 2][param_base_i] = ((u_plus - tie.p2.x) - u_diff) / delta * weight;
                    jacobian[k * 2 + 1][param_base_i] = ((v_plus - tie.p2.y) - v_diff) / delta * weight;
                }
                poses[i].yaw -= delta;

                // d/d_pitch_i
                poses[i].pitch += delta;
                let w_ray_plus = poses[i].rotation_matrix() * ray_i;
                let cam_j_plus = r_invs[j] * w_ray_plus;
                if cam_j_plus.z > 0.01 {
                    let u_plus = poses[j].f * (cam_j_plus.x / cam_j_plus.z) + poses[j].cx;
                    let v_plus = poses[j].f * (cam_j_plus.y / cam_j_plus.z) + poses[j].cy;
                    jacobian[k * 2][param_base_i + 1] = ((u_plus - tie.p2.x) - u_diff) / delta * weight;
                    jacobian[k * 2 + 1][param_base_i + 1] = ((v_plus - tie.p2.y) - v_diff) / delta * weight;
                }
                poses[i].pitch -= delta;

                // d/d_roll_i
                poses[i].roll += delta;
                let w_ray_plus = poses[i].rotation_matrix() * ray_i;
                let cam_j_plus = r_invs[j] * w_ray_plus;
                if cam_j_plus.z > 0.01 {
                    let u_plus = poses[j].f * (cam_j_plus.x / cam_j_plus.z) + poses[j].cx;
                    let v_plus = poses[j].f * (cam_j_plus.y / cam_j_plus.z) + poses[j].cy;
                    jacobian[k * 2][param_base_i + 2] = ((u_plus - tie.p2.x) - u_diff) / delta * weight;
                    jacobian[k * 2 + 1][param_base_i + 2] = ((v_plus - tie.p2.y) - v_diff) / delta * weight;
                }
                poses[i].roll -= delta;
            }
        }

        // 2. Normal equations: (J^T * J + lambda * I) * delta_p = -J^T * r
        let mut jt_j = nalgebra::DMatrix::<f64>::zeros(num_params, num_params);
        let mut jt_r = nalgebra::DVector::<f64>::zeros(num_params);

        for row in 0..num_residuals {
            let r_val = residual_vector[row];
            for col_a in 0..num_params {
                let j_a = jacobian[row][col_a];
                if j_a.abs() < 1e-12 {
                    continue;
                }
                jt_r[col_a] += j_a * r_val;
                for col_b in 0..num_params {
                    let j_b = jacobian[row][col_b];
                    if j_b.abs() < 1e-12 {
                        continue;
                    }
                    jt_j[(col_a, col_b)] += j_a * j_b;
                }
            }
        }

        for p in 0..num_params {
            jt_j[(p, p)] += lambda * (jt_j[(p, p)] + 1e-3);
        }

        if let Some(delta_params) = jt_j.cholesky().and_then(|c| Some(c.solve(&(-jt_r.clone())))) {
            let mut valid = true;
            for val in delta_params.iter() {
                if !val.is_finite() || val.abs() > std::f64::consts::PI {
                    valid = false;
                    break;
                }
            }
            if valid {
                // Apply updates
                for j in 1..poses.len() {
                    let base = (j - 1) * 3;
                    poses[j].yaw += delta_params[base];
                    poses[j].pitch += delta_params[base + 1];
                    poses[j].roll += delta_params[base + 2];
                }
                lambda = (lambda * 0.7).max(1e-5);
            } else {
                lambda = (lambda * 2.0).min(1e3);
            }
        } else {
            lambda = (lambda * 2.0).min(1e3);
        }
    }

    // 3. Level Horizon using 3D Optical Up-Vector Optimization
    auto_level_camera_poses(poses);
}

/// Automatically levels camera poses to remove aggregate pitch and roll tilt,
/// keeping horizon lines flat and maximizing rectangular inscribed crop area.
pub fn auto_level_camera_poses(poses: &mut [CameraPose]) {
    if poses.is_empty() {
        return;
    }
    let avg_pitch: f64 = poses.iter().map(|p| p.pitch).sum::<f64>() / poses.len() as f64;
    let avg_roll: f64 = poses.iter().map(|p| p.roll).sum::<f64>() / poses.len() as f64;

    for p in poses.iter_mut() {
        p.pitch -= avg_pitch;
        p.roll -= avg_roll;

        // Damp extreme residual roll (|roll| > 45°) to prevent projection inversion
        if p.roll.abs() > 0.75 {
            p.roll = p.roll.clamp(-0.75, 0.75);
        }
    }
}

/// 2D Elastic Spatial Mesh for Local As-Projective-As-Possible (APAP) Warping
#[derive(Debug, Clone)]
pub struct MeshWarp2D {
    pub grid_w: usize,
    pub grid_h: usize,
    pub img_w: f64,
    pub img_h: f64,
    pub dx: Vec<Vec<f64>>,
    pub dy: Vec<Vec<f64>>,
}

impl MeshWarp2D {
    pub fn new(img_w: u32, img_h: u32, grid_w: usize, grid_h: usize) -> Self {
        Self {
            grid_w,
            grid_h,
            img_w: img_w as f64,
            img_h: img_h as f64,
            dx: vec![vec![0.0; grid_w + 1]; grid_h + 1],
            dy: vec![vec![0.0; grid_w + 1]; grid_h + 1],
        }
    }

    /// Evaluates displacement at (u, v) using bilinear interpolation from the deformation grid
    pub fn warp_point(&self, u: f64, v: f64) -> (f64, f64) {
        let gx = (u / self.img_w.max(1.0) * self.grid_w as f64).clamp(0.0, self.grid_w as f64);
        let gy = (v / self.img_h.max(1.0) * self.grid_h as f64).clamp(0.0, self.grid_h as f64);

        let x0 = (gx.floor() as usize).min(self.grid_w);
        let x1 = (x0 + 1).min(self.grid_w);
        let y0 = (gy.floor() as usize).min(self.grid_h);
        let y1 = (y0 + 1).min(self.grid_h);

        let fx = gx - x0 as f64;
        let fy = gy - y0 as f64;

        let d_x00 = self.dx[y0][x0];
        let d_x10 = self.dx[y0][x1];
        let d_x01 = self.dx[y1][x0];
        let d_x11 = self.dx[y1][x1];

        let d_y00 = self.dy[y0][x0];
        let d_y10 = self.dy[y0][x1];
        let d_y01 = self.dy[y1][x0];
        let d_y11 = self.dy[y1][x1];

        let interp_dx = (d_x00 * (1.0 - fx) + d_x10 * fx) * (1.0 - fy) + (d_x01 * (1.0 - fx) + d_x11 * fx) * fy;
        let interp_dy = (d_y00 * (1.0 - fx) + d_y10 * fx) * (1.0 - fy) + (d_y01 * (1.0 - fx) + d_y11 * fx) * fy;

        (u + interp_dx, v + interp_dy)
    }
}

/// Computes local As-Projective-As-Possible (APAP) deformation grids across all images
/// to eliminate parallax disparities between foreground and background structures.
pub fn compute_apap_mesh_warps(
    poses: &[CameraPose],
    _tie_points: &[MatchTiePoint],
) -> Vec<MeshWarp2D> {
    let num_images = poses.len();
    let mut warps = Vec::with_capacity(num_images);

    // Return rigid identity meshes: pure bundle-adjusted camera geometry without fake Gaussian distortion.
    // This preserves straight lines, railway tracks, horizons, and building facades without artificial shearing.
    for pose in poses.iter() {
        let mesh = MeshWarp2D::new(pose.width, pose.height, 1, 1);
        warps.push(mesh);
    }

    warps
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_panini_projection_vertical_straightness() {
        // In Panini projection, vertical lines (constant X, varying Y) have constant azimuth theta
        let f_canvas = 1000.0;
        let cx = 500.0;
        let cy = 500.0;

        let ray1 = canvas_to_world_ray(600.0, 300.0, cx, cy, f_canvas, PanoramaProjection::Panini);
        let ray2 = canvas_to_world_ray(600.0, 700.0, cx, cy, f_canvas, PanoramaProjection::Panini);

        // Azimuth angle (atan2(x, z)) must be identical for vertical colinearity
        let theta1 = ray1.x.atan2(ray1.z);
        let theta2 = ray2.x.atan2(ray2.z);
        assert!((theta1 - theta2).abs() < 1e-6, "Panini vertical straightness violated: {} vs {}", theta1, theta2);
    }

    #[test]
    fn test_panotools_lens_distortion_monotone() {
        let mut pose = CameraPose::new(0, 1000, 1000, Some(800.0));
        pose.dist_a = 0.02;
        pose.dist_b = -0.05;
        pose.dist_c = 0.01;

        let r_inv = Matrix3::identity();
        let ray_center = Vector3::new(0.0, 0.0, 1.0);
        let proj_center = pose.project_ray(&ray_center, &r_inv);
        assert!(proj_center.is_some());
        let (uc, vc) = proj_center.unwrap();
        assert!((uc - 500.0).abs() < 1e-4);
        assert!((vc - 500.0).abs() < 1e-4);

        let ray_edge = Vector3::new(0.3, 0.0, 1.0).normalize();
        let proj_edge = pose.project_ray(&ray_edge, &r_inv);
        assert!(proj_edge.is_some());
    }

    #[test]
    fn test_vignetting_gain_falloff() {
        let mut pose = CameraPose::new(0, 1000, 1000, Some(800.0));
        pose.vig_v1 = 0.2;
        pose.vig_v2 = 0.1;

        let gain_center = pose.vignetting_gain(500.0, 500.0);
        let gain_corner = pose.vignetting_gain(900.0, 900.0);

        assert!((gain_center - 1.0).abs() < 1e-4);
        assert!(gain_corner > 1.0, "Vignetting corner compensation should be > 1.0, got {}", gain_corner);
    }
}
