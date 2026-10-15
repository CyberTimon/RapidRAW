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
use parking_lot::Mutex as SyncMutex;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Weak};
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

/// The worker accepts at most 4 concurrent model connections, each held
/// for the socket's lifetime. RapidRAW has nine AI models, so remote
/// backends share one pool that keeps at most this many live sessions,
/// evicting the least-recently-used one (dropping the socket releases the
/// worker-side model). One slot of headroom stays for the transient
/// sensor-RAW/upscale connections.
pub const REMOTE_POOL_CAP: usize = 3;

struct SlotInner {
    /// `None` = evicted; the next run reconnects lazily.
    state: SyncMutex<Option<RemoteModel>>,
    last_used: AtomicU64,
}

/// One lazily-connected model session owned by the shared pool. `cpu`
/// requests an explicit CPU session on the wire (a request, never a
/// fallback); GPU sessions refuse a CPU provider client-side.
pub struct RemoteSlot {
    pool: Arc<RemotePool>,
    endpoint: String,
    model: String,
    file: String,
    cpu: bool,
    inner: Arc<SlotInner>,
}

/// Bounds live worker connections across every AI model.
pub struct RemotePool {
    cap: usize,
    /// Serialises reconnects so the live count never overshoots the cap.
    connect_lock: SyncMutex<()>,
    slots: SyncMutex<Vec<Weak<SlotInner>>>,
    tick: AtomicU64,
}


impl RemotePool {
    pub fn new(cap: usize) -> Arc<Self> {
        Arc::new(Self {
            cap,
            connect_lock: SyncMutex::new(()),
            slots: SyncMutex::new(Vec::new()),
            tick: AtomicU64::new(1),
        })
    }

    pub fn slot(self: &Arc<Self>, endpoint: &str, model: &str, file: &str, cpu: bool) -> RemoteSlot {
        let inner = Arc::new(SlotInner {
            state: SyncMutex::new(None),
            last_used: AtomicU64::new(0),
        });
        self.slots.lock().push(Arc::downgrade(&inner));
        RemoteSlot {
            pool: self.clone(),
            endpoint: endpoint.to_string(),
            model: model.to_string(),
            file: file.to_string(),
            cpu,
            inner,
        }
    }

    fn bump(&self, slot: &SlotInner) {
        slot.last_used
            .store(self.tick.fetch_add(1, Ordering::SeqCst), Ordering::SeqCst);
    }

    fn candidates_excluding(&self, keep: Option<&Arc<SlotInner>>) -> Vec<(u64, Arc<SlotInner>)> {
        self.slots
            .lock()
            .iter()
            .filter_map(Weak::upgrade)
            .filter(|s| keep.is_none_or(|k| !Arc::ptr_eq(s, k)))
            .map(|s| (s.last_used.load(Ordering::SeqCst), s))
            .collect()
    }

    fn live_count_excluding(&self, keep: &Arc<SlotInner>) -> usize {
        self.slots
            .lock()
            .iter()
            .filter_map(Weak::upgrade)
            .filter(|s| !Arc::ptr_eq(s, keep))
            .filter(|s| match s.state.try_lock() {
                Some(g) => g.is_some(),
                None => true, // locked == inference in flight == live
            })
            .count()
    }

    /// Drop the least-recently-used live session (never `keep`).
    fn evict_one_excluding(&self, keep: &Arc<SlotInner>) -> Result<()> {
        let mut candidates = self.candidates_excluding(Some(keep));
        candidates.sort_by_key(|(t, _)| *t);
        // Prefer unlocked victims so an in-flight inference is never yanked.
        for (_, cand) in &candidates {
            if let Some(mut st) = cand.state.try_lock() {
                if st.is_some() {
                    *st = None;
                    return Ok(());
                }
            }
        }
        // Everything is busy or empty: wait on the oldest live slot.
        for (_, cand) in &candidates {
            let mut st = cand.state.lock();
            if st.is_some() {
                *st = None;
                return Ok(());
            }
        }
        bail!("no live remote session available to evict");
    }

