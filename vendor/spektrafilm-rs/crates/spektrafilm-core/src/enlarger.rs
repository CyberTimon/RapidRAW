/// Enlarger service: computes the filtered illuminant for the printing stage.
///
/// Models the dichroic CMY color filters and the TH-KG3 tungsten-halogen light source.
/// Filter values are in Kodak CC units (100 = 1.0 density = 90% reduction).
use spektrafilm_math::spectral::{self, N_WAVELENGTHS};

/// TH-KG3 illuminant SPD (tungsten-halogen + Schott KG3 heat filter)
/// at full f64 precision. Baked from Python's
/// `standard_illuminant('TH-KG3')`. The f32 fallback drops ~7 digits
/// per sample and accumulates ~3e-8 in the filtered illuminant.
const ILLUMINANT_TH_KG3_F64: [f64; N_WAVELENGTHS] = [
    0.27115487737678473,
    0.2933630241983439,
    0.31540886133985474,
    0.3369808836611168,
    0.3586779925678246,
    0.38052016290102403,
    0.40301341542370506,
    0.4267870797493813,
    0.4516515921147848,
    0.4780646983713809,
    0.5066708689059379,
    0.5366576010691867,
    0.5680769778513239,
    0.5999220381342626,
    0.630515347854697,
    0.6612217385546929,
    0.6920909115305464,
    0.7236647580300142,
    0.7576009324911563,
    0.7930688015230838,
    0.829084542867803,
    0.8654853588024557,
    0.902212749209677,
    0.938990050475476,
    0.9747004155955517,
    1.0087417855358256,
    1.040916738775546,
    1.0715558331394295,
    1.1009111192408307,
    1.131926197237691,
    1.1638985698017286,
    1.19636460651255,
    1.2303390279092097,
    1.2682954247580434,
    1.3068524359316893,
    1.3428629981362672,
    1.375710370915656,
    1.4046281460277452,
    1.4308952617117419,
    1.4554028101360024,
    1.4771790396751106,
    1.4964115098687572,
    1.5136660039295053,
    1.5280688440333003,
    1.538146469210825,
    1.5459434102593674,
    1.5515901051035574,
    1.5540261727761033,
    1.5535666436238242,
    1.5500616564793381,
    1.5408266875226315,
    1.5320737503736817,
    1.5194886088637505,
    1.5030832634966458,
    1.479985561016079,
    1.4599852627082766,
    1.4367535752409983,
    1.4032296202488896,
    1.3718429999284323,
    1.3404558220815574,
    1.3019482391882462,
    1.2649087261004042,
    1.2261391348332888,
    1.1802123657454517,
    1.136867763608742,
    1.0926534663168934,
    1.0452427815027683,
    1.0004794004746733,
    0.9480577282133905,
    0.9023807920757143,
    0.8546651971962678,
    0.7922263441280082,
    0.7345212240830614,
    0.6892285469718005,
    0.6522498893006442,
    0.607482301998138,
    0.5717547839358964,
    0.526940374973515,
    0.4866761911161827,
    0.449539809526992,
    0.41455292589926274,
];

/// TH-KG3 illuminant SPD (tungsten-halogen + Schott KG3 heat filter).
/// Baked from Python's `standard_illuminant('TH-KG3')`.
const ILLUMINANT_TH_KG3: [f32; N_WAVELENGTHS] = [
    0.271155, 0.293363, 0.315409, 0.336981, 0.358678, 0.380520, 0.403013, 0.426787, 0.451652,
    0.478065, 0.506671, 0.536658, 0.568077, 0.599922, 0.630515, 0.661222, 0.692091, 0.723665,
    0.757601, 0.793069, 0.829085, 0.865485, 0.902213, 0.938990, 0.974700, 1.008742, 1.040917,
    1.071556, 1.100911, 1.131926, 1.163899, 1.196365, 1.230339, 1.268295, 1.306852, 1.342863,
    1.375710, 1.404628, 1.430895, 1.455403, 1.477179, 1.496412, 1.513666, 1.528069, 1.538146,
    1.545943, 1.551590, 1.554026, 1.553567, 1.550062, 1.540827, 1.532074, 1.519489, 1.503083,
    1.479986, 1.459985, 1.436754, 1.403230, 1.371843, 1.340456, 1.301948, 1.264909, 1.226139,
    1.180212, 1.136868, 1.092653, 1.045243, 1.000479, 0.948058, 0.902381, 0.854665, 0.792226,
    0.734521, 0.689229, 0.652250, 0.607482, 0.571755, 0.526940, 0.486676, 0.449540, 0.414553,
];

