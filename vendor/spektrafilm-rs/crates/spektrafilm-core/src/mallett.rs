//! Mallett et al. (2019) reflectance-basis RGB → film raw upsampling.
//!
//! Port of upstream `rgb_to_raw_mallett2019`: the input RGB is converted to
//! linear sRGB, treated as a reflectance via the sRGB Mallett2019 basis,
//! illuminated by the film's reference illuminant, and integrated against the
//! film sensitivity — then normalised by the green-channel midgray response.
//!
//! Because every term is linear in the input, the whole transform collapses to
//! a single per-pixel 3×3 matrix:
//!
//! ```text
//!   raw = core · M_cs · rgb
//! ```
//!
//! where `M_cs` is the input-colour-space → linear-sRGB matrix (colour's
//! `RGB_to_RGB` with a CAT02 chromatic adaptation) and `core` maps linear sRGB
//! to raw. The final `raw / raw_midgray_green` ratio is invariant to the
//! illuminant's absolute scale (numerator and denominator both scale with it),
//! so only the illuminant's spectral *shape* matters.
//!
//! An alternative to the default `hanatos2025` spectral LUT path; selected by
//! `settings.rgb_to_raw_method == "mallett2019"`.

/// sRGB Mallett2019 reflectance basis functions, aligned to 380–780 nm step 5.
/// Baked from `colour.recovery.MSDS_BASIS_FUNCTIONS_sRGB_MALLETT2019`.
pub const MALLETT2019_BASIS: [[f64; 3]; 81] = [
    [0.3274574138270549, 0.33186171308587414, 0.34068079154805275],
    [
        0.32375057827054093,
        0.32968818775939884,
        0.34656118662485247,
    ],
    [0.3134394612515769, 0.32786002162469752, 0.35870049314035102],
    [
        0.28887938275526504,
        0.31917358023175574,
        0.39194702658819558,
    ],
    [
        0.23920568115888613,
        0.29432258369484204,
        0.46647173058733271,
    ],
    [
        0.18970203689053472,
        0.25869706476873611,
        0.55160089559860181,
    ],
    [
        0.12174606795921808,
        0.18889431925476516,
        0.68935961094892773,
    ],
    [
        0.074578270669465999,
        0.12538838199168884,
        0.80003334687860739,
    ],
    [
        0.044433158634033673,
        0.07868706031062167,
        0.87687978093531582,
    ],
    [
        0.028928632128502912,
        0.053143270865945391,
        0.91792809744395387,
    ],
    [
        0.022316653484751169,
        0.042288146031342011,
        0.93539520066963255,
    ],
    [
        0.01691130729263177,
        0.033318345502917082,
        0.94977034711518271,
    ],
    [
        0.014181107117966709,
        0.029755948185972422,
        0.95606294480524168,
    ],
    [
        0.013053142677487287,
        0.030331250536904726,
        0.95661560689031544,
    ],
    [
        0.011986163627845011,
        0.030988571897300723,
        0.95702526493132678,
    ],
    [
        0.011288714712404805,
        0.031686355188838077,
        0.9570249305347116,
    ],
    [
        0.010906066465651693,
        0.034669961502997441,
        0.95442397273706481,
    ],
    [
        0.010400713481004192,
        0.034551957443675001,
        0.95504732902020473,
    ],
    [
        0.010637360254146501,
        0.040684806194829642,
        0.94867783309333276,
    ],
    [
        0.010907662533774091,
        0.054460037369405551,
        0.93463229984232865,
    ],
    [
        0.011032712448098799,
        0.080905287420473634,
        0.90806199985226976,
    ],
    [
        0.011310656591226799,
        0.14634830285704412,
        0.84234103946372485,
    ],
    [
        0.011154642056940303,
        0.37967964329661669,
        0.60916571536564634,
    ],
    [
        0.010148770406212195,
        0.76674426865403378,
        0.22310696095953308,
    ],
    [
        0.0089185821188384334,
        0.87621474761336915,
        0.11486667029133618,
    ],
    [
        0.007685576338471058,
        0.91849165561384172,
        0.073822767895743657,
    ],
    [
        0.0067057082846952477,
        0.94065556253443727,
        0.052638728791055529,
    ],
    [
        0.0059958059876442484,
        0.95373188453301982,
        0.040272309016888733,
    ],
    [
        0.0055372566423418819,
        0.9616432798402379,
        0.032819462650959128,
    ],
    [
        0.0051937842412066119,
        0.96720001968507885,
        0.027606195927045614,
    ],
    [
        0.0050253622652233348,
        0.97098974639004598,
        0.023984891127039394,
    ],
    [
        0.0051363627696750852,
        0.97285230356355246,
        0.022011333352792182,
    ],
    [
        0.0054332002605398328,
        0.97311659407644435,
        0.021450205255996592,
    ],
    [
        0.0058199859024353475,
        0.97335106915414327,
        0.02082894450956848,
    ],
    [
        0.0064005727746241237,
        0.97335111554436793,
        0.020248311388808723,
    ],
    [
        0.0074495286834087805,
        0.97226107973172549,
        0.020289391451206597,
    ],
    [
        0.0085836358193765779,
        0.97335102174691701,
        0.018065342335913004,
    ],
    [
        0.010395762465167397,
        0.97314849518569335,
        0.016455742234468509,
    ],
    [
        0.013565433538649212,
        0.97106130630091381,
        0.015373260134095497,
    ],
    [
        0.019384515839974206,
        0.96637130595518239,
        0.014244178484551695,
    ],
    [
        0.032084071202002344,
        0.95494196750254901,
        0.012973961554334692,
    ],
    [
        0.074356037845941136,
        0.91357898955126315,
        0.012064974134521804,
    ],
    [
        0.62439372417807504,
        0.36434880390768665,
        0.01125747816039009,
    ],
    [
        0.91831003276871925,
        0.071507242540885418,
        0.01018272467169418,
    ],
    [
        0.94925303017505269,
        0.041230434471375005,
        0.0095165353872374153,
    ],
    [
        0.95818783332924606,
        0.032423874183668412,
        0.0093882927286681756,
    ],
    [
        0.95818775133269718,
        0.031924629798200349,
        0.0098876190906702893,
    ],
    [
        0.95818762508778177,
        0.031276033173096844,
        0.010536342006458905,
    ],
    [
        0.95567906077174447,
        0.032630370429057413,
        0.011690568837444796,
    ],
    [
        0.95800615489342877,
        0.029530872149073878,
        0.012462972887103695,
    ],
    [
        0.95410157345656343,
        0.031561761170246415,
        0.014336665177420311,
    ],
    [
        0.94760760623723805,
        0.035674218270820388,
        0.016718175327544292,
    ],
    [
        0.93868132844754815,
        0.041403005395567259,
        0.019915666075002496,
    ],
    [
        0.9244666827514334,
        0.050604260448956107,
        0.024929056163280981,
    ],
    [
        0.9046060253330559,
        0.063434300381700351,
        0.031959673586040238,
    ],
    [
        0.88041219892793243,
        0.078918245293922926,
        0.040669554095248368,
    ],
    [
        0.84778787315169857,
        0.099542742665374689,
        0.052669382421939533,
    ],
    [
        0.80577912662301809,
        0.12559576009328702,
        0.068625110514194759,
    ],
    [
        0.75253185387142152,
        0.15759091044167997,
        0.089877232300013501,
    ],
    [0.68643939684457933, 0.19539823904421, 0.11816235892643401],
    [0.61869457086060975, 0.23147447477217845, 0.1498309474421331],
    [
        0.54026444395911122,
        0.26885213609526171,
        0.19088340934183401,
    ],
    [
        0.47296441629383762,
        0.29602916421792785,
        0.23100640302521697,
    ],
    [
        0.43270159670404906,
        0.30975499444194521,
        0.25754338542220195,
    ],
    [
        0.40535804552839244,
        0.31781588338382205,
        0.27682603872153572,
    ],
    [0.3854918349749028, 0.32299034738989796, 0.29151777281079483],
    [
        0.37098358455106067,
        0.32635384793800992,
        0.30266250608323286,
    ],
    [0.3576087015230815, 0.32914390227897949, 0.31324730130288586],
    [0.3487128001083929, 0.33080872680368206, 0.32047832512463303],
    [
        0.34488011934469148,
        0.33148268992224356,
        0.32363699470796092,
    ],
    [
        0.34191787732329115,
        0.33198455035238905,
        0.32609730884690052,
    ],
    [
        0.33953109298712925,
        0.33234117252254514,
        0.32812736934018444,
    ],
    [0.33716950377436727, 0.33291200941553917, 0.3299179759588885],
    [
        0.33617201852771694,
        0.33291927969521379,
        0.33090790121664942,
    ],
    [
        0.33516744343336274,
        0.33302767257885613,
        0.33180363309599509,
    ],
    [
        0.33442162530646313,
        0.33317970467326019,
        0.33239662725536101,
    ],
    [
        0.33400876037640204,
        0.33324703097454905,
        0.33274078072682406,
    ],
    [0.3339157927900821, 0.33325934921060074, 0.33282085708148867],
    [
        0.33381845494636675,
        0.33327505027938326,
        0.33290173128344441,
    ],
    [
        0.33367277492845621,
        0.33329432844873186,
        0.33302596748863184,
    ],
    [0.33356951340559093, 0.3333094249577751, 0.33311108308149712],
];

