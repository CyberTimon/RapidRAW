//! Sony maker-note focus distance, matching exiftool's `FocusDistance2`.
//!
//! The metres are shown in the metadata panel. They are not written to
//! `SubjectDistance`, which lens correction already reads.

/// Exiftool `Decipher` for tags 0x2010 and 0x94xx: byte `b` becomes `(b³ mod 249)`,
/// and bytes 249–255 stay put. Built the same way as `Sony.pm`'s translation table.
const DECIPHER: [u8; 256] = decipher_table();

const fn decipher_table() -> [u8; 256] {
    let mut table = [0u8; 256];
    let mut unchanged = 249u16;
    while unchanged < 256 {
        table[unchanged as usize] = unchanged as u8;
        unchanged += 1;
    }
    let mut plain = 0u32;
    while plain < 249 {
        let enciphered = (plain * plain * plain) % 249;
        table[enciphered as usize] = plain as u8;
        plain += 1;
    }
    table
}

/// Printed focus distance for a Sony raw, or nothing when exiftool would omit it.
pub(crate) fn focus_distance(file_bytes: &[u8]) -> Option<String> {
    let tiff = Tiff::open(file_bytes)?;
    let ifd0 = tiff
        .u32(4)
        .and_then(|offset| usize::try_from(offset).ok())?;
    let make = ascii_tag(&tiff, ifd0, 0x010F)?;
    if !make.eq_ignore_ascii_case("SONY") {
        return None;
    }
    let model = ascii_tag(&tiff, ifd0, 0x0110).unwrap_or_default();
    // Tag9402's FocusPosition2 byte. SLT, Hasselblad HV and ILCA use another
    // block; DSC and Stellar do not keep the distance at this offset.
    if model.starts_with("SLT-")
        || model.starts_with("HV")
        || model.starts_with("ILCA-")
        || model.starts_with("DSC-")
        || model.starts_with("Stellar")
    {
        return None;
    }

    let exif_ifd = long_tag(&tiff, ifd0, 0x8769)?;
    let focal = short_tag(&tiff, exif_ifd, 0xA405)?;
    if focal == 0 {
        return None;
    }
    let maker = tag_bytes(&tiff, exif_ifd, 0x927C)?;
    let maker_ifd = if maker_note_has_header(file_bytes, maker.0) {
        maker.0.checked_add(12)?
    } else {
        maker.0
    };

    let mut passes = 1u8;
    let mut focus_byte = None;
    for_entries(&tiff, maker_ifd, |tag, kind, count, value_at| {
        if tag == 0x9400
            && let Some((offset, _)) = located(&tiff, kind, count, value_at)
            && let Some(&first) = file_bytes.get(offset)
            && matches!(first, 0x5E | 0xE7 | 0x04)
        {
            // Exiftool sets DoubleCipher when Tag9400's first byte is already
            // one of these enciphered markers, then deciphers the block twice.
            passes = 2;
        }
        if tag == 0x9402
            && count > 0x2D
            && let Some((offset, size)) = located(&tiff, kind, count, value_at)
            && size > 0x2D
            && let Some(&first) = file_bytes.get(offset)
            && first != 0x05
            && first != 0xFF
            && let Some(&byte) = file_bytes.get(offset + 0x2D)
        {
            focus_byte = Some(byte);
        }
        false
    })?;

    let mut position = focus_byte?;
    for _ in 0..passes {
        position = DECIPHER[usize::from(position)];
    }
    if position == 0 {
        return None;
    }
    if position == 255 {
        return Some("inf".to_string());
    }

    let metres = (f64::exp2(f64::from(position) / 16.0 - 5.0) + 1.0) * f64::from(focal) / 1000.0;
    Some(format!("{} m", format_sig4(metres)))
}

