use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "code", content = "params", rename_all = "camelCase")]
pub enum PanoMessage {
    Cancelled,
    Reprojecting,
    LoadingFile {
        current: usize,
        total: usize,
        name: String,
    },
    Projecting,
    Exposure,
    Blending,
    Finishing,
    Rendering,
    Encoding,
    WritingTiff,
    SaveComplete,
    NeedTwo,
    NoSession,
    NoSessionSave,
    NoOverlap,
    FovTooWide {
        degrees: f64,
    },
    NoPreview,
    AlignmentMismatch,
    NoParent,
    CropFailed,
    OutOfMemory,
    TaskFailed {
        detail: String,
    },
    ReprojectFailed {
        detail: String,
    },
    SaveFailed {
        detail: String,
    },
    LoaderFailed {
        detail: String,
    },
    SaveWriteFailed {
        detail: String,
    },
    EncodeFailed {
        detail: String,
    },
    ReadFailed {
        file: String,
        detail: String,
    },
    DroppedNoOverlap,
    DroppedNoOverlapFocal {
        focal: f64,
    },
}

impl PanoMessage {
    pub fn encode_failed(e: impl ToString) -> Self {
        PanoMessage::EncodeFailed {
            detail: e.to_string(),
        }
    }
}
