use crate::colorspace;
use crate::image::ImageBuf;
use crate::lut;
use byteorder::{LittleEndian, ReadBytesExt};
/// Spectral upsampling (Hanatos2025 method) and spectral constants.
///
/// Wavelength grid: 380-780 nm at 5 nm intervals (81 samples).
use std::io::Read;

pub const WAVELENGTH_MIN: f32 = 380.0;
pub const WAVELENGTH_MAX: f32 = 780.0;
pub const WAVELENGTH_STEP: f32 = 5.0;
pub const N_WAVELENGTHS: usize = 81;

pub const CMF_X: [f32; N_WAVELENGTHS] = [
    0.001368, 0.002236, 0.004243, 0.007650, 0.014310, 0.023190, 0.043510, 0.077630, 0.134380,
    0.214770, 0.283900, 0.328500, 0.348280, 0.348060, 0.336200, 0.318700, 0.290800, 0.251100,
    0.195360, 0.142100, 0.095640, 0.058010, 0.032010, 0.014700, 0.004900, 0.002400, 0.009300,
    0.029100, 0.063270, 0.109600, 0.165500, 0.225750, 0.290400, 0.359700, 0.433450, 0.512050,
    0.594500, 0.678400, 0.762100, 0.842500, 0.916300, 0.978600, 1.026300, 1.056700, 1.062200,
    1.045600, 1.002600, 0.938400, 0.854450, 0.751400, 0.642400, 0.541900, 0.447900, 0.360800,
    0.283500, 0.218700, 0.164900, 0.121200, 0.087400, 0.063600, 0.046770, 0.032900, 0.022700,
    0.015840, 0.011359, 0.008111, 0.005790, 0.004109, 0.002899, 0.002049, 0.001440, 0.001000,
    0.000690, 0.000476, 0.000332, 0.000235, 0.000166, 0.000117, 0.000083, 0.000059, 0.000042,
];
pub const CMF_Y: [f32; N_WAVELENGTHS] = [
    0.000039, 0.000064, 0.000120, 0.000217, 0.000396, 0.000640, 0.001210, 0.002180, 0.004000,
    0.007300, 0.011600, 0.016840, 0.023000, 0.029800, 0.038000, 0.048000, 0.060000, 0.073900,
    0.090980, 0.112600, 0.139020, 0.169300, 0.208020, 0.258600, 0.323000, 0.407300, 0.503000,
    0.608200, 0.710000, 0.793200, 0.862000, 0.914850, 0.954000, 0.980300, 0.994950, 1.000000,
    0.995000, 0.978600, 0.952000, 0.915400, 0.870000, 0.816300, 0.757000, 0.694900, 0.631000,
    0.566800, 0.503000, 0.441200, 0.381000, 0.321000, 0.265000, 0.217000, 0.175000, 0.138200,
    0.107000, 0.081600, 0.061000, 0.044580, 0.032000, 0.023200, 0.017000, 0.011920, 0.008210,
    0.005723, 0.004102, 0.002929, 0.002091, 0.001484, 0.001047, 0.000740, 0.000520, 0.000361,
    0.000249, 0.000172, 0.000120, 0.000085, 0.000060, 0.000042, 0.000030, 0.000021, 0.000015,
];
/// Full-precision f64 CIE 1931 2° colour-matching functions —
/// exact match with `colour.MSDS_CMFS['CIE 1931 2 Degree Standard Observer']`
/// sampled at 380–780 nm @ 5 nm. The f32 constants below drop ~7 digits
/// per sample and contribute ~5e-6 of scan-stage parity drift after the
/// 81-wavelength reduction.
pub const CMF_X_F64: [f64; N_WAVELENGTHS] = [
    0.001367999999999999,
    0.0022360000000000036,
    0.004242999999999995,
    0.007650000000000009,
    0.014310000000000015,
    0.02318999999999999,
    0.04351000000000006,
    0.07763000000000013,
    0.13437999999999997,
    0.21476999999999988,
    0.2838999999999997,
    0.32849999999999996,
    0.34828000000000064,
    0.3480599999999996,
    0.3362,
    0.3187000000000001,
    0.2908000000000001,
    0.2510999999999998,
    0.19536000000000003,
    0.14209999999999998,
    0.09564000000000014,
    0.05795001000000004,
    0.03201000000000002,
    0.014700000000000029,
    0.0049000000000000085,
    0.0023999999999999985,
    0.009299999999999987,
    0.029099999999999994,
    0.06326999999999997,
    0.1096,
    0.16550000000000006,
    0.2257498999999999,
    0.2904000000000001,
    0.35969999999999924,
    0.43344990000000044,
    0.5120500999999994,
    0.5945000000000001,
    0.6784000000000019,
    0.7620999999999987,
    0.8425000000000007,
    0.9163000000000006,
    0.9785999999999998,
    1.0263000000000002,
    1.0567000000000006,
    1.0622000000000011,
    1.0455999999999988,
    1.002600000000001,
    0.9383999999999998,
    0.8544499000000009,
    0.7514000000000002,
    0.6424000000000001,
    0.5418999999999998,
    0.44790000000000013,
    0.36079999999999957,
    0.2834999999999997,
    0.21869999999999998,
    0.16490000000000027,
    0.12120000000000006,
    0.08740000000000003,
    0.06359999999999995,
    0.046770000000000096,
    0.032900000000000006,
    0.02270000000000002,
    0.015839999999999986,
    0.011359160000000002,
    0.008110916000000008,
    0.005790346000000004,
    0.004109457000000003,
    0.0028993270000000045,
    0.0020491899999999976,
    0.0014399709999999989,
    0.0009999492999999992,
    0.000690078599999999,
    0.0004760212999999998,
    0.0003323010999999998,
    0.00023482609999999986,
    0.00016615050000000006,
    0.00011741300000000006,
    8.307527000000014e-05,
    5.870651999999992e-05,
    4.1509940000000024e-05,
];
pub const CMF_Y_F64: [f64; N_WAVELENGTHS] = [
    3.9000000000000006e-05,
    6.400000000000001e-05,
    0.00012000000000000023,
    0.0002170000000000001,
    0.00039599999999999965,
    0.0006400000000000006,
    0.0012099999999999986,
    0.0021800000000000014,
    0.003999999999999998,
    0.007299999999999996,
    0.0116,
    0.01684,
    0.022999999999999958,
    0.029799999999999997,
    0.038,
    0.048,
    0.05999999999999997,
    0.07390000000000006,
    0.09098000000000009,
    0.11259999999999995,
    0.13901999999999984,
    0.16930000000000012,
    0.20802000000000018,
    0.2585999999999998,
    0.3230000000000004,
    0.40729999999999955,
    0.503,
    0.6082,
    0.7099999999999982,
    0.7931999999999992,
    0.8620000000000013,
    0.9148501000000003,
    0.954000000000001,
    0.9802999999999993,
    0.9949501,
    1.0,
    0.9950000000000009,
    0.9785999999999984,
    0.951999999999999,
    0.9154000000000012,
    0.8700000000000009,
    0.8163000000000001,
    0.7570000000000005,
    0.6948999999999997,
    0.6310000000000001,
    0.5668000000000005,
    0.5030000000000002,
    0.44120000000000004,
    0.3809999999999996,
    0.32099999999999973,
    0.2650000000000001,
    0.21700000000000036,
    0.17500000000000002,
    0.1382000000000001,
    0.10700000000000008,
    0.08160000000000009,
    0.06099999999999994,
    0.04457999999999998,
    0.031999999999999945,
    0.023199999999999988,
    0.017000000000000008,
    0.011919999999999986,
    0.008209999999999992,
    0.00572300000000001,
    0.004101999999999998,
    0.0029290000000000045,
    0.0020909999999999982,
    0.0014839999999999999,
    0.001046999999999999,
    0.0007399999999999985,
    0.0005200000000000007,
    0.00036109999999999983,
    0.0002492000000000002,
    0.00017189999999999952,
    0.00011999999999999991,
    8.480000000000008e-05,
    6.000000000000006e-05,
    4.2399999999999974e-05,
    2.9999999999999994e-05,
    2.1200000000000004e-05,
    1.499e-05,
];
pub const CMF_Z_F64: [f64; N_WAVELENGTHS] = [
    0.006450001000000005,
    0.010549989999999976,
    0.020050009999999986,
    0.03621000000000002,
    0.06785000999999999,
    0.11019999999999998,
    0.20739999999999972,
    0.3713000000000002,
    0.6455999999999998,
    1.0390501000000005,
    1.3856,
    1.6229600000000006,
    1.747059999999998,
    1.782599999999997,
    1.7721099999999987,
    1.7440999999999993,
    1.669200000000001,
    1.5280999999999991,
    1.287640000000001,
    1.0418999999999996,
    0.8129500999999999,
    0.6162000000000009,
    0.4651799999999993,
    0.35329999999999967,
    0.27199999999999985,
    0.21230000000000016,
    0.15820000000000015,
    0.11169999999999997,
    0.07824999000000012,
    0.05725001000000006,
    0.04216000000000003,
    0.029839999999999988,
    0.020299999999999953,
    0.013400000000000004,
    0.008749998999999993,
    0.005749999000000004,
    0.0038999999999999972,
    0.002749999000000001,
    0.002099999999999999,
    0.0018,
    0.001650001000000001,
    0.0014000000000000009,
    0.0010999999999999998,
    0.0009999999999999998,
    0.0007999999999999996,
    0.0006000000000000004,
    0.0003399999999999997,
    0.00024000000000000033,
    0.00019,
    0.00010000000000000014,
    4.999999000000001e-05,
    2.9999999999999994e-05,
    2.0000000000000032e-05,
    1.000000000000001e-05,
    -1.4823076576950256e-21,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
];

