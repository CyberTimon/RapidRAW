// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 3DCF (3D Colorimetric Film) tone mapper.
//
// Ported from Libre DT-Lab's 3DCF module (GPL-3.0-or-later):
// ACES 2.0 Single-Stage Tone Scale (SSTS) with a film-like spectral gamut
// roll-off.  This port deliberately stays in RapidRAW's native linear sRGB
// D65 working space instead of darktable's D50/Rec.2020 pipeline, so neutral
// colours keep the exact D65 white point used by white balance and the other
// colour tools.  The SSTS tone scale is applied to linear luminance only, so
// the chromaticity of every pixel is preserved exactly; the final sRGB
// transfer function is applied once, after the XYZ -> RGB conversion.  This
// avoids both the over-saturation of a gamma-encoded Y scaling and arbitrary
// post-tone-map desaturation.

use crate::render::color_space::primitives_srgb_matrices;
use glam::{Mat3, Vec3};
use std::sync::OnceLock;

pub const TABLE_SIZE: usize = 360;

const ST_GAMUT_SHAPE_REF: f32 = 2.090563;
const LUMA_SRGB: [f32; 3] = [0.2126, 0.7152, 0.0722];

const FIXED_PEAK_NITS: f64 = 200.0;
// RapidRAW's scene-linear values are already baseline-exposed.  A +1.0 EV
// tone-scale offset puts 18% grey at the same code value as AgX (~0.51) and
// keeps scene white near 0.97.
const FIXED_INPUT_EXPOSURE_EV: f32 = 1.0;
const GAMUT_KNEE: f32 = 0.20;
const GAMUT_STEEPNESS: f32 = 0.50;

