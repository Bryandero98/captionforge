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
# Con --build-arg WITH_SEPARATION=1 se fija torch/torchaudio 2.11 y se instala Demucs para la limpieza de audio
# (cleanAudio, ADR 0013); sin él, la imagen es la de siempre y los trabajos que la pidan siguen con el audio original.
ARG WITH_SEPARATION=0
# Con --build-arg WITH_DIARIZATION=1 se instala pyannote.audio para identificar quién habla (diarize, ADR 0014); usa la
# misma pila de PyTorch 2.11. El modelo se descarga en el primer uso con el token HF_TOKEN del contenedor.
ARG WITH_DIARIZATION=0
COPY apps/ai-worker/requirements-separation.txt apps/ai-worker/requirements-diarization.txt apps/ai-worker/
RUN if [ "$WITH_SEPARATION" = "1" ] || [ "$WITH_DIARIZATION" = "1" ]; then \
      pip install --retries 10 --timeout 60 torch==2.11.0 torchaudio==2.11.0 --index-url https://download.pytorch.org/whl/cpu; \
    else \
      pip install --retries 10 --timeout 60 torch --index-url https://download.pytorch.org/whl/cpu; \
    fi \
 && if [ "$WITH_SEPARATION" = "1" ]; then pip install --no-deps -r apps/ai-worker/requirements-separation.txt; fi \
 && if [ "$WITH_DIARIZATION" = "1" ]; then pip install -r apps/ai-worker/requirements-diarization.txt --extra-index-url https://download.pytorch.org/whl/cpu; fi

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
