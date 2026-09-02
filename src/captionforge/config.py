"""Runtime configuration - where job files live, and server defaults."""

from __future__ import annotations

import tempfile
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Settings:
    jobs_dir: Path = field(default_factory=lambda: Path(tempfile.gettempdir()) / "captionforge-jobs")
    default_model_size: str = "small"
    host: str = "127.0.0.1"
    port: int = 8420
