//! Client for the darktable remote ONNX inference wire protocol v1.
//!
//! Reuses the proven protocol shared with `tools/ai/remote_worker.py`
//! (darktable) and its deployed instance on the GPU host, reachable as a
//! loopback endpoint through the SSH tunnel (default 127.0.0.1:8794).
//!
//! Wire format: big-endian u32 length prefix + UTF-8 JSON frame; `run`
//! frames concatenate raw tensor payloads after the JSON. One persistent
//! TCP connection per loaded model. Any protocol violation, timeout or
//! worker refusal kills the connection — the caller reconnects and reloads;
//! there is never a local-inference or downgraded-model fallback.
//!
//! Trust boundary mirrors the C client (`darktable src/ai/backend_remote.c`):
//! only numeric loopback endpoints, all descriptors bounds-validated before
//! any allocation, response payloads validated against expectations before
//! being read.

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

pub const DEFAULT_ENDPOINT: &str = "127.0.0.1:8794";
pub const MODEL_RAW_DENOISE: &str = "rawdenoise-nind";
pub const MODEL_RAW_DENOISE_FILE: &str = "model_bayer.onnx";
pub const MODEL_UPSCALE: &str = "upscale-realplksr";
pub const MODEL_UPSCALE_X2_FILE: &str = "model_x2.onnx";
pub const MODEL_UPSCALE_X4_FILE: &str = "model_x4.onnx";

const PROTOCOL_VERSION: i64 = 1;
const MAX_JSON: usize = 64 * 1024;
const MAX_BYTES: u64 = (512 << 20) as u64;
const MAX_IO: usize = 16;
const MIN_RANK: usize = 1;
const MAX_RANK: usize = 8;
const TIMEOUT: Duration = Duration::from_secs(300);

/// Wire dtype codes shared with the worker (dt_ai_dtype_t).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DType {
    F32 = 1,
    U8 = 2,
    I8 = 3,
    I32 = 4,
    I64 = 5,
    F16 = 10,
}

impl DType {
    fn from_code(code: i64) -> Result<Self> {
        Ok(match code {
            1 => DType::F32,
            2 => DType::U8,
            3 => DType::I8,
            4 => DType::I32,
            5 => DType::I64,
            10 => DType::F16,
            _ => bail!("unknown wire dtype {code}"),
        })
    }

    fn elem_size(self) -> u64 {
        match self {
            DType::F32 | DType::I32 => 4,
            DType::U8 | DType::I8 => 1,
            DType::I64 => 8,
            DType::F16 => 2,
        }
    }
}

/// One tensor descriptor as exchanged on the wire.
#[derive(Debug, Clone)]
pub struct TensorDesc {
    pub name: Option<String>,
    pub dtype: DType,
    /// -1 marks a dynamic dim (only valid in load metadata / allocation requests).
    pub shape: Vec<i64>,
}

impl TensorDesc {
    /// Overflow-checked product of the concrete (>= 1) dims.
    fn elems(&self) -> Result<u64> {
        self.shape.iter().try_fold(1u64, |acc, &d| {
            if d <= 0 {
                bail!("non-concrete dim {d} in {:?} shape {:?}", self.name, self.shape);
            }
            acc.checked_mul(d as u64).ok_or_else(|| anyhow!("shape overflow"))
        })
    }

