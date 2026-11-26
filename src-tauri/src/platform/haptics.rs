use serde::Deserialize;

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum HapticKind {
    Alignment,
    Level,
}

#[tauri::command]
pub fn haptic(app_handle: tauri::AppHandle, kind: HapticKind) {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{
            NSHapticFeedbackManager, NSHapticFeedbackPattern, NSHapticFeedbackPerformanceTime,
            NSHapticFeedbackPerformer,
        };
        let pattern = match kind {
            HapticKind::Alignment => NSHapticFeedbackPattern::Alignment,
            HapticKind::Level => NSHapticFeedbackPattern::LevelChange,
        };
        let _ = app_handle.run_on_main_thread(move || {
            NSHapticFeedbackManager::defaultPerformer().performFeedbackPattern_performanceTime(
                pattern,
                NSHapticFeedbackPerformanceTime::Now,
            );
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app_handle, kind);
}