pub const CMF_Z: [f32; N_WAVELENGTHS] = [
    0.006450, 0.010550, 0.020050, 0.036210, 0.067850, 0.110200, 0.207400, 0.371300, 0.645600,
    1.039050, 1.385600, 1.622960, 1.747060, 1.782600, 1.772110, 1.744100, 1.669200, 1.528100,
    1.287640, 1.041900, 0.812950, 0.616200, 0.465180, 0.353300, 0.272000, 0.212300, 0.158200,
    0.111700, 0.078250, 0.057250, 0.042160, 0.029840, 0.020300, 0.013400, 0.008750, 0.005750,
    0.003900, 0.002750, 0.002100, 0.001800, 0.001650, 0.001400, 0.001100, 0.001000, 0.000800,
    0.000600, 0.000340, 0.000240, 0.000190, 0.000100, 0.000050, 0.000030, 0.000020, 0.000010,
    0.000000, 0.000000, 0.000000, 0.000000, 0.000000, 0.000000, 0.000000, 0.000000, 0.000000,
    0.000000, 0.000000, 0.000000, 0.000000, 0.000000, 0.000000, 0.000000, 0.000000, 0.000000,
    0.000000, 0.000000, 0.000000, 0.000000, 0.000000, 0.000000, 0.000000, 0.000000, 0.000000,
];