// AP1/CAM16-derived hue shape used by 3DCF.  The source table contains 342
// entries; the final 18 degrees are completed here by linear wrap-around so
// that hue angles 342..359 do not fall back to zero.
#[rustfmt::skip]
#[allow(clippy::excessive_precision)]
pub const GAMUT_REACH: [f32; TABLE_SIZE] = [
    215.33465000, 216.65399000, 217.88428000, 219.05153000, 220.14357000, 221.16588000,
    222.12170000, 223.01161000, 223.83662000, 224.59834000, 225.29921000, 225.93167000,
    226.51031000, 227.04002000, 227.52505000, 227.96997000, 228.37961000, 228.75839000,
    229.10887000, 229.44225000, 223.68723000, 214.16800000, 205.47426000, 197.50737000,
    190.18221000, 183.42755000, 177.40927000, 171.71423000, 166.01921000, 161.26114000,
    156.51205000, 152.09988000, 148.09119000, 144.08249000, 140.61681000, 137.19861000,
    133.96431000, 131.02483000, 128.08536000, 125.48020000, 122.93465000, 120.49192000,
    118.27464000, 116.05737000, 114.05550000, 112.11517000, 110.23206000, 108.52786000,
    106.82366000, 105.26328000, 103.76254000, 102.29211000, 100.96827000, 99.64443000,
    98.41933000, 97.25076000, 96.09600000, 95.06489000, 94.03378000, 93.07201000,
    92.16363000, 91.25852000, 90.46065000, 89.66278000, 88.91450000, 88.21698000,
    87.51945000, 86.91000000, 86.30434000, 85.73459000, 85.21377000, 84.69295000,
    84.24227000, 83.80045000, 83.38480000, 83.01721000, 82.64962000, 82.33952000,
    82.04231000, 81.76405000, 81.53416000, 81.30428000, 81.12289000, 80.95801000,
    80.83521000, 80.72168000, 80.65045000, 80.59034000, 80.57131000, 80.56710000,
    80.60517000, 80.65601000, 80.75144000, 80.85907000, 81.01254000, 81.17904000,
    81.39567000, 81.62642000, 81.90923000, 82.20887000, 82.55980000, 82.93072000,
    83.35113000, 83.79470000, 84.29233000, 84.81635000, 85.39422000, 86.00119000,
    86.66454000, 87.35604000, 88.10696000, 88.88807000, 89.72918000, 90.60318000,
    91.53980000, 92.51119000, 93.54398000, 94.61283000, 95.74192000, 96.90921000,
    98.13804000, 99.40525000, 100.73635000, 102.10578000, 103.54021000, 105.01234000,
    106.55258000, 108.13228000, 109.78187000, 111.47143000, 113.23616000, 115.04231000,
    116.92601000, 118.85246000, 120.86163000, 122.91274000, 125.04886000, 127.22766000,
    129.49422000, 131.80248000, 134.20437000, 136.64542000, 139.18477000, 141.75740000,
    144.42843000, 147.11901000, 149.91091000, 152.71301000, 155.62236000, 158.53839000,
    161.56854000, 164.59702000, 167.74177000, 170.87844000, 174.13757000, 177.38217000,
    180.75291000, 184.09992000, 187.58020000, 191.02417000, 194.61319000, 198.14956000,
    201.86339000, 205.49933000, 209.35075000, 213.10937000, 217.10868000, 220.98853000,
    225.15117000, 229.14913000, 233.51938000, 237.72111000, 242.30969000, 246.71441000,
    251.55396000, 256.19424000, 261.32180000, 266.20905000, 271.65866000, 276.83450000,
    282.62812000, 288.11413000, 294.30017000, 300.15022000, 306.75516000, 313.00060000,
    320.03412000, 326.65935000, 334.14812000, 341.20554000, 349.15821000, 356.62305000,
    365.05924000, 373.00500000, 381.98756000, 390.45261000, 400.03007000, 409.09923000,
    419.36868000, 429.09772000, 440.10982000, 450.60016000, 462.44890000, 473.75378000,
    486.51340000, 498.72287000, 512.51868000, 525.71943000, 540.63986000, 554.90985000,
    570.99998000, 586.35636000, 603.68996000, 620.20696000, 638.99757000, 656.90554000,
    677.15919000, 696.34557000, 718.06863000, 738.60920000, 761.87958000, 783.85566000,
    808.71603000, 832.03886000, 858.63238000, 883.55051000, 911.94378000, 938.53107000,
    969.00048000, 997.36899000, 1029.94947000, 1060.28584000, 1094.99923000, 1127.44384000,
    1164.36269000, 1198.98879000, 1237.19312000, 1273.05128000, 1313.63076000, 1351.65816000,
    1394.65221000, 1434.90942000, 1479.36892000, 1521.29923000, 1568.31051000, 1611.98419000,
    1660.62312000, 1705.85267000, 1756.34372000, 1803.03751000, 1855.55009000, 1903.87186000,
    1958.61575000, 2008.99678000, 2065.34081000, 2116.53174000, 2174.75144000, 2227.24046000,
    2286.71107000, 2334.72467000, 2382.30107000, 2412.86075000, 2440.19453000, 2454.06478000,
    2459.10001000, 2451.71571000, 2434.68372000, 2404.68880000, 2367.15629000, 2312.62957000,
    2255.38400000, 2181.09339000, 2107.34164000, 2016.32946000, 1927.02893000, 1817.55349000,
    1712.68006000, 1587.07577000, 1470.86887000, 1330.42737000, 1206.14536000, 1053.68427000,
    932.34317000, 788.29193000, 696.24225000, 611.53390000, 544.99676000, 492.60999000,
    450.65358000, 416.32756000, 387.83403000, 363.87664000, 343.46013000, 325.87004000,
    310.59306000, 297.22935000, 285.46049000, 275.03443000, 265.75110000, 257.45036000,
    250.00035000, 243.29181000, 237.23430000, 231.75173000, 226.77956000, 222.26262000,
    218.15373000, 214.41231000, 210.99364000, 207.86736000, 204.98974000, 202.32907000,
    199.85763000, 197.55163000, 195.39062000, 193.35700000, 191.43587000, 189.61455000,
    187.88248000, 186.23068000, 184.65166000, 183.13911000, 181.68774000, 180.29310000,
    178.95149000, 177.65981000, 176.41537000, 175.21587000, 174.05930000, 172.94393000,
    171.86825000, 170.83094000, 169.83086000, 168.86699000, 167.93843000, 167.04441000,
    166.18422000, 165.35726000, 164.56299000, 163.80093000, 163.07064000, 162.37175000,
    165.15927105, 167.94679211, 170.73431316, 173.52183421, 176.30935526, 179.09687632,
    181.88439737, 184.67191842, 187.45943947, 190.24696053, 193.03448158, 195.82200263,
    198.60952368, 201.39704474, 204.18456579, 206.97208684, 209.75960789, 212.54712895,
];

