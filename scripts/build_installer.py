#!/usr/bin/env python
"""Builds a single-file CaptionForge executable via PyInstaller.

This is a deliberately narrow FIRST STEP toward issue #2 (a packaged native
installer), not the installer itself. See scripts/captionforge.spec for the
full, commented build configuration and the README's "Packaged build (first
step)" section for what this does and does not cover:

- One platform only: whatever OS this script runs on. PyInstaller cross-
  builds per-host (a Windows box only ever produces a Windows binary), so
  there's no "pick a target OS" option here.
- CPU-only: bundles whatever faster-whisper/ctranslate2 backend is already
  installed in the current venv. No CUDA/cuDNN wheels, no GPU detection.
- No code signing: Windows SmartScreen / macOS Gatekeeper will warn on
  first run.
- ffmpeg is NOT bundled: a user still needs it on PATH, same as running
  from source.

Usage:
    pip install -e ".[build]"
    python scripts/build_installer.py

Produces dist/captionforge(.exe).
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC_FILE = ROOT / "scripts" / "captionforge.spec"


def main() -> None:
    if shutil.which("pyinstaller") is None:
        print('pyinstaller not found - run `pip install -e ".[build]"` first.', file=sys.stderr)
        sys.exit(1)

    cmd = ["pyinstaller", "--noconfirm", str(SPEC_FILE)]
    print("Running:", " ".join(cmd))
    subprocess.run(cmd, cwd=ROOT, check=True)
    print("\nBuilt executable: dist/captionforge" + (".exe" if sys.platform == "win32" else ""))
    print('ffmpeg is NOT bundled - it must still be on PATH. See the README\'s "Packaged build" section.')


if __name__ == "__main__":
    main()
