"""DubRunner (ADR 0020, T9): sintetiza la voz de cada segmento, la ajusta a su tiempo y arma dub.mp3 (y, en T9b, el MP4 mezclado).
ffmpeg, S3 y PostgreSQL reales; la voz es falsa pero entrega MP3 reales (tonos generados con ffmpeg) de la duración que cada prueba pide."""

from __future__ import annotations

import array
import asyncio
import json
import subprocess
import threading
import wave
from collections.abc import Callable
from pathlib import Path

import pytest
from captionforge.ffmpeg_locator import find_ffmpeg
from captionforge_contracts import DubJob, DubResult

from ai_worker.adapters import Adapters
from ai_worker.db import JobRepository
from ai_worker.errors import JobCancelled, JobFailure
from ai_worker.dub import DubRunner
from ai_worker.progress import DUB_STAGE_RANGES, Progress

from test_pipeline import read_object

_TONES: dict[float, bytes] = {}


def tone_mp3(seconds: float) -> bytes:
    """Un MP3 real de `seconds` segundos (un tono)."""
    if seconds not in _TONES:
        out = subprocess.run(
            [find_ffmpeg(), "-v", "error", "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}", "-ac", "1", "-ar", "24000", "-f", "mp3", "-"],
            capture_output=True,
            check=True,
        )
        _TONES[seconds] = out.stdout
    return _TONES[seconds]


class ToneVoice:
    """Voz falsa: cada texto dura lo que diga `seconds_for(texto)`. Recuerda qué se le pidió."""

    def __init__(self, seconds_for: Callable[[str], float] = lambda text: 0.5, fail_on_call: int | None = None) -> None:
        self.seconds_for = seconds_for
        self.fail_on_call = fail_on_call
        self.calls: list[tuple[str, str]] = []

    async def synthesize(self, text: str, voice: str) -> bytes:
        self.calls.append((text, voice))
        if self.fail_on_call is not None and len(self.calls) == self.fail_on_call:
            raise JobFailure("EXTERNAL_QUOTA_EXCEEDED", "El proveedor indica que no hay saldo.")
        return tone_mp3(self.seconds_for(text))


def seg(start: float, end: float, text: str) -> dict:
    return {"start": start, "end": end, "text": text, "words": None}


def run_dub(config, storage, payload, *, voice=None, cancel=None, runner_config=None):  # noqa: ANN001
    repo = JobRepository(config.database_url)
    voice = voice or ToneVoice()
    adapters = Adapters(None, voices={payload["options"]["provider"]: voice})
    runner = DubRunner(runner_config or config, storage, adapters)
    model = DubJob.model_validate_json(json.dumps(payload), strict=True)
    cancel = cancel or threading.Event()

    async def go():
        assert await repo.claim(payload["jobId"])
        progress = Progress(repo, payload["jobId"], asyncio.get_running_loop(), min_interval=0.0, ranges=DUB_STAGE_RANGES)
        return await runner.run(model, progress, cancel)

    try:
        return asyncio.run(go())
    finally:
        repo.close()


def decode(mp3: bytes, tmp_path: Path) -> tuple[float, array.array]:
    """(duración en s, muestras) de un MP3."""
    source = tmp_path / "in.mp3"
    source.write_bytes(mp3)
    target = tmp_path / "out.wav"
    subprocess.run([find_ffmpeg(), "-v", "error", "-y", "-i", str(source), "-ac", "1", "-ar", "24000", str(target)], check=True)
    with wave.open(str(target), "rb") as wav:
        samples = array.array("h")
        samples.frombytes(wav.readframes(wav.getnframes()))
        return wav.getnframes() / wav.getframerate(), samples


def loudness(samples: array.array, start: float, end: float) -> int:
    chunk = samples[int(start * 24000) : int(end * 24000)]
    return max((abs(value) for value in chunk), default=0)


def test_builds_dub_mp3_with_each_phrase_at_its_time(config, storage, new_dub_job, tmp_path) -> None:  # noqa: ANN001
    job_id, payload, _ = new_dub_job(segments=[seg(1.0, 1.7, "Uno"), seg(2.0, 2.7, "Dos"), seg(3.0, 3.7, "Tres")])
    result = run_dub(config, storage, payload)

    DubResult.model_validate_json(json.dumps(result), strict=True)
    assert result["provider"] == "openai" and result["mix"] == "none" and result["segmentCount"] == 3
    assert result["overflowSegments"] == [] and result["characters"] == len("UnoDosTres")
    assert result["artifacts"] == {"audio": f"jobs/{job_id}/out/dub.mp3"}
    mp3 = read_object(storage, result["artifacts"]["audio"])
    assert mp3[:3] == b"ID3" or mp3[0] == 0xFF, "debe ser un MP3 real"
    duration, samples = decode(mp3, tmp_path)
    assert 3.4 <= duration <= 3.7, "termina cuando acaba la última frase"
    assert loudness(samples, 0.0, 0.9) < 300, "silencio antes de la primera frase"
    assert loudness(samples, 1.05, 1.4) > 1500, "la primera frase suena en su tiempo"
    assert loudness(samples, 1.75, 1.95) < 600, "silencio entre frases"
    assert loudness(samples, 3.05, 3.4) > 1500, "la tercera frase suena en su tiempo"


def test_a_phrase_slightly_too_long_is_sped_up_to_fit_its_slot(config, storage, new_dub_job, tmp_path) -> None:  # noqa: ANN001
    _, payload, _ = new_dub_job(segments=[seg(0.0, 0.8, "Larga"), seg(1.0, 1.8, "Siguiente")])
    result = run_dub(config, storage, payload, voice=ToneVoice(lambda text: 1.0 if text == "Larga" else 0.5))
    assert result["overflowSegments"] == []
    duration, _ = decode(read_object(storage, result["artifacts"]["audio"]), tmp_path)
    assert 1.45 <= duration <= 1.7, "1,0 s acelerado a 1,25x = 0,8 s; la siguiente empieza en 1,0 y dura 0,5"