// CIE 1931 2-degree spectral locus, 380-700 nm at 5 nm steps plus the 780 nm
// endpoint.
#[rustfmt::skip]
const SPECTRAL_LOCUS_XY: [[f32; 2]; 66] = [
    [0.174112, 0.004964],
    [0.174008, 0.004981],
    [0.173801, 0.004915],
    [0.173560, 0.004923],
    [0.173337, 0.004797],
    [0.173021, 0.004775],
    [0.172577, 0.004799],
    [0.172087, 0.004833],
    [0.171407, 0.005102],
    [0.170301, 0.005789],
    [0.168878, 0.006900],
    [0.166895, 0.008556],
    [0.164412, 0.010858],
    [0.161105, 0.013793],
    [0.156641, 0.017705],
    [0.150985, 0.022740],
    [0.143960, 0.029703],
    [0.135503, 0.039879],
    [0.124118, 0.057803],
    [0.109594, 0.086843],
    [0.091294, 0.132702],
    [0.068706, 0.200723],
    [0.045391, 0.294976],
    [0.023460, 0.412703],
    [0.008168, 0.538423],
    [0.003859, 0.654823],
    [0.013870, 0.750186],
    [0.038852, 0.812016],
    [0.074302, 0.833803],
    [0.114161, 0.826207],
    [0.154722, 0.805864],
    [0.192876, 0.781629],
    [0.229620, 0.754329],
    [0.265775, 0.724324],
    [0.301604, 0.692308],
    [0.337363, 0.658848],
    [0.373102, 0.624451],
    [0.408736, 0.589607],
    [0.444062, 0.554714],
    [0.478775, 0.520202],
    [0.512486, 0.486591],
    [0.544787, 0.454434],
    [0.575151, 0.424232],
    [0.602933, 0.396497],
    [0.627037, 0.372491],
    [0.648233, 0.351395],
    [0.665764, 0.334011],
    [0.680079, 0.319747],
    [0.691504, 0.308342],
    [0.700606, 0.299301],
    [0.707918, 0.292027],
    [0.714032, 0.285929],
    [0.719033, 0.280935],
    [0.723032, 0.276948],
    [0.725992, 0.274008],
    [0.728272, 0.271728],
    [0.729969, 0.270031],
    [0.731089, 0.268911],
    [0.731993, 0.268007],
    [0.732719, 0.267281],
    [0.733417, 0.266583],
    [0.734047, 0.265953],
    [0.734390, 0.265610],
    [0.734592, 0.265408],
    [0.734690, 0.265310],
    [0.734690, 0.265310],
];

#[derive(Clone)]
pub struct ThreeDcfContext {
    pub input_matrix: Mat3,
    pub output_matrix: Mat3,
    pub luma: [f32; 3],
    pub exposure_factor: f32,
    pub s_2: f32,
    pub m_2: f32,
    pub g: f32,
    pub t_1: f32,
    pub n_r: f32,
    pub n: f32,
    pub gamut_knee: f32,
    pub gamut_steepness: f32,
    pub white_chroma_x: f32,
    pub white_chroma_z: f32,
    pub spectral_boundary: [f32; TABLE_SIZE],
}