/// Four significant digits, trimmed like printf `%.4g`: no trailing zeros, a
/// decimal point only when a fraction remains, and scientific form when the
/// exponent is below -4 or at least 4. Ties round to even. Infinity is not
/// formatted here; the caller returns the exiftool string `inf`.
fn format_sig4(value: f64) -> String {
    let abs = value.abs();
    if abs == 0.0 {
        return "0".to_string();
    }
    // Enough extra digits that a value just above a 4-digit midpoint is not
    // collapsed into a tie before we round. Checked against printf `%.4g`.
    let rendered = format!("{abs:.32e}");
    let Some((mantissa, exponent)) = rendered.split_once('e') else {
        return "0".to_string();
    };
    let Ok(mut exp) = exponent.parse::<i32>() else {
        return "0".to_string();
    };
    let mut digits = [0u8; 40];
    let mut count = 0usize;
    for byte in mantissa.bytes() {
        if byte != b'.' && count < digits.len() {
            digits[count] = byte;
            count += 1;
        }
    }
    if count < 5 {
        return "0".to_string();
    }
    let tie_digit_is_odd = (digits[3] - b'0') % 2 == 1;
    let further_digits = digits[5..count].iter().any(|byte| *byte != b'0');
    let round_up = digits[4] > b'5' || (digits[4] == b'5' && (further_digits || tie_digit_is_odd));
    if round_up {
        let mut index = 4usize;
        loop {
            if index == 0 {
                digits[0] = b'1';
                digits[1] = b'0';
                digits[2] = b'0';
                digits[3] = b'0';
                exp += 1;
                break;
            }
            index -= 1;
            if digits[index] < b'9' {
                digits[index] += 1;
                break;
            }
            digits[index] = b'0';
        }
    }
    let body = if !(-4..4).contains(&exp) {
        scientific(&digits[..4], exp)
    } else {
        fixed(&digits[..4], exp)
    };
    if value.is_sign_negative() {
        format!("-{body}")
    } else {
        body
    }
}

fn fixed(digits: &[u8], exp: i32) -> String {
    if exp >= 0 {
        let int_len = (exp as usize) + 1;
        let mut out = String::from_utf8_lossy(&digits[..int_len]).into_owned();
        let end = digits[int_len..]
            .iter()
            .rposition(|byte| *byte != b'0')
            .map(|index| index + 1)
            .unwrap_or(0);
        if end > 0 {
            out.push('.');
            out.push_str(&String::from_utf8_lossy(&digits[int_len..int_len + end]));
        }
        out
    } else {
        let zeros = (-exp - 1) as usize;
        let end = digits
            .iter()
            .rposition(|byte| *byte != b'0')
            .map(|index| index + 1)
            .unwrap_or(0);
        let mut out = String::from("0.");
        out.extend(std::iter::repeat_n('0', zeros));
        out.push_str(&String::from_utf8_lossy(&digits[..end]));
        out
    }
}

fn scientific(digits: &[u8], exp: i32) -> String {
    let end = digits
        .iter()
        .rposition(|byte| *byte != b'0')
        .map(|index| index + 1)
        .unwrap_or(1);
    let mut out = String::new();
    out.push(digits[0] as char);
    if end > 1 {
        out.push('.');
        out.push_str(&String::from_utf8_lossy(&digits[1..end]));
    }
    out.push('e');
    out.push(if exp >= 0 { '+' } else { '-' });
    out.push_str(&format!("{:02}", exp.abs()));
    out
}

fn maker_note_has_header(bytes: &[u8], offset: usize) -> bool {
    let Some(head) = bytes.get(offset..offset.saturating_add(12)) else {
        return false;
    };
    head.starts_with(b"SONY DSC \0")
        || head.starts_with(b"SONY CAM \0")
        || head.starts_with(b"SONY MOBILE\0")
        || head.starts_with(b"\0\0SONY PIC\0")
        || head.starts_with(b"VHAB     \0")
}

struct Tiff<'a> {
    data: &'a [u8],
    little: bool,
}

impl<'a> Tiff<'a> {
    fn open(data: &'a [u8]) -> Option<Self> {
        let little = match data.get(..2)? {
            b"II" => true,
            b"MM" => false,
            _ => return None,
        };
        let tiff = Self { data, little };
        if tiff.u16(2)? != 42 {
            return None;
        }
        Some(tiff)
    }