    fn run_slot(
        &self,
        keep: &Arc<SlotInner>,
        endpoint: &str,
        model: &str,
        file: &str,
        cpu: bool,
        inputs: &[TensorIn],
    ) -> Result<Vec<RunOutput>> {
        // Fast path: live session, no pool coordination.
        let mut st = keep.state.lock();
        if let Some(m) = st.as_mut() {
            self.bump(keep);
            return m.run_typed(inputs);
        }
        drop(st);

        // Reconnect path: serialise so the cap is never exceeded.
        let _guard = self.connect_lock.lock();
        let mut st = keep.state.lock();
        if let Some(m) = st.as_mut() {
            // Another thread reconnected meanwhile.
            self.bump(keep);
            return m.run_typed(inputs);
        }
        while self.live_count_excluding(keep) >= self.cap {
            self.evict_one_excluding(keep)?;
        }
        let mut m = RemoteModel::connect_load_with_opts(endpoint, model, file, cpu)?;
        let out = m.run_typed(inputs)?;
        *st = Some(m);
        self.bump(keep);
        Ok(out)
    }
}

/// Process-wide pool for the app's AI model sessions.
pub static SHARED_POOL: LazyLock<Arc<RemotePool>> =
    LazyLock::new(|| RemotePool::new(REMOTE_POOL_CAP));

impl RemoteSlot {
    pub fn run(&self, inputs: &[TensorIn]) -> Result<Vec<RunOutput>> {
        self.pool.run_slot(
            &self.inner,
            &self.endpoint,
            &self.model,
            &self.file,
            self.cpu,
            inputs,
        )
    }
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

impl RunOutput {
    /// Decode a non-float output that the caller does not consume.
    fn opaque(shape: Vec<i64>) -> Self {
        Self { data: Vec::new(), shape }
    }
}

/// One concrete input tensor for a typed `run` call.
#[derive(Debug, Clone)]
pub struct TensorIn {
    pub dtype: DType,
    pub shape: Vec<i64>,
    /// Little-endian payload, exactly shape-product × elem-size bytes.
    pub data: Vec<u8>,
}

fn checked_payload(shape: &[i64], dtype: DType, len: usize, what: &str) -> Result<()> {
    let elems = shape.iter().try_fold(1u64, |a, &d| {
        if d <= 0 {
            bail!("{what}: dim {d} must be concrete");
        }
        a.checked_mul(d as u64).ok_or_else(|| anyhow!("{what}: shape overflow"))
    })?;
    if (elems * dtype.elem_size()) as usize != len {
        bail!("{what}: payload {len} bytes != shape product {elems} × {}", dtype.elem_size());
    }
    if len as u64 > MAX_BYTES {
        bail!("{what}: payload {len} exceeds {MAX_BYTES}");
    }
    Ok(())
}

impl TensorIn {
    fn build(shape: &[i64], dtype: DType, data: Vec<u8>) -> Result<Self> {
        checked_payload(shape, dtype, data.len(), "input tensor")?;
        Ok(Self { dtype, shape: shape.to_vec(), data })
    }

    pub fn f32(shape: &[i64], values: &[f32]) -> Result<Self> {
        let mut data = Vec::with_capacity(values.len() * 4);
        for v in values {
            data.extend_from_slice(&v.to_le_bytes());
        }
        Self::build(shape, DType::F32, data)
    }

    pub fn u8(shape: &[i64], values: &[u8]) -> Result<Self> {
        Self::build(shape, DType::U8, values.to_vec())
    }

    pub fn i64(shape: &[i64], values: &[i64]) -> Result<Self> {
        let mut data = Vec::with_capacity(values.len() * 8);
        for v in values {
            data.extend_from_slice(&v.to_le_bytes());
        }
        Self::build(shape, DType::I64, data)
    }
}

impl RemoteModel {
    /// Connect to a loopback worker and load `model/file` on the GPU.
    /// No fallback on failure: the error is returned and nothing local
    /// is attempted.
    pub fn connect_load(endpoint: &str, model: &str, file: &str) -> Result<Self> {
        Self::connect_load_with_opts(endpoint, model, file, false)
    }

    /// Load with an explicit CPU session (`cpu:true` on the wire — the
    /// protocol treats this as a request, never a fallback). Used by the
    /// live smoke to share a busy GPU host fairly.
    pub fn connect_load_with_opts(endpoint: &str, model: &str, file: &str, cpu: bool) -> Result<Self> {
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
                "cpu": cpu,
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
        // Fail closed: a GPU request must never surface a CPU session. The
        // worker itself disables fallback, so this only trips on a
        // misconfigured host. Explicit `cpu:true` requests are honoured.
        if !cpu && provider == "CPUExecutionProvider" {
            bail!("remote worker loaded {model} on CPU after a GPU request; refusing");
        }
        log::info!("remote AI: loaded {model}/{file} on {provider}");
        Ok(Self { stream, inputs, outputs, provider })
    }

