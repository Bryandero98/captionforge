"""Audio puro como entrada (Issue #14, Fase 2): MP3, WAV, M4A, OGG y FLAC se transcriben sin pasos de video; el quemado y la mezcla
del doblaje, que necesitan imagen, se rechazan con un código claro. ffmpeg, S3 y PostgreSQL reales; Whisper y la voz, falsos."""

from __future__ import annotations

import asyncio
import json
import subprocess
from pathlib import Path

import pytest
from captionforge.ffmpeg_locator import find_ffmpeg
from captionforge_contracts import TranscribeResult

from ai_worker.audio import has_audio_stream, has_video_stream
from ai_worker.errors import JobFailure, classify

from conftest import CLIP
from test_burn import run_burn
from test_dub_job import ToneVoice, run_dub, seg
from test_pipeline import read_object, run_job

#: extensión -> (tipo MIME que informa el navegador, codificador de ffmpeg)
FORMATS = {
    "mp3": ("audio/mpeg", ["-c:a", "libmp3lame"]),
    "wav": ("audio/wav", ["-c:a", "pcm_s16le"]),
    "m4a": ("audio/mp4", ["-c:a", "aac"]),
    "ogg": ("audio/ogg", ["-c:a", "libvorbis"]),
    "flac": ("audio/flac", ["-c:a", "flac"]),
}


def make_audio(directory: Path, extension: str) -> Path:
    """Dos segundos de tono en el formato pedido, hechos con el ffmpeg real."""
    target = directory / f"voz.{extension}"
    subprocess.run(
        [find_ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", *FORMATS[extension][1], str(target)],
        check=True,
    )
    return target


def audio_job(new_job, storage, tmp_path: Path, extension: str) -> tuple[str, dict]:  # noqa: ANN001
    """Un trabajo de transcripción como lo crearía el API con un archivo de audio: clave con su extensión y su tipo."""
    job_id, payload = new_job(upload_input=False, filename=f"podcast.{extension}")
    key = f"jobs/{job_id}/input.{extension}"
    path = make_audio(tmp_path, extension)
    storage.upload_file(path, key, FORMATS[extension][0])
    payload["input"].update(objectKey=key, originalFilename=f"podcast.{extension}", contentType=FORMATS[extension][0], sizeBytes=path.stat().st_size)
    return job_id, payload


@pytest.mark.parametrize("extension", sorted(FORMATS))
def test_an_audio_only_file_is_transcribed_like_a_video(extension, config, storage, fake_models, new_job, tmp_path) -> None:  # noqa: ANN001
    job_id, payload = audio_job(new_job, storage, tmp_path, extension)
    result = run_job(config, storage, fake_models, payload)

    TranscribeResult.model_validate_json(json.dumps(result), strict=True)
    assert result["jobId"] == job_id and result["segmentCount"] == 3
    assert json.loads(read_object(storage, result["artifacts"]["waveform"]))["duration"] > 0
    assert b"-->" in read_object(storage, result["artifacts"]["srt"])
    assert not (Path(config.work_dir) / job_id).exists()


def test_an_audio_file_that_is_not_audio_maps_to_ffmpeg_failed(config, storage, fake_models, new_job, tmp_path) -> None:  # noqa: ANN001
    job_id, payload = new_job(upload_input=False)
    junk = tmp_path / "falso.mp3"
    junk.write_bytes(b"esto no es un mp3" * 100)
    key = f"jobs/{job_id}/input.mp3"
    storage.upload_file(junk, key, "audio/mpeg")
    payload["input"].update(objectKey=key, contentType="audio/mpeg")
    with pytest.raises(Exception) as caught:  # noqa: PT011
        run_job(config, storage, fake_models, payload)
    assert classify(caught.value).code == "FFMPEG_FAILED"


def test_stream_detection_tells_audio_from_video(tmp_path) -> None:  # noqa: ANN001
    mp3 = make_audio(tmp_path, "mp3")
    assert asyncio.run(has_audio_stream(mp3)) is True
    assert asyncio.run(has_video_stream(mp3)) is False
    assert asyncio.run(has_video_stream(CLIP)) is True


def test_burning_subtitles_onto_an_audio_file_is_refused_with_a_clear_code(config, storage, new_burn_job, tmp_path) -> None:  # noqa: ANN001
    job_id, payload, _ = new_burn_job()
    storage.upload_file(make_audio(tmp_path, "mp3"), payload["input"]["objectKey"], "audio/mpeg")
    with pytest.raises(JobFailure) as caught:
        run_burn(config, storage, payload)
    failure = classify(caught.value)
    assert failure.code == "BURN_NEEDS_VIDEO"
    assert "audio" in failure.message.lower() and str(tmp_path) not in failure.message
    assert not (Path(config.work_dir) / job_id).exists()


@pytest.mark.parametrize("mix", ["replace", "duck"])
def test_mixing_a_dub_into_an_audio_file_is_refused_before_spending(mix, config, storage, new_dub_job, tmp_path) -> None:  # noqa: ANN001
    _, payload, _ = new_dub_job(mix=mix, segments=[seg(0.0, 0.7, "Uno")])
    storage.upload_file(make_audio(tmp_path, "mp3"), payload["input"]["objectKey"], "audio/mpeg")
    voice = ToneVoice()
    with pytest.raises(JobFailure) as caught:
        run_dub(config, storage, payload, voice=voice)
    assert classify(caught.value).code == "MIX_NEEDS_VIDEO"
    assert voice.calls == [], "no se pide nada al proveedor si la mezcla no se puede hacer"


def test_dubbing_an_audio_file_without_mix_delivers_only_the_mp3(config, storage, new_dub_job, tmp_path) -> None:  # noqa: ANN001
    _, payload, _ = new_dub_job(mix="none", segments=[seg(0.0, 0.7, "Uno"), seg(1.0, 1.7, "Dos")])
    storage.upload_file(make_audio(tmp_path, "wav"), payload["input"]["objectKey"], "audio/wav")
    result = run_dub(config, storage, payload)
    assert result["mix"] == "none" and list(result["artifacts"]) == ["audio"]
    assert result["artifacts"]["audio"].endswith(".mp3")
    track = read_object(storage, result["artifacts"]["audio"])
    assert track[:3] == b"ID3" or track[0] == 0xFF, "debe ser un MP3 real"