    fn u16(&self, at: usize) -> Option<u16> {
        let bytes: [u8; 2] = self.data.get(at..at.checked_add(2)?)?.try_into().ok()?;
        Some(if self.little {
            u16::from_le_bytes(bytes)
        } else {
            u16::from_be_bytes(bytes)
        })
    }

    fn u32(&self, at: usize) -> Option<u32> {
        let bytes: [u8; 4] = self.data.get(at..at.checked_add(4)?)?.try_into().ok()?;
        Some(if self.little {
            u32::from_le_bytes(bytes)
        } else {
            u32::from_be_bytes(bytes)
        })
    }
}

fn for_entries(
    tiff: &Tiff<'_>,
    ifd: usize,
    mut visit: impl FnMut(u16, u16, u32, usize) -> bool,
) -> Option<()> {
    let count = usize::from(tiff.u16(ifd)?);
    if count > 512 {
        return None;
    }
    let entries_end = ifd.checked_add(2)?.checked_add(count.checked_mul(12)?)?;
    if entries_end > tiff.data.len() {
        return None;
    }
    for index in 0..count {
        let at = ifd + 2 + index * 12;
        if visit(tiff.u16(at)?, tiff.u16(at + 2)?, tiff.u32(at + 4)?, at + 8) {
            break;
        }
    }
    Some(())
}

fn located(tiff: &Tiff<'_>, kind: u16, count: u32, value_at: usize) -> Option<(usize, usize)> {
    let unit = match kind {
        1 | 2 | 6 | 7 => 1,
        3 | 8 => 2,
        4 | 9 => 4,
        5 | 10 => 8,
        _ => return None,
    };
    let size = usize::try_from(count).ok()?.checked_mul(unit)?;
    if size <= 4 {
        return Some((value_at, size));
    }
    let offset = usize::try_from(tiff.u32(value_at)?).ok()?;
    if offset.checked_add(size)? > tiff.data.len() {
        return None;
    }
    Some((offset, size))
}

fn ascii_tag(tiff: &Tiff<'_>, ifd: usize, wanted: u16) -> Option<String> {
    let mut found = None;
    for_entries(tiff, ifd, |tag, kind, count, value_at| {
        if tag != wanted || kind != 2 {
            return false;
        }
        let Some((offset, size)) = located(tiff, kind, count, value_at) else {
            return false;
        };
        let size = size.min(64);
        let Some(bytes) = tiff.data.get(offset..offset + size) else {
            return false;
        };
        let end = bytes
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(bytes.len());
        found = Some(String::from_utf8_lossy(&bytes[..end]).trim().to_string());
        true
    })?;
    found.filter(|text| !text.is_empty())
}

fn long_tag(tiff: &Tiff<'_>, ifd: usize, wanted: u16) -> Option<usize> {
    let mut found = None;
    for_entries(tiff, ifd, |tag, kind, count, value_at| {
        if tag == wanted && kind == 4 && count >= 1 {
            found = tiff
                .u32(value_at)
                .and_then(|offset| usize::try_from(offset).ok());
            return true;
        }
        false
    })?;
    found
}

fn short_tag(tiff: &Tiff<'_>, ifd: usize, wanted: u16) -> Option<u16> {
    let mut found = None;
    for_entries(tiff, ifd, |tag, kind, count, value_at| {
        if tag == wanted && kind == 3 && count >= 1 {
            found = tiff.u16(value_at);
            return true;
        }
        false
    })?;
    found
}

fn tag_bytes(tiff: &Tiff<'_>, ifd: usize, wanted: u16) -> Option<(usize, usize)> {
    let mut found = None;
    for_entries(tiff, ifd, |tag, kind, count, value_at| {
        if tag == wanted {
            found = located(tiff, kind, count, value_at);
            return true;
        }
        false
    })?;
    found
}
