#!/usr/bin/env bash
# Crea o completa el .env de CaptionForge (lo llama start.sh; start.bat hace lo mismo con tools/new-env.ps1).
# Se ejecuta DESDE la carpeta que tiene .env.example. Nunca imprime un secreto.
#
#  - Sin .env: lo crea desde .env.example con contraseñas aleatorias.
#  - Con .env: no cambia NINGÚN valor que ya exista; solo añade lo que falte o esté vacío (DEFAULT_API_KEY, APP_SECRET y
#    WORKER_INTERNAL_TOKEN, que un .env anterior a la tenencia o a BYOK no trae). APP_SECRET jamás se regenera: cambiarlo deja ilegibles
#    las claves externas que los espacios ya guardaron (docs/runbook-app-secret.md).
#
# Aleatoriedad: openssl rand, o /dev/urandom si no hay openssl. Todo en hexadecimal (va dentro de URLs de conexión sin codificar).
set -euo pipefail

# Las ocho credenciales obligatorias de .env.example.
SECRETS="POSTGRES_PASSWORD CF_OWNER_DB_PASSWORD CF_API_DB_PASSWORD CF_WORKER_DB_PASSWORD REDIS_PASSWORD S3_ROOT_PASSWORD S3_API_SECRET_KEY S3_WORKER_SECRET_KEY"
# Claves de 32 bytes (64 caracteres hexadecimales): DEFAULT_API_KEY (con prefijo cfk_, ADR 0015), APP_SECRET y WORKER_INTERNAL_TOKEN (ADR 0020).
# La validación del API exige 32 bytes o más; son tres valores distintos e independientes entre sí.
STRONG="DEFAULT_API_KEY APP_SECRET WORKER_INTERNAL_TOKEN"

say() { printf '%s\n' "$*"; }
fail() { printf '\nNo se pudo continuar: %s\n' "$*" >&2; exit 1; }

random_secret() {
  bytes="${1:-18}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
  else
    # Hexadecimal del generador del sistema operativo.
    od -An -N"$bytes" -tx1 /dev/urandom | tr -d ' \n'
  fi
}

# Aborta si el generador no entrega 64 caracteres hexadecimales: nunca se escribe un secreto vacío.
strong_value() {
  value="$(random_secret 32)" || fail "no se pudo generar un secreto aleatorio."
  case "$value" in *[!0-9a-f]* | "") fail "el generador aleatorio devolvió un valor inválido." ;; esac
  [ "${#value}" -eq 64 ] || fail "el generador aleatorio devolvió un valor inválido."
  case "$1" in
    DEFAULT_API_KEY) printf 'cfk_%s' "$value" ;;
    *) printf '%s' "$value" ;;
  esac
}

new_tmp() { mktemp ./.env.XXXXXX || fail "no se pudo crear un archivo temporal."; }

umask 077
# Archivo temporal impredecible en la misma carpeta (mv atómico), borrado si el script termina a medias.
TMP="$(new_tmp)"
trap 'rm -f "$TMP"' EXIT

[ ! -e .env ] || [ -f .env ] || fail ".env existe pero no es un archivo (¿lo creó Docker como carpeta?). Bórralo y vuelve a ejecutar."

if [ ! -e .env ]; then
  [ -f .env.example ] || fail "No encuentro .env.example en $(pwd). Ejecuta el script desde la carpeta de CaptionForge."
  say "Creando .env con contraseñas aleatorias..."
  while IFS= read -r line || [ -n "$line" ]; do
    key="${line%%=*}"
    for secret in $SECRETS; do
      if [ "$key" = "$secret" ]; then
        line="${secret}=$(random_secret)"
        break
      fi
    done
    for strong in $STRONG; do
      if [ "$key" = "$strong" ]; then
        line="${strong}=$(strong_value "$strong")"
        break
      fi
    done
    printf '%s\n' "$line" >> "$TMP"
  done < .env.example
  mv "$TMP" .env
  chmod 600 .env
  TMP="$(new_tmp)"
  say ".env creado. Guárdalo: tiene las contraseñas de tu instalación y el APP_SECRET que cifra las claves externas (no se sube a git)."
else
  say "Se usa el .env que ya existe (no se cambia ningún valor)."
fi

# Completar lo que falte: un .env anterior a la tenencia (ADR 0015) o a BYOK (ADR 0020) no trae estas variables.
# «Falta» incluye la línea vacía (también con el salto de línea de Windows). Lo demás del archivo no se toca.
for strong in $STRONG; do
  # «Presente» = cualquier valor con algún carácter visible (aunque empiece por espacio: no se reescribe).
  if ! grep -Eq "^${strong}=[[:space:]]*[^[:space:]]" .env; then
    say "Añadiendo ${strong} al .env..."
    new_value="$(strong_value "$strong")"
    # grep sale con 1 si no quedó ninguna línea (válido); con 2 es un error de lectura y no se toca el .env.
    rc=0
    grep -Ev "^${strong}=[[:space:]]*$" .env > "$TMP" || rc=$?
    [ "$rc" -le 1 ] || fail "no se pudo leer el .env (grep devolvió $rc)."
    # Si el archivo no termina en salto de línea, el valor nuevo no debe pegarse a la última línea.
    if [ -s "$TMP" ] && [ -n "$(tail -c1 "$TMP")" ]; then printf '\n' >> "$TMP"; fi
    printf '%s=%s\n' "$strong" "$new_value" >> "$TMP"
    mv "$TMP" .env
    chmod 600 .env
    TMP="$(new_tmp)"
  fi
done
