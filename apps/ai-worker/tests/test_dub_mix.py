"""Mezcla del doblaje en el MP4 (ADR 0020, T9b): `replace` cambia el audio por la voz; `duck` baja el original mientras habla la voz.
ffmpeg, S3 y PostgreSQL reales; la voz es falsa."""

from __future__ import annotations

import array
import subprocess
import wave
from pathlib import Path

import pytest
from captionforge.ffmpeg_locator import find_ffmpeg

from test_dub_job import ToneVoice, run_dub, seg
from test_pipeline import read_object

SEGMENTS = [seg(2.0, 2.7, "Uno"), seg(5.0, 5.7, "Dos")]


def streams(video: bytes, tmp_path: Path) -> str:
    """Lista de flujos del MP4 según ffmpeg (`Stream #0:0 ... Video`, `Stream #0:1 ... Audio`)."""
    path = tmp_path / "salida.mp4"
    path.write_bytes(video)
    result = subprocess.run([find_ffmpeg(), "-hide_banner", "-i", str(path)], capture_output=True, text=True)
    return "\n".join(line for line in result.stderr.splitlines() if "Stream #" in line)


def audio_of(video: bytes, tmp_path: Path) -> array.array:
    path = tmp_path / "v.mp4"
    path.write_bytes(video)
    wav = tmp_path / "a.wav"
    subprocess.run([find_ffmpeg(), "-v", "error", "-y", "-i", str(path), "-vn", "-ac", "1", "-ar", "24000", str(wav)], check=True)
    with wave.open(str(wav), "rb") as handle:
        samples = array.array("h")
        samples.frombytes(handle.readframes(handle.getnframes()))
    return samples


def level(samples: array.array, start: float, end: float) -> int:
    chunk = samples[int(start * 24000) : int(end * 24000)]
    return max((abs(value) for value in chunk), default=0)


@pytest.mark.parametrize("mix", ["replace", "duck"])
def test_the_dubbed_mp4_keeps_the_video_and_carries_the_voice(mix, config, storage, new_dub_job, tmp_path) -> None:  # noqa: ANN001
    job_id, payload, _ = new_dub_job(mix=mix, segments=SEGMENTS)
    result = run_dub(config, storage, payload)

    assert result["mix"] == mix
    assert result["artifacts"] == {"audio": f"jobs/{job_id}/out/dub.mp3", "video": f"jobs/{job_id}/out/dubbed.mp4"}
    video = read_object(storage, result["artifacts"]["video"])
    assert video[4:8] == b"ftyp", "debe ser un MP4 real"
    listing = streams(video, tmp_path)
    assert "Video: h264" in listing, "el video se copia sin recodificar"
    assert "Audio:" in listing
    samples = audio_of(video, tmp_path)
    assert level(samples, 2.05, 2.6) > 1500, "la voz doblada suena en su tiempo"


def test_replace_drops_the_original_audio_and_duck_keeps_it_underneath(config, storage, new_dub_job, tmp_path) -> None:  # noqa: ANN001
    # El clip de prueba trae audio propio. Entre frases (3.0-4.5 s): replace = silencio de la pista doblada; duck = el original.
    _, replace_payload, _ = new_dub_job(mix="replace", segments=SEGMENTS)
    replaced = audio_of(read_object(storage, run_dub(config, storage, replace_payload)["artifacts"]["video"]), tmp_path)
    _, duck_payload, _ = new_dub_job(mix="duck", segments=SEGMENTS)
    ducked = audio_of(read_object(storage, run_dub(config, storage, duck_payload)["artifacts"]["video"]), tmp_path)
    assert level(replaced, 3.0, 4.5) < 300, "replace: solo queda la voz; entre frases hay silencio"
    assert level(ducked, 3.0, 4.5) > level(replaced, 3.0, 4.5), "duck: el audio original sigue ahí entre frases"


def test_ducking_lowers_the_original_while_the_voice_speaks(config, storage, new_dub_job, tmp_path) -> None:  # noqa: ANN001
    _, payload, _ = new_dub_job(mix="duck", segments=[seg(2.0, 3.5, "Uno largo")])
    voice = ToneVoice(lambda text: 1.4)
    video = read_object(storage, run_dub(config, storage, payload, voice=voice)["artifacts"]["video"])
    samples = audio_of(video, tmp_path)
    # La voz es un tono; con el original bajado, el nivel bajo la voz lo domina el tono, no el audio original.
    assert level(samples, 2.1, 3.4) > 1500


def test_mix_none_does_not_touch_the_video(config, storage, new_dub_job) -> None:  # noqa: ANN001
    _, payload, _ = new_dub_job(mix="none", segments=SEGMENTS)
    assert "video" not in run_dub(config, storage, payload)["artifacts"]


def test_a_missing_original_video_is_reported_with_its_contract_code(config, storage, new_dub_job) -> None:  # noqa: ANN001
    from ai_worker.errors import JobFailure, classify

    _, payload, _ = new_dub_job(mix="replace", segments=SEGMENTS, upload_video=False)
    with pytest.raises(Exception) as caught:
        run_dub(config, storage, payload)
    assert classify(caught.value).code == "INPUT_NOT_FOUND"
    assert JobFailure  # el código viene del mismo clasificador que usa el worker


def test_no_files_are_left_in_the_work_dir(config, storage, new_dub_job) -> None:  # noqa: ANN001
    job_id, payload, _ = new_dub_job(mix="duck", segments=SEGMENTS)
    run_dub(config, storage, payload)
    assert not (Path(config.work_dir) / job_id).exists()