    fn parse(value: &Value, allow_dynamic: bool, require_name: bool) -> Result<Self> {
        let obj = value.as_object().ok_or_else(|| anyhow!("descriptor must be an object"))?;
        let dtype = DType::from_code(
            obj.get("type")
                .and_then(Value::as_i64)
                .ok_or_else(|| anyhow!("missing/invalid dtype"))?,
        )?;
        let shape: Vec<i64> = obj
            .get("shape")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("missing shape array"))?
            .iter()
            .map(|v| v.as_i64().ok_or_else(|| anyhow!("non-integer dim")))
            .collect::<Result<_>>()?;
        if !(MIN_RANK..=MAX_RANK).contains(&shape.len()) {
            bail!("rank {} outside {MIN_RANK}..{MAX_RANK}", shape.len());
        }
        for &d in &shape {
            let valid = d > 0 || (allow_dynamic && d == -1);
            if !valid {
                bail!("invalid dim {d} (allow_dynamic={allow_dynamic})");
            }
        }
        let name = match obj.get("name") {
            Some(v) if v.is_string() => Some(v.as_str().unwrap().to_string()),
            None => {
                if require_name {
                    bail!("descriptor without name");
                }
                None
            }
            _ => bail!("non-string name"),
        };
        // `bytes` is not stored: the caller recomputes it from shape so a
        // mismatched declared size can never bypass validation.
        if let Some(bytes) = obj.get("bytes").and_then(Value::as_i64) {
            if bytes < 0 {
                bail!("negative bytes");
            }
            if !allow_dynamic {
                let expected = shape.iter().try_fold(1i64, |a, &d| {
                    let p = a.checked_mul(d).ok_or_else(|| anyhow!("shape overflow"))?;
                    Ok::<i64, anyhow::Error>(p)
                })?;
                if expected.checked_mul(dtype.elem_size() as i64) != Some(bytes) {
                    bail!("declared bytes {bytes} != shape product");
                }
            }
        }
        Ok(Self { name, dtype, shape })
    }
}

fn parse_desc_array(value: &Value, allow_dynamic: bool, require_name: bool) -> Result<Vec<TensorDesc>> {
    let arr = value.as_array().ok_or_else(|| anyhow!("descriptors must be an array"))?;
    if arr.is_empty() || arr.len() > MAX_IO {
        bail!("descriptor count {} outside 1..{MAX_IO}", arr.len());
    }
    arr.iter()
        .map(|v| TensorDesc::parse(v, allow_dynamic, require_name))
        .collect()
}

/// Parse a numeric HOST:PORT endpoint and refuse anything off loopback.
pub fn parse_endpoint(spec: &str) -> Result<SocketAddr> {
    let spec = spec.trim();
    if spec.is_empty() {
        bail!("remote AI endpoint is empty");
    }
    let addr: SocketAddr = spec
        .parse()
        .map_err(|_| anyhow!("remote AI endpoint must be numeric HOST:PORT, got '{spec}'"))?;
    if !addr.ip().is_loopback() {
        bail!("remote AI endpoint must be loopback (SSH-tunnel it to 127.0.0.1), got '{spec}'");
    }
    Ok(addr)
}

/// A model loaded on the remote worker over one dedicated connection.
#[derive(Debug)]
pub struct RemoteModel {
    stream: TcpStream,
    pub inputs: Vec<TensorDesc>,
    pub outputs: Vec<TensorDesc>,
    pub provider: String,
}

fn send_frame(stream: &mut TcpStream, value: &Value) -> Result<()> {
    let data = serde_json::to_vec(value)?;
    if data.is_empty() || data.len() > MAX_JSON {
        bail!("JSON frame of {} bytes outside 1..{MAX_JSON}", data.len());
    }
    stream.write_all(&(data.len() as u32).to_be_bytes())?;
    stream.write_all(&data)?;
    stream.flush()?;
    Ok(())
}

fn recv_exact(stream: &mut TcpStream, len: usize) -> Result<Vec<u8>> {
    let mut buf = vec![0u8; len];
    stream.read_exact(&mut buf)?;
    Ok(buf)
}

fn recv_frame(stream: &mut TcpStream) -> Result<Value> {
    let mut hdr = [0u8; 4];
    stream.read_exact(&mut hdr)?;
    let len = u32::from_be_bytes(hdr) as usize;
    if len == 0 || len > MAX_JSON {
        bail!("response JSON frame of {len} bytes outside 1..{MAX_JSON}");
    }
    let raw = recv_exact(stream, len)?;
    serde_json::from_slice(&raw).map_err(|e| anyhow!("malformed JSON frame: {e}"))
}

