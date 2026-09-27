#!/usr/bin/env bash
# Freeze the sidecar with PyInstaller (--onedir) into sidecar/dist/sidecar/.
# tauri.release.conf.json bundles that folder as an app resource.
set -euo pipefail

cd "$(dirname "$0")"
PY="../venv/bin/python"

rm -rf build dist

# When llm.py / intents.py land, add e.g.:
#   --collect-all mlx --collect-all mlx_lm --collect-all sentence_transformers
"$PY" -m PyInstaller \
  --noconfirm \
  --onedir \
  --name sidecar \
  --paths . \
  --distpath dist \
  --workpath build \
  --specpath build \
  --collect-submodules uvicorn \
  app/server.py

echo "Built: $(pwd)/dist/sidecar/sidecar"