/// Illuminant SPDs normalized to match Python colour-science `standard_illuminant()`.
/// These are the exact values returned by spektrafilm's Python illuminant loader.
pub const ILLUMINANT_D55: [f32; N_WAVELENGTHS] = [
    0.37928266, 0.41130471, 0.44333841, 0.57639697, 0.70945552, 0.75371138, 0.79797887, 0.81556713,
    0.83316704, 0.81185393, 0.79052917, 0.89349794, 0.99645507, 1.06855416, 1.14065325, 1.15502884,
    1.16940443, 1.16620338, 1.16300234, 1.17944987, 1.19589741, 1.16877586, 1.14164267, 1.15678650,
    1.17193034, 1.17202346, 1.17210494, 1.16798433, 1.16386371, 1.18843607, 1.21302007, 1.20075135,
    1.18848263, 1.19352282, 1.19856300, 1.18128902, 1.16401504, 1.14781195, 1.13160886, 1.13470514,
    1.13781306, 1.10104182, 1.06428223, 1.08167261, 1.09905136, 1.10325345, 1.10744390, 1.10208944,
    1.09673497, 1.07478164, 1.05282832, 1.06378170, 1.07473508, 1.05450450, 1.03427392, 1.04279451,
    1.05130346, 1.07244197, 1.09359213, 1.07034675, 1.04710137, 0.98728263, 0.92745226, 0.94585534,
    0.96427006, 0.97593349, 0.98759692, 0.90256562, 0.81754596, 0.87031076, 0.92307556, 0.95620343,
    0.98933130, 0.91301847, 0.83669401, 0.72561205, 0.61451846, 0.74916008, 0.88380170, 0.85988119,
    0.83597232,
];
pub const ILLUMINANT_D65: [f32; N_WAVELENGTHS] = [
    0.57072795, 0.59740886, 0.62409091, 0.78458177, 0.94507378, 0.99492846, 1.04478429, 1.05589496,
    1.06700563, 1.02846489, 0.98992529, 1.09374935, 1.19757455, 1.26690631, 1.33624949, 1.34084039,
    1.34543129, 1.32857514, 1.31173041, 1.31779452, 1.32385862, 1.28324855, 1.24263848, 1.24573334,
    1.24883962, 1.23997758, 1.23111554, 1.21391679, 1.19671803, 1.21326584, 1.22982506, 1.21107317,
    1.19232127, 1.19026565, 1.18822144, 1.16511846, 1.14201549, 1.12108349, 1.10015149, 1.09703264,
    1.09391380, 1.05335854, 1.01280329, 1.02034402, 1.02788475, 1.02555960, 1.02323560, 1.01238417,
    1.00153274, 0.97635016, 0.95116871, 0.95351327, 0.95585783, 0.93488814, 0.91391845, 0.91499081,
    0.91606316, 0.92784419, 0.93962522, 0.91682146, 0.89401769, 0.84512230, 0.79622805, 0.80700753,
    0.81778702, 0.83343149, 0.84907710, 0.77630216, 0.70352722, 0.75081580, 0.79810438, 0.82780478,
    0.85750517, 0.79187126, 0.72623849, 0.62817019, 0.53010303, 0.64651553, 0.76292802, 0.74338471,
    0.72384139,
];
pub const ILLUMINANT_D50: [f32; N_WAVELENGTHS] = [
    0.28500907, 0.31632887, 0.34766031, 0.46076543, 0.57388219, 0.61580487, 0.65773919, 0.67822334,
    0.69871914, 0.68582343, 0.67292773, 0.77189179, 0.87086750, 0.94315561, 1.01544372, 1.03503170,
    1.05460803, 1.05900747, 1.06340690, 1.08517132, 1.10694737, 1.08863966, 1.07033195, 1.09221275,
    1.11410518, 1.11928442, 1.12445201, 1.12745480, 1.13045759, 1.15937982, 1.18830205, 1.18048083,
    1.17265960, 1.18174945, 1.19083929, 1.17736165, 1.16387237, 1.15069733, 1.13751066, 1.14440078,
    1.15127927, 1.11973833, 1.08820902, 1.11258051, 1.13696364, 1.14615823, 1.15536446, 1.15403765,
    1.15272247, 1.13340219, 1.11408191, 1.13233143, 1.15056931, 1.13200554, 1.11344178, 1.12812985,
    1.14280628, 1.17082069, 1.19882345, 1.17630252, 1.15378159, 1.08539245, 1.01700331, 1.04157266,
    1.06615364, 1.07362570, 1.08110940, 0.98780176, 0.89448247, 0.95068587, 1.00687762, 1.04220115,
    1.07751304, 0.99400520, 0.91049735, 0.79097930, 0.67146125, 0.81828375, 0.96511788, 0.93806949,
    0.91100946,
];

