"""FastAPI app factory.

create_app() builds the app, mounts routes and static files, and owns the
shared JobStore.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .config import Settings
from .jobs import JobStore
from .routes import jobs as jobs_routes
from .routes import results as results_routes
from .routes import upload as upload_routes

STATIC_DIR = Path(__file__).resolve().parent / "static"


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    app = FastAPI(title="CaptionForge")
    app.state.settings = settings
    app.state.job_store = JobStore()

    app.include_router(upload_routes.router)
    app.include_router(jobs_routes.router)
    app.include_router(results_routes.router)

    @app.get("/api/health")
    async def health():
        return {"status": "ok", "ffmpeg_available": shutil.which("ffmpeg") is not None}

    if STATIC_DIR.exists() and any(STATIC_DIR.iterdir()):
        app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")

    return app
