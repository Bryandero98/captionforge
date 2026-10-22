"""Separador de voz por subproceso: protocolo de progreso, fallos, silencio (stall) y cancelación.

El hijo es un script de Python de prueba, no Demucs: lo que se comprueba es la MECÁNICA (arrancar, leer el
progreso, matar al hijo y que su memoria vuelva al sistema), que es lo que garantiza que Whisper y el modelo de
separación nunca convivan en la GPU. La inferencia real se mide en el benchmark, no en la CI."""

from __future__ import annotations

import asyncio
import sys
import textwrap
import time
from pathlib import Path

import pytest

from ai_worker.separation import SeparationFailed, SubprocessSeparator


def child(tmp_path: Path, body: str) -> list[str]:
    """Un hijo de prueba: recibe (entrada, salida) como argumentos, igual que el real."""
    script = tmp_path / "hijo.py"
    script.write_text(textwrap.dedent(body), encoding="utf-8")
    return [sys.executable, str(script)]


def make(tmp_path: Path, body: str, *, stall: float = 5.0, total: float = 20.0) -> SubprocessSeparator:
    return SubprocessSeparator(command=child(tmp_path, body), stall_timeout=stall, total_timeout=total)


def audio(tmp_path: Path) -> tuple[Path, Path]:
    source = tmp_path / "audio.wav"
    source.write_bytes(b"RIFF")
    return source, tmp_path / "vocals.wav"


async def noop(stage: str, fraction: float) -> None:
    return None


def test_reports_progress_lines_and_leaves_the_output(tmp_path: Path) -> None:
    source, target = audio(tmp_path)
    separator = make(
        tmp_path,
        """
        import sys
        print("PROGRESS downloading_separation_model 0.0", flush=True)
        print("PROGRESS downloading_separation_model 1.0", flush=True)
        print("PROGRESS separating_voice 0.5", flush=True)
        open(sys.argv[2], "wb").write(b"vocals")
        print("PROGRESS separating_voice 1.0", flush=True)
        """,
    )
    seen: list[tuple[str, float]] = []

    async def go() -> None:
        async def report(stage: str, fraction: float) -> None:
            seen.append((stage, fraction))

        await separator.separate(source, target, report)

    asyncio.run(go())
    assert target.read_bytes() == b"vocals"
    assert seen == [
        ("downloading_separation_model", 0.0),
        ("downloading_separation_model", 1.0),
        ("separating_voice", 0.5),
        ("separating_voice", 1.0),
    ]


def test_ignores_noise_on_stdout_and_unknown_stages(tmp_path: Path) -> None:
    source, target = audio(tmp_path)
    separator = make(
        tmp_path,
        """
        import sys
        print("cualquier cosa que imprima una biblioteca", flush=True)
        print("PROGRESS etapa_inventada 0.5", flush=True)
        print("PROGRESS separating_voice no-es-un-numero", flush=True)
        print("PROGRESS separating_voice 7", flush=True)
        open(sys.argv[2], "wb").write(b"v")
        """,
    )
    seen: list[tuple[str, float]] = []

    async def go() -> None:
        async def report(stage: str, fraction: float) -> None:
            seen.append((stage, fraction))

        await separator.separate(source, target, report)

    asyncio.run(go())
    assert seen == [("separating_voice", 1.0)]  # una fracción fuera de rango se recorta, el resto se descarta


def test_nonzero_exit_raises_without_leaking_the_child_stderr(tmp_path: Path) -> None:
    source, target = audio(tmp_path)
    separator = make(
        tmp_path,
        """
        import sys
        sys.stderr.write("Traceback secreto-ruta CUDA out of memory")
        sys.exit(3)
        """,
    )
    with pytest.raises(SeparationFailed) as raised:
        asyncio.run(separator.separate(source, target, noop))
    assert "secreto" not in str(raised.value) and "CUDA" not in str(raised.value)
    assert not target.exists()


def test_exit_zero_without_output_is_a_failure(tmp_path: Path) -> None:
    source, target = audio(tmp_path)
    separator = make(tmp_path, "print('PROGRESS separating_voice 1.0')")
    with pytest.raises(SeparationFailed):
        asyncio.run(separator.separate(source, target, noop))


def test_a_silent_child_is_killed_after_the_stall_timeout(tmp_path: Path) -> None:
    source, target = audio(tmp_path)
    marker = tmp_path / "vivo.txt"
    separator = make(
        tmp_path,
        f"""
        import time
        while True:
            open(r"{marker}", "a").write("x")
            time.sleep(0.05)
        """,
        stall=3.0,  # el arranque de Python bajo carga puede tardar más de un segundo: el margen evita una prueba intermitente
    )
    with pytest.raises(SeparationFailed):
        asyncio.run(separator.separate(source, target, noop))
    assert marker.exists(), "el hijo ni llegó a arrancar"
    size = marker.stat().st_size
    time.sleep(0.4)
    assert marker.stat().st_size == size, "el hijo sigue vivo tras el tiempo de silencio"


def test_cancelling_the_task_kills_the_child(tmp_path: Path) -> None:
    source, target = audio(tmp_path)
    marker = tmp_path / "vivo.txt"
    separator = make(
        tmp_path,
        f"""
        import time
        print("PROGRESS separating_voice 0.1", flush=True)
        while True:
            open(r"{marker}", "a").write("x")
            time.sleep(0.05)
        """,
        stall=30.0,
    )

    async def go() -> None:
        started = asyncio.Event()

        async def report(stage: str, fraction: float) -> None:
            started.set()

        task = asyncio.create_task(separator.separate(source, target, report))
        await asyncio.wait_for(started.wait(), 10)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(go())
    size = marker.stat().st_size
    time.sleep(0.4)
    assert marker.stat().st_size == size, "el hijo sobrevivió a la cancelación"


def test_missing_command_is_a_separation_failure_not_a_crash(tmp_path: Path) -> None:
    source, target = audio(tmp_path)
    separator = SubprocessSeparator(command=[str(tmp_path / "no-existe")], stall_timeout=2, total_timeout=5)
    with pytest.raises(SeparationFailed):
        asyncio.run(separator.separate(source, target, noop))


def test_the_real_child_without_demucs_installed_fails_cleanly(tmp_path: Path) -> None:
    """El hijo REAL (`python -m ai_worker.separate_cli`) sin demucs/torch en la CI: error limpio, nunca un cuelgue."""
    try:
        import demucs  # noqa: F401
    except ImportError:
        pass
    else:
        pytest.skip("este entorno sí tiene demucs")
    source, target = audio(tmp_path)
    separator = SubprocessSeparator(stall_timeout=30, total_timeout=60)
    with pytest.raises(SeparationFailed):
        asyncio.run(separator.separate(source, target, noop))
