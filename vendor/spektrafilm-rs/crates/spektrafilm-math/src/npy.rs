/// Minimal NumPy `.npy` file loader.
///
/// Supports float16 (`<f2`) and float64 (`<f8`) arrays in C order.
use std::io::Read;

use half::f16;

/// Load a `.npy` file and return the shape + f32 data (converting from original dtype).
pub fn load_npy_f32<R: Read>(mut reader: R) -> Result<(Vec<usize>, Vec<f32>), NpyError> {
    // Magic: \x93NUMPY
    let mut magic = [0u8; 6];
    reader.read_exact(&mut magic)?;
    if &magic != b"\x93NUMPY" {
        return Err(NpyError::BadMagic);
    }

    // Version
    let mut ver = [0u8; 2];
    reader.read_exact(&mut ver)?;

    // Header length
    let header_len = if ver[0] == 1 {
        let mut buf = [0u8; 2];
        reader.read_exact(&mut buf)?;
        u16::from_le_bytes(buf) as usize
    } else {
        let mut buf = [0u8; 4];
        reader.read_exact(&mut buf)?;
        u32::from_le_bytes(buf) as usize
    };

    // Read header string
    let mut header_bytes = vec![0u8; header_len];
    reader.read_exact(&mut header_bytes)?;
    let header = String::from_utf8_lossy(&header_bytes);

    // Parse header dict — extract descr, shape, fortran_order
    let descr =
        extract_field(&header, "descr").ok_or_else(|| NpyError::Parse("missing descr".into()))?;
    let shape_str =
        extract_field(&header, "shape").ok_or_else(|| NpyError::Parse("missing shape".into()))?;
    let fortran_order = extract_field(&header, "fortran_order")
        .map(|s| s.contains("True"))
        .unwrap_or(false);

    if fortran_order {
        return Err(NpyError::Parse("Fortran order not supported".into()));
    }

    // Parse shape tuple
    let shape: Vec<usize> = shape_str
        .trim_matches(|c: char| c == '(' || c == ')' || c.is_whitespace())
        .split(',')
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().parse::<usize>())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| NpyError::Parse(format!("bad shape: {e}")))?;

    let total_elements: usize = shape.iter().product();

    // Read data based on dtype
    let data = match descr.trim_matches('\'') {
        "<f2" => {
            // float16, little-endian
            let mut raw = vec![0u8; total_elements * 2];
            reader.read_exact(&mut raw)?;
            raw.chunks_exact(2)
                .map(|chunk| f16::from_le_bytes([chunk[0], chunk[1]]).to_f32())
                .collect()
        }
        "<f4" => {
            // float32, little-endian
            let mut raw = vec![0u8; total_elements * 4];
            reader.read_exact(&mut raw)?;
            raw.chunks_exact(4)
                .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
                .collect()
        }
        "<f8" => {
            // float64, little-endian
            let mut raw = vec![0u8; total_elements * 8];
            reader.read_exact(&mut raw)?;
            raw.chunks_exact(8)
                .map(|chunk| {
                    let v = f64::from_le_bytes([
                        chunk[0], chunk[1], chunk[2], chunk[3], chunk[4], chunk[5], chunk[6],
                        chunk[7],
                    ]);
                    v as f32
                })
                .collect()
        }
        other => return Err(NpyError::Parse(format!("unsupported dtype: {other}"))),
    };

    Ok((shape, data))
}

/// Extract a field value from a Python dict-like header string.
fn extract_field<'a>(header: &'a str, key: &str) -> Option<String> {
    let pattern = format!("'{key}':");
    let start = header.find(&pattern)?;
    let rest = &header[start + pattern.len()..];
    let rest = rest.trim_start();

    // Handle string values: 'value'
    if rest.starts_with('\'') {
        let end = rest[1..].find('\'')?;
        return Some(rest[..end + 2].to_string());
    }

    // Handle tuple values: (1, 2, 3)
    if rest.starts_with('(') {
        let end = rest.find(')')?;
        return Some(rest[..=end].to_string());
    }

    // Handle bare values: True, False, etc.
    let end = rest
        .find(|c: char| c == ',' || c == '}')
        .unwrap_or(rest.len());
    Some(rest[..end].trim().to_string())
}

#[derive(Debug)]
pub enum NpyError {
    Io(std::io::Error),
    BadMagic,
    Parse(String),
}

impl From<std::io::Error> for NpyError {
    fn from(e: std::io::Error) -> Self {
        NpyError::Io(e)
    }
}

impl std::fmt::Display for NpyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NpyError::Io(e) => write!(f, "IO error: {e}"),
            NpyError::BadMagic => write!(f, "not a .npy file"),
            NpyError::Parse(s) => write!(f, "parse error: {s}"),
        }
    }
}