/// Validate an `ok` frame; a refused frame carries a worker error string.
fn check_ok(frame: &Value) -> Result<()> {
    match frame.get("ok").and_then(Value::as_bool) {
        Some(true) => Ok(()),
        Some(false) => {
            let err = frame
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unspecified worker error");
            Err(anyhow!("remote worker refused: {err}"))
        }
        None => Err(anyhow!("response frame without boolean ok")),
    }
}

/// One inference result: f32 data plus the worker's concrete output shape.
pub struct RunOutput {
    pub data: Vec<f32>,
    pub shape: Vec<i64>,
}

impl RemoteModel {
    /// Connect to a loopback worker and load `model/file`. No fallback on
    /// failure: the error is returned and nothing local is attempted.
    pub fn connect_load(endpoint: &str, model: &str, file: &str) -> Result<Self> {
        if model.is_empty() || model.contains('/') || model.contains("..") {
            bail!("model id must be a directory basename: '{model}'");
        }
        if file.is_empty()
            || file.contains('/')
            || file.contains("..")
            || !file.ends_with(".onnx")
        {
            bail!("model file must be a basename '*.onnx': '{file}'");
        }
        let addr = parse_endpoint(endpoint)?;
        let mut stream = TcpStream::connect_timeout(&addr, TIMEOUT)?;
        stream.set_read_timeout(Some(TIMEOUT))?;
        stream.set_write_timeout(Some(TIMEOUT))?;
        stream.set_nodelay(true)?;

        send_frame(
            &mut stream,
            &json!({
                "v": PROTOCOL_VERSION,
                "op": "load",
                "model": model,
                "file": file,
                "opt": 0,
                "cpu": false,
                "overrides": [],
            }),
        )?;
        let frame = recv_frame(&mut stream)?;
        check_ok(&frame)?;
        let inputs = parse_desc_array(
            frame.get("inputs").ok_or_else(|| anyhow!("load response without inputs"))?,
            true,
            true,
        )?;
        let outputs = parse_desc_array(
            frame.get("outputs").ok_or_else(|| anyhow!("load response without outputs"))?,
            true,
            true,
        )?;
        let provider = frame
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        if provider != "CUDAExecutionProvider" {
            bail!("remote worker loaded {model} on {provider}; CUDA required, refusing");
        }
        log::info!("remote AI: loaded {model}/{file} on {provider}");
        Ok(Self { stream, inputs, outputs, provider })
    }

