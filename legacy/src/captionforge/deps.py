"""Shared FastAPI dependency accessors - pull the app-wide Settings/JobStore off app.state."""

from __future__ import annotations

from fastapi import Request

from .config import Settings
from .jobs import JobStore


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_job_store(request: Request) -> JobStore:
    return request.app.state.job_store
