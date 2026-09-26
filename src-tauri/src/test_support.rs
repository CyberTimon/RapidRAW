pub fn sample_values(n: usize) -> Vec<f32> {
    const SPECIAL: [f32; 10] = [
        0.0,
        -0.0,
        1.0,
        -1.0,
        0.5,
        65504.0,
        70000.0,
        1.0e-8,
        f32::NAN,
        f32::INFINITY,
    ];
    let mut state: u32 = 0x9E37_79B9;
    (0..n)
        .map(|i| {
            if i % 13 == 0 {
                SPECIAL[(i / 13) % SPECIAL.len()]
            } else {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (state >> 8) as f32 / (1u32 << 24) as f32 * 4.0 - 1.0
            }
        })
        .collect()
}

/// Compares bit patterns, so NaN == NaN and 0.0 != -0.0.
pub fn assert_bits_eq(expected: &[f32], actual: &[f32]) {
    assert_eq!(expected.len(), actual.len(), "length differs");
    for (i, (e, a)) in expected.iter().zip(actual).enumerate() {
        assert_eq!(e.to_bits(), a.to_bits(), "value {i}: expected {e}, got {a}");
    }
}
