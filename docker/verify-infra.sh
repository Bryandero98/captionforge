#!/usr/bin/env bash
# Verifica la infraestructura levantada con `npm run infra:up`: no basta con que los contenedores
# estén "healthy", hay que comprobar que los permisos de mínimo privilegio se cumplen (lo permitido
# funciona y lo prohibido falla POR LA RAZÓN CORRECTA, no por cualquier error). Sale con código != 0
# si algo falla.
#
# Uso:  bash docker/verify-infra.sh        (desde la raíz del repo, con .env presente)
# Crea y borra una tabla de prueba (public.t_probe): no lo ejecutes contra datos reales.
set -uo pipefail

cd "$(dirname "$0")/.."

# Carga .env SIN ejecutarlo como código de shell (solo líneas NOMBRE=valor; sin comentarios al final).
while IFS= read -r linea; do
  linea="${linea%%#*}"
  [[ "$linea" =~ ^[[:space:]]*([A-Z][A-Z0-9_]*)=(.*)$ ]] || continue
  valor="${BASH_REMATCH[2]}"; valor="${valor%"${valor##*[![:space:]]}"}"
  export "${BASH_REMATCH[1]}=$valor"
done < .env

DB="${POSTGRES_DB:-captionforge}"
BUCKET="${S3_BUCKET:-captionforge}"
export BUCKET
export S3_API_ACCESS_KEY="${S3_API_ACCESS_KEY:-cf-api}"
export S3_WORKER_ACCESS_KEY="${S3_WORKER_ACCESS_KEY:-cf-worker}"
RC_IMAGE="$(sed -n 's/^ *image: \(rustfs\/rc:[^ ]*\).*/\1/p' docker-compose.yml | head -1)"
fallos=0

ok()   { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFALLA\033[0m %s\n' "$1"; fallos=$((fallos + 1)); }

# esperar_ok <descripción> <comando...>: el comando debe terminar con éxito
esperar_ok() { local d="$1"; shift; if "$@" > /dev/null 2>&1; then ok "$d"; else fail "$d"; fi; }

# esperar_rechazo <patrón> <descripción> <comando...>: el comando debe fallar Y su salida debe
# contener el patrón (así un error cualquiera, como una red caída, no cuenta como "denegado").
esperar_rechazo() {
  local patron="$1" d="$2" salida; shift 2
  if salida="$("$@" 2>&1)"; then fail "$d (se permitió)"
  elif grep -Eiq -- "$patron" <<< "$salida"; then ok "$d"
  else fail "$d (falló por otra causa: $(head -c 120 <<< "$salida" | tr '\n' ' '))"; fi
}

# Se conecta por el nombre del servicio (no por 127.0.0.1): la imagen oficial de PostgreSQL usa
# "trust" para el bucle local, y así sí se comprueba la contraseña (scram-sha-256). La contraseña
# viaja por el entorno, nunca por la línea de comandos.
pg() { # pg <usuario> <contraseña> <base> <sql>
  PGPASSWORD="$2" docker compose exec -T -e PGPASSWORD postgres \
    psql -h postgres -U "$1" -d "$3" -v ON_ERROR_STOP=1 -tA -c "$4"
}
DENEGADO='permission denied|must be owner|no encryption|password authentication failed|not permitted'

echo "PostgreSQL"
owner_no_es_superusuario() {
  [ "$(pg cf_owner "$CF_OWNER_DB_PASSWORD" "$DB" "select rolsuper from pg_roles where rolname = current_user")" = f ]
}
esperar_ok "cf_owner no es superusuario" owner_no_es_superusuario
esperar_rechazo "$DENEGADO|must be superuser" "cf_owner no puede crear roles" \
  pg cf_owner "$CF_OWNER_DB_PASSWORD" "$DB" "create role intruso"
esperar_rechazo "$DENEGADO" "cf_owner no puede leer pg_authid" \
  pg cf_owner "$CF_OWNER_DB_PASSWORD" "$DB" "select * from pg_authid limit 1"
pg cf_owner "$CF_OWNER_DB_PASSWORD" "$DB" "drop table if exists public.t_probe; create table public.t_probe(id int primary key, a text)" > /dev/null 2>&1 \
  && ok "cf_owner crea tablas (DDL)" || fail "cf_owner no pudo crear la tabla de prueba"
esperar_ok    "cf_api lee, inserta, actualiza y borra en tablas de cf_owner (privilegios por defecto)" \
  pg cf_api "$CF_API_DB_PASSWORD" "$DB" "insert into public.t_probe values (1,'x'); update public.t_probe set a='y'; delete from public.t_probe"
esperar_rechazo "$DENEGADO" "cf_api no puede crear tablas (DDL)" \
  pg cf_api "$CF_API_DB_PASSWORD" "$DB" "create table public.hack(id int)"
esperar_rechazo "$DENEGADO" "cf_api no puede borrar tablas del dueño" \
  pg cf_api "$CF_API_DB_PASSWORD" "$DB" "drop table public.t_probe"
esperar_ok    "cf_worker puede leer" \
  pg cf_worker "$CF_WORKER_DB_PASSWORD" "$DB" "select count(*) from public.t_probe"
esperar_rechazo "$DENEGADO" "cf_worker no puede insertar" \
  pg cf_worker "$CF_WORKER_DB_PASSWORD" "$DB" "insert into public.t_probe values (2,'x')"
esperar_rechazo "$DENEGADO" "cf_worker no puede actualizar (sin concesión por columna)" \
  pg cf_worker "$CF_WORKER_DB_PASSWORD" "$DB" "update public.t_probe set a='z'"
esperar_rechazo "$DENEGADO" "cf_worker no puede borrar" \
  pg cf_worker "$CF_WORKER_DB_PASSWORD" "$DB" "delete from public.t_probe"
esperar_rechazo "$DENEGADO" "cf_worker no puede crear tablas" \
  pg cf_worker "$CF_WORKER_DB_PASSWORD" "$DB" "create table public.hack(id int)"
esperar_rechazo "$DENEGADO" "cf_api no puede leer pg_authid" \
  pg cf_api "$CF_API_DB_PASSWORD" "$DB" "select * from pg_authid limit 1"
esperar_rechazo "$DENEGADO" "cf_api no puede conectar a la base 'postgres'" \
  pg cf_api "$CF_API_DB_PASSWORD" postgres "select 1"
esperar_rechazo "$DENEGADO" "cf_worker no puede conectar a 'template1'" \
  pg cf_worker "$CF_WORKER_DB_PASSWORD" template1 "select 1"
esperar_rechazo "password authentication failed" "contraseña incorrecta rechazada" \
  pg cf_api "incorrecta" "$DB" "select 1"
pg cf_owner "$CF_OWNER_DB_PASSWORD" "$DB" "drop table if exists public.t_probe" > /dev/null 2>&1

echo "Redis"
rcli() { REDISCLI_AUTH="$REDIS_PASSWORD" docker compose exec -T -e REDISCLI_AUTH redis redis-cli --no-auth-warning "$@"; }
esperar_ok "sin contraseña se rechaza (NOAUTH)" \
  bash -c 'docker compose exec -T redis redis-cli get x 2>&1 | grep -q NOAUTH'
[ "$(rcli config get maxmemory-policy | tail -1)" = "noeviction" ] \
  && ok "maxmemory-policy = noeviction (requisito de BullMQ)" || fail "maxmemory-policy no es noeviction"
[ "$(rcli config get appendonly | tail -1)" = "yes" ] \
  && ok "appendonly = yes (la cola sobrevive a un reinicio)" || fail "appendonly desactivado"
[ "$(rcli config get maxmemory | tail -1)" -gt 0 ] 2>/dev/null \
  && ok "maxmemory definido (rechaza escrituras en vez de morir por OOM)" || fail "maxmemory sin definir"
if docker inspect "$(docker compose ps -q redis)" --format '{{.Path}} {{join .Args " "}}' | grep -qF -- "$REDIS_PASSWORD"; then
  fail "la contraseña de Redis aparece en la línea de comandos del contenedor"
else ok "la contraseña de Redis no está en la línea de comandos del contenedor"; fi

echo "S3"
rc_sh() { # rc_sh <script sh>: ejecuta rc dentro de la red del compose; los secretos van por entorno
  docker run --rm --network captionforge-net --entrypoint /bin/sh \
    -e S3_API_ACCESS_KEY -e S3_API_SECRET_KEY -e S3_WORKER_ACCESS_KEY -e S3_WORKER_SECRET_KEY \
    -e S3_ROOT_USER -e S3_ROOT_PASSWORD -e BUCKET "$RC_IMAGE" -c "$1"
}
export S3_ROOT_USER="${S3_ROOT_USER:-captionforge}"
PRE='rc alias set api http://s3:9000 "$S3_API_ACCESS_KEY" "$S3_API_SECRET_KEY" >/dev/null &&
     rc alias set worker http://s3:9000 "$S3_WORKER_ACCESS_KEY" "$S3_WORKER_SECRET_KEY" >/dev/null &&
     echo contenido > /tmp/f.txt &&
     K=jobs/00000000-0000-4000-8000-000000000001/input/f.txt'
DENEGADO_S3='AccessDenied|403|Forbidden'
esperar_ok    "worker sube a jobs/" \
  rc_sh "$PRE && rc put /tmp/f.txt worker/\$BUCKET/\$K"
esperar_ok    "worker lee de jobs/" \
  rc_sh "$PRE && rc get worker/\$BUCKET/\$K /tmp/out.txt && grep -q contenido /tmp/out.txt"
esperar_rechazo "$DENEGADO_S3" "worker no puede subir fuera de jobs/" \
  rc_sh "$PRE && rc put /tmp/f.txt worker/\$BUCKET/otro/f.txt"
esperar_rechazo "$DENEGADO_S3" "worker no puede subir a otro bucket" \
  rc_sh "$PRE && rc put /tmp/f.txt worker/otrobucket/jobs/x/f.txt"
esperar_rechazo "$DENEGADO_S3" "worker no puede listar la raíz del bucket" \
  rc_sh "$PRE && rc bucket list worker/\$BUCKET"
esperar_rechazo "$DENEGADO_S3" "worker no puede borrar" \
  rc_sh "$PRE && rc object remove worker/\$BUCKET/\$K"
esperar_ok    "api sube 24 MiB (subida multiparte)" \
  rc_sh "$PRE && dd if=/dev/zero of=/tmp/big bs=1M count=24 2>/dev/null && rc put /tmp/big api/\$BUCKET/jobs/00000000-0000-4000-8000-000000000001/big.bin"
esperar_ok    "api puede borrar en jobs/" \
  rc_sh "$PRE && rc object remove api/\$BUCKET/\$K && rc object remove api/\$BUCKET/jobs/00000000-0000-4000-8000-000000000001/big.bin"
esperar_rechazo "$DENEGADO_S3" "api no puede subir fuera de jobs/" \
  rc_sh "$PRE && rc put /tmp/f.txt api/\$BUCKET/otro/f.txt"
esperar_rechazo "403 Forbidden" "acceso anónimo denegado" \
  docker run --rm --network captionforge-net --entrypoint /bin/sh "$RC_IMAGE" -c "wget -S -q -O- http://s3:9000/$BUCKET/jobs/x/input/f.txt"
esperar_ok    "regla de caducidad presente" \
  rc_sh 'rc alias set r http://s3:9000 "$S3_ROOT_USER" "$S3_ROOT_PASSWORD" >/dev/null && rc bucket lifecycle rule list r/$BUCKET | grep -q expire-jobs'

echo
if [ "$fallos" -eq 0 ]; then
  printf '\033[32mInfraestructura verificada: todas las comprobaciones pasaron.\033[0m\n'
else
  printf '\033[31m%d comprobaciones fallaron.\033[0m\n' "$fallos"; exit 1
fi
