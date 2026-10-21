"""Punto de entrada: `python -m ai_worker`."""

from __future__ import annotations

import asyncio
import logging
import signal
import sys

from .config import ConfigError, WorkerConfig
from .worker import AiWorker


async def _main() -> None:
    config = WorkerConfig.from_env()
    config.work_dir.mkdir(parents=True, exist_ok=True)
    worker = AiWorker(config)
    stop = asyncio.Event()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # Windows: solo Ctrl+C (KeyboardInterrupt)
            pass

    await worker.start()
    try:
        await stop.wait()
    finally:
        await worker.stop()


def run() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    try:
        asyncio.run(_main())
    except ConfigError as error:
        print(f"Configuración inválida: {error}", file=sys.stderr)
        sys.exit(2)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    run()
