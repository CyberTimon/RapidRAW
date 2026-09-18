/// Common utilities for ONNX Runtime initialization and configuration

use anyhow::Result;
use log::info;

pub fn init_environment() -> Result<()> {
    let committed = ort::init().commit();
    if !committed {
        return Err(anyhow::anyhow!("Failed to commit ONNX environment"));
    }
    info!("ONNX Runtime environment initialized successfully");
    Ok(())
}