/// Full-precision f64 illuminant SPDs — exact bit-for-bit match with
/// Python `colour.SDS_ILLUMINANTS[...].values` after the spektrafilm
/// normalization. Use these whenever the integration is in f64 (the
/// f32 constants drop ~7 decimal places per sample and accumulate
/// O(1e-9) error per LUT cell after the 81-wavelength reduction).
pub const ILLUMINANT_D50_F64: [f64; N_WAVELENGTHS] = [
    0.2850090652725487,
    0.3163288706730889,
    0.3476603147973008,
    0.46076543143886517,
    0.5738821868041013,
    0.6158048694695586,
    0.6577391908586877,
    0.6782233445208768,
    0.6987191369067376,
    0.6858234310784959,
    0.672927725250254,
    0.771891792630705,
    0.8708674987348276,
    0.9431556114597459,
    1.0154437241846643,
    1.0350316961241326,
    1.0546080293399291,
    1.059007466887831,
    1.063406904435733,
    1.085171317701809,
    1.1069473696915564,
    1.0886396573559751,
    1.0703319450203934,
    1.0922127455231865,
    1.114105184749651,
    1.1192844167835567,
    1.1244520100937907,
    1.127454800801089,
    1.1304575915083872,
    1.1593798198325576,
    1.188302048156728,
    1.1804808258493467,
    1.1726596035419652,
    1.1817494467295617,
    1.190839289917158,
    1.1773616479053315,
    1.163872367169833,
    1.1506973319734706,
    1.1375106580534362,
    1.1444007824670817,
    1.1512792681570556,
    1.119738327006753,
    1.0882090245801221,
    1.1125805119486585,
    1.1369636380408665,
    1.146158229741508,
    1.1553644601658217,
    1.1540376456672479,
    1.1527224698923462,
    1.1334021885973269,
    1.1140819073023076,
    1.1323314260195307,
    1.150569306013082,
    1.132005541756723,
    1.1134417775003642,
    1.1281298467740475,
    1.142806277324059,
    1.1708206852018368,
    1.198823454355943,
    1.1763025240512068,
    1.1537815937464706,
    1.0853924534515713,
    1.0170033131566718,
    1.041572658827627,
    1.0661536432222538,
    1.073625703819484,
    1.081109403140386,
    0.9878017554643806,
    0.8944824690647035,
    0.9506858656753348,
    1.0068776235622943,
    1.0422011499058987,
    1.0775130375258315,
    0.994005195181396,
    0.9104973528369604,
    0.7909792994522902,
    0.67146124606762,
    0.8182837451860946,
    0.9651178830282406,
    0.9380694892152138,
    0.9110094566785151,
];
pub const ILLUMINANT_D55_F64: [f64; N_WAVELENGTHS] = [
    0.3792826592081565,
    0.41130471283820924,
    0.4433384066186183,
    0.5763969653409493,
    0.7094555240632804,
    0.7537113757177554,
    0.7979788675225865,
    0.8155671347108852,
    0.8331670420495402,
    0.8118539267472403,
    0.7905291712945844,
    0.8934979413460009,
    0.996455071247061,
    1.0685541625536938,
    1.1406532538603265,
    1.1550288395502992,
    1.169404425240272,
    1.1662033838923025,
    1.1630023425443328,
    1.1794498749977185,
    1.1958974074511046,
    1.1687758571210345,
    1.141642666640608,
    1.1567865022540935,
    1.1719303378675792,
    1.172023459070429,
    1.1721049401229227,
    1.167984326896809,
    1.1638637136706955,
    1.1884360710727462,
    1.213020068625153,
    1.2007513501496623,
    1.1884826316741712,
    1.1935228167784289,
    1.1985630018826865,
    1.1812890187540066,
    1.1640150356253267,
    1.1478119463294223,
    1.1316088570335177,
    1.134705137028281,
    1.1378130571734006,
    1.1010418221979967,
    1.0642822273729489,
    1.0816726120051912,
    1.0990513564870772,
    1.1032534507656848,
    1.107443904893936,
    1.1020894357300595,
    1.096734966566183,
    1.0747816429942894,
    1.0528283194223955,
    1.0637817009076298,
    1.0747350823928643,
    1.054504501073696,
    1.0342739197545279,
    1.0427945098153053,
    1.0513034597257263,
    1.0724419727726824,
    1.0935921259699946,
    1.0703467457085567,
    1.047101365447119,
    0.9872826327663333,
    0.9274522599351918,
    0.945855337648428,
    0.9642700555120207,
    0.9759334861689865,
    0.9875969168259522,
    0.9025656184735221,
    0.8175459602714483,
    0.8703107618363444,
    0.9230755634012404,
    0.9562034313151373,
    0.989331299229034,
    0.9130184734934376,
    0.8366940076074848,
    0.72561205275776,
    0.6145184577576788,
    0.7491600769284603,
    0.883801696099242,
    0.8598811871171415,
    0.8359723182853972,
];
pub const ILLUMINANT_D65_F64: [f64; N_WAVELENGTHS] = [
    0.5707279519739907,
    0.5974088599028126,
    0.6240909098471259,
    0.784581772919553,
    0.9450737780074718,
    0.9949284642905997,
    1.044784292589219,
    1.0558949613064004,
    1.0670056300235817,
    1.028464891215129,
    0.9899252944221679,
    1.093749348804438,
    1.1975745452021997,
    1.2669063056935226,
    1.3362494863397605,
    1.3408403886157467,
    1.3454312908917327,
    1.3285751422366197,
    1.3117304137364219,
    1.317794515996493,
    1.3238586182565644,
    1.2832485473774433,
    1.2426384764983223,
    1.2457333384803924,
    1.2488396206173782,
    1.2399775804030368,
    1.2311155401886955,
    1.2139167868861207,
    1.196718033583546,
    1.2132658380559436,
    1.2298250626832565,
    1.211073168312189,
    1.1923212739411213,
    1.1902656460563512,
    1.1882214383264968,
    1.165118464932666,
    1.1420154915388354,
    1.1210834895944202,
    1.100151487650005,
    1.0970326433426123,
    1.0939137990352197,
    1.0533585448996927,
    1.0128032907641653,
    1.0203440190547963,
    1.0278847473454273,
    1.0255596038046542,
    1.023235602279373,
    1.0123841710787707,
    1.0015327398781688,
    0.9763501562742458,
    0.9511687146858145,
    0.9535132724899438,
    0.955857830294073,
    0.9348881418384369,
    0.9139184533828008,
    0.9149908059293558,
    0.9160631584759108,
    0.9278441902866253,
    0.93962522209734,
    0.9168214567622925,
    0.8940176914272451,
    0.8451222981570099,
    0.7962280469022661,
    0.8070075311269012,
    0.8177870153515362,
    0.8334314855701267,
    0.8490770978042088,
    0.7763021606058965,
    0.7035272234075842,
    0.7508158008812243,
    0.7981043783548644,
    0.8278047752433149,
    0.8575051721317655,
    0.7918712578020454,
    0.726238485487817,
    0.6281701891829027,
    0.5301030348934798,
    0.6465155260389825,
    0.7629280171844853,
    0.7433847060777811,
    0.723841394971077,
];

pub struct HanatosLut {
    pub width: usize,
    pub height: usize,
    pub coeffs: Vec<[f32; 4]>,
}

impl HanatosLut {
    pub fn load<R: Read>(mut reader: R) -> Result<Self, std::io::Error> {
        let _h0 = reader.read_i32::<LittleEndian>()?;
        let _h1 = reader.read_i32::<LittleEndian>()?;
        let width = reader.read_i32::<LittleEndian>()? as usize;
        let height = reader.read_i32::<LittleEndian>()? as usize;
        let n_pixels = width * height;
        let mut coeffs = Vec::with_capacity(n_pixels);
        for _ in 0..n_pixels {
            coeffs.push([
                reader.read_f32::<LittleEndian>()?,
                reader.read_f32::<LittleEndian>()?,
                reader.read_f32::<LittleEndian>()?,
                reader.read_f32::<LittleEndian>()?,
            ]);
        }
        Ok(Self {
            width,
            height,
            coeffs,
        })
    }
}