    /// Run one inference round trip. The output buffer is allocated from the
    /// worker's concrete response shape after full descriptor validation.
    pub fn run(&mut self, input: &[f32], input_shape: &[i64], out_rank: usize) -> Result<RunOutput> {
        if self.inputs.len() != 1 || self.outputs.len() != 1 {
            bail!("remote model must have exactly one input and one output");
        }
        let in_elems: u64 = input_shape
            .iter()
            .try_fold(1u64, |a, &d| {
                if d <= 0 {
                    bail!("input dim {d} must be concrete");
                }
                a.checked_mul(d as u64).ok_or_else(|| anyhow!("shape overflow"))
            })?;
        if in_elems as usize != input.len() {
            bail!("input len {} != shape product {in_elems}", input.len());
        }
        let in_bytes = in_elems * 4;
        if in_bytes > MAX_BYTES {
            bail!("input payload {in_bytes} exceeds {MAX_BYTES}");
        }

        send_frame(
            &mut self.stream,
            &json!({
                "v": PROTOCOL_VERSION,
                "op": "run",
                "inputs": [{
                    "type": DType::F32 as i64,
                    "shape": input_shape,
                    "bytes": in_bytes,
                }],
                "outputs": [{
                    "type": DType::F32 as i64,
                    "shape": vec![-1i64; out_rank],
                    "bytes": 0,
                }],
            }),
        )?;

        let mut payload = Vec::with_capacity(input.len() * 4);
        for v in input {
            payload.extend_from_slice(&v.to_le_bytes());
        }
        self.stream.write_all(&payload)?;
        self.stream.flush()?;

        let resp = recv_frame(&mut self.stream)?;
        check_ok(&resp)?;
        let mut outs = parse_desc_array(
            resp.get("outputs").ok_or_else(|| anyhow!("run response without outputs"))?,
            false,
            false,
        )?;
        if outs.len() != 1 {
            bail!("run response has {} outputs, expected 1", outs.len());
        }
        let out = outs.pop().unwrap();
        if !matches!(out.dtype, DType::F32 | DType::F16) {
            bail!("model delivers non-float output dtype {:?}", out.dtype);
        }
        let elems = out.elems()?;
        let raw_bytes = elems * out.dtype.elem_size();
        if raw_bytes > MAX_BYTES {
            bail!("output payload {raw_bytes} exceeds {MAX_BYTES}");
        }
        let raw = recv_exact(&mut self.stream, raw_bytes as usize)?;
        let data: Vec<f32> = match out.dtype {
            DType::F32 => raw
                .chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect(),
            DType::F16 => raw
                .chunks_exact(2)
                .map(|c| half_to_f32(u16::from_le_bytes([c[0], c[1]])))
                .collect(),
            _ => unreachable!("dtype filtered above"),
        };
        if data.len() != elems as usize {
            bail!("payload yielded {} elements, expected {elems}", data.len());
        }
        Ok(RunOutput { data, shape: out.shape })
    }
}

