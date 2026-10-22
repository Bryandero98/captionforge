"""Configuración del worker, leída del entorno y validada al arrancar."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

from .diarization import resolve_hf_token

TRANSCRIBE_QUEUE = "captionforge.transcribe"
BURN_QUEUE = "captionforge.burn"
CANCEL_CHANNEL = "captionforge:cancel"


class ConfigError(ValueError):
    """Falta o es inválida una variable de entorno."""


@dataclass(frozen=True)
class WorkerConfig:
    redis_host: str
    redis_port: int
    redis_password: str
    database_url: str
    s3_endpoint: str
    s3_region: str
    s3_bucket: str
    s3_access_key: str
    s3_secret_key: str
    work_dir: Path
    queue_name: str = TRANSCRIBE_QUEUE
    burn_queue_name: str = BURN_QUEUE
    cancel_channel: str = CANCEL_CHANNEL
    concurrency: int = 1
    # El candado se renueva cada mitad de este tiempo; Whisper y ffmpeg corren fuera del bucle de
    # eventos (ADR 0006), así que se renueva aunque un segmento tarde minutos.
    lock_duration_ms: int = 60_000
    # Cada cuánto busca BullMQ trabajos cuyo candado venció (un worker que murió a mitad).
    stalled_interval_ms: int = 30_000
    # Latido del trabajo en curso: el recolector del API cierra los RUNNING sin cambios durante 20 min, y hay
    # etapas largas que no informan progreso (descargar 4 GiB, traducir miles de segmentos).
    heartbeat_seconds: float = 60.0
    # Al recibir SIGTERM se deja este tiempo al trabajo en curso; pasado, se cierra como fallido. Debe ser menor que
    # el stop_grace_period del contenedor, o Docker mata el proceso antes de poder escribir el estado.
    shutdown_grace_seconds: float = 45.0
    ffmpeg_stall_timeout: float = 300.0
    ffmpeg_total_timeout: float = 6 * 3600.0
    # Separación de voz (subproceso): sin ninguna señal de vida en este tiempo se da por colgada y se continúa con el audio original.
    separation_stall_timeout: float = 300.0
    separation_total_timeout: float = 3600.0
    # Identificar hablantes (subproceso): misma política que la separación. En CPU la inferencia tarda varias veces la
    # duración del audio, por eso los topes son más holgados.
    diarization_stall_timeout: float = 600.0
    diarization_total_timeout: float = 7200.0
    # Token de Hugging Face (HF_TOKEN o HF_TOKEN_FILE). repr=False: nunca debe salir en un log ni en un traceback.
    hf_token: str | None = field(default=None, repr=False)

    @property
    def redis_connection(self) -> dict[str, object]:
        return {"host": self.redis_host, "port": self.redis_port, "password": self.redis_password}

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> WorkerConfig:
        env = os.environ if env is None else env

        def need(name: str) -> str:
            value = env.get(name)
            if not value:
                raise ConfigError(f"Falta la variable de entorno {name}")
            return value

        def number(name: str, default: float, *, integer: bool = False) -> float:
            raw = env.get(name)
            if raw is None or raw == "":
                return default
            try:
                value = int(raw) if integer else float(raw)
            except ValueError:
                raise ConfigError(f"{name} debe ser un número (recibido {raw!r})") from None
            if value <= 0:
                raise ConfigError(f"{name} debe ser positivo (recibido {raw!r})")
            return value

        return cls(
            redis_host=need("REDIS_HOST"),
            redis_port=int(number("REDIS_PORT", 6379, integer=True)),
            redis_password=need("REDIS_PASSWORD"),
            database_url=need("DATABASE_URL"),
            s3_endpoint=need("S3_ENDPOINT"),
            s3_region=env.get("S3_REGION", "us-east-1"),
            s3_bucket=need("S3_BUCKET"),
            s3_access_key=need("S3_ACCESS_KEY"),
            s3_secret_key=need("S3_SECRET_KEY"),
            work_dir=Path(env.get("WORK_DIR", "") or "work"),
            concurrency=int(number("WORKER_CONCURRENCY", 1, integer=True)),
            lock_duration_ms=int(number("LOCK_DURATION_MS", 60_000, integer=True)),
            stalled_interval_ms=int(number("STALLED_INTERVAL_MS", 30_000, integer=True)),
            heartbeat_seconds=number("HEARTBEAT_SECONDS", 60.0),
            shutdown_grace_seconds=number("SHUTDOWN_GRACE_SECONDS", 45.0),
            ffmpeg_stall_timeout=number("FFMPEG_STALL_TIMEOUT_SECONDS", 300.0),
            ffmpeg_total_timeout=number("FFMPEG_TOTAL_TIMEOUT_SECONDS", 6 * 3600.0),
            separation_stall_timeout=number("SEPARATION_STALL_TIMEOUT_SECONDS", 300.0),
            separation_total_timeout=number("SEPARATION_TOTAL_TIMEOUT_SECONDS", 3600.0),
            diarization_stall_timeout=number("DIARIZATION_STALL_TIMEOUT_SECONDS", 600.0),
            diarization_total_timeout=number("DIARIZATION_TOTAL_TIMEOUT_SECONDS", 7200.0),
            hf_token=resolve_hf_token(env),
        )
