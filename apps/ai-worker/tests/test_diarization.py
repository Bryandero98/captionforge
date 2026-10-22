"""Identificar quién habla: asignación de hablantes a los segmentos (lógica pura), token, subproceso y protocolo del hijo.

Nada de esto carga pyannote: la inferencia real se mide en el benchmark. Aquí se comprueba la mecánica y la
política: partir por palabras, el respaldo y que el token nunca viaje por argumentos ni acabe en un mensaje."""

from __future__ import annotations

import asyncio
import json
import sys
import textwrap
from pathlib import Path

import pytest
from captionforge.srt import Segment, WordTiming, segment_from_dict, segment_to_dict

from ai_worker import diarize_cli
from ai_worker.diarization import (
    DiarizationFailed,
    DiarizationUnavailable,
    SubprocessDiarizer,
    Turn,
    assign_speakers,
    resolve_hf_token,
)


def word(start: float, end: float, text: str) -> WordTiming:
    return WordTiming(start=start, end=end, text=text, probability=0.9)


def segment(start: float, end: float, text: str, words: list[WordTiming] | None = None) -> Segment:
    return Segment(start=start, end=end, text=text, words=words)


# ---------- Segment.speaker en el formato heredado ----------


def test_a_segment_without_speaker_serializes_exactly_as_before() -> None:
    assert "speaker" not in segment_to_dict(segment(0, 1, "hola"))
    assert segment_from_dict({"start": 0, "end": 1, "text": "hola", "words": None}).speaker is None


def test_the_speaker_round_trips_through_segments_json() -> None:
    original = Segment(start=0, end=1, text="hola", speaker="SPEAKER_01")
    assert segment_to_dict(original)["speaker"] == "SPEAKER_01"
    assert segment_from_dict(segment_to_dict(original)) == original


# ---------- assign_speakers ----------


def test_a_segment_inside_one_turn_keeps_its_text_and_timing_and_gets_the_speaker() -> None:
    segs = [segment(1, 4, " Hola a todos", [word(1, 2, " Hola"), word(2, 3, " a"), word(3, 4, " todos")])]
    out = assign_speakers(segs, [Turn(0, 5, "SPEAKER_07")])
    assert len(out) == 1
    assert (out[0].start, out[0].end, out[0].text, out[0].words) == (1, 4, " Hola a todos", segs[0].words)
    assert out[0].speaker == "SPEAKER_01"  # se renombra por orden de aparición en la transcripción


def test_a_segment_crossing_a_speaker_change_is_split_by_words() -> None:
    words = [word(0, 1, " Buenos"), word(1, 2, " días."), word(2.2, 3, " Gracias,"), word(3, 4, " igualmente.")]
    segs = [segment(0, 4, " Buenos días. Gracias, igualmente.", words)]
    out = assign_speakers(segs, [Turn(0, 2.1, "A"), Turn(2.1, 4, "B")])
    assert [(s.speaker, s.text.strip(), s.start, s.end) for s in out] == [
        ("SPEAKER_01", "Buenos días.", 0, 2),
        ("SPEAKER_02", "Gracias, igualmente.", 2.2, 4),
    ]
    assert out[1].words == words[2:]


def test_speakers_are_numbered_by_first_appearance_in_the_transcript() -> None:
    segs = [segment(0, 1, "a", [word(0, 1, "a")]), segment(2, 3, "b", [word(2, 3, "b")]), segment(4, 5, "c", [word(4, 5, "c")])]
    turns = [Turn(0, 1.5, "Z"), Turn(1.5, 3.5, "A"), Turn(3.5, 6, "Z")]
    assert [s.speaker for s in assign_speakers(segs, turns)] == ["SPEAKER_01", "SPEAKER_02", "SPEAKER_01"]


def test_a_word_in_a_gap_between_turns_goes_to_the_nearest_turn() -> None:
    segs = [segment(0, 3, " uno dos", [word(0, 1, " uno"), word(1.9, 2.9, " dos")])]
    out = assign_speakers(segs, [Turn(0, 1, "A"), Turn(3, 5, "B")])
    assert [(s.speaker, s.text.strip()) for s in out] == [("SPEAKER_01", "uno"), ("SPEAKER_02", "dos")]