impl ThreeDcfContext {
    fn new() -> Self {
        let (input_matrix, output_matrix) = primitives_srgb_matrices();
        let white_xyz = input_matrix * Vec3::ONE;
        let white_chroma_x = if white_xyz.y > 0.0 {
            white_xyz.x / white_xyz.y
        } else {
            0.95047
        };
        let white_chroma_z = if white_xyz.y > 0.0 {
            white_xyz.z / white_xyz.y
        } else {
            1.08883
        };
        let (s_2, m_2, g, t_1, n_r, n) = ssts_init(FIXED_PEAK_NITS);

        Self {
            input_matrix,
            output_matrix,
            luma: LUMA_SRGB,
            exposure_factor: 2.0f32.powf(FIXED_INPUT_EXPOSURE_EV),
            s_2,
            m_2,
            g,
            t_1,
            n_r,
            n,
            gamut_knee: GAMUT_KNEE,
            gamut_steepness: GAMUT_STEEPNESS,
            white_chroma_x,
            white_chroma_z,
            spectral_boundary: compute_spectral_boundary(white_chroma_x, white_chroma_z),
        }
    }

    fn ssts_fwd(&self, x: f32) -> f32 {
        if x <= 0.0 {
            return 0.0;
        }
        let f = self.m_2 * (x / (x + self.s_2)).powf(self.g);
        let h = (f * f) / (f + self.t_1);
        h * self.n_r
    }

    fn compute_y_tm(&self, y_scene: f32) -> f32 {
        if self.n <= 0.0 {
            return 0.0;
        }
        let y_linear = self.ssts_fwd(y_scene * self.exposure_factor) / self.n_r;
        y_linear.clamp(0.0, 1.0)
    }

    fn spectral_gamut(&self, x_tm_in: f32, z_tm_in: f32, y_tm: f32) -> (f32, f32) {
        let mut x_tm = x_tm_in;
        let mut z_tm = z_tm_in;

        if y_tm <= 0.0 || !x_tm.is_finite() || !z_tm.is_finite() {
            return (x_tm, z_tm);
        }

        let sum = x_tm + y_tm + z_tm;
        if sum <= 0.0 {
            return (x_tm, z_tm);
        }

        let mut cie_x = x_tm / sum;
        let mut cie_z = z_tm / sum;
        let white_sum = self.white_chroma_x + 1.0 + self.white_chroma_z;
        let white_cie_x = self.white_chroma_x / white_sum;
        let white_cie_z = self.white_chroma_z / white_sum;

        let mut dx = cie_x - white_cie_x;
        let mut dz = cie_z - white_cie_z;
        let mut chroma_sq = dx * dx + dz * dz;

        let angle_deg = hue_angle_deg(dz, dx);
        let (bin, next, frac) = hue_bin(angle_deg);
        let max_dist = self.spectral_boundary[bin]
            + frac * (self.spectral_boundary[next] - self.spectral_boundary[bin]);
        let target_dist = max_dist * 0.92;

        if max_dist > 0.0 && chroma_sq > target_dist * target_dist {
            let chroma = chroma_sq.sqrt();
            let excess = chroma - target_dist;
            let bsteep = (target_dist * 0.05).max(0.001);
            let compression = excess / (excess + bsteep);
            let scale = (chroma - compression * excess) / chroma;

            cie_x = white_cie_x + scale * dx;
            cie_z = white_cie_z + scale * dz;
            let y_new = 1.0 - cie_x - cie_z;
            if y_new > 0.0 {
                let s_new = y_tm / y_new;
                x_tm = cie_x * s_new;
                z_tm = cie_z * s_new;
                dx = cie_x - white_cie_x;
                dz = cie_z - white_cie_z;
                chroma_sq = dx * dx + dz * dz;
            }
        }

        let angle_deg = hue_angle_deg(dz, dx);
        let shape = reach_from_table(angle_deg) / chroma_norm(angle_deg).max(1e-6);
        let shape_norm = (shape / ST_GAMUT_SHAPE_REF).max(0.0);
        let knee_mod = self.gamut_knee * shape_norm.sqrt();

        if chroma_sq > knee_mod * knee_mod {
            let chroma = chroma_sq.sqrt();
            let excess = chroma - knee_mod;
            let compression = excess / (excess + self.gamut_steepness.max(1e-6));
            let scale = (chroma - compression * excess) / chroma;

            let x_new = white_cie_x + scale * dx;
            let z_new = white_cie_z + scale * dz;
            let y_new = 1.0 - x_new - z_new;

            if y_new > 0.0 {
                let s_new = y_tm / y_new;
                x_tm = x_new * s_new;
                z_tm = z_new * s_new;
            }
        }

        (x_tm, z_tm)
    }

