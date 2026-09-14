"""Entry point for the PyInstaller single-file build - double-click and go.

Same behavior as `captionforge serve` with its defaults (see cli.py), minus
argparse: a packaged executable has no terminal to pass flags to, so this
always serves on the default port with the default model and opens the
browser automatically. See scripts/build_installer.py and the README's
"Packaged build (first step)" section for what this build does and does
not cover.
"""

from __future__ import annotations

import shutil
import sys
import webbrowser
from threading import Timer

import uvicorn

from captionforge.app import create_app
from captionforge.config import Settings


def main() -> None:
    if shutil.which("ffmpeg") is None:
        print(
            "captionforge: 'ffmpeg' was not found on PATH. Install it first "
            "(https://ffmpeg.org/download.html) - this build does not bundle "
            "it yet, see the README.",
            file=sys.stderr,
        )
        input("Press Enter to exit...")
        sys.exit(1)

    settings = Settings()
    app = create_app(settings)
    url = f"http://{settings.host}:{settings.port}/"
    Timer(1.0, webbrowser.open, args=(url,)).start()
    print(f"CaptionForge listening at {url}")
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="warning")


if __name__ == "__main__":
    main()