/// Pre-computed TC LUT: [size][size][channels], maps tc→per-channel film raw.
/// Stored in f64 for calibration precision matching Python.
#[derive(Clone)]
pub struct TcLut {
    pub size: usize,
    pub channels: usize,
    pub data: Vec<f64>,
}

// ── Coordinate transforms ──

/// CIE xy → triangular/quad coordinates. Port of Python `_tri2quad` (f64 throughout).
///
/// Python: x_out = (1 - x_in)^2, y_out = y_in / max(1 - x_in, eps)
/// Input: CIE xy chromaticity
/// Output: (tx, ty) in [0,1]² for LUT indexing
#[inline]
pub fn xy_to_tc(x: f64, y: f64) -> (f64, f64) {
    let tx = (1.0 - x) * (1.0 - x);
    let ty = y / (1.0 - x).max(1e-10);
    (tx.clamp(0.0, 1.0), ty.clamp(0.0, 1.0))
}

/// Triangular/quad coordinates → CIE xy. Port of Python `_quad2tri`.
///
/// Python: x_out = 1 - sqrt(tx), y_out = ty * sqrt(tx) (no epsilon, no clamp).
/// The single shared `sqrt(tx)` matters: a separate epsilon on the y-term
/// shifts the tx=0 edge off zero and diverges from Python by ~1e-4.
#[inline]
pub fn tc_to_xy(tx: f64, ty: f64) -> (f64, f64) {
    let sq = tx.max(0.0).sqrt();
    let x_out = 1.0 - sq;
    let y_out = ty * sq;
    (x_out, y_out)
}

/// XYZ → CIE xy chromaticity.
#[inline]
pub fn xyz_to_xy(xyz: [f32; 3]) -> (f32, f32) {
    let sum = xyz[0] + xyz[1] + xyz[2];
    if sum <= 0.0 {
        return (0.3127, 0.3290);
    }
    (xyz[0] / sum, xyz[1] / sum)
}

/// Pre-computed illuminant XYZ white points (Y=1) matching Python exactly.
/// Computed from: sum(illuminant * CMF) / sum(illuminant * CMF_Y) in f64 in Python.
const D50_ILLUMINANT_XYZ: [f32; 3] = [0.964220, 1.0, 0.825210]; // from colour-science
const D55_ILLUMINANT_XYZ: [f32; 3] = [0.956791, 1.0, 0.921367]; // exact Python value
const D65_ILLUMINANT_XYZ: [f32; 3] = [0.950456, 1.0, 1.089058]; // from sRGB whitepoint

/// f64 pre-computed illuminant XYZ. Exactly matches Python's `_illuminant_to_xy`
/// → `(x/y, 1, (1-x-y)/y)` chain, computed at full f64 precision.
const D50_ILLUMINANT_XYZ_F64: [f64; 3] = [0.96419686124892201, 1.0, 0.82512259200404314];
const D55_ILLUMINANT_XYZ_F64: [f64; 3] = [0.9567908993343901, 1.0, 0.92136745658606822];
const D65_ILLUMINANT_XYZ_F64: [f64; 3] = [0.95042966940215057, 1.0, 1.0888005470297513];

/// Get the native white point XYZ for a named colorspace.
/// Uses xy chromaticity → XYZ conversion to match Python colour-science exactly.
pub fn colorspace_white_xyz(name: &str) -> [f32; 3] {
    match name {
        // sRGB: whitepoint xy = (0.3127, 0.329) per colour-science
        "sRGB" => colorspace::xy_to_xyz(0.3127, 0.329),
        // ProPhoto: whitepoint = D50 xy = (0.3457, 0.3585)
        "ProPhoto RGB" => colorspace::xy_to_xyz(0.3457, 0.3585),
        // Rec.2020: whitepoint = D65 xy = (0.3127, 0.329)
        "Rec. 2020" | "Rec2020" | "ITU-R BT.2020" => colorspace::xy_to_xyz(0.3127, 0.329),
        // ACES: whitepoint xy = (0.32168, 0.33767)
        "ACES2065-1" => colorspace::xy_to_xyz(0.32168, 0.33767),
        _ => colorspace::xy_to_xyz(0.3457, 0.3585), // ProPhoto default
    }
}

/// f64 variant: native white point XYZ for a named colorspace.
pub fn colorspace_white_xyz_f64(name: &str) -> [f64; 3] {
    match name {
        "sRGB" => colorspace::xy_to_xyz_f64(0.3127, 0.329),
        "ProPhoto RGB" => colorspace::xy_to_xyz_f64(0.3457, 0.3585),
        "Rec. 2020" | "Rec2020" | "ITU-R BT.2020" => colorspace::xy_to_xyz_f64(0.3127, 0.329),
        "ACES2065-1" => colorspace::xy_to_xyz_f64(0.32168, 0.33767),
        _ => colorspace::xy_to_xyz_f64(0.3457, 0.3585),
    }
}

/// Get the RGB→XYZ matrix for a named colorspace.
pub fn colorspace_to_xyz(name: &str) -> [[f32; 3]; 3] {
    match name {
        "sRGB" => colorspace::SRGB_TO_XYZ,
        "ProPhoto RGB" => colorspace::PROPHOTO_TO_XYZ,
        "Rec. 2020" | "Rec2020" | "ITU-R BT.2020" => colorspace::REC2020_TO_XYZ,
        "ACES2065-1" => colorspace::ACES_TO_XYZ,
        _ => colorspace::PROPHOTO_TO_XYZ,
    }
}

