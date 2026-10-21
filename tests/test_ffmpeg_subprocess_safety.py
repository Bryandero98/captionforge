"""El subproceso de ffmpeg nunca debe quedar huérfano ni colgado para siempre.

Se usa un Python como "ffmpeg" falso (el primer elemento de `cmd` es el ejecutable que corre
`_run_ffmpeg`), que imprime `time=` en stderr y luego se cuelga, sigue hablando sin parar o sale.
Para saber si el proceso murió de verdad se espía el objeto de `asyncio.create_subprocess_exec`
real y se comprueba su `returncode`: sin esperas fijas ni señales del sistema.
"""

from __future__ import annotations

import asyncio
import sys

import pytest

from captionforge import pipeline, waveform

_REAL_CREATE_SUBPROCESS_EXEC = asyncio.create_subprocess_exec

# Imprime un avance y se cuelga: simula un ffmpeg atascado.
_HANGS_AFTER_PROGRESS = (
    "import sys, time\n"
    "sys.stderr.write('time=00:00:01.00 bitrate=1\\r'); sys.stderr.flush()\n"
    "time.sleep(60)\n"
)
# Nunca deja de emitir avances: simula un ffmpeg que no termina pero no está "mudo".
_NEVER_ENDS = (
    "import sys, time\n"
    "while True:\n"
    "    sys.stderr.write('time=00:00:01.00 bitrate=1\\r'); sys.stderr.flush()\n"
    "    time.sleep(0.1)\n"
)
_EXITS_OK = "import sys\nsys.stderr.write('time=00:00:01.00 bitrate=1\\r')\n"


def _cmd(script: str) -> list[str]:
    return [sys.executable, "-c", script]


class _SpawnSpy:
    """Reemplazo de create_subprocess_exec que guarda cada proceso lanzado."""

    def __init__(self) -> None:
        self.processes: list[asyncio.subprocess.Process] = []

    async def __call__(self, *args: object, **kwargs: object) -> asyncio.subprocess.Process:
        process = await _REAL_CREATE_SUBPROCESS_EXEC(*args, **kwargs)  # type: ignore[arg-type]
        self.processes.append(process)
        return process


@pytest.fixture
def spawn_spy(monkeypatch):
    spy = _SpawnSpy()
    monkeypatch.setattr(pipeline.asyncio, "create_subprocess_exec", spy)
    # with_ffmpeg_path reemplazaría nuestro "ffmpeg" falso (un Python) por el ffmpeg real.
    monkeypatch.setattr(pipeline, "with_ffmpeg_path", lambda cmd: cmd)
    yield spy
    for process in spy.processes:  # que una prueba en rojo no deje hijos dormidos
        if process.returncode is None:
            process.kill()


def _assert_all_terminated(spy: _SpawnSpy) -> None:
    assert spy.processes, "la prueba no llegó a lanzar ningún proceso"
    still_running = [p.pid for p in spy.processes if p.returncode is None]
    assert not still_running, f"procesos ffmpeg huérfanos: {still_running}"


class TestRunFfmpegNeverLeavesAnOrphan:
    def test_kills_the_process_when_on_progress_raises(self, spawn_spy):
        def boom(_progress: float) -> None:
            raise RuntimeError("trabajo reemplazado")

        with pytest.raises(RuntimeError, match="trabajo reemplazado"):
            asyncio.run(
                pipeline._run_ffmpeg(_cmd(_HANGS_AFTER_PROGRESS), on_progress=boom, total_duration=10.0)
            )
        _assert_all_terminated(spawn_spy)

    def test_kills_the_process_when_the_task_is_cancelled(self, spawn_spy):
        async def scenario() -> None:
            task = asyncio.ensure_future(pipeline._run_ffmpeg(_cmd(_HANGS_AFTER_PROGRESS)))
            # Cancelar solo cuando el hijo ya existe: en una máquina cargada lanzar Python tarda
            # más que cualquier espera fija, y cancelar antes no probaría nada.
            for _ in range(200):
                if spawn_spy.processes:
                    break
                await asyncio.sleep(0.05)
            await asyncio.sleep(0.3)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

        asyncio.run(scenario())
        _assert_all_terminated(spawn_spy)

    def test_a_normal_run_still_succeeds_and_is_not_flagged(self, spawn_spy):
        asyncio.run(pipeline._run_ffmpeg(_cmd(_EXITS_OK), stall_timeout=30.0, total_timeout=60.0))
        _assert_all_terminated(spawn_spy)


class TestRunFfmpegTimeouts:
    def test_a_silent_hung_process_is_killed_after_the_stall_timeout(self, spawn_spy):
        with pytest.raises(pipeline.FfmpegTimeoutError, match="sin actividad"):
            asyncio.run(pipeline._run_ffmpeg(_cmd(_HANGS_AFTER_PROGRESS), stall_timeout=0.6))
        _assert_all_terminated(spawn_spy)

    def test_a_process_that_never_ends_is_killed_after_the_total_timeout(self, spawn_spy):
        with pytest.raises(pipeline.FfmpegTimeoutError, match="tiempo máximo"):
            asyncio.run(pipeline._run_ffmpeg(_cmd(_NEVER_ENDS), stall_timeout=30.0, total_timeout=1.0))
        _assert_all_terminated(spawn_spy)

    def test_the_timeout_error_is_a_runtime_error_so_job_handlers_report_it(self):
        assert issubclass(pipeline.FfmpegTimeoutError, RuntimeError)

    def test_default_timeouts_are_generous_enough_for_long_videos(self):
        # Un primer quemado en Windows puede tardar minutos sin escribir nada (caché de fuentes);
        # un video largo puede tardar horas en total. Estos mínimos evitan matar trabajo legítimo.
        assert pipeline.FFMPEG_STALL_TIMEOUT_SECONDS >= 120
        assert pipeline.FFMPEG_TOTAL_TIMEOUT_SECONDS >= 3600


class TestWaveformTimeout:
    def test_a_hung_ffmpeg_raises_a_readable_error_instead_of_blocking(self, monkeypatch, tmp_path):
        hung_cmd = _cmd("import time; time.sleep(10)")
        monkeypatch.setattr(waveform, "build_waveform_extract_cmd", lambda _path: hung_cmd)
        monkeypatch.setattr(waveform, "with_ffmpeg_path", lambda cmd: cmd)
        monkeypatch.setattr(waveform, "WAVEFORM_TIMEOUT_SECONDS", 0.5)
        with pytest.raises(waveform.WaveformExtractionError, match="tiempo"):
            waveform.compute_waveform_peaks(tmp_path / "video.mp4")

    def test_default_waveform_timeout_exists_and_is_not_tiny(self):
        assert waveform.WAVEFORM_TIMEOUT_SECONDS >= 60