/// TH-KG3 + default CMY dichroic filters (C=0, M=65, Y=55) at full f64 precision.
/// Baked from Python's `color_enlarger(standard_illuminant('TH-KG3'), (0, 65, 55))`.
pub const ILLUMINANT_TH_KG3_DEFAULT_FILTERS_F64: [f64; N_WAVELENGTHS] = [
    0.076421827812783602,
    0.082680934006473347,
    0.08889429511698034,
    0.09497411706729042,
    0.10108919320733555,
    0.10724515321222156,
    0.11358461311007609,
    0.12028494208498575,
    0.12729271380947246,
    0.13473693859299893,
    0.1427992528693425,
    0.15125066227867243,
    0.16010584580204665,
    0.16908100323669883,
    0.17770336942939643,
    0.18635760617251029,
    0.19505772120421974,
    0.2039564406313438,
    0.21352096037006471,
    0.22351668404629316,
    0.23363744629683408,
    0.2432488826107779,
    0.24735625670401551,
    0.22978765149526054,
    0.18081421309758575,
    0.13133385431563133,
    0.11994061263796985,
    0.14769238817210392,
    0.19019156674164894,
    0.2271276476184739,
    0.25130540461178019,
    0.26541441186065001,
    0.27497594883722626,
    0.2838715857361308,
    0.29256135527354399,
    0.30062911352644833,
    0.30798316495996542,
    0.31445707136359646,
    0.32033754692537281,
    0.3258241039638296,
    0.33069925935007316,
    0.33501055498097576,
    0.33910665126158795,
    0.34684180528620251,
    0.39036895200336019,
    0.57212079355872469,
    0.9494739308862189,
    1.32681724491585,
    1.5070844264164487,
    1.5452434916315201,
    1.5405833549263461,
    1.5320678663435376,
    1.5194885418034796,
    1.5030832631393889,
    1.479985561015196,
    1.4599852627082757,
    1.4367535752409983,
    1.4032296202488896,
    1.3718429999284323,
    1.3404558220815574,
    1.3019482391882462,
    1.2649087261004042,
    1.2261391348332888,
    1.1802123657454517,
    1.1368677636087421,
    1.0926534663168934,
    1.0452427815027683,
    1.0004794004746733,
    0.94805772821339052,
    0.90238079207571431,
    0.85466519719626777,
    0.79222634412800819,
    0.73452122408306142,
    0.68922854697180047,
    0.6522498893006442,
    0.60748230199813802,
    0.5717547839358964,
    0.52694037497351498,
    0.48667619111618271,
    0.44953980952699202,
    0.41455292589926274,
];

/// TH-KG3 + default CMY dichroic filters (C=0, M=65, Y=55) — f32 fallback.
/// Baked from Python's `color_enlarger(standard_illuminant('TH-KG3'), (0, 65, 55))`.
pub const ILLUMINANT_TH_KG3_DEFAULT_FILTERS: [f32; N_WAVELENGTHS] = [
    0.076422, 0.082681, 0.088894, 0.094974, 0.101089, 0.107245, 0.113585, 0.120285, 0.127293,
    0.134737, 0.142799, 0.151251, 0.160106, 0.169081, 0.177703, 0.186358, 0.195058, 0.203956,
    0.213521, 0.223517, 0.233637, 0.243249, 0.247356, 0.229788, 0.180814, 0.131334, 0.119941,
    0.147692, 0.190192, 0.227128, 0.251305, 0.265414, 0.274976, 0.283872, 0.292561, 0.300629,
    0.307983, 0.314457, 0.320338, 0.325824, 0.330699, 0.335011, 0.339107, 0.346842, 0.390369,
    0.572121, 0.949474, 1.326817, 1.507084, 1.545243, 1.540583, 1.532068, 1.519489, 1.503083,
    1.479986, 1.459985, 1.436754, 1.403230, 1.371843, 1.340456, 1.301948, 1.264909, 1.226139,
    1.180212, 1.136868, 1.092653, 1.045243, 1.000479, 0.948058, 0.902381, 0.854665, 0.792226,
    0.734521, 0.689229, 0.652250, 0.607482, 0.571755, 0.526940, 0.486676, 0.449540, 0.414553,
];

