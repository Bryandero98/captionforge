"""Whether a Whisper model is already cached, and whether there's room to fetch it.

faster-whisper downloads CTranslate2-converted checkpoints from the Hugging
Face Hub on first use (see faster_whisper.utils.download_model) - silently,
with no size statement and no disk check, the same gap PortOS found in its
own nearest equivalent before building a proper preflight for it. This module
is CaptionForge's version of that: a pure size/cache/disk-space check the
upload route and the frontend's consent step both call BEFORE a job commits
to a multi-hundred-megabyte transfer.

Deliberately thin: huggingface_hub's own downloader (which faster-whisper
uses internally) already verifies each fetched file's hash against the Hub
and resumes an interrupted download on retry - CaptionForge doesn't need to
reimplement either. What it's missing, and what this module adds, is the
consent step itself: telling the user the size and the free disk BEFORE the
first byte moves, and refusing outright when the disk can't hold it.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path

from huggingface_hub import snapshot_download
from huggingface_hub.errors import LocalEntryNotFoundError

# Only the files faster_whisper.utils.download_model actually fetches -
# checking for anything else would report "not cached" for a model that's
# perfectly usable.
_MODEL_FILES = ["config.json", "preprocessor_config.json", "model.bin", "tokenizer.json", "vocabulary.*"]

# Repo ids straight out of faster_whisper.utils._MODELS, restricted to the
# three sizes CaptionForge's own <select id="model-size"> offers.
_REPO_IDS = {
    "base": "Systran/faster-whisper-base",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
}

# Approximate download size per model, for the consent step - a display hint
# only, not a byte-exact promise (the Hub is the real source of truth, same
# posture as any "about N MB" figure a package manager shows before a pull).
# base/small are the actual measured size of this project's own local cache
# (rglob-summed .bin + config + tokenizer + vocab, Sep 2026); medium is the
# widely published figure for the CTranslate2 conversion, unmeasured here -
# it would mean downloading a model twice just to size it.
_APPROX_BYTES = {
    "base": 148_000_000,
    "small": 486_000_000,
    "medium": 1_530_000_000,
}

# Headroom kept free AFTER the model lands, so a from-empty machine doesn't
# finish a download sitting at 0 bytes free - matches the spirit (not the
# exact number) of PortOS's own download-preflight headroom.
_DISK_HEADROOM_BYTES = 500_000_000


class UnknownModelSizeError(ValueError):
    """Raised for a model_size CaptionForge's own catalog doesn't recognize."""


@dataclass(frozen=True)
class ModelPreflight:
    model_size: str
    cached: bool
    approx_bytes: int
    free_bytes: int
    destination: str
    fits: bool


def _repo_id(model_size: str) -> str:
    repo_id = _REPO_IDS.get(model_size)
    if repo_id is None:
        raise UnknownModelSizeError(
            f"Tamaño de modelo desconocido: {model_size!r} (esperado uno de {sorted(_REPO_IDS)})"
        )
    return repo_id


def is_model_cached(model_size: str) -> bool:
    """True if every file a transcription needs is already in the local Hugging Face cache.

    `local_files_only=True` makes this a pure local filesystem check - no
    network call, so it's cheap enough to call on every preflight and again
    right before the actual download.
    """
    try:
        snapshot_download(_repo_id(model_size), local_files_only=True, allow_patterns=_MODEL_FILES)
        return True
    except LocalEntryNotFoundError:
        return False


def model_preflight(model_size: str, *, destination: Path | None = None) -> ModelPreflight:
    """Size / cache / free-disk numbers for the consent step. Downloads nothing.

    `destination` defaults to the Hugging Face cache's own drive - the same
    volume `download_model` will actually write to unless HF_HOME is set to
    somewhere else, in which case the caller can override it.
    """
    cached = is_model_cached(model_size)
    approx_bytes = _APPROX_BYTES[model_size]
    probe_dir = destination or Path.home()
    free_bytes = shutil.disk_usage(probe_dir).free
    return ModelPreflight(
        model_size=model_size,
        cached=cached,
        approx_bytes=approx_bytes,
        free_bytes=free_bytes,
        destination=str(probe_dir),
        fits=cached or free_bytes >= approx_bytes + _DISK_HEADROOM_BYTES,
    )


class InsufficientDiskSpaceError(RuntimeError):
    """Raised when a download is about to start on a disk too full to hold it."""


def assert_model_fits(model_size: str) -> None:
    """Re-checks disk space right before the real download - the server-side half of the

    consent gate. The frontend's preflight call is advisory (a user could hit
    the API directly, or free disk could have dropped since they clicked
    confirm); this is what actually stops the transfer.
    """
    preflight = model_preflight(model_size)
    if not preflight.fits:
        approx_gb = preflight.approx_bytes / 1024**3
        free_gb = preflight.free_bytes / 1024**3
        raise InsufficientDiskSpaceError(
            f"No hay espacio suficiente para descargar el modelo '{model_size}' "
            f"(~{approx_gb:.1f} GB, disponibles {free_gb:.1f} GB)."
        )
