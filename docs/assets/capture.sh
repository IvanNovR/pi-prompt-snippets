#!/usr/bin/env bash
# macOS; existing node_modules, tmux, Python Pillow, ffmpeg. No dependency downloads.
set -euo pipefail
cd "$(dirname "$0")/../.."
python3 docs/assets/capture-terminal.py