    fn gamut_compress(&self, rgb: [f32; 3]) -> [f32; 3] {
        let luma = self.luma[0] * rgb[0] + self.luma[1] * rgb[1] + self.luma[2] * rgb[2];
        let anchor = if luma > 1e-4 { luma } else { 1.0 };

        let mut t = 0.0f32;
        for &c in &rgb {
            if c < 0.0 {
                let denom = anchor - c;
                let ti = if denom > 1e-6 { -c / denom } else { 1.0 };
                t = t.max(ti);
            } else if c > 1.0 {
                let denom = c - anchor;
                let ti = if denom > 1e-6 { (c - 1.0) / denom } else { 1.0 };
                t = t.max(ti);
            }
        }

        if t <= 0.0 {
            return rgb;
        }

        let blend = t.min(1.0);
        [
            (1.0 - blend) * rgb[0] + blend * anchor,
            (1.0 - blend) * rgb[1] + blend * anchor,
            (1.0 - blend) * rgb[2] + blend * anchor,
        ]
    }

    pub fn eval_rgb(&self, rgb_in: [f32; 3]) -> [f32; 3] {
        let mut c = Vec3::from_array(rgb_in);
        let min_c = c.min_element();
        if min_c < 0.0 {
            c -= Vec3::splat(min_c);
        }

        let xyz = self.input_matrix * c;
        let y_abs = xyz.y;
        if y_abs <= 1e-10 || !y_abs.is_finite() {
            return [0.0; 3];
        }

        let x_ratio = (xyz.x / y_abs).clamp(-100.0, 100.0);
        let z_ratio = (xyz.z / y_abs).clamp(-100.0, 100.0);
        let y_tm = self.compute_y_tm(y_abs);
        let (x_tm, z_tm) = self.spectral_gamut(x_ratio * y_tm, z_ratio * y_tm, y_tm);

        let rgb = self.output_matrix * Vec3::new(x_tm, y_tm, z_tm);

        // The tone scale and spectral gamut operate on luminance/chromaticity
        // in XYZ, so chromaticity is preserved.  Gamut compression is applied
        // in linear RGB, and the sRGB transfer function is applied exactly once
        // here, at the very end of the conversion.
        let rgb = self.gamut_compress([rgb.x, rgb.y, rgb.z]);
        [
            linear_to_srgb(rgb[0].clamp(0.0, 1.0)),
            linear_to_srgb(rgb[1].clamp(0.0, 1.0)),
            linear_to_srgb(rgb[2].clamp(0.0, 1.0)),
        ]
    }
}

pub fn context() -> &'static ThreeDcfContext {
    static CONTEXT: OnceLock<ThreeDcfContext> = OnceLock::new();
    CONTEXT.get_or_init(ThreeDcfContext::new)
}

fn ssts_init(peak_luminance: f64) -> (f32, f32, f32, f32, f32, f32) {
    const N_R: f64 = 100.0;
    const G: f64 = 1.15;
    const C: f64 = 0.18;
    const C_D: f64 = 10.013;
    const W_G: f64 = 0.14;
    const T_1: f64 = 0.04;
    const R_HIT_MIN: f64 = 128.0;
    const R_HIT_MAX: f64 = 896.0;

    let n = peak_luminance.max(1.0);
    let r_hit = R_HIT_MIN + (R_HIT_MAX - R_HIT_MIN) * (n / N_R).ln() / (10000.0f64 / 100.0f64).ln();
    let m_0 = n / N_R;
    let m_1 = 0.5 * (m_0 + (m_0 * (m_0 + 4.0 * T_1)).sqrt());
    let u = ((r_hit / m_1) / ((r_hit / m_1) + 1.0)).powf(G);
    let m = m_1 / u;

    let w_i = (n / 100.0).ln() / 2.0f64.ln();
    let c_t = (C_D / N_R) * (1.0 + w_i * W_G);
    let g_ip = 0.5 * (c_t + (c_t * (c_t + 4.0 * T_1)).sqrt());
    let g_ipp2 = -(m_1 * (g_ip / m).powf(1.0 / G)) / ((g_ip / m).powf(1.0 / G) - 1.0);
    let w_2 = C / g_ipp2;
    let s_2 = w_2 * m_1;

    let u_2 = ((r_hit / m_1) / ((r_hit / m_1) + w_2)).powf(G);
    let m_2 = m_1 / u_2;

    (
        s_2 as f32, m_2 as f32, G as f32, T_1 as f32, N_R as f32, n as f32,
    )
}

