#!/usr/bin/env bash
# CaptionForge: arranque local con un solo comando (macOS y Linux).
#   ./start.sh          levanta todo (primera vez: construye las imágenes, tarda unos minutos)
# Lo único que hay que tener instalado es Docker. Detalles y alternativas: README, «Quickstart».
set -euo pipefail
cd "$(dirname "$0")"

PORT="${CF_PORT:-3000}"
URL="http://localhost:${PORT}"

say() { printf '%s\n' "$*"; }
fail() { printf '\nNo se pudo continuar: %s\n' "$*" >&2; exit 1; }

# --- 1. Docker ---------------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || fail "Docker no está instalado. Instálalo desde https://docs.docker.com/get-docker/ y vuelve a ejecutar ./start.sh"
docker compose version >/dev/null 2>&1 || fail "Falta «docker compose» (v2). Actualiza Docker o instala el plugin: https://docs.docker.com/compose/install/"
docker info >/dev/null 2>&1 || fail "Docker está instalado pero no responde. Abre Docker Desktop (o inicia el servicio de Docker) y vuelve a ejecutar ./start.sh"

# --- 2. .env con contraseñas propias -------------------------------------------------------------
# tools/ensure-env.sh crea el .env o, si ya existe, solo añade lo que falte (DEFAULT_API_KEY, APP_SECRET, WORKER_INTERNAL_TOKEN) sin
# cambiar ningún valor. APP_SECRET nunca se regenera: cambiarlo deja ilegibles las claves externas guardadas.
[ -f tools/ensure-env.sh ] || fail "No encuentro tools/ensure-env.sh en $(pwd). Ejecuta el script desde la carpeta de CaptionForge."
bash tools/ensure-env.sh || fail "no se pudo crear o completar el .env."

# --- 3. Levantar todo ----------------------------------------------------------------------------
say "Levantando PostgreSQL, Redis, S3, la API y el worker (la primera vez tarda unos minutos)..."
docker compose --profile app up -d --build || fail "docker compose falló. Revisa el error de arriba; «docker compose --profile app logs» da más detalle."

# --- 4. Esperar a que responda -------------------------------------------------------------------
if command -v curl >/dev/null 2>&1; then
  say "Esperando a que la API responda..."
  ready=0
  for _ in $(seq 1 90); do
    if curl -fsS "${URL}/health" >/dev/null 2>&1; then ready=1; break; fi
    sleep 2
  done
  [ "$ready" = 1 ] || fail "la API no respondió en 3 minutos. Mira «docker compose --profile app logs api-gateway ai-worker»."
fi

cat <<EOF

  CaptionForge está listo.

    Abre:  ${URL}

  Los videos y los subtítulos se borran del servidor pasado un día.
  La primera transcripción descarga el modelo de Whisper (puede tardar unos minutos).

    Ver registros:  docker compose --profile app logs -f
    Apagar:         docker compose --profile app down
    Volver a abrir: ./start.sh
EOF