    /// Run one inference round trip with typed multi-input/output
    /// descriptors (wire protocol v1, `dt_ai_dtype_t`). Inputs are sent in
    /// model input order; every model output is requested as a dynamic
    /// (worker-allocated) descriptor of the model's own dtype and decoded
    /// to f32 when float. The output buffers are allocated from the
    /// worker's concrete response shape after full descriptor validation.
    pub fn run_typed(&mut self, inputs: &[TensorIn]) -> Result<Vec<RunOutput>> {
        if inputs.len() != self.inputs.len() {
            bail!(
                "model takes {} inputs, got {}",
                self.inputs.len(),
                inputs.len()
            );
        }
        let mut descs = Vec::with_capacity(inputs.len());
        for (i, t) in inputs.iter().enumerate() {
            // The worker casts float32<->float16 and nothing else, so an
            // f16 model input may be fed an f32 payload; every other
            // dtype must match the model exactly.
            let compatible = self.inputs[i].dtype == t.dtype
                || (self.inputs[i].dtype == DType::F16 && t.dtype == DType::F32);
            if !compatible {
                bail!(
                    "input {} is {:?} on the model, got {:?}",
                    i,
                    self.inputs[i].dtype,
                    t.dtype
                );
            }
            descs.push(json!({
                "type": t.dtype as i64,
                "shape": t.shape,
                "bytes": t.data.len(),
            }));
        }
        if descs.is_empty() || descs.len() > MAX_IO {
            bail!("input count {} outside 1..{MAX_IO}", descs.len());
        }
        let out_reqs: Vec<Value> = self
            .outputs
            .iter()
            .map(|o| {
                if o.shape.is_empty() {
                    bail!("rank-0 output cannot be expressed on wire v1");
                }
                Ok(json!({
                    "type": o.dtype as i64,
                    "shape": vec![-1i64; o.shape.len()],
                    "bytes": 0,
                }))
            })
            .collect::<Result<_>>()?;

        send_frame(
            &mut self.stream,
            &json!({
                "v": PROTOCOL_VERSION,
                "op": "run",
                "inputs": descs,
                "outputs": out_reqs,
            }),
        )?;
        for t in inputs {
            self.stream.write_all(&t.data)?;
        }
        self.stream.flush()?;

        let resp = recv_frame(&mut self.stream)?;
        check_ok(&resp)?;
        let outs = parse_desc_array(
            resp.get("outputs").ok_or_else(|| anyhow!("run response without outputs"))?,
            false,
            false,
        )?;
        if outs.len() != self.outputs.len() {
            bail!("run response has {} outputs, expected {}", outs.len(), self.outputs.len());
        }
        let mut results = Vec::with_capacity(outs.len());
        for out in outs {
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
                _ => {
                    results.push(RunOutput::opaque(out.shape));
                    continue;
                }
            };
            if data.len() != elems as usize {
                bail!("payload yielded {} elements, expected {elems}", data.len());
            }
            results.push(RunOutput { data, shape: out.shape });
        }
        Ok(results)
    }

