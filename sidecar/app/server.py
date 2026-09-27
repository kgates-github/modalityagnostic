"""Sidecar entrypoint: `python -m app.server` (dev) or the PyInstaller binary (packaged)."""

import multiprocessing
import os
import threading
import time

import uvicorn

from app.main import app

HOST = "127.0.0.1"
PORT = int(os.environ.get("SIDECAR_PORT", "8756"))


def _exit_when_parent_dies() -> None:
    """Tauri passes its PID; if it's gone (crash, SIGKILL) don't linger holding the port."""
    parent = os.environ.get("SIDECAR_PARENT_PID")
    if not parent:
        return
    pid = int(parent)

    def watch() -> None:
        while True:
            time.sleep(2)
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                os._exit(0)
            except PermissionError:
                pass  # exists, owned by someone else

    threading.Thread(target=watch, daemon=True).start()


def main() -> None:
    _exit_when_parent_dies()
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")


if __name__ == "__main__":
    multiprocessing.freeze_support()  # needed for frozen builds once torch/mlx spawn workers
    main()