def test_without_word_timings_the_speaker_with_the_most_overlap_wins_and_nothing_is_split() -> None:
    segs = [segment(0, 10, " Todo junto"), segment(10, 12, " Otro")]
    out = assign_speakers(segs, [Turn(0, 3, "A"), Turn(3, 12, "B")])
    assert [(s.text, s.speaker) for s in out] == [(" Todo junto", "SPEAKER_01"), (" Otro", "SPEAKER_01")]  # B gana en ambos
    out = assign_speakers(segs, [Turn(0, 3, "A"), Turn(3, 10, "B"), Turn(10, 12, "A")])
    assert [s.speaker for s in out] == ["SPEAKER_01", "SPEAKER_02"]


def test_without_turns_nothing_changes() -> None:
    segs = [segment(0, 1, "a", [word(0, 1, "a")])]
    assert assign_speakers(segs, []) == segs


def test_overlapping_speech_picks_the_speaker_covering_most_of_the_word() -> None:
    segs = [segment(0, 2, " ya", [word(0, 2, " ya")])]
    out = assign_speakers(segs, [Turn(0, 0.5, "A"), Turn(0.4, 2, "B")])
    assert len(out) == 1 and out[0].speaker == "SPEAKER_01"


# ---------- token ----------


def test_the_token_comes_from_the_environment_first() -> None:
    assert resolve_hf_token({"HF_TOKEN": " hf_abc123 ", "HF_TOKEN_FILE": "/no/existe"}) == "hf_abc123"


def test_the_token_can_come_from_a_file_as_bare_token_or_env_line(tmp_path: Path) -> None:
    bare = tmp_path / "bare.txt"
    bare.write_text("hf_barefile000\n", encoding="utf-8")
    assert resolve_hf_token({"HF_TOKEN_FILE": str(bare)}) == "hf_barefile000"
    for line in ("HF_TOKEN=hf_envline111", 'export HF_TOKEN="hf_envline111"', "# comentario\nHF_TOKEN='hf_envline111'\nOTRA=x"):
        path = tmp_path / "t.env"
        path.write_text(line + "\n", encoding="utf-8")
        assert resolve_hf_token({"HF_TOKEN_FILE": str(path)}) == "hf_envline111", line


def test_without_a_usable_token_there_is_none(tmp_path: Path) -> None:
    assert resolve_hf_token({}) is None
    assert resolve_hf_token({"HF_TOKEN": "   "}) is None
    assert resolve_hf_token({"HF_TOKEN_FILE": str(tmp_path / "no-existe")}) is None
    empty = tmp_path / "vacio"
    empty.write_text("\n", encoding="utf-8")
    assert resolve_hf_token({"HF_TOKEN_FILE": str(empty)}) is None


# ---------- SubprocessDiarizer ----------


def child(tmp_path: Path, body: str) -> list[str]:
    script = tmp_path / "hijo.py"
    script.write_text(textwrap.dedent(body), encoding="utf-8")
    return [sys.executable, str(script)]


def make(tmp_path: Path, body: str, *, token: str | None = "hf_secretotoken123", stall: float = 5.0, total: float = 20.0) -> SubprocessDiarizer:
    return SubprocessDiarizer(token=token, command=child(tmp_path, body), stall_timeout=stall, total_timeout=total)


async def noop(stage: str, fraction: float) -> None:
    return None


def audio(tmp_path: Path) -> Path:
    path = tmp_path / "audio.wav"
    path.write_bytes(b"RIFF")
    return path


def test_the_diarizer_returns_the_turns_and_reports_progress(tmp_path: Path) -> None:
    diarizer = make(
        tmp_path,
        """
        import json, sys
        print("PROGRESS downloading_diarization_model 1.0", flush=True)
        print("PROGRESS diarizing 0.5", flush=True)
        json.dump([{"start": 0.5, "end": 2.0, "speaker": "SPEAKER_01"}, {"start": 2.0, "end": 3.5, "speaker": "SPEAKER_00"}], open(sys.argv[2], "w"))
        print("PROGRESS diarizing 1.0", flush=True)
        """,
    )
    seen: list[tuple[str, float]] = []

    async def go() -> list[Turn]:
        async def report(stage: str, fraction: float) -> None:
            seen.append((stage, fraction))

        return await diarizer.diarize(audio(tmp_path), report)

    assert asyncio.run(go()) == [Turn(0.5, 2.0, "SPEAKER_01"), Turn(2.0, 3.5, "SPEAKER_00")]
    assert seen == [("downloading_diarization_model", 1.0), ("diarizing", 0.5), ("diarizing", 1.0)]


