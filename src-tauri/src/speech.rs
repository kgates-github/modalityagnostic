//! Spawns and tears down the Swift speech sidecar, and relays its NDJSON
//! stdout lines to the frontend as `speech-event`. Control is a tiny
//! stdin protocol: `{"cmd":"start"}` / `{"cmd":"stop"}`.
//!
//! dev only for now (`swift run`) -- release packaging (a built binary
//! bundled as a resource, like sidecar.rs does for Python) is deferred
//! until the real SpeechAnalyzer/SpeechTranscriber body replaces the demo.

use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::Mutex,
    thread,
};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct SpeechSidecarState {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
}

pub fn spawn(app: &AppHandle) -> Result<(), String> {
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let package_dir = repo.join("speech-sidecar");
    if !package_dir.exists() {
        return Err(format!("{} not found", package_dir.display()));
    }

    let mut cmd = Command::new("swift");
    cmd.args(["run", "--package-path"])
        .arg(&package_dir)
        .arg("SpeechSidecar")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());

    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");

    let app_handle = app.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().flatten() {
            let _ = app_handle.emit("speech-event", line);
        }
    });

    let state = app.state::<SpeechSidecarState>();
    *state.stdin.lock().unwrap() = Some(stdin);
    *state.child.lock().unwrap() = Some(child);
    Ok(())
}

fn send(app: &AppHandle, cmd: &str) -> Result<(), String> {
    let state = app.state::<SpeechSidecarState>();
    let mut guard = state.stdin.lock().unwrap();
    let stdin = guard.as_mut().ok_or("speech sidecar not running")?;
    writeln!(stdin, "{{\"cmd\":\"{cmd}\"}}").map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn speech_start(app: AppHandle) -> Result<(), String> {
    send(&app, "start")
}

#[tauri::command]
pub fn speech_stop(app: AppHandle) -> Result<(), String> {
    send(&app, "stop")
}

/// SIGTERM, wait briefly for a clean exit, then SIGKILL.
pub fn shutdown(app: &AppHandle) {
    let Some(mut child) = app.state::<SpeechSidecarState>().child.lock().unwrap().take() else {
        return;
    };
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
    let _ = child.wait();
}
