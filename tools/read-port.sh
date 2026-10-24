#!/usr/bin/env bash
# Imprime el puerto en el que se publica CaptionForge en tu equipo: CF_PORT del entorno, si no el de .env, si no 3000.
# Lo usa start.sh (start.bat hace lo mismo con tools/read-port.ps1). Se ejecuta desde la carpeta que tiene el .env.
# Si el valor no es un puerto válido (1 a 65535) sale con error y no imprime nada: nunca se pasa texto raro a docker compose.
set -euo pipefail

port="${CF_PORT:-}"
if [ -z "$port" ] && [ -f .env ]; then
  # La última línea CF_PORT= gana, como en docker compose; se quitan el salto de línea de Windows y los espacios de los extremos.
  line="$(grep -E '^CF_PORT=' .env | tail -n 1 || true)"
  port="${line#CF_PORT=}"
  port="$(printf '%s' "$port" | tr -d '\r' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
fi
port="${port:-3000}"

invalid() {
  printf 'CF_PORT debe ser un número entre 1 y 65535 (tiene «%s»). Corrígelo en .env o en el entorno.\n' "$port" >&2
  exit 1
}
case "$port" in '' | *[!0-9]*) invalid ;; esac
[ "${#port}" -le 5 ] || invalid
port=$((10#$port))
{ [ "$port" -ge 1 ] && [ "$port" -le 65535 ]; } || invalid
printf '%s\n' "$port"