def test_the_token_travels_in_the_environment_never_in_the_arguments(tmp_path: Path) -> None:
    diarizer = make(
        tmp_path,
        """
        import json, os, sys
        assert "hf_secretotoken123" not in " ".join(sys.argv), "el token no puede ir en argv"
        json.dump([{"start": 0, "end": 1, "speaker": os.environ["HF_TOKEN"]}], open(sys.argv[2], "w"))
        """,
    )
    turns = asyncio.run(diarizer.diarize(audio(tmp_path), noop))
    assert turns[0].speaker == "hf_secretotoken123"  # el hijo SÍ lo recibe por entorno


def test_without_a_token_it_is_unavailable_and_no_child_is_started(tmp_path: Path) -> None:
    marker = tmp_path / "arranco.txt"
    diarizer = make(tmp_path, f"open(r'{marker}', 'w').write('x')", token=None)
    with pytest.raises(DiarizationUnavailable):
        asyncio.run(diarizer.diarize(audio(tmp_path), noop))
    assert not marker.exists()


def test_a_failing_child_raises_without_leaking_stderr_or_the_token(tmp_path: Path) -> None:
    diarizer = make(
        tmp_path,
        """
        import sys
        sys.stderr.write("Traceback C:/secreto/ruta hf_secretotoken123 401 Unauthorized")
        sys.exit(1)
        """,
    )
    with pytest.raises(DiarizationFailed) as raised:
        asyncio.run(diarizer.diarize(audio(tmp_path), noop))
    assert "secreto" not in str(raised.value) and "hf_" not in str(raised.value)


@pytest.mark.parametrize(
    "payload",
    ['"no es una lista"', '[{"start": "x", "end": 1, "speaker": "A"}]', '[{"start": 2, "end": 1, "speaker": "A"}]', '[{"start": 0, "end": 1}]', "{rota"],
)
def test_a_malformed_turns_file_is_a_failure(tmp_path: Path, payload: str) -> None:
    diarizer = make(tmp_path, f"open(__import__('sys').argv[2], 'w').write({payload!r})")
    with pytest.raises(DiarizationFailed):
        asyncio.run(diarizer.diarize(audio(tmp_path), noop))


def test_a_silent_child_is_killed_after_the_stall_timeout(tmp_path: Path) -> None:
    diarizer = make(tmp_path, "import time\ntime.sleep(60)", stall=3.0)
    with pytest.raises(DiarizationFailed):
        asyncio.run(diarizer.diarize(audio(tmp_path), noop))


# ---------- diarize_cli (hijo real, motor falso) ----------


def test_cli_wires_progress_and_writes_the_turns(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    source, target = tmp_path / "a.wav", tmp_path / "turnos.json"
    source.write_bytes(b"x")

    def engine(src: Path, emit) -> list[Turn]:  # noqa: ANN001
        emit("downloading_diarization_model", 1.0)
        emit("diarizing", 0.25)
        return [Turn(0.0, 1.0, "SPEAKER_00")]

    assert diarize_cli.main([str(source), str(target)], engine=engine) == 0
    assert capsys.readouterr().out.splitlines() == ["PROGRESS downloading_diarization_model 1.000", "PROGRESS diarizing 0.250"]
    assert json.loads(target.read_text(encoding="utf-8")) == [{"start": 0.0, "end": 1.0, "speaker": "SPEAKER_00"}]


def test_cli_failure_exits_nonzero_and_keeps_stdout_clean(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    def engine(src: Path, emit) -> list[Turn]:  # noqa: ANN001
        raise RuntimeError("boom")

    assert diarize_cli.main([str(tmp_path / "a.wav"), str(tmp_path / "t.json")], engine=engine) == 1
    captured = capsys.readouterr()
    assert "PROGRESS" not in captured.out and "boom" in captured.err


def test_cli_rejects_wrong_usage() -> None:
    assert diarize_cli.main([]) == 2