/// f64 variant: RGB→XYZ matrix for a named colorspace.
pub fn colorspace_to_xyz_f64(name: &str) -> [[f64; 3]; 3] {
    match name {
        "sRGB" => colorspace::SRGB_TO_XYZ_F64,
        "ProPhoto RGB" => colorspace::PROPHOTO_TO_XYZ_F64,
        "Rec. 2020" | "Rec2020" | "ITU-R BT.2020" => colorspace::REC2020_TO_XYZ_F64,
        "ACES2065-1" => colorspace::ACES_TO_XYZ_F64,
        _ => colorspace::PROPHOTO_TO_XYZ_F64,
    }
}

/// Compute the reference illuminant's XYZ (for CAT02 target white).
/// Uses f64 accumulation. Illuminant values are upcast from f32 source.
/// For maximum precision, the illuminant constants should be stored at full
/// Python f64 precision — our f32 constants lose ~1e-7 per value which
/// accumulates to ~3e-6 in the final XYZ after 81 wavelengths.
pub fn illuminant_xyz(illuminant: &[f32]) -> [f32; 3] {
    // Match known illuminants by first value to use pre-computed XYZ
    if illuminant.len() == N_WAVELENGTHS {
        if (illuminant[0] - ILLUMINANT_D55[0]).abs() < 1e-6 {
            return D55_ILLUMINANT_XYZ;
        }
        if (illuminant[0] - ILLUMINANT_D65[0]).abs() < 1e-6 {
            return D65_ILLUMINANT_XYZ;
        }
        if (illuminant[0] - ILLUMINANT_D50[0]).abs() < 1e-6 {
            return D50_ILLUMINANT_XYZ;
        }
    }

    // Fallback: compute from SPD (f64 accumulation)
    let n = illuminant.len().min(N_WAVELENGTHS);
    let mut xyz = [0.0f64; 3];
    for i in 0..n {
        xyz[0] += illuminant[i] as f64 * CMF_X[i] as f64;
        xyz[1] += illuminant[i] as f64 * CMF_Y[i] as f64;
        xyz[2] += illuminant[i] as f64 * CMF_Z[i] as f64;
    }
    if xyz[1] > 0.0 {
        let s = 1.0 / xyz[1];
        xyz[0] *= s;
        xyz[1] = 1.0;
        xyz[2] *= s;
    }
    [xyz[0] as f32, xyz[1] as f32, xyz[2] as f32]
}

/// Compute the illuminant's xy chromaticity from its SPD (f64 precision).
pub fn illuminant_to_xy(illuminant: &[f32]) -> (f64, f64) {
    let xyz = illuminant_xyz_f64(illuminant);
    xyz_to_xy_f64(xyz)
}

/// f64 illuminant XYZ — matches Python's `_illuminant_to_xy` → xy_to_XYZ chain exactly.
///
/// Uses pre-computed full-precision XYZ values for standard illuminants (D50/D55/D65),
/// or falls back to live SPD integration in f64.
pub fn illuminant_xyz_f64(illuminant: &[f32]) -> [f64; 3] {
    if illuminant.len() == N_WAVELENGTHS {
        if (illuminant[0] - ILLUMINANT_D55[0]).abs() < 1e-6 {
            return D55_ILLUMINANT_XYZ_F64;
        }
        if (illuminant[0] - ILLUMINANT_D65[0]).abs() < 1e-6 {
            return D65_ILLUMINANT_XYZ_F64;
        }
        if (illuminant[0] - ILLUMINANT_D50[0]).abs() < 1e-6 {
            return D50_ILLUMINANT_XYZ_F64;
        }
    }

    // Fallback: live computation in f64 — sum(illu * CMF), then xy → XYZ.
    let n = illuminant.len().min(N_WAVELENGTHS);
    let mut xyz_unnorm = [0.0f64; 3];
    for i in 0..n {
        xyz_unnorm[0] += illuminant[i] as f64 * CMF_X[i] as f64;
        xyz_unnorm[1] += illuminant[i] as f64 * CMF_Y[i] as f64;
        xyz_unnorm[2] += illuminant[i] as f64 * CMF_Z[i] as f64;
    }
    let sum = xyz_unnorm[0] + xyz_unnorm[1] + xyz_unnorm[2];
    if sum <= 0.0 {
        return [1.0, 1.0, 1.0];
    }
    let x = xyz_unnorm[0] / sum;
    let y = xyz_unnorm[1] / sum;
    if y <= 0.0 {
        return [1.0, 1.0, 1.0];
    }
    [x / y, 1.0, (1.0 - x - y) / y]
}

/// f64 variant of XYZ → CIE xy.
#[inline]
pub fn xyz_to_xy_f64(xyz: [f64; 3]) -> (f64, f64) {
    let sum = xyz[0] + xyz[1] + xyz[2];
    if sum <= 0.0 {
        return (0.3127, 0.3290);
    }
    (xyz[0] / sum, xyz[1] / sum)
}

/// Build the combined `RGB → adapted-XYZ` matrix used by `rgb_to_tc_b`.
///
/// `M = CAT02_adapt(src_white, dst_white) @ rgb_to_xyz`
///
/// The per-pixel work is then a single 3x3 matrix multiply, which lets a GPU
/// shader compute the equivalent of `_rgb_to_tc_b` with no string lookups,
/// no per-pixel matrix construction, and no chromatic-adaptation arithmetic.
pub fn build_rgb_to_adapted_xyz(
    color_space: &str,
    ref_illuminant: &[f32],
    cat16: bool,
) -> [[f64; 3]; 3] {
    let rgb_to_xyz = colorspace_to_xyz_f64(color_space);
    let src_white = colorspace_white_xyz_f64(color_space);
    let dst_white = illuminant_xyz_f64(ref_illuminant);
    let adapt = if cat16 {
        colorspace::chromatic_adaptation_matrix_cat16_f64(src_white, dst_white)
    } else {
        colorspace::chromatic_adaptation_matrix_f64(src_white, dst_white)
    };

    let mut out = [[0.0f64; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            out[i][j] = adapt[i][0] * rgb_to_xyz[0][j]
                + adapt[i][1] * rgb_to_xyz[1][j]
                + adapt[i][2] * rgb_to_xyz[2][j];
        }
    }
    out
}