/// Bit-exact IEEE half -> f32 (handles zero, denormals, infinity, NaN),
/// mirroring the C client's `_half_to_float`.
pub fn half_to_f32(h: u16) -> f32 {
    let sign = ((h >> 15) & 1) as u32;
    let exp = ((h >> 10) & 0x1F) as u32;
    let mant = (h & 0x3FF) as u32;
    let bits: u32 = if exp == 0 {
        if mant == 0 {
            sign << 31
        } else {
            let mut m = mant;
            let mut e = -1i32;
            while m & 0x400 == 0 {
                m <<= 1;
                e -= 1;
            }
            m &= 0x3FF;
            (sign << 31) | (((e + 127 - 14 + 1) as u32) << 23) | (m << 13)
        }
    } else if exp == 31 {
        (sign << 31) | 0x7F80_0000 | (mant << 13)
    } else {
        (sign << 31) | ((exp + 127 - 15) << 23) | (mant << 13)
    };
    f32::from_bits(bits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn write_frame(buf: &mut Vec<u8>, value: &Value) {
        let data = serde_json::to_vec(value).unwrap();
        buf.extend_from_slice(&(data.len() as u32).to_be_bytes());
        buf.extend_from_slice(&data);
    }

    fn read_frame<R: Read>(r: &mut R) -> (Value, u32) {
        let mut hdr = [0u8; 4];
        r.read_exact(&mut hdr).unwrap();
        let len = u32::from_be_bytes(hdr);
        let mut raw = vec![0u8; len as usize];
        r.read_exact(&mut raw).unwrap();
        (serde_json::from_slice(&raw).unwrap(), len)
    }

    #[test]
    fn endpoint_parsing_requires_numeric_loopback() {
        assert!(parse_endpoint("127.0.0.1:8794").is_ok());
        assert!(parse_endpoint("127.5.6.7:1").is_ok());
        assert!(parse_endpoint("[::1]:8794").is_ok());
        assert!(parse_endpoint("localhost:8794").is_err()); // non-numeric host
        assert!(parse_endpoint("100.96.93.15:8794").is_err()); // tailscale, not loopback
        assert!(parse_endpoint("192.168.1.10:8794").is_err());
        assert!(parse_endpoint("::1:8794").is_err()); // ambiguous, unparseable
        assert!(parse_endpoint("").is_err());
        assert!(parse_endpoint("127.0.0.1").is_err());
    }

    #[test]
    fn descriptors_reject_bad_bounds() {
        let ok = json!({"name": "input", "type": 1, "shape": [1, 4, 512, 512]});
        assert!(TensorDesc::parse(&ok, true, true).is_ok());
        // dynamic dim in a concrete (run-response) descriptor
        let dyn_dim = json!({"type": 1, "shape": [1, 3, -1, -1], "bytes": 0});
        assert!(TensorDesc::parse(&dyn_dim, false, false).is_err());
        assert!(TensorDesc::parse(&dyn_dim, true, false).is_ok());
        // declared bytes must equal shape product x elem size
        let bad_bytes = json!({"name": "x", "type": 1, "shape": [1, 2, 2], "bytes": 17});
        assert!(TensorDesc::parse(&bad_bytes, false, true).is_err());
        // zero dims never valid, rank bounds enforced
        assert!(TensorDesc::parse(&json!({"type": 1, "shape": [0]}), false, false).is_err());
        assert!(TensorDesc::parse(&json!({"type": 1, "shape": vec![1; 9]}), false, false).is_err());
        assert!(TensorDesc::parse(&json!({"type": 7, "shape": [1]}), false, false).is_err());
        // missing name where required
        assert!(TensorDesc::parse(&json!({"type": 1, "shape": [1]}), true, true).is_err());
    }

    #[test]
    fn half_conversion_matches_c_semantics() {
        assert_eq!(half_to_f32(0x0000), 0.0);
        assert_eq!(half_to_f32(0x8000), -0.0);
        assert!(half_to_f32(0x7C00).is_infinite());
        assert_eq!(half_to_f32(0xFC00), f32::NEG_INFINITY);
        assert!(half_to_f32(0x7E00).is_nan());
        // smallest normal half 2^-14
        assert_eq!(half_to_f32(0x0400), 2.0f32.powi(-14));
        // a denormal half: mantissa 1 -> 2^-24
        assert_eq!(half_to_f32(0x0001), 2.0f32.powi(-24));
        assert_eq!(half_to_f32(0x3C00), 1.0);
        assert_eq!(half_to_f32(0xBC00), -1.0);
        assert_eq!(half_to_f32(0x5100), 40.0);
    }

    /// Mock worker: scripted load response, then validates the run frame and
    /// payload, replying with a concrete f32 output.
    #[test]
    fn load_and_run_round_trip_on_the_wire() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            sock.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
            let (load, _) = read_frame(&mut sock);
            assert_eq!(load["v"], 1);
            assert_eq!(load["op"], "load");
            assert_eq!(load["model"], "rawdenoise-nind");
            assert_eq!(load["file"], "model_bayer.onnx");
            assert_eq!(load["cpu"], false);
            let mut resp = Vec::new();
            write_frame(
                &mut resp,
                &json!({
                    "ok": true,
                    "inputs": [{"name": "input", "type": 1, "shape": [1, 4, 512, 512]}],
                    "outputs": [{"name": "output", "type": 1, "shape": [1, 3, 1024, 1024]}],
                    "provider": "CUDAExecutionProvider",
                }),
            );
            sock.write_all(&resp).unwrap();

            let (run, json_len) = read_frame(&mut sock);
            assert_eq!(run["op"], "run");
            assert_eq!(run["inputs"][0]["shape"], json!([1, 4, 4, 4]));
            assert_eq!(run["inputs"][0]["bytes"], 4 * 4 * 4 * 4);
            assert_eq!(run["outputs"][0]["shape"], json!([-1, -1, -1, -1]));
            assert_eq!(run["outputs"][0]["bytes"], 0);
            let mut payload = vec![0u8; 4 * 4 * 4 * 4];
            sock.read_exact(&mut payload).unwrap();
            let vals: Vec<f32> = payload
                .chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect();
            assert_eq!(vals[0], 1.5);
            assert_eq!(vals[63], -0.25);
            let _ = json_len;
            let mut out = Vec::new();
            write_frame(
                &mut out,
                &json!({"ok": true, "outputs": [{"type": 1, "shape": [1, 3, 8, 8], "bytes": 3 * 64 * 4}]}),
            );
            out.extend_from_slice(&(0..192).map(|i| (i as f32) * 0.5).collect::<Vec<f32>>()[..]
                .iter()
                .flat_map(|f| f.to_le_bytes())
                .collect::<Vec<u8>>());
            sock.write_all(&out).unwrap();
        });

        let mut model =
            RemoteModel::connect_load(&format!("127.0.0.1:{port}"), "rawdenoise-nind", "model_bayer.onnx")
                .unwrap();
        assert_eq!(model.provider, "CUDAExecutionProvider");
        assert_eq!(model.inputs[0].shape, vec![1, 4, 512, 512]);
        let mut input = vec![0.0f32; 64];
        input.iter_mut().take(1).for_each(|v| *v = 1.5);
        input[63] = -0.25;
        let out = model
            .run(&input, &[1, 4, 4, 4], 4)
            .unwrap();
        server.join().unwrap();
        assert_eq!(out.shape, vec![1, 3, 8, 8]);
        assert_eq!(out.data.len(), 192);
        assert_eq!(out.data[191], 95.5);
    }

    #[test]
    fn worker_refusal_surfaces_the_error_string() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let _ = read_frame(&mut sock);
            let mut resp = Vec::new();
            write_frame(&mut resp, &json!({"ok": false, "error": "unknown model file"}));
            sock.write_all(&resp).unwrap();
        });
        let err = RemoteModel::connect_load(&format!("127.0.0.1:{port}"), "nope", "model.onnx")
            .unwrap_err();
        server.join().unwrap();
        assert!(err.to_string().contains("unknown model file"), "{err}");
    }

    #[test]
    fn f16_payload_is_converted() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let _ = read_frame(&mut sock);
            let mut resp = Vec::new();
            write_frame(
                &mut resp,
                &json!({
                    "ok": true,
                    "inputs": [{"name": "input", "type": 10, "shape": [1, 1, 2, 2]}],
                    "outputs": [{"name": "output", "type": 10, "shape": [1, 1, 2, 2]}],
                    "provider": "CUDAExecutionProvider",
                }),
            );
            sock.write_all(&resp).unwrap();
            let (run, _) = read_frame(&mut sock);
            // client must declare f32 on the wire for both directions
            assert_eq!(run["inputs"][0]["type"], 1);
            assert_eq!(run["outputs"][0]["type"], 1);
            let mut payload = vec![0u8; 16];
            sock.read_exact(&mut payload).unwrap();
            let mut out = Vec::new();
            write_frame(
                &mut out,
                &json!({"ok": true, "outputs": [{"type": 10, "shape": [1, 1, 2, 2], "bytes": 8}]}),
            );
            // halves: 1.0, -2.0, 0.25, +inf
            for h in [0x3C00u16, 0xC000, 0x3400, 0x7C00] {
                out.extend_from_slice(&h.to_le_bytes());
            }
            sock.write_all(&out).unwrap();
        });
        let mut model =
            RemoteModel::connect_load(&format!("127.0.0.1:{port}"), "m", "model.onnx").unwrap();
        let out = model
            .run(&[1.0, -2.0, 0.25, 9.0], &[1, 1, 2, 2], 4)
            .unwrap();
        server.join().unwrap();
        assert_eq!(out.data[0], 1.0);
        assert_eq!(out.data[1], -2.0);
        assert_eq!(out.data[2], 0.25);
        assert!(out.data[3].is_infinite());
    }
}
