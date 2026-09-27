mod sidecar;

use std::sync::Mutex;
use tauri::{Manager, RunEvent};

pub fn run() {
    let app = tauri::Builder::default()
        .manage(sidecar::SidecarState(Mutex::new(None)))
        .setup(|app| {
            // Don't abort startup if the sidecar fails: the UI shows "offline" and the
            // reason is in the terminal.
            match sidecar::spawn(app.handle()) {
                Ok(child) => *app.state::<sidecar::SidecarState>().0.lock().unwrap() = Some(child),
                Err(e) => eprintln!("[sidecar] failed to start: {e}"),
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            sidecar::shutdown(handle);
        }
    });
}