/// RGB → tc coordinates + brightness, with full CAT02 chromatic adaptation.
///
/// Exact port of Python `_rgb_to_tc_b`:
///   1. RGB → XYZ using colorspace matrix
///   2. CAT02 adaptation from colorspace white to reference illuminant white
///   3. XYZ → xy → tc, b = sum(XYZ)
pub fn rgb_to_tc_b(
    rgb: [crate::precision::Scalar; 3],
    color_space: &str,
    ref_illuminant: &[f32],
    cat16: bool,
) -> ((f64, f64), f64) {
    let rgb_to_xyz = colorspace_to_xyz_f64(color_space);
    let src_white = colorspace_white_xyz_f64(color_space);
    let dst_white = illuminant_xyz_f64(ref_illuminant);

    // Step 1: RGB → XYZ (in colorspace's native white) — f64 throughout
    let rgb64 = [rgb[0] as f64, rgb[1] as f64, rgb[2] as f64];
    let xyz_native = [
        rgb_to_xyz[0][0] * rgb64[0] + rgb_to_xyz[0][1] * rgb64[1] + rgb_to_xyz[0][2] * rgb64[2],
        rgb_to_xyz[1][0] * rgb64[0] + rgb_to_xyz[1][1] * rgb64[1] + rgb_to_xyz[1][2] * rgb64[2],
        rgb_to_xyz[2][0] * rgb64[0] + rgb_to_xyz[2][1] * rgb64[1] + rgb_to_xyz[2][2] * rgb64[2],
    ];

    // Step 2: chromatic adaptation (CAT02, or CAT16 when enabled) — f64.
    let adapt = if cat16 {
        colorspace::chromatic_adaptation_matrix_cat16_f64(src_white, dst_white)
    } else {
        colorspace::chromatic_adaptation_matrix_f64(src_white, dst_white)
    };
    let xyz = [
        adapt[0][0] * xyz_native[0] + adapt[0][1] * xyz_native[1] + adapt[0][2] * xyz_native[2],
        adapt[1][0] * xyz_native[0] + adapt[1][1] * xyz_native[1] + adapt[1][2] * xyz_native[2],
        adapt[2][0] * xyz_native[0] + adapt[2][1] * xyz_native[1] + adapt[2][2] * xyz_native[2],
    ];

    // Step 3: XYZ → xy → tc, b — fully f64 (Python parity).
    let b = xyz[0] + xyz[1] + xyz[2];
    if b <= 1e-10 {
        return ((0.5, 0.5), 0.0);
    }
    // No xy clip (upstream 0.3.4 removed it): the input gamut compression
    // baked into the tc_lut handles OOG chromaticities; `xy_to_tc` clamps
    // each tc component to [0, 1] so the LUT lookup stays in-bounds.
    let x_chrom = xyz[0] / b;
    let y_chrom = xyz[1] / b;
    let tc = xy_to_tc(x_chrom, y_chrom);
    (tc, b)
}

/// Matrix-based Hanatos2025 RGB → raw — avoids per-pixel string lookups for the matrix.
///
/// `rgb_to_adapted_xyz` must equal `build_rgb_to_adapted_xyz(color_space, ref_illuminant)`.
/// This is what the wgpu shader needs as a uniform (one-time CPU work, pure per-pixel GPU).
pub fn hanatos2025_rgb_to_raw_with_matrix(
    image: &ImageBuf,
    tc_lut: &TcLut,
    rgb_to_adapted_xyz: &[[f64; 3]; 3],
) -> ImageBuf {
    use rayon::prelude::*;
    let size = tc_lut.size;
    let channels = tc_lut.channels;
    assert_eq!(channels, 3);

    let mut output = ImageBuf::new(image.width, image.height);
    output
        .data
        .par_chunks_exact_mut(3)
        .zip(image.data.par_chunks_exact(3))
        .for_each(|(out, px)| {
            let r = px[0] as f64;
            let g = px[1] as f64;
            let b_in = px[2] as f64;
            // RGB → adapted XYZ
            let xyz0 = rgb_to_adapted_xyz[0][0] * r
                + rgb_to_adapted_xyz[0][1] * g
                + rgb_to_adapted_xyz[0][2] * b_in;
            let xyz1 = rgb_to_adapted_xyz[1][0] * r
                + rgb_to_adapted_xyz[1][1] * g
                + rgb_to_adapted_xyz[1][2] * b_in;
            let xyz2 = rgb_to_adapted_xyz[2][0] * r
                + rgb_to_adapted_xyz[2][1] * g
                + rgb_to_adapted_xyz[2][2] * b_in;
            let b = xyz0 + xyz1 + xyz2;
            if b <= 1e-10 {
                out[0] = crate::precision::from_f64(0.0);
                out[1] = crate::precision::from_f64(0.0);
                out[2] = crate::precision::from_f64(0.0);
                return;
            }
            // No xy clip (upstream 0.3.4) — `xy_to_tc` clamps the tc output.
            let xc = xyz0 / b;
            let yc = xyz1 / b;
            let tc = xy_to_tc(xc, yc);

            // Python: `lut[tc[0]_idx, tc[1]_idx]` — first axis = tc.0.
            let lut_x = tc.0 * (size - 1) as f64;
            let lut_y = tc.1 * (size - 1) as f64;
            let interp = lut::bicubic_2d_f64(&tc_lut.data, size, size, channels, lut_x, lut_y);
            out[0] = crate::precision::from_f64(interp[0] * b);
            out[1] = crate::precision::from_f64(interp[1] * b);
            out[2] = crate::precision::from_f64(interp[2] * b);
        });
    output
}