/// Compute filtered enlarger illuminant with CMY dichroic filters.
///
/// Filter values are in Kodak CC units: 100 = 1.0 density = 90% reduction.
/// For the default TH-KG3 + (C=0, M=65, Y=55) configuration, uses the exact
/// baked values from the Python reference to ensure parity.
pub fn enlarger_filtered_illuminant(
    illuminant_name: &str,
    c_filter: f32,
    m_filter: f32,
    y_filter: f32,
) -> Vec<f32> {
    enlarger_filtered_illuminant_f64(
        illuminant_name,
        c_filter as f64,
        m_filter as f64,
        y_filter as f64,
    )
    .into_iter()
    .map(|v| v as f32)
    .collect()
}

/// Compute filtered enlarger illuminant in f64 (Python parity).
///
/// Filter values are f64 to avoid the f32 truncation drift — the
/// neutral-filter database stores them at full f64 precision, and the
/// ~5-7 digit precision drop from `as f32` propagates through
/// `10^(-cc/100)` to a ~4e-8 shift in the filtered illuminant, which
/// is the seed of the print stage's parity drift.
pub fn enlarger_filtered_illuminant_f64(
    illuminant_name: &str,
    c_filter: f64,
    m_filter: f64,
    y_filter: f64,
) -> Vec<f64> {
    // Fast path: use baked f64 values for default TH-KG3 configuration
    if illuminant_name == "TH-KG3"
        && (c_filter - 0.0).abs() < 0.01
        && (m_filter - 65.0).abs() < 0.01
        && (y_filter - 55.0).abs() < 0.01
    {
        return ILLUMINANT_TH_KG3_DEFAULT_FILTERS_F64.to_vec();
    }

    let light_source: Vec<f64> = match illuminant_name {
        "TH-KG3" => ILLUMINANT_TH_KG3_F64.to_vec(),
        "D50" => spectral::ILLUMINANT_D50_F64.to_vec(),
        "D55" => spectral::ILLUMINANT_D55_F64.to_vec(),
        "D65" => spectral::ILLUMINANT_D65_F64.to_vec(),
        _ => ILLUMINANT_TH_KG3.iter().map(|&v| v as f64).collect(),
    };

    let dichroics = dichroic_filters_f64();
    let filter_cc = [c_filter, m_filter, y_filter];

    // Convert CC values to transmittance: 10^(-cc/100)
    let filter_transmittance: [f64; 3] = [
        10.0f64.powf(-filter_cc[0] / 100.0),
        10.0f64.powf(-filter_cc[1] / 100.0),
        10.0f64.powf(-filter_cc[2] / 100.0),
    ];

    // Apply dichroic filters: for each CMY filter,
    //   dimmed = 1 - (1 - dichroic) * (1 - transmittance_value)
    //   combined = product of all 3 dimmed filters
    let mut filtered = vec![0.0f64; N_WAVELENGTHS];
    for i in 0..N_WAVELENGTHS {
        let mut total = 1.0f64;
        for f in 0..3 {
            let dimmed = 1.0 - (1.0 - dichroics[i][f]) * (1.0 - filter_transmittance[f]);
            total *= dimmed;
        }
        filtered[i] = light_source[i] * total;
    }

    filtered
}

