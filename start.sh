#!/usr/bin/env bash
# CaptionForge: arranque local con un solo comando (macOS y Linux).
#   ./start.sh          levanta todo (primera vez: construye las imágenes, tarda unos minutos)
# Lo único que hay que tener instalado es Docker. Detalles y alternativas: README, «Quickstart».
set -euo pipefail
cd "$(dirname "$0")"

PORT="${CF_PORT:-3000}"
URL="http://localhost:${PORT}"
# Las ocho credenciales obligatorias de .env.example (solo letras y números: van dentro de URLs de conexión).
SECRETS="POSTGRES_PASSWORD CF_OWNER_DB_PASSWORD CF_API_DB_PASSWORD CF_WORKER_DB_PASSWORD REDIS_PASSWORD S3_ROOT_PASSWORD S3_API_SECRET_KEY S3_WORKER_SECRET_KEY"

say() { printf '%s\n' "$*"; }
fail() { printf '\nNo se pudo continuar: %s\n' "$*" >&2; exit 1; }

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 18
  else
    # 36 caracteres hexadecimales del generador del sistema operativo.
    od -An -N18 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

# --- 1. Docker ---------------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || fail "Docker no está instalado. Instálalo desde https://docs.docker.com/get-docker/ y vuelve a ejecutar ./start.sh"
docker compose version >/dev/null 2>&1 || fail "Falta «docker compose» (v2). Actualiza Docker o instala el plugin: https://docs.docker.com/compose/install/"
docker info >/dev/null 2>&1 || fail "Docker está instalado pero no responde. Abre Docker Desktop (o inicia el servicio de Docker) y vuelve a ejecutar ./start.sh"

# --- 2. .env con contraseñas propias -------------------------------------------------------------
if [ -f .env ]; then
  say "Se usa el .env que ya existe (no se modifica)."
else
  [ -f .env.example ] || fail "No encuentro .env.example en $(pwd). Ejecuta el script desde la carpeta de CaptionForge."
  say "Creando .env con contraseñas aleatorias..."
  umask 077
  : > .env.tmp
  while IFS= read -r line || [ -n "$line" ]; do
    key="${line%%=*}"
    for secret in $SECRETS; do
      if [ "$key" = "$secret" ]; then
        line="${secret}=$(random_secret)"
        break
      fi
    done
    printf '%s\n' "$line" >> .env.tmp
  done < .env.example
  mv .env.tmp .env
  chmod 600 .env
  say ".env creado. Guárdalo: tiene las contraseñas de tu instalación (no se sube a git)."
fi

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
