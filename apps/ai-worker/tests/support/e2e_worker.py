"""Worker REAL para la prueba E2E de traducir y doblar (apps/api-gateway/test/providers-e2e.e2e.spec.ts). No es una prueba de pytest.

Es el `AiWorker` de producción (colas de BullMQ, PostgreSQL, S3, canal interno del API) con una sola diferencia: las URL de OpenAI y
ElevenLabs apuntan a un proveedor falso. En producción esas URL son constantes del código (nada del entorno las cambia, para que una
clave nunca viaje a otro servidor); aquí se inyectan desde el propio arnés, que solo existe en el árbol de pruebas.

Entorno: el del rol `worker` (REDIS_*, DATABASE_URL, S3_*), más API_INTERNAL_URL, WORKER_INTERNAL_TOKEN, WORK_DIR y FAKE_PROVIDER_URL.
Termina limpiamente cuando se cierra su entrada estándar.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys

from ai_worker.adapters import Adapters
from ai_worker.config import WorkerConfig
from ai_worker.external_key import ExternalKeyClient
from ai_worker.logfmt import configure_logging
from ai_worker.worker import AiWorker

log = logging.getLogger("ai_worker")


async def main() -> None:
    configure_logging("json")
    config = WorkerConfig.from_env(os.environ)
    assert config.api_internal_url and config.worker_internal_token, "el arnés necesita el canal interno"
    fake = os.environ["FAKE_PROVIDER_URL"]
    adapters = Adapters(
        ExternalKeyClient(config.api_internal_url, config.worker_internal_token),
        base_urls={"openai": fake, "elevenlabs": fake},
    )
    worker = AiWorker(config, adapters=adapters)
    await worker.start()
    print("READY", flush=True)
    await asyncio.to_thread(sys.stdin.read)  # hasta que la prueba cierre la entrada
    await worker.stop()
    print("STOPPED", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