/// Apply a 2D TC LUT to an image using bicubic interpolation.
///
/// Full Hanatos2025 path with CAT02 adaptation:
///   RGB → XYZ → CAT02 adapt → xy → tc → LUT → raw × brightness
pub fn hanatos2025_rgb_to_raw(
    image: &ImageBuf,
    tc_lut: &TcLut,
    color_space: &str,
    ref_illuminant: &[f32],
    cat16: bool,
) -> ImageBuf {
    let rgb_to_xyz = colorspace_to_xyz_f64(color_space);
    let src_white = colorspace_white_xyz_f64(color_space);
    let dst_white = illuminant_xyz_f64(ref_illuminant);
    let adapt = if cat16 {
        colorspace::chromatic_adaptation_matrix_cat16_f64(src_white, dst_white)
    } else {
        colorspace::chromatic_adaptation_matrix_f64(src_white, dst_white)
    };
    hanatos2025_rgb_to_raw_prepared(image, tc_lut, &rgb_to_xyz, &adapt)
}

/// Apply the Hanatos2025 TC LUT with precomputed colour matrices.
///
/// This keeps the CPU parity order of `rgb_to_tc_b`: RGB→XYZ first, then
/// chromatic adaptation as a second 3×3 multiply. The matrices are simply
/// prepared once per image instead of rebuilt for every pixel.
pub fn hanatos2025_rgb_to_raw_prepared(
    image: &ImageBuf,
    tc_lut: &TcLut,
    rgb_to_xyz: &[[f64; 3]; 3],
    adapt: &[[f64; 3]; 3],
) -> ImageBuf {
    use rayon::prelude::*;
    let size = tc_lut.size;
    let channels = tc_lut.channels;
    assert_eq!(channels, 3);

    let mut output = ImageBuf::new(image.width, image.height);

    output
        .data
        .par_chunks_exact_mut(3)
        .zip(image.data.par_chunks_exact(3))
        .for_each(|(out, px)| {
            let r = px[0] as f64;
            let g = px[1] as f64;
            let b_in = px[2] as f64;
            let xyz_native = [
                rgb_to_xyz[0][0] * r + rgb_to_xyz[0][1] * g + rgb_to_xyz[0][2] * b_in,
                rgb_to_xyz[1][0] * r + rgb_to_xyz[1][1] * g + rgb_to_xyz[1][2] * b_in,
                rgb_to_xyz[2][0] * r + rgb_to_xyz[2][1] * g + rgb_to_xyz[2][2] * b_in,
            ];
            let xyz = [
                adapt[0][0] * xyz_native[0]
                    + adapt[0][1] * xyz_native[1]
                    + adapt[0][2] * xyz_native[2],
                adapt[1][0] * xyz_native[0]
                    + adapt[1][1] * xyz_native[1]
                    + adapt[1][2] * xyz_native[2],
                adapt[2][0] * xyz_native[0]
                    + adapt[2][1] * xyz_native[1]
                    + adapt[2][2] * xyz_native[2],
            ];
            let brightness = xyz[0] + xyz[1] + xyz[2];
            if brightness <= 1e-10 {
                out[0] = crate::precision::from_f64(0.0);
                out[1] = crate::precision::from_f64(0.0);
                out[2] = crate::precision::from_f64(0.0);
                return;
            }
            let tc = xy_to_tc(xyz[0] / brightness, xyz[1] / brightness);

            let lut_x = tc.0 * (size - 1) as f64;
            let lut_y = tc.1 * (size - 1) as f64;

            let interp = lut::bicubic_2d_f64(&tc_lut.data, size, size, channels, lut_x, lut_y);

            out[0] = crate::precision::from_f64(interp[0] * brightness);
            out[1] = crate::precision::from_f64(interp[1] * brightness);
            out[2] = crate::precision::from_f64(interp[2] * brightness);
        });

    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tc_xy_roundtrip() {
        for &(x, y) in &[(0.3127f64, 0.3290), (0.4, 0.4), (0.2, 0.3)] {
            let (tx, ty) = xy_to_tc(x, y);
            let (x2, y2) = tc_to_xy(tx, ty);
            assert!((x - x2).abs() < 0.01, "x roundtrip: {x} → {x2}");
            assert!((y - y2).abs() < 0.01, "y roundtrip: {y} → {y2}");
        }
    }

    #[test]
    fn test_xyz_to_xy_white() {
        let (x, y) = xyz_to_xy([0.95047, 1.0, 1.08883]);
        assert!((x - 0.3127).abs() < 0.001);
        assert!((y - 0.3290).abs() < 0.001);
    }

    #[test]
    fn test_cmf_y_peak() {
        let max_idx = CMF_Y
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .unwrap()
            .0;
        assert_eq!(max_idx, 35);
    }

    #[test]
    fn test_wavelength_count() {
        assert_eq!(CMF_X.len(), N_WAVELENGTHS);
        assert_eq!(CMF_Y.len(), N_WAVELENGTHS);
        assert_eq!(CMF_Z.len(), N_WAVELENGTHS);
    }

    #[test]
    fn test_illuminant_to_xy_d65() {
        let (x, y) = illuminant_to_xy(&ILLUMINANT_D65);
        assert!((x - 0.3127).abs() < 0.01, "D65 x={x}");
        assert!((y - 0.3290).abs() < 0.01, "D65 y={y}");
    }

    #[test]
    fn test_rgb_to_tc_b_neutral_gray() {
        use crate::precision::from_f64;
        // 18% gray in sRGB with D55 ref should produce balanced tc near center
        let gray = [from_f64(0.184), from_f64(0.184), from_f64(0.184)];
        let (tc, b) = rgb_to_tc_b(gray, "sRGB", &ILLUMINANT_D55, false);
        assert!(b > 0.0, "brightness should be positive: {b}");
        // tc should be near the D55 chromaticity mapped to tc space
        let d55_xy = illuminant_to_xy(&ILLUMINANT_D55);
        let d55_tc = xy_to_tc(d55_xy.0, d55_xy.1);
        assert!(
            (tc.0 - d55_tc.0).abs() < 0.05,
            "tc.0 ({}) far from D55 tc ({}))",
            tc.0,
            d55_tc.0
        );
        assert!(
            (tc.1 - d55_tc.1).abs() < 0.05,
            "tc.1 ({}) far from D55 tc ({})",
            tc.1,
            d55_tc.1
        );
    }
}