/// Spatially-constant raw 3-vector added to every print pixel's exposure
/// *before* the inner `log10` — the enlarger preflash (a uniform low
/// pre-exposure that lifts shadow density and lowers print contrast).
///
/// Port of Python `PrintingStage._compute_raw_preflash`: the film base
/// density is lit by the preflash-filtered illuminant (the enlarger filters
/// at neutral plus the preflash Y/M shifts), integrated against the print
/// sensitivity, and scaled by `preflash_exposure`. Returns `[0; 3]` when
/// preflash is off, so the runtime path stays inert by default.
pub fn compute_preflash_raw(
    enlarger: &crate::params::EnlargerParams,
    c_neutral: f64,
    m_neutral: f64,
    y_neutral: f64,
    base_density: &[f64],
    print_sensitivity: &[[f64; 3]],
) -> [f64; 3] {
    if enlarger.preflash_exposure <= 0.0 {
        return [0.0; 3];
    }
    let preflash_illuminant = enlarger_filtered_illuminant_f64(
        &enlarger.illuminant,
        c_neutral,
        m_neutral + enlarger.preflash_m_filter_shift as f64,
        y_neutral + enlarger.preflash_y_filter_shift as f64,
    );
    let n_wl = preflash_illuminant
        .len()
        .min(base_density.len())
        .min(print_sensitivity.len());
    let mut raw = [0.0f64; 3];
    for wl in 0..n_wl {
        // density_to_light: 10^(-base) * illuminant, NaN → 0 (base_density
        // carries NaN at wavelengths with no data — see deser_nullable_vec).
        let t = 10.0f64.powf(-base_density[wl]) * preflash_illuminant[wl];
        let light = if t.is_nan() { 0.0 } else { t };
        for c in 0..3 {
            raw[c] += light * print_sensitivity[wl][c];
        }
    }
    let e = enlarger.preflash_exposure as f64;
    [raw[0] * e, raw[1] * e, raw[2] * e]
}

/// f64 dichroic filter curves.
fn dichroic_filters_f64() -> [[f64; 3]; N_WAVELENGTHS] {
    let edges = [516.0f64, 500.0, 610.0, 607.0];
    let transitions = [12.0f64, 8.0, 8.0, 8.0];

    let mut filters = [[0.0f64; 3]; N_WAVELENGTHS];
    for i in 0..N_WAVELENGTHS {
        let wl = spectral::WAVELENGTH_MIN as f64 + (i as f64) * spectral::WAVELENGTH_STEP as f64;
        filters[i][2] = erf((wl - edges[0]) / transitions[0]) / 2.0 + 0.5;
        if wl <= 550.0 {
            filters[i][1] = -erf((wl - edges[1]) / transitions[1]) / 2.0 + 0.5;
        } else {
            filters[i][1] = erf((wl - edges[2]) / transitions[2]) / 2.0 + 0.5;
        }
        filters[i][0] = -erf((wl - edges[3]) / transitions[3]) / 2.0 + 0.5;
    }
    filters
}

/// Midgray sensor raw for the hanatos2025 upsampling path: `rgb_midgray·scale`
/// pushed through the tc LUT. Always evaluated in sRGB (see
/// `midgray_density_spectral_from_raw`); `scale` folds the EV compensation.
pub fn midgray_raw_hanatos(
    tc_lut: &spektrafilm_math::spectral::TcLut,
    ref_illuminant: &[f32],
    use_cat16: bool,
    scale: f64,
) -> [f64; 3] {
    use spektrafilm_math::image::ImageBuf;
    let gray = spektrafilm_math::precision::from_f64(0.184 * scale);
    let img = ImageBuf::from_data(1, 1, vec![gray, gray, gray]);
    let raw = spektrafilm_math::spectral::hanatos2025_rgb_to_raw(
        &img,
        tc_lut,
        "sRGB",
        ref_illuminant,
        use_cat16,
    );
    let p = raw.get(0, 0);
    [p[0] as f64, p[1] as f64, p[2] as f64]
}