fn compute_spectral_boundary(white_x_ratio: f32, white_z_ratio: f32) -> [f32; TABLE_SIZE] {
    let mut boundary = [0.0f64; TABLE_SIZE];
    let white_sum = white_x_ratio as f64 + 1.0 + white_z_ratio as f64;
    let white_cie_x = white_x_ratio as f64 / white_sum;
    let white_cie_z = white_z_ratio as f64 / white_sum;

    for &[x, y] in &SPECTRAL_LOCUS_XY {
        let x = x as f64;
        let y = y as f64;
        let z = 1.0 - x - y;
        let dx = x - white_cie_x;
        let dz = z - white_cie_z;
        let dist = (dx * dx + dz * dz).sqrt();
        let angle = dz.atan2(dx).to_degrees();
        let bin = hue_bin_f64(angle);
        if dist > boundary[bin] {
            boundary[bin] = dist;
        }
    }

    let x_r = SPECTRAL_LOCUS_XY[SPECTRAL_LOCUS_XY.len() - 1][0] as f64;
    let y_r = SPECTRAL_LOCUS_XY[SPECTRAL_LOCUS_XY.len() - 1][1] as f64;
    let x_b = SPECTRAL_LOCUS_XY[0][0] as f64;
    let y_b = SPECTRAL_LOCUS_XY[0][1] as f64;
    let inv_y_r = 1.0 / y_r;
    let inv_y_b = 1.0 / y_b;
    let big_x_r = x_r * inv_y_r;
    let big_z_r = (1.0 - x_r - y_r) * inv_y_r;
    let big_x_b = x_b * inv_y_b;
    let big_z_b = (1.0 - x_b - y_b) * inv_y_b;

    const NSEG: usize = 32;
    for i in 1..=NSEG {
        let t = i as f64 / (NSEG + 1) as f64;
        let big_x = big_x_r + t * (big_x_b - big_x_r);
        let big_z = big_z_r + t * (big_z_b - big_z_r);
        let sum_xyz = big_x + 1.0 + big_z;
        let x = big_x / sum_xyz;
        let y = 1.0 / sum_xyz;
        let z = 1.0 - x - y;
        let dx = x - white_cie_x;
        let dz = z - white_cie_z;
        let dist = (dx * dx + dz * dz).sqrt();
        let angle = dz.atan2(dx).to_degrees();
        let bin = hue_bin_f64(angle);
        if dist > boundary[bin] {
            boundary[bin] = dist;
        }
    }

    let mut last = 0.0f64;
    for v in boundary.iter_mut() {
        if *v > 0.0 {
            last = *v;
        } else if last > 0.0 {
            *v = last;
        }
    }
    last = 0.0;
    for v in boundary.iter_mut().rev() {
        if *v > 0.0 {
            last = *v;
        } else if last > 0.0 {
            *v = last;
        }
    }

    let min_nonzero = boundary
        .iter()
        .copied()
        .filter(|v| *v > 0.0)
        .fold(f64::INFINITY, f64::min);
    let min_nonzero = if min_nonzero.is_finite() {
        min_nonzero
    } else {
        1.0
    };
    boundary.map(|v| {
        if v > 0.0 {
            v as f32
        } else {
            min_nonzero as f32
        }
    })
}

fn hue_bin_f64(angle: f64) -> usize {
    let mut a = angle;
    if a < 0.0 {
        a += 360.0;
    }
    if a >= 360.0 {
        a -= 360.0;
    }
    (a as usize).min(TABLE_SIZE - 1)
}

