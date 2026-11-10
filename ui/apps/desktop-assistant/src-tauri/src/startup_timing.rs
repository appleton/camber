//! Native-side startup timing marks, for correlating the Rust launch path
//! with the webview's startup diagnostics (startupDiagnostics.ts).
//!
//! Enabled only when CAMBER_STARTUP_TIMING is set (scripts/measure-startup.mjs
//! sets it); each mark is one stderr line with an absolute epoch-millisecond
//! timestamp so an external harness can compute per-phase durations from its
//! own spawn time without any clock translation.

use std::time::{SystemTime, UNIX_EPOCH};

pub fn mark(name: &str) {
    if std::env::var_os("CAMBER_STARTUP_TIMING").is_none() {
        return;
    }
    let epoch_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    eprintln!("startup-timing: {epoch_ms} {name}");
}
