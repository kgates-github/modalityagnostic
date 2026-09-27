//! Spawns and tears down the Python sidecar (FastAPI on 127.0.0.1:8756).
//!
//! - debug builds (`tauri dev`): run from source with the repo's `venv/`
//! - release builds: run the PyInstaller `--onedir` build bundled as the `sidecar` resource

use std::{
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

pub struct SidecarState(pub Mutex<Option<Child>>);

fn command(app: &AppHandle) -> Result<Command, String> {
    if cfg!(debug_assertions) {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let python = repo.join("venv/bin/python");
        if !python.exists() {
            return Err(format!("{} not found; create the venv first", python.display()));
        }
        let mut cmd = Command::new(python);
        cmd.args(["-u", "-m", "app.server"]).current_dir(repo.join("sidecar"));
        Ok(cmd)
    } else {
        let exe = app
            .path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("sidecar/sidecar");
        if !exe.exists() {
            return Err(format!(
                "{} not found; build with `npm run tauri:build` so the sidecar is bundled",
                exe.display()
            ));
        }
        Ok(Command::new(exe))
    }
}

pub fn spawn(app: &AppHandle) -> Result<Child, String> {
    let mut cmd = command(app)?;
    cmd.env("SIDECAR_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    cmd.spawn().map_err(|e| format!("spawn failed: {e}"))
}

/// SIGTERM, wait briefly for a clean exit, then SIGKILL.
pub fn shutdown(app: &AppHandle) {
    let Some(mut child) = app.state::<SidecarState>().0.lock().unwrap().take() else {
        return;
    };
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}