/// Midgray reference reflectance (upstream uses 0.184).
const MIDGRAY: f64 = 0.184;

fn matmul3(a: [[f64; 3]; 3], b: [[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut out = [[0.0f64; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    out
}

/// Core matrix mapping linear-sRGB RGB to film raw (green-midgray normalised).
///
/// `core[m][k] = (Σ_λ basis[λ][k] · illuminant[λ] · sensitivity[λ][m]) / midgray_g`,
/// with `midgray_g = Σ_λ illuminant[λ] · 0.184 · sensitivity[λ][1]`.
pub fn compute_core_matrix(sensitivity: &[[f64; 3]], illuminant: &[f64]) -> [[f64; 3]; 3] {
    let n_wl = sensitivity
        .len()
        .min(illuminant.len())
        .min(MALLETT2019_BASIS.len());
    // m_mallett[k][m] = Σ_λ basis[λ][k]·illuminant[λ]·sensitivity[λ][m]
    let mut m_mallett = [[0.0f64; 3]; 3];
    let mut midgray = [0.0f64; 3];
    for wl in 0..n_wl {
        let illu = illuminant[wl];
        let bi = [
            MALLETT2019_BASIS[wl][0] * illu,
            MALLETT2019_BASIS[wl][1] * illu,
            MALLETT2019_BASIS[wl][2] * illu,
        ];
        for k in 0..3 {
            for m in 0..3 {
                m_mallett[k][m] += bi[k] * sensitivity[wl][m];
            }
        }
        for m in 0..3 {
            midgray[m] += illu * MIDGRAY * sensitivity[wl][m];
        }
    }
    let g = midgray[1];
    let mut core = [[0.0f64; 3]; 3];
    for m in 0..3 {
        for k in 0..3 {
            core[m][k] = m_mallett[k][m] / g;
        }
    }
    core
}

/// Input colour space → linear sRGB matrices, baked from colour-science's
/// `matrix_RGB_to_RGB(<space>, sRGB, 'CAT02')`. Baked rather than reconstructed
/// because colour stores some primary matrices (e.g. ProPhoto) at 4-digit
/// precision, so composing the higher-precision Rust matrices would diverge by
/// ~1e-4 from upstream's actual `RGB_to_RGB`. Even sRGB→sRGB is not exactly the
/// identity for the same reason.
const M_CS_SRGB: [[f64; 3]; 3] = [
    [
        0.99999173999999968,
        -3.2584989817507904e-16,
        2.3159999999960313e-05,
    ],
    [
        2.167000000015163e-05,
        1.0000403200000001,
        -7.9399999999762392e-06,
    ],
    [3.7999999999427381e-07, 1.1920000000026354e-05, 1.00000355],
];
const M_CS_PROPHOTO: [[f64; 3]; 3] = [
    [
        2.036491724209688,
        -0.73759065250943212,
        -0.29925986889011419,
    ],
    [
        -0.2257179790832855,
        1.2231765312786034,
        0.0027252247674664941,
    ],
    [
        -0.010545128632237159,
        -0.13487984972504941,
        1.1452101524691205,
    ],
];
const M_CS_REC2020: [[f64; 3]; 3] = [
    [
        1.6603034854214438,
        -0.58757014253161699,
        -0.072890060215056104,
    ],
    [
        -0.12437559530838622,
        1.1328344814319584,
        -0.0083597371874014337,
    ],
    [
        -0.018112279959916489,
        -0.10058360850721247,
        1.118770326157098,
    ],
];
const M_CS_ACES2065_1: [[f64; 3]; 3] = [
    [
        2.5216494298433045,
        -1.1368885542222591,
        -0.38491759319444518,
    ],
    [
        -0.27521355124402608,
        1.3697051510263252,
        -0.094392450776519921,
    ],
    [
        -0.015925010090464285,
        -0.14780636811079964,
        1.1638058159424312,
    ],
];

/// Input colour space → linear sRGB (colour's `RGB_to_RGB` with CAT02). The
/// space names and the ProPhoto default mirror `colorspace_to_xyz_f64`.
pub fn input_cs_to_srgb(color_space: &str) -> [[f64; 3]; 3] {
    match color_space {
        "sRGB" => M_CS_SRGB,
        "Rec. 2020" | "Rec2020" | "ITU-R BT.2020" => M_CS_REC2020,
        "ACES2065-1" => M_CS_ACES2065_1,
        _ => M_CS_PROPHOTO,
    }
}

/// Full per-pixel matrix `core · M_cs` mapping input-colour-space RGB to raw.
pub fn film_matrix(core: &[[f64; 3]; 3], color_space: &str) -> [[f64; 3]; 3] {
    matmul3(*core, input_cs_to_srgb(color_space))
}

/// Apply a 3×3 raw matrix to one RGB triple: `raw = m · rgb`.
#[inline]
pub fn apply(m: &[[f64; 3]; 3], rgb: [f64; 3]) -> [f64; 3] {
    [
        m[0][0] * rgb[0] + m[0][1] * rgb[1] + m[0][2] * rgb[2],
        m[1][0] * rgb[0] + m[1][1] * rgb[1] + m[1][2] * rgb[2],
        m[2][0] * rgb[0] + m[2][1] * rgb[1] + m[2][2] * rgb[2],
    ]
}

#[cfg(test)]
mod parity_tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn data_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("data")
    }

    fn sensitivity(film: &crate::profile::Profile) -> Vec<[f64; 3]> {
        film.log_sensitivity_f64()
            .iter()
            .map(|row| {
                let mut out = [0.0f64; 3];
                for c in 0..3 {
                    let v = 10.0f64.powf(row[c]);
                    out[c] = if v.is_nan() { 0.0 } else { v };
                }
                out
            })
            .collect()
    }

    /// Mallett2019 RGB→raw regression guard. Cross-checked against upstream
    /// `rgb_to_raw_mallett2019` (colour-science basis + `RGB_to_RGB`) on the
    /// kodak_portra_400 sensitivity with its D55 reference illuminant, for both
    /// sRGB and ProPhoto input. Note colour's sRGB↔XYZ matrices are not exact
    /// inverses, so even sRGB→sRGB carries a ~2e-5 off-identity term — hence the
    /// sRGB case must also go through `film_matrix`, not the bare `core`.
    #[test]
    fn mallett_rgb_to_raw_matches_python() {
        let dir = data_dir();
        let film = crate::profile::load_profile_by_name(&dir, "kodak_portra_400").unwrap();
        let sens = sensitivity(&film);
        let illu = &spektrafilm_math::spectral::ILLUMINANT_D55_F64;
        let core = compute_core_matrix(&sens, illu);

        let srgb = film_matrix(&core, "sRGB");
        let srgb_cases: [([f64; 3], [f64; 3]); 4] = [
            (
                [0.184, 0.184, 0.184],
                [1.0261271743289262, 1.0000480357869586, 0.90783645942343971],
            ),
            (
                [0.5, 0.2, 0.8],
                [2.5959193807455856, 1.5669967316466955, 3.5305942856145802],
            ),
            (
                [0.9, 0.9, 0.1],
                [4.9104478344325155, 4.2939918170777842, 1.1774257970182864],
            ),
            (
                [0.05, 0.4, 0.6],
                [0.62562090012015215, 2.2862723969426275, 2.6767361929693676],
            ),
        ];
        for (rgb, want) in srgb_cases {
            let got = apply(&srgb, rgb);
            for c in 0..3 {
                assert!(
                    (got[c] - want[c]).abs() <= 1e-9 + 1e-9 * want[c].abs(),
                    "sRGB {rgb:?} ch {c}: {} vs {}",
                    got[c],
                    want[c]
                );
            }
        }

        let pp = film_matrix(&core, "ProPhoto RGB");
        let pp_cases: [([f64; 3], [f64; 3]); 4] = [
            (
                [0.184, 0.184, 0.184],
                [1.0258192985230492, 1.0001184102809104, 0.90765394681064204],
            ),
            (
                [0.5, 0.2, 0.8],
                [3.1683155254726083, 1.3409379130249184, 3.879877239815936],
            ),
            (
                [0.9, 0.9, 0.1],
                [6.0080668280419696, 4.2229236844575118, 0.7785667495185622],
            ),
            (
                [0.05, 0.4, 0.6],
                [-1.2797498408711341, 2.6305888165323061, 2.7163233124729302],
            ),
        ];
        for (rgb, want) in pp_cases {
            let got = apply(&pp, rgb);
            for c in 0..3 {
                assert!(
                    (got[c] - want[c]).abs() <= 1e-9 + 1e-9 * want[c].abs(),
                    "ProPhoto {rgb:?} ch {c}: {} vs {}",
                    got[c],
                    want[c]
                );
            }
        }
    }

    /// End-to-end smoke test: a `mallett2019` pipeline calibrates with no tc LUT
    /// and produces finite output through the full filming→printing→scanning chain.
    #[test]
    fn mallett_pipeline_calibrates_and_runs() {
        use spektrafilm_math::image::ImageBuf;
        use spektrafilm_math::precision::from_f64;

        let dir = data_dir();
        let film = crate::profile::load_profile_by_name(&dir, "kodak_portra_400").unwrap();
        let print = crate::profile::load_profile_by_name(&dir, "kodak_portra_endura").unwrap();
        let mut params = crate::params::RuntimeParams::default();
        params.settings.rgb_to_raw_method = "mallett2019".into();
        params.camera.auto_exposure = false;
        params.film_render.grain.active = false;

        let pipeline =
            crate::pipeline::Pipeline::new_with_spectral(film, print, params, &dir).unwrap();
        assert!(pipeline.tc_lut().is_none(), "mallett path builds no tc LUT");

        let g = from_f64(0.184);
        let img = ImageBuf::from_data(2, 2, vec![g; 12]);
        let out = pipeline.process(img, &spektrafilm_gpu::cpu_backend::CpuBackend);
        assert_eq!((out.width, out.height), (2, 2));
        assert!(
            out.data.iter().all(|v| (*v as f64).is_finite()),
            "mallett output must be finite"
        );
    }

    /// The mallett front pass in the GPU-resident chain matches the CPU
    /// per-stage path. The GPU shaders are f32, so the tolerance is the
    /// established resident-chain f32 budget (mean ~5e-3), not the 1e-9 of
    /// the f64 parity tests. Midtone inputs only — output highlight clipping
    /// is the known outlier regime for CPU↔GPU divergence.
    #[test]
    fn mallett_gpu_resident_matches_cpu() {
        use spektrafilm_math::image::ImageBuf;
        use spektrafilm_math::precision::from_f64;

        let Some(gpu) = spektrafilm_gpu::wgpu_backend::WgpuBackend::new() else {
            eprintln!("no GPU adapter available; skipping");
            return;
        };

        let dir = data_dir();
        let film = crate::profile::load_profile_by_name(&dir, "kodak_portra_400").unwrap();
        let print = crate::profile::load_profile_by_name(&dir, "kodak_portra_endura").unwrap();
        let mut params = crate::params::RuntimeParams::default();
        params.settings.rgb_to_raw_method = "mallett2019".into();
        params.camera.auto_exposure = false;
        // Nonzero EV so the resident path's exposure fold into the mallett
        // matrix is exercised, not just the identity case.
        params.camera.exposure_compensation_ev = 0.5;
        params.film_render.grain.active = false;
        // Output gamut compression forces the per-stage path — keep it off
        // so this test exercises the GPU-resident chain.
        params.io.output_gamut_compress.algorithm = "off".into();

        let pipeline =
            crate::pipeline::Pipeline::new_with_spectral(film, print, params, &dir).unwrap();

        let (w, h) = (16u32, 16u32);
        let data: Vec<_> = (0..w * h * 3)
            .map(|i| from_f64(0.05 + 0.5 * ((i * 37) % 256) as f64 / 255.0))
            .collect();
        let img = ImageBuf::from_data(w, h, data);

        let out_gpu = pipeline.process(img.clone(), &gpu);
        let out_cpu = pipeline.process(img, &spektrafilm_gpu::cpu_backend::CpuBackend);

        let mut max_diff = 0.0f64;
        let mut max_at = (0usize, 0.0f64, 0.0f64);
        let mut sum_diff = 0.0f64;
        for (i, (g, c)) in out_gpu.data.iter().zip(out_cpu.data.iter()).enumerate() {
            let d = (*g as f64 - *c as f64).abs();
            if d > max_diff {
                max_diff = d;
                max_at = (i, *g as f64, *c as f64);
            }
            sum_diff += d;
        }
        let mean_diff = sum_diff / out_cpu.data.len() as f64;
        // Same budget as the hanatos resident chain on this input (measured
        // mean 1.3e-3 / max 1.3e-2 vs mallett's 2.1e-3 / 2.6e-2): per-pixel
        // outliers come from f32 density-curve interpolation, not the front
        // pass. A wrong matrix would blow the mean by orders of magnitude.
        assert!(mean_diff < 5e-3, "mean GPU↔CPU divergence: {mean_diff}");
        assert!(
            max_diff < 5e-2,
            "max GPU↔CPU divergence: {max_diff} at idx {} (gpu {} vs cpu {})",
            max_at.0,
            max_at.1,
            max_at.2
        );
    }

    /// An unknown upsampler method is rejected at calibration (mirrors upstream).
    #[test]
    fn unknown_rgb_to_raw_method_errors() {
        let dir = data_dir();
        let film = crate::profile::load_profile_by_name(&dir, "kodak_portra_400").unwrap();
        let print = crate::profile::load_profile_by_name(&dir, "kodak_portra_endura").unwrap();
        let mut params = crate::params::RuntimeParams::default();
        params.settings.rgb_to_raw_method = "bogus".into();
        let err = match crate::pipeline::Pipeline::new_with_spectral(film, print, params, &dir) {
            Err(e) => e,
            Ok(_) => panic!("expected an error for an unknown method"),
        };
        assert!(err.contains("unsupported rgb_to_raw_method"), "{err}");
    }
}
