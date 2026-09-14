# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller build spec for the first-step packaged CaptionForge build.

Generated once via `pyinstaller --onefile --add-data ... --collect-all ...`
(see the equivalent CLI form's rationale in build_installer.py's docstring),
then hand-edited here for two things a raw `pyi-makespec`/first-run output
never gets right on its own:

1. Paths are relative to SPECPATH (this file's own directory, always
   `scripts/`, and set by PyInstaller itself when it loads a .spec file) -
   NOT the absolute paths a fresh `pyinstaller <args> entrypoint.py` run
   bakes in, which only work on the machine that generated them.
2. Comments explaining WHY each collect_all/add_data entry exists, so this
   file stays a readable reference for the "first step" documented in the
   README, not just an opaque build artifact.

Scope (see README's "Packaged build (first step)" section and issue #2):
one platform per build (whatever OS runs `pyinstaller` - no cross-compile),
CPU-only, unsigned, ffmpeg NOT bundled.

Usage: `pyinstaller scripts/captionforge.spec` (also what
scripts/build_installer.py runs for you).
"""

import os

from PyInstaller.utils.hooks import collect_all

REPO_ROOT = os.path.dirname(SPECPATH)  # noqa: F821 - SPECPATH is injected by PyInstaller itself
STATIC_DIR = os.path.join(REPO_ROOT, "src", "captionforge", "static")
ENTRYPOINT = os.path.join(REPO_ROOT, "scripts", "pyinstaller_entrypoint.py")

# Ships index.html/app.js/style.css/i18n.js/onboarding.js at the
# captionforge/static/ path app.py's STATIC_DIR expects relative to the
# frozen module (see app.py's `Path(__file__).resolve().parent / "static"`).
datas = [(STATIC_DIR, "captionforge/static")]
binaries = []
hiddenimports = []

# Each of these ships native extensions and/or data files (Whisper model
# loading code, CTranslate2's compiled backend, Argos Translate's package
# manifests) that PyInstaller's static import analysis can't discover on
# its own - collect_all pulls in each package's full contents rather than
# guessing which submodules/binaries actually get touched at runtime.
for package in ("faster_whisper", "ctranslate2", "argostranslate"):
    pkg_datas, pkg_binaries, pkg_hiddenimports = collect_all(package)
    datas += pkg_datas
    binaries += pkg_binaries
    hiddenimports += pkg_hiddenimports

a = Analysis(  # noqa: F821 - Analysis/PYZ/EXE are injected by PyInstaller's spec exec environment
    [ENTRYPOINT],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)  # noqa: F821

exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="captionforge",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    # Console stays on for this first step - it's the only place errors
    # (e.g. missing ffmpeg) are visible, since there's no installer/log
    # viewer yet. A windowed (no-console) build is a later polish step.
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    # No code signing - see the README's "Packaged build (first step)"
    # section and issue #2 for why this is explicitly deferred.
    codesign_identity=None,
    entitlements_file=None,
)
