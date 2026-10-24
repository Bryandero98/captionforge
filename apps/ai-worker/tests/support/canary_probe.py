"""Sonda de la prueba canario (ADR 0020). NO es una prueba de pytest: la ejecuta apps/api-gateway/test/leak-canary.e2e.spec.ts.

Hace lo que hará un trabajo TRANSLATE o DUB: pide al API la clave externa de su trabajo por el canal interno, la usa contra un
proveedor (de mentira) y escribe sus archivos de trabajo y sus registros. Además intenta, a propósito, todas las maneras de filtrarla
(registrarla, meterla en una traza, en el mensaje de error de un proveedor, en una excepción sin capturar). La prueba escanea después
Redis, la base, los registros del API, la salida de esta sonda y la carpeta de trabajo: la clave no puede aparecer en ninguno.

Entorno: API_INTERNAL_URL, WORKER_INTERNAL_TOKEN, JOB_ID, PROVIDER, WORK_DIR, FAKE_PROVIDER_URL.
  MODE=normal  (por defecto) el proveedor falso responde 401 repitiendo la clave en su mensaje, como hace OpenAI.
  MODE=crash   una excepción con la clave en su mensaje llega sin capturar hasta el intérprete.
  LEAK=1       CONTROL NEGATIVO: filtra la clave a propósito (print y archivo, que no pasan por el filtro del registro) para comprobar
               que el escáner de la prueba la detecta cuando existe.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path

import httpx

from ai_worker.errors import JobFailure
from ai_worker.external_key import ExternalKeyClient
from ai_worker.logfmt import configure_logging

log = logging.getLogger("ai_worker")


async def main() -> None:
    configure_logging("json")
    job_id = os.environ["JOB_ID"]
    provider = os.environ["PROVIDER"]
    mode = os.environ.get("MODE", "normal")
    leak = os.environ.get("LEAK") == "1"
    job_dir = Path(os.environ["WORK_DIR"]) / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    client = ExternalKeyClient(os.environ["API_INTERNAL_URL"], os.environ["WORKER_INTERNAL_TOKEN"])
    async with client.lease(job_id, provider) as secret:
        fingerprint = secret.fingerprint()
        log.info("clave obtenida (huella %s)", fingerprint)
        log.info("el secreto como objeto: %s | %r | %s", secret, secret, f"{secret}")
        # Fugas que un descuido podría producir: el filtro del registro debe censurarlas.
        log.info("fuga directa en un registro: %s", secret.reveal())
        try:
            raise RuntimeError(f"la autenticación falló con {secret.reveal()}")
        except RuntimeError:
            log.exception("fallo simulado con la clave dentro de la traza")

        (job_dir / "translated.segments.json").write_text(json.dumps({"provider": provider, "segments": [{"start": 0, "end": 1, "text": "hola"}]}), encoding="utf-8")

        async with httpx.AsyncClient(timeout=10.0, trust_env=False) as http:
            response = await http.post(os.environ["FAKE_PROVIDER_URL"], headers={"authorization": f"Bearer {secret.reveal()}"}, json={"text": "hola"})
        if response.status_code != 200:
            # Lo que el trabajo guardaría en Job.errorMessage y vería la persona: el cuerpo del proveedor repite la clave.
            failure = JobFailure("INTERNAL", f"El proveedor respondió {response.status_code}: {response.text}")
            print("FAILURE_MESSAGE=" + failure.message, flush=True)
            log.error("el proveedor rechazó la petición: %s", response.text)

        if leak:
            (job_dir / "fuga.txt").write_text(secret.reveal(), encoding="utf-8")
            print("FUGA=" + secret.reveal(), flush=True)

        if mode == "crash":
            raise RuntimeError(f"error sin capturar con la clave {secret.reveal()} dentro")

    print("RESULT " + json.dumps({"fingerprint": fingerprint}), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