/// Midgray spectral density through the film, from the midgray sensor raw.
///
/// Shared tail of Python's `_simple_rgb_to_density_spectral`:
///   raw → log10(raw + 1e-10) → develop_simple (RAW curves, no normalization)
///   → compute_density_spectral (einsum + base_density).
///
/// The raw is computed by the configured upsampler (`midgray_raw_hanatos` or
/// the Mallett core matrix). Python's `_rgb_to_film_raw(rgb)` defaults to
/// `color_space="sRGB"`, so midgray calibration is always done in sRGB
/// regardless of the runtime input color space — otherwise the print exposure
/// normalization would shift with the working space. Callers must honour that.
///
/// Critically: the curves are NOT normalized by their per-channel minimum here —
/// that normalization happens only in the full `develop` path, not the midgray
/// calibration path. See `spektrafilm/runtime/stages/filming.py:_simple_rgb_to_density_spectral`.
pub fn midgray_density_spectral_from_raw(
    raw: [f64; 3],
    film: &crate::profile::Profile,
    params: &crate::params::RuntimeParams,
) -> Vec<f64> {
    // Python: log_raw = np.log10(raw + 1e-10)
    let log_raw: [f64; 3] = [
        (raw[0] + 1e-10).log10(),
        (raw[1] + 1e-10).log10(),
        (raw[2] + 1e-10).log10(),
    ];

    // Python: density_cmy = interpolate_exposure_to_density(log_raw, density_curves, log_exposure, gamma_factor)
    // - density_curves is used RAW (not normalized) in the midgray path
    // - gamma_factor scalar → broadcast to [gamma, gamma, gamma] per channel
    // - x-axis per channel = log_exposure / gamma_factor[c]
    let log_exposure = film.log_exposure_f64();
    let density_curves = film.density_curves_f64();
    let g = params.film_render.density_curve_gamma as f64;
    let gamma = [g, g, g];

    let density_cmy =
        interp_density_curve_at_log_raw(&log_raw, &log_exposure, &density_curves, &gamma);

    // Python: compute_density_spectral — einsum + base_density. NaN propagates per wavelength.
    let n_wl = film.data.channel_density.len();
    let mut spectral = vec![0.0f64; n_wl];
    for wl in 0..n_wl {
        let cd = &film.data.channel_density[wl];
        let s = density_cmy[0] * cd[0] + density_cmy[1] * cd[1] + density_cmy[2] * cd[2];
        let bd = if wl < film.data.base_density.len() {
            film.data.base_density[wl]
        } else {
            0.0
        };
        spectral[wl] = s + bd;
    }
    spectral
}

/// Port of Python's `fast_interp` for a single point per channel, used in the midgray chain.
///
/// Python (`utils/fast_interp.py`):
///   - Per-channel x-axis: `log_exposure[:, None] / gamma_factor[None, :]` → shape (n, 3)
///   - For each channel: bisect/searchsorted in xa[:, c], then linear interp into y[:, c]
///   - Clamp to endpoints outside the range
fn interp_density_curve_at_log_raw(
    log_raw: &[f64; 3],
    log_exposure: &[f64],
    density_curves: &[[f64; 3]],
    gamma: &[f64; 3],
) -> [f64; 3] {
    let n = log_exposure.len();
    let mut out = [0.0f64; 3];
    for c in 0..3 {
        // Per-channel stretched x-axis
        let xa: Vec<f64> = log_exposure.iter().map(|&v| v / gamma[c]).collect();
        let xq = log_raw[c];
        if xq <= xa[0] {
            out[c] = density_curves[0][c];
        } else if xq >= xa[n - 1] {
            out[c] = density_curves[n - 1][c];
        } else {
            // bisect_right then step back one — matches numpy searchsorted(side='right') - 1
            let idx = xa.partition_point(|&v| v <= xq);
            let low = idx - 1;
            let dx = xa[low + 1] - xa[low];
            let frac = if dx != 0.0 { (xq - xa[low]) / dx } else { 0.0 };
            out[c] = density_curves[low][c]
                + frac * (density_curves[low + 1][c] - density_curves[low][c]);
        }
    }
    out
}