def test_a_short_phrase_is_slowed_down_but_never_below_the_floor(config, storage, new_dub_job, tmp_path) -> None:  # noqa: ANN001
    _, payload, _ = new_dub_job(segments=[seg(0.0, 3.0, "Corta")])
    result = run_dub(config, storage, payload, voice=ToneVoice(lambda text: 1.0))
    duration, _ = decode(read_object(storage, result["artifacts"]["audio"]), tmp_path)
    assert 1.1 <= duration <= 1.35, "1,0 s a 0,85x = 1,18 s: no se estira hasta llenar los 3 s"


def test_a_phrase_that_cannot_fit_even_at_max_speed_is_reported_and_the_next_one_waits(config, storage, new_dub_job, tmp_path) -> None:  # noqa: ANN001
    _, payload, _ = new_dub_job(segments=[seg(0.0, 0.5, "Muy larga"), seg(0.6, 1.1, "Pegada"), seg(3.0, 3.5, "Lejana")])
    result = run_dub(config, storage, payload, voice=ToneVoice(lambda text: 2.0 if text == "Muy larga" else 0.5))
    assert result["overflowSegments"] == [0], "se avisa del segmento que no cupo"
    duration, samples = decode(read_object(storage, result["artifacts"]["audio"]), tmp_path)
    # 2,0 s a 1,25x = 1,6 s; la siguiente no se solapa: empieza al terminar (1,6 s). La tercera sigue en su sitio (3,0 s).
    assert loudness(samples, 1.7, 2.0) > 1500, "la segunda frase suena DESPUÉS de la primera, sin pisarla"
    assert loudness(samples, 3.05, 3.4) > 1500, "el desborde se absorbe en el silencio siguiente: la tercera mantiene su tiempo"
    assert 3.4 <= duration <= 3.7


def test_blank_segments_are_not_sent_to_the_provider(config, storage, new_dub_job) -> None:  # noqa: ANN001
    _, payload, _ = new_dub_job(segments=[seg(0.0, 0.7, "Hola"), seg(1.0, 1.5, "   "), seg(2.0, 2.7, "Adiós")])
    voice = ToneVoice()
    result = run_dub(config, storage, payload, voice=voice)
    assert [text for text, _ in voice.calls] == ["Hola", "Adiós"]
    assert result["segmentCount"] == 3 and result["characters"] == len("HolaAdiós")


def test_the_requested_voice_reaches_the_provider(config, storage, new_dub_job) -> None:  # noqa: ANN001
    _, payload, _ = new_dub_job(voice="nova")
    voice = ToneVoice()
    run_dub(config, storage, payload, voice=voice)
    assert {name for _, name in voice.calls} == {"nova"}


def test_segments_edited_after_the_request_fail_with_segments_changed(config, storage, new_dub_job, tmp_path) -> None:  # noqa: ANN001
    _, payload, _ = new_dub_job()
    edited = tmp_path / "otro.json"
    edited.write_text("[]")
    storage.upload_file(edited, payload["segments"]["objectKey"], "application/json")
    voice = ToneVoice()
    with pytest.raises(JobFailure) as caught:
        run_dub(config, storage, payload, voice=voice)
    assert caught.value.code == "SEGMENTS_CHANGED" and voice.calls == []


def test_a_job_over_the_spending_caps_fails_before_calling_the_provider(config, storage, new_dub_job) -> None:  # noqa: ANN001
    import dataclasses

    voice = ToneVoice()
    for caps in ({"max_job_segments": 1}, {"max_job_characters": 3}):
        _, payload, _ = new_dub_job()
        with pytest.raises(JobFailure) as caught:
            run_dub(config, storage, payload, voice=voice, runner_config=dataclasses.replace(config, **caps))
        assert caught.value.code == "JOB_TOO_LARGE"
    assert voice.calls == [], "no se gasta nada si el trabajo ya excede el tope"


def test_a_segment_too_long_for_the_provider_is_refused_before_spending(config, storage, new_dub_job) -> None:  # noqa: ANN001
    _, payload, _ = new_dub_job(segments=[seg(0.0, 2.0, "Hola"), seg(2.0, 4.0, "x" * 4500)])
    voice = ToneVoice()
    with pytest.raises(JobFailure) as caught:
        run_dub(config, storage, payload, voice=voice)
    assert caught.value.code == "JOB_TOO_LARGE" and voice.calls == []


def test_a_provider_failure_midway_is_controlled_and_leaves_no_files(config, storage, new_dub_job) -> None:  # noqa: ANN001
    job_id, payload, _ = new_dub_job()
    with pytest.raises(JobFailure) as caught:
        run_dub(config, storage, payload, voice=ToneVoice(fail_on_call=2))
    assert caught.value.code == "EXTERNAL_QUOTA_EXCEEDED"
    assert not (Path(config.work_dir) / job_id).exists()


def test_cancelling_stops_between_phrases_and_cleans_up(config, storage, new_dub_job) -> None:  # noqa: ANN001
    job_id, payload, _ = new_dub_job()
    cancel = threading.Event()

    class CancelsAfterFirst(ToneVoice):
        async def synthesize(self, text: str, voice: str) -> bytes:
            cancel.set()
            return await super().synthesize(text, voice)

    voice = CancelsAfterFirst()
    with pytest.raises(JobCancelled):
        run_dub(config, storage, payload, voice=voice, cancel=cancel)
    assert len(voice.calls) == 1
    assert not (Path(config.work_dir) / job_id).exists()
