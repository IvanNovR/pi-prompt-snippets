#!/usr/bin/env python3
"""Bounded macOS Chrome screenshot; Chrome may write a PNG but stay running."""
import os
from pathlib import Path
import signal
import struct
import subprocess
import sys

chrome, profile, html = sys.argv[1:]
html = Path(html).resolve()
png = html.with_suffix('.png')
png.unlink(missing_ok=True)  # Never mistake a previous capture for this one.
command = [chrome, '--headless', '--no-first-run', '--no-default-browser-check',
           '--disable-background-networking', '--disable-sync', '--disable-extensions',
           '--disable-component-update', '--disable-crash-reporter', '--disable-gpu',
           f'--user-data-dir={profile}', '--hide-scrollbars', '--window-size=1100,600',
           f'--screenshot={png}', html.as_uri()]
with html.with_suffix('.chrome.log').open('wb') as log:
    process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
                               start_new_session=True)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        # Target only the process group created for this capture, never other browsers.
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=2)
    finally:
        # Reap capture helper processes in the same group even if the parent exited.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
raw = png.read_bytes()  # Fails loudly if Chrome did not produce a screenshot.
assert raw[:8] == b'\x89PNG\r\n\x1a\n', f'Invalid PNG: {png}'
assert struct.unpack('>II', raw[16:24]) == (1100, 600), f'Unexpected image size: {png}'
print(f'Captured {png.name}: {len(raw)} bytes', flush=True)
