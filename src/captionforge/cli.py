"""`captionforge serve` - starts the local web server and opens the browser."""

from __future__ import annotations

import argparse
import shutil
import sys
import webbrowser
from threading import Timer

import uvicorn

from .app import create_app
from .config import Settings


def _open_browser(url: str) -> None:
    webbrowser.open(url)


def main() -> None:
    parser = argparse.ArgumentParser(prog="captionforge")
    subparsers = parser.add_subparsers(dest="command", required=True)

    serve_parser = subparsers.add_parser("serve", help="Inicia el servidor local")
    serve_parser.add_argument("--port", type=int, default=8420)
    serve_parser.add_argument(
        "--model", default="small", choices=["base", "small", "medium"], help="Modelo Whisper por defecto"
    )
    serve_parser.add_argument(
        "--no-browser", action="store_true", help="No abrir el navegador automaticamente"
    )

    args = parser.parse_args()

    if args.command == "serve":
        if shutil.which("ffmpeg") is None:
            print(
                "captionforge: no se encontro 'ffmpeg' en el PATH. Instalalo antes de continuar "
                "(https://ffmpeg.org/download.html).",
                file=sys.stderr,
            )
            sys.exit(1)

        settings = Settings(default_model_size=args.model, port=args.port)
        app = create_app(settings)
        url = f"http://{settings.host}:{settings.port}/"

        if not args.no_browser:
            Timer(1.0, _open_browser, args=(url,)).start()

        print(f"CaptionForge escuchando en {url}")
        uvicorn.run(app, host=settings.host, port=settings.port, log_level="warning")


if __name__ == "__main__":
    main()
