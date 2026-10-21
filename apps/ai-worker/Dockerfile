# AI Worker (Python). Contexto de construcción: la RAÍZ del repositorio.
#   docker build -f apps/ai-worker/Dockerfile .
# Instala el paquete heredado (legacy/: ffmpeg, Whisper, SRT, traducción) y los contratos generados
# desde sus carpetas, y el worker encima. Ver ADR 0009.
#
# Una sola etapa: todo se instala desde ruedas (no se compila nada), así que no hay herramientas de
# construcción que dejar fuera, y se evita copiar entre etapas un entorno de ~2,5 GB.

FROM python:3.12-slim

# libgomp1: lo cargan ctranslate2 y onnxruntime. ffmpeg viene con imageio-ffmpeg (paquete heredado).
# fontconfig + fuentes: libass (dentro de ffmpeg) las necesita para dibujar los subtítulos quemados; la imagen
# slim no trae ninguna y sin ellas el quemado falla o sale sin texto. Los estilos piden Arial: fonts-liberation
# (Liberation Sans) es su sustituta de mismas medidas y fonts-dejavu-core es la de respaldo para cualquier otro
# glifo. `fc-cache` deja la caché hecha en la imagen en vez de en cada arranque.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 fontconfig fonts-dejavu-core fonts-liberation \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home --uid 10001 worker \
 && mkdir -p /models /work \
 && chown worker:worker /models /work

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_CONSTRAINT=/repo/apps/ai-worker/constraints.txt \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    WORK_DIR=/work \
    HF_HOME=/models/hf \
    XDG_DATA_HOME=/models/xdg
WORKDIR /repo

# Versiones fijadas (ver el archivo): se copian antes que el código para no invalidar las capas pesadas.
COPY apps/ai-worker/constraints.txt apps/ai-worker/constraints.txt

# torch solo en versión CPU: argostranslate (stanza) lo exige y la rueda por defecto trae CUDA (~2 GB).
RUN pip install torch --index-url https://download.pytorch.org/whl/cpu

# Dependencias locales primero (cambian poco); el código del worker después.
COPY legacy/pyproject.toml legacy/README.md legacy/
COPY legacy/src legacy/src
COPY packages/contracts/generated/python packages/contracts/generated/python
RUN pip install ./packages/contracts/generated/python ./legacy

COPY apps/ai-worker/pyproject.toml apps/ai-worker/
COPY apps/ai-worker/src apps/ai-worker/src
RUN pip install ./apps/ai-worker \
 && rm -rf /repo/legacy /repo/packages /repo/apps/ai-worker/src /repo/apps/ai-worker/pyproject.toml

USER worker
WORKDIR /work
CMD ["python", "-m", "ai_worker"]