/// Compute the print exposure normalization factor from midgray spectral density.
///
/// Port of Python `_exposure_factor` (printing.py:120):
///   light = density_to_light(density_spectral_midgray, print_illuminant)
///       = 10^(-density) * light;  light[isnan] = 0
///   raw = einsum("ijk, kl->ijl", light, sensitivity)
///   raw = np.fmax(raw, 1e-10)
///   geomean = exp(mean(log(raw), axis=channel))
///   return 1 / geomean
///
/// `print_sensitivity` is f64 to preserve precision through the einsum
/// (Python: `np.nan_to_num(10 ** log_sensitivity)`).
pub fn compute_exposure_factor(
    density_spectral_midgray: &[f64],
    print_illuminant: &[f64],
    print_sensitivity: &[[f64; 3]],
) -> f64 {
    let n_wl = density_spectral_midgray
        .len()
        .min(print_illuminant.len())
        .min(print_sensitivity.len());

    // Mirror Python's `_exposure_factor`:
    //   light = density_to_light(d_spec, illuminant)  # element-wise
    //   raw   = contract('ijk,kl->ijl', light, sens)  # numpy pairwise sum
    // numpy/opt_einsum use pairwise reduction (recursive halving) over
    // the 81 wavelengths — a hand-rolled left-to-right loop drifts by
    // ~10 ULPs across that sum, which on a small geomean propagates to
    // ~1e-8 in the factor and from there to every print pixel.
    let mut light = vec![0.0f64; n_wl];
    for wl in 0..n_wl {
        let d = density_spectral_midgray[wl];
        let t = 10.0f64.powf(-d) * print_illuminant[wl];
        light[wl] = if t.is_nan() { 0.0 } else { t };
    }
    let mut raw = [0.0f64; 3];
    for c in 0..3 {
        let mut per_wl = Vec::with_capacity(n_wl);
        for wl in 0..n_wl {
            per_wl.push(light[wl] * print_sensitivity[wl][c]);
        }
        raw[c] = crate::spectral_service::pairwise_sum_f64_pub(&per_wl);
    }

    // Python: raw_midgray = np.fmax(raw_midgray, 1e-10)
    //         geomean = exp(mean(log(raw_midgray)))
    let log_sum: f64 = raw.iter().map(|&v| v.max(1e-10).ln()).sum::<f64>() / 3.0;
    let geomean = log_sum.exp();

    1.0 / geomean
}

/// f64 erf — matches scipy.special.erf at full f64 precision (libm).
#[inline]
fn erf(x: f64) -> f64 {
    libm::erf(x)
}

#[cfg(test)]
mod parity_tests {
    use crate::pipeline::Pipeline;
    use std::path::{Path, PathBuf};

    fn data_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("data")
    }

    /// Enlarger preflash regression guard. The constant preflash raw vector is
    /// the film base density lit by the preflash-filtered illuminant, integrated
    /// against the print sensitivity and scaled by `preflash_exposure` — Python
    /// `PrintingStage._compute_raw_preflash`. Reference values were computed from
    /// a faithful numpy transcription (`density_to_light` + `einsum`) on the real
    /// kodak_portra_400 base density and kodak_portra_endura sensitivity, with the
    /// baked TH-KG3 (C0 M65 Y55) default-filter illuminant and exposure 0.0625
    /// (an f32-exact value, so the f32→f64 widening of `preflash_exposure` is
    /// not part of the comparison).
    #[test]
    fn preflash_raw_matches_python_reference() {
        let dir = data_dir();
        let film = crate::profile::load_profile_by_name(&dir, "kodak_portra_400").unwrap();
        let print = crate::profile::load_profile_by_name(&dir, "kodak_portra_endura").unwrap();

        let mut params = crate::params::RuntimeParams::default();
        // Keep the neutral filters at the param defaults (C=0, M=65, Y=55) so the
        // preflash illuminant is the baked TH-KG3 default-filter spectrum the
        // reference used (no per-stock database override).
        params.settings.neutral_print_filters_from_database = false;
        params.enlarger.preflash_exposure = 0.0625;

        let pipeline = Pipeline::new_with_spectral(film, print, params, &dir).unwrap();
        let p = pipeline.preflash_raw();

        let expect = [0.4567086334477163, 0.3959958805787103, 0.5172324967476551];
        for c in 0..3 {
            assert!(
                (p[c] - expect[c]).abs() < 1e-12,
                "channel {c}: {} vs {}",
                p[c],
                expect[c]
            );
        }
    }

    /// Preflash is inert by default — `preflash_exposure == 0` yields no exposure.
    #[test]
    fn preflash_off_is_zero() {
        let dir = data_dir();
        let film = crate::profile::load_profile_by_name(&dir, "kodak_portra_400").unwrap();
        let print = crate::profile::load_profile_by_name(&dir, "kodak_portra_endura").unwrap();

        let params = crate::params::RuntimeParams::default();
        assert_eq!(params.enlarger.preflash_exposure, 0.0);

        let pipeline = Pipeline::new_with_spectral(film, print, params, &dir).unwrap();
        assert_eq!(pipeline.preflash_raw(), [0.0; 3]);
    }
}