    /// Single f32 tensor convenience wrapper kept for the sensor RAW
    /// denoise / upscale paths.
    pub fn run(&mut self, input: &[f32], input_shape: &[i64], out_rank: usize) -> Result<RunOutput> {
        if self.outputs.len() != 1 {
            bail!("single-tensor run needs exactly one model output, has {}", self.outputs.len());
        }
        if out_rank != self.outputs[0].shape.len() {
            bail!(
                "model output rank is {}, caller declared {out_rank}",
                self.outputs[0].shape.len()
            );
        }
        let input = [TensorIn::f32(input_shape, input)?];
        Ok(self.run_typed(&input)?.pop().ok_or_else(|| anyhow!("worker returned no outputs"))?)
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
        assert!(parse_endpoint("198.51.100.10:8794").is_err()); // routed subnet, not loopback
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
            // client declares f32 on the wire for inputs, the model's own
            // f16 dtype for outputs (no worker-side cast needed)
            assert_eq!(run["inputs"][0]["type"], 1);
            assert_eq!(run["outputs"][0]["type"], 10);
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

    /// Typed multi-input (f32 + u8 + i64) and multi-output (f32 + f16)
    /// round trip: frame descriptors, concatenated payload order and f16
    /// decode are all exercised in one pass.
    #[test]
    fn typed_multi_io_round_trip() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            sock.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
            let (load, _) = read_frame(&mut sock);
            assert_eq!(load["cpu"], false);
            let mut resp = Vec::new();
            write_frame(
                &mut resp,
                &json!({
                    "ok": true,
                    "inputs": [
                        {"name": "image", "type": 1, "shape": [1, 2]},
                        {"name": "pixels", "type": 2, "shape": [4]},
                        {"name": "ids", "type": 5, "shape": [3]},
                    ],
                    "outputs": [
                        {"name": "out_f32", "type": 1, "shape": [1, 2]},
                        {"name": "out_f16", "type": 10, "shape": [2]},
                        {"name": "out_i64", "type": 5, "shape": [1]},
                    ],
                    "provider": "CUDAExecutionProvider",
                }),
            );
            sock.write_all(&resp).unwrap();

            let (run, _) = read_frame(&mut sock);
            let ins = run["inputs"].as_array().unwrap();
            assert_eq!(ins[0], json!({"type": 1, "shape": [1, 2], "bytes": 8}));
            assert_eq!(ins[1], json!({"type": 2, "shape": [4], "bytes": 4}));
            assert_eq!(ins[2], json!({"type": 5, "shape": [3], "bytes": 24}));
            let outs = run["outputs"].as_array().unwrap();
            assert_eq!(outs[0], json!({"type": 1, "shape": [-1, -1], "bytes": 0}));
            assert_eq!(outs[1], json!({"type": 10, "shape": [-1], "bytes": 0}));
            assert_eq!(outs[2], json!({"type": 5, "shape": [-1], "bytes": 0}));
            // payloads arrive in descriptor order
            let mut all = vec![0u8; 8 + 4 + 24];
            sock.read_exact(&mut all).unwrap();
            assert_eq!(&all[8..12], &[9u8, 8, 7, 6]);
            let ids: Vec<i64> = all[12..36]
                .chunks_exact(8)
                .map(|c| i64::from_le_bytes(c.try_into().unwrap()))
                .collect();
            assert_eq!(ids, vec![5, 6, 7]);

            let mut out = Vec::new();
            write_frame(
                &mut out,
                &json!({"ok": true, "outputs": [
                    {"type": 1, "shape": [1, 2], "bytes": 8},
                    {"type": 10, "shape": [2], "bytes": 4},
                    {"type": 5, "shape": [1], "bytes": 8},
                ]}),
            );
            out.extend_from_slice(&1.5f32.to_le_bytes());
            out.extend_from_slice(&(-2.5f32).to_le_bytes());
            out.extend_from_slice(&0x3C00u16.to_le_bytes()); // 1.0
            out.extend_from_slice(&0xC000u16.to_le_bytes()); // -2.0
            out.extend_from_slice(&42i64.to_le_bytes());
            sock.write_all(&out).unwrap();
        });

        let mut model =
            RemoteModel::connect_load(&format!("127.0.0.1:{port}"), "m", "model.onnx").unwrap();
        let outs = model
            .run_typed(&[
                TensorIn::f32(&[1, 2], &[0.25, -0.75]).unwrap(),
                TensorIn::u8(&[4], &[9, 8, 7, 6]).unwrap(),
                TensorIn::i64(&[3], &[5, 6, 7]).unwrap(),
            ])
            .unwrap();
        server.join().unwrap();
        assert_eq!(outs[0].data, vec![1.5, -2.5]);
        assert_eq!(outs[1].data, vec![1.0, -2.0]);
        // non-float outputs are returned opaque (shape only)
        assert_eq!(outs[2].shape, vec![1]);
        assert!(outs[2].data.is_empty());
    }

    #[test]
    fn input_count_and_dtype_mismatch_fail_before_send() {
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
                    "inputs": [{"name": "image", "type": 1, "shape": [1, 2]}],
                    "outputs": [{"name": "out", "type": 1, "shape": [1, 2]}],
                    "provider": "CUDAExecutionProvider",
                }),
            );
            sock.write_all(&resp).unwrap();
        });
        let mut model =
            RemoteModel::connect_load(&format!("127.0.0.1:{port}"), "m", "model.onnx").unwrap();
        server.join().unwrap();
        // wrong arity fails before any frame is written
        assert!(model.run_typed(&[]).is_err());
        // wrong dtype fails before any frame is written
        assert!(model.run_typed(&[TensorIn::u8(&[1, 2], &[0, 0]).unwrap()]).is_err());
        // payload/shape mismatch is rejected at construction, before any frame
        assert!(TensorIn::f32(&[1, 2], &[1.0]).is_err());
    }

    #[test]
    fn explicit_cpu_load_is_honoured_but_gpu_request_refuses_cpu_session() {
        for (cpu, provider, ok) in [
            (true, "CPUExecutionProvider", true),
            (false, "CPUExecutionProvider", false),
            (false, "CUDAExecutionProvider", true),
            (false, "CoreMLExecutionProvider", true),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = std::thread::spawn(move || {
                let (mut sock, _) = listener.accept().unwrap();
                let (load, _) = read_frame(&mut sock);
                assert_eq!(load["cpu"], cpu);
                let mut resp = Vec::new();
                write_frame(
                    &mut resp,
                    &json!({
                        "ok": true,
                        "inputs": [{"name": "input", "type": 1, "shape": [1]}],
                        "outputs": [{"name": "output", "type": 1, "shape": [1]}],
                        "provider": provider,
                    }),
                );
                sock.write_all(&resp).unwrap();
            });
            let res = RemoteModel::connect_load_with_opts(
                &format!("127.0.0.1:{port}"),
                "m",
                "model.onnx",
                cpu,
            );
            server.join().unwrap();
            assert_eq!(res.is_ok(), ok, "cpu={cpu} provider={provider}: {res:?}");
        }
    }

    #[test]
    fn unreachable_endpoint_fails_closed() {
        // port 1 on loopback: nothing listens, connect must fail and no
        // local fallback exists by construction
        let err = RemoteModel::connect_load("127.0.0.1:1", "m", "model.onnx").unwrap_err();
        assert!(!err.to_string().is_empty());
    }

    /// Real worker smoke for the typed client path, on an explicitly
    /// requested CPU session (no GPU contention). Ignored by default:
    ///
    /// ```sh
    /// RAPIDRAW_REMOTE_SMOKE_ENDPOINT=127.0.0.1:18794 \
    ///   cargo test --lib live_worker_typed_smoke -- --ignored --nocapture
    /// ```
    ///
    /// Optional: RAPIDRAW_SMOKE_MODEL / RAPIDRAW_SMOKE_FILE select a
    /// different provisioned pack (default: upscale-realplksr/model_x2.onnx).
    #[test]
    #[ignore = "needs the tunnelled worker; run explicitly per doc comment"]
    fn live_worker_typed_smoke() {
        let endpoint =
            std::env::var("RAPIDRAW_REMOTE_SMOKE_ENDPOINT").unwrap_or_else(|_| DEFAULT_ENDPOINT.into());
        let model = std::env::var("RAPIDRAW_SMOKE_MODEL").unwrap_or_else(|_| MODEL_UPSCALE.into());
        let file = std::env::var("RAPIDRAW_SMOKE_FILE").unwrap_or_else(|_| MODEL_UPSCALE_X2_FILE.into());
        // Exercise the app path: shared pool slot with lazy connect and
        // LRU eviction, not a bare RemoteModel.
        let slot = SHARED_POOL.slot(&endpoint, &model, &file, true);
        let in_shape = vec![1, 3, 320, 320];
        let input = vec![0.5f32; in_shape.iter().product::<i64>() as usize];
        let outs = slot
            .run(&[TensorIn::f32(&in_shape, &input).unwrap()])
            .unwrap_or_else(|e| panic!("worker must load {model}/{file} on an explicit CPU session: {e}"));
        let out = &outs[0];
        assert!(!out.shape.is_empty());
        assert_eq!(out.data.len(), out.shape.iter().product::<i64>() as usize);
        assert!(out.data.iter().all(|v| v.is_finite()));
        println!("smoke ok: out shape {:?}", out.shape);
    }
}
