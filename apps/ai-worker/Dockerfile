# AI Worker (Python). Contexto de construcción: la RAÍZ del repositorio.
#   docker build -f apps/ai-worker/Dockerfile .
# Instala el paquete heredado (legacy/: ffmpeg, Whisper, SRT, traducción) y los contratos generados
# desde sus carpetas, y el worker encima. Ver ADR 0009.

FROM python:3.12-slim AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
WORKDIR /repo

# torch solo en versión CPU: argostranslate (stanza) lo exige y la rueda por defecto trae CUDA (~2 GB).
RUN pip install torch --index-url https://download.pytorch.org/whl/cpu

# Dependencias locales primero (cambian poco); el código del worker después.
COPY legacy/pyproject.toml legacy/README.md legacy/
COPY legacy/src legacy/src
COPY packages/contracts/generated/python packages/contracts/generated/python
RUN pip install ./packages/contracts/generated/python ./legacy

COPY apps/ai-worker/pyproject.toml apps/ai-worker/
COPY apps/ai-worker/src apps/ai-worker/src
RUN pip install ./apps/ai-worker

FROM python:3.12-slim
# libgomp1: lo cargan ctranslate2 y onnxruntime. ffmpeg viene con imageio-ffmpeg (paquete heredado).
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home --uid 10001 worker \
 && mkdir -p /models /work \
 && chown worker:worker /models /work
COPY --from=build /opt/venv /opt/venv

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    WORK_DIR=/work \
    HF_HOME=/models/hf \
    XDG_DATA_HOME=/models/xdg

USER worker
WORKDIR /work
CMD ["python", "-m", "ai_worker"]
