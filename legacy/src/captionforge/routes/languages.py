"""GET /api/languages - the source-language codes/names for the picker.

Served from the backend (rather than duplicated as a hand-written list in
app.js) so the dropdown can never drift from what upload.py actually accepts:
both read the same captionforge.languages module.
"""

from __future__ import annotations

from fastapi import APIRouter

from ..languages import WHISPER_LANGUAGE_NAMES

router = APIRouter()


@router.get("/api/languages")
async def get_languages():
    languages = [{"code": code, "name": name} for code, name in WHISPER_LANGUAGE_NAMES.items()]
    languages.sort(key=lambda entry: entry["name"])
    return {"languages": languages}