fn hue_angle_deg(dz: f32, dx: f32) -> f32 {
    let mut angle = dz.atan2(dx).to_degrees();
    if angle < 0.0 {
        angle += 360.0;
    }
    if angle >= 360.0 {
        angle -= 360.0;
    }
    angle
}

fn hue_bin(angle: f32) -> (usize, usize, f32) {
    let bin = (angle as usize).min(TABLE_SIZE - 1);
    let next = (bin + 1) % TABLE_SIZE;
    let frac = angle - bin as f32;
    (bin, next, frac)
}

fn reach_from_table(h: f32) -> f32 {
    if !h.is_finite() {
        return 0.0;
    }
    let mut hw = h % 360.0;
    if hw < 0.0 {
        hw += 360.0;
    }
    let i0 = (hw as usize).min(TABLE_SIZE - 1);
    let i1 = (i0 + 1) % TABLE_SIZE;
    let t = hw - i0 as f32;
    GAMUT_REACH[i0] + t * (GAMUT_REACH[i1] - GAMUT_REACH[i0])
}

fn chroma_norm(h: f32) -> f32 {
    let hr = h.to_radians();
    let a = hr.cos();
    let b = hr.sin();
    let a2 = a * a - b * b;
    let b2 = 2.0 * a * b;
    let a3 = 4.0 * a * a * a - 3.0 * a;
    let b3 = 3.0 * b - 4.0 * b * b * b;
    11.34072 * a + 16.46899 * a2 + 7.88380 * a3 + 14.66441 * b - 6.37224 * b2
        + 9.19364 * b3
        + 77.12896
}

