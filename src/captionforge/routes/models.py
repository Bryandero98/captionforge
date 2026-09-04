"""GET /api/models/{model_size}/preflight - size/cache/free-disk numbers for the consent step.

Called by the frontend before it uploads anything, so a first-time model
download states its size and the machine's free disk BEFORE the transfer
starts, instead of the job silently stalling on it.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..models import UnknownModelSizeError, model_preflight

router = APIRouter()


@router.get("/api/models/{model_size}/preflight")
async def get_model_preflight(model_size: str):
    try:
        preflight = model_preflight(model_size)
    except UnknownModelSizeError as exc:
        raise HTTPException(400, str(exc)) from exc

    return {
        "model_size": preflight.model_size,
        "cached": preflight.cached,
        "approx_bytes": preflight.approx_bytes,
        "free_bytes": preflight.free_bytes,
        "destination": preflight.destination,
        "fits": preflight.fits,
    }
