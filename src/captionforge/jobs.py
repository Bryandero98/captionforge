"""In-memory job state machine - thread-safe, no persistence.

CaptionForge handles one video at a time in v1 (by design, per the project
plan) - JobStore enforces that: starting a second job while one is already
active is a real, surfaced error, not silently queued or overwritten.
"""

from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass
from enum import Enum
from pathlib import Path


class JobStatus(str, Enum):
    QUEUED = "queued"
    EXTRACTING_AUDIO = "extracting_audio"
    # Only entered when the requested Whisper model isn't in the local
    # Hugging Face cache yet (see models.py) - a job whose model is already
    # cached skips straight from EXTRACTING_AUDIO to TRANSCRIBING.
    DOWNLOADING_MODEL = "downloading_model"
    TRANSCRIBING = "transcribing"
    DONE = "done"
    BURNING_SUBTITLES = "burning_subtitles"
    BURNED = "burned"
    ERROR = "error"


# Valid forward transitions. Any status can also move to ERROR (checked
# separately below) - that's not listed here to avoid repeating it for
# every entry.
_TRANSITIONS: dict[JobStatus, set[JobStatus]] = {
    JobStatus.QUEUED: {JobStatus.EXTRACTING_AUDIO},
    JobStatus.EXTRACTING_AUDIO: {JobStatus.DOWNLOADING_MODEL, JobStatus.TRANSCRIBING},
    JobStatus.DOWNLOADING_MODEL: {JobStatus.TRANSCRIBING},
    JobStatus.TRANSCRIBING: {JobStatus.DONE},
    JobStatus.DONE: {JobStatus.BURNING_SUBTITLES},
    JobStatus.BURNING_SUBTITLES: {JobStatus.BURNED},
    JobStatus.BURNED: set(),
    JobStatus.ERROR: set(),
}

_ACTIVE_STATUSES = {
    JobStatus.QUEUED,
    JobStatus.EXTRACTING_AUDIO,
    JobStatus.DOWNLOADING_MODEL,
    JobStatus.TRANSCRIBING,
    JobStatus.BURNING_SUBTITLES,
}


@dataclass
class Job:
    id: str
    status: JobStatus = JobStatus.QUEUED
    progress: float = 0.0
    stage_label: str = "En cola"
    error: str | None = None
    srt_ready: bool = False
    video_ready: bool = False
    # Set right after creation by the upload route - kept on the Job itself
    # so later requests (burn, download) never have to re-derive a path
    # from job_id + settings, just read it straight off the job.
    video_path: Path | None = None
    srt_path: Path | None = None
    captioned_path: Path | None = None


class JobConflictError(Exception):
    """Raised when a new job is requested while one is already active."""


class InvalidTransitionError(Exception):
    """Raised when a job tries to move to a status unreachable from its current one."""


class UnknownJobError(Exception):
    """Raised when an operation targets a job_id that doesn't match the current job."""


class JobStore:
    """Holds at most one job at a time - see module docstring for why."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._job: Job | None = None

    def create(self) -> Job:
        with self._lock:
            if self._job is not None and self._job.status in _ACTIVE_STATUSES:
                raise JobConflictError("Ya hay un trabajo en curso.")
            job = Job(id=str(uuid.uuid4()))
            self._job = job
            return job

    def get(self, job_id: str) -> Job:
        with self._lock:
            if self._job is None or self._job.id != job_id:
                raise UnknownJobError(job_id)
            return self._job

    def update(self, job_id: str, **fields: object) -> Job:
        """Updates arbitrary Job fields (progress, stage_label, error, srt_ready, video_ready, *_path).

        Doesn't change status - use transition() for that.
        """
        with self._lock:
            if self._job is None or self._job.id != job_id:
                raise UnknownJobError(job_id)
            for key, value in fields.items():
                setattr(self._job, key, value)
            return self._job

    def transition(self, job_id: str, new_status: JobStatus) -> Job:
        with self._lock:
            if self._job is None or self._job.id != job_id:
                raise UnknownJobError(job_id)
            current = self._job.status
            allowed = new_status == JobStatus.ERROR or new_status in _TRANSITIONS.get(current, set())
            if not allowed:
                raise InvalidTransitionError(f"No se puede pasar de {current.value} a {new_status.value}.")
            self._job.status = new_status
            return self._job