fn linear_to_srgb(x: f32) -> f32 {
    let x = x.max(0.0);
    if x <= 0.0031308 {
        x * 12.92
    } else {
        1.055 * x.powf(1.0 / 2.4) - 0.055
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_uses_d65_white() {
        let ctx = context();
        let sum = ctx.white_chroma_x + 1.0 + ctx.white_chroma_z;
        let x = ctx.white_chroma_x / sum;
        let y = 1.0 / sum;
        assert!((x - 0.3127).abs() < 1.0e-4, "white x = {x}");
        assert!((y - 0.3290).abs() < 1.0e-4, "white y = {y}");
    }

    #[test]
    fn neutral_stays_neutral() {
        let ctx = context();
        for value in [0.05, 0.18, 0.5, 1.0, 4.0, 16.0] {
            let out = ctx.eval_rgb([value, value, value]);
            let spread = (out[0] - out[1])
                .abs()
                .max((out[1] - out[2]).abs())
                .max((out[0] - out[2]).abs());
            assert!(spread < 1.0e-4, "value {value} produced {out:?}");
        }
    }

    #[test]
    fn mid_gray_and_white_are_natural() {
        let ctx = context();
        let mid = ctx.eval_rgb([0.18, 0.18, 0.18])[0];
        let white = ctx.eval_rgb([1.0, 1.0, 1.0])[0];
        assert!((0.49..=0.53).contains(&mid), "18% grey -> {mid}");
        assert!((0.95..=0.99).contains(&white), "scene white -> {white}");
    }

    #[test]
    fn gray_ramp_is_monotonic() {
        let ctx = context();
        let mut previous = -1.0;
        for i in 0..=64 {
            let value = i as f32 / 16.0;
            let out = ctx.eval_rgb([value, value, value]);
            assert!(out[0] + 1.0e-6 >= previous, "ramp decreased at {value}");
            previous = out[0];
        }
    }

    #[test]
    fn chromaticity_is_preserved() {
        let ctx = context();
        let to_linear = |c: f32| {
            if c <= 0.04045 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        };

        for rgb in [
            [0.5, 0.3, 0.2],
            [0.3, 0.4, 0.2],
            [0.2, 0.25, 0.3],
            [0.18, 0.18, 0.18],
            [0.4, 0.35, 0.3],
        ] {
            let out = ctx.eval_rgb(rgb);
            let out_linear = Vec3::new(to_linear(out[0]), to_linear(out[1]), to_linear(out[2]));
            let in_xyz = ctx.input_matrix * Vec3::from_array(rgb);
            let out_xyz = ctx.input_matrix * out_linear;
            let in_sum = in_xyz.x + in_xyz.y + in_xyz.z;
            let out_sum = out_xyz.x + out_xyz.y + out_xyz.z;
            assert!(
                ((in_xyz.x / in_sum) - (out_xyz.x / out_sum)).abs() < 2.0e-3,
                "x chromaticity drifted for {rgb:?}: {out:?}"
            );
            assert!(
                ((in_xyz.z / in_sum) - (out_xyz.z / out_sum)).abs() < 2.0e-3,
                "z chromaticity drifted for {rgb:?}: {out:?}"
            );
        }
    }

    #[test]
    fn primaries_keep_chroma() {
        let ctx = context();
        for rgb in [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]] {
            let out = ctx.eval_rgb(rgb);
            let max = out.iter().copied().fold(0.0f32, f32::max);
            let min = out.iter().copied().fold(1.0f32, f32::min);
            assert!(max - min > 0.05, "primary {rgb:?} lost its chroma: {out:?}");
        }
    }

    #[test]
    fn output_is_finite_and_bounded() {
        let ctx = context();
        for rgb in [
            [0.0, 0.0, 0.0],
            [0.18, 0.18, 0.18],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [-0.1, 0.2, 0.3],
            [100.0, 100.0, 100.0],
        ] {
            let out = ctx.eval_rgb(rgb);
            for c in out {
                assert!(c.is_finite(), "input {rgb:?} produced {out:?}");
                assert!((0.0..=1.0).contains(&c), "input {rgb:?} produced {out:?}");
            }
        }
    }

    #[test]
    fn spectral_boundary_is_complete() {
        let ctx = context();
        assert!(ctx.spectral_boundary.iter().all(|&v| v > 0.0));
    }

    #[test]
    fn shader_wgsl_validates() {
        let source = include_str!("../shaders/shader.wgsl");
        let module = naga::front::wgsl::parse_str(source).expect("shader.wgsl should parse");
        let mut validator = naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::all(),
        );
        validator
            .validate(&module)
            .expect("shader.wgsl should validate");
    }

    #[test]
    fn shader_uniform_layout_matches_rust() {
        let source = include_str!("../shaders/shader.wgsl");
        let module = naga::front::wgsl::parse_str(source).expect("shader.wgsl should parse");
        let mut layouter = naga::proc::Layouter::default();
        layouter
            .update(naga::proc::GlobalCtx {
                types: &module.types,
                constants: &module.constants,
                overrides: &module.overrides,
                global_expressions: &module.global_expressions,
            })
            .expect("shader layouts should compute");

        let (handle, ty) = module
            .types
            .iter()
            .find(|(_, ty)| ty.name.as_deref() == Some("AllAdjustments"))
            .expect("AllAdjustments should exist in the shader");
        let shader_size = layouter[handle].size as usize;
        let rust_size = std::mem::size_of::<crate::render::uniforms::AllAdjustments>();
        assert_eq!(
            shader_size, rust_size,
            "WGSL/Rust AllAdjustments layouts differ: shader={shader_size}, rust={rust_size}"
        );

        let naga::TypeInner::Struct { members, .. } = &ty.inner else {
            panic!("AllAdjustments should be a struct");
        };
        let member_offset = |name: &str| {
            members
                .iter()
                .find(|m| m.name.as_deref() == Some(name))
                .unwrap_or_else(|| panic!("{name} should exist in AllAdjustments"))
                .offset as usize
        };
        assert_eq!(
            member_offset("three_dcf"),
            std::mem::offset_of!(crate::render::uniforms::AllAdjustments, three_dcf),
            "three_dcf offset differs"
        );
        assert_eq!(
            member_offset("mask_adjustments"),
            std::mem::offset_of!(crate::render::uniforms::AllAdjustments, mask_adjustments),
            "mask_adjustments offset differs"
        );
    }
}
