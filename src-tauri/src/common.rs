/// Common utilities for ONNX Runtime initialization and configuration
/// This module centralizes all ONNX environment setup following the ORT examples pattern

use anyhow::Result;
use log::info;
use ort::ep::*;

/// Initialize the global ONNX Runtime environment with GPU providers based on the current platform.
///
/// This function should be called once at application startup. It configures the global
/// ONNX Runtime environment with the appropriate execution providers for the platform:
/// - Windows: DirectML → CUDA → CPU
/// - Linux: CUDA → TensorRT → CPU
/// - macOS: CoreML → CPU
/// - Other: CPU only
///
/// All subsequently-created sessions will automatically inherit these configured providers.
///
/// # Returns
/// - `Ok(())` if environment initialization succeeded
/// - `Err(...)` if provider configuration failed
pub fn init_environment() -> Result<()> {
    info!("🔧 Initializing ONNX Runtime global environment...");
    
    #[cfg(target_os = "windows")]
    {
        info!("   Platform: Windows");
        info!("   Providers: DirectML → CUDA → CPU");
        
        // let committed = ort::init()
        //     .with_execution_providers([
        //         DirectML::default().build(),
        //         CUDA::default().build(),
        //     ])
        //     .commit();
        
         let committed = ort::init()
             .commit();
        if !committed {
            return Err(anyhow::anyhow!("Failed to commit ONNX environment with DirectML/CUDA providers"));
        }
    }
    
    #[cfg(target_os = "linux")]
    {
        info!("   Platform: Linux");
        info!("   Providers: CUDA → TensorRT → CPU");
        
        let committed = ort::init()
            .with_execution_providers([
                CUDA::default().build(),
                TensorRT::default().build(),
            ])
            .commit();
        
        if !committed {
            return Err(anyhow::anyhow!("Failed to commit ONNX environment with CUDA/TensorRT providers"));
        }
    }
    
    #[cfg(target_os = "macos")]
    {
        info!("   Platform: macOS");
        info!("   Providers: CoreML → CPU");
        
        let committed = ort::init()
            .with_execution_providers([
                CoreML::default().build(),
            ])
            .commit();
        
        if !committed {
            return Err(anyhow::anyhow!("Failed to commit ONNX environment with CoreML provider"));
        }
    }
    
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        info!("   Platform: Unsupported (using CPU only)");
        
        let committed = ort::init().commit();
        if !committed {
            return Err(anyhow::anyhow!("Failed to commit ONNX environment"));
        }
    }
    
    info!("✓ ONNX Runtime environment initialized successfully");
    Ok(())
}
