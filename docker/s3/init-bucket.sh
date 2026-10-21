#!/bin/sh
# Inicializa el almacenamiento S3 (RustFS): bucket privado, caducidad de archivos y cuentas de
# servicio de mínimo privilegio. Idempotente: se ejecuta en cada `docker compose up`. Crear una
# política o un usuario que ya existe lo actualiza (no se borra nada, así no se cortan subidas).
set -eu

: "${S3_ROOT_USER:?}" "${S3_ROOT_PASSWORD:?}" "${S3_BUCKET:?}"
: "${S3_API_ACCESS_KEY:?}" "${S3_API_SECRET_KEY:?}"
: "${S3_WORKER_ACCESS_KEY:?}" "${S3_WORKER_SECRET_KEY:?}"

rc alias set local http://s3:9000 "$S3_ROOT_USER" "$S3_ROOT_PASSWORD" > /dev/null

rc bucket create --ignore-existing "local/$S3_BUCKET"

# Los archivos son temporales: todo lo que cuelga de jobs/ caduca al día. `import` reemplaza la
# configuración entera, por eso es idempotente (no acumula reglas repetidas).
cat > /tmp/lifecycle.json <<JSON
{"Rules":[{"ID":"expire-jobs","Status":"Enabled","Filter":{"Prefix":"jobs/"},"Expiration":{"Days":1}}]}
JSON
rc bucket lifecycle rule import "local/$S3_BUCKET" /tmp/lifecycle.json

# Las subidas grandes (hasta varios GiB) son multiparte: sin Abort/ListParts, las partes de una
# subida abandonada quedarían ocupando disco.
MULTIPART_OBJECT='"s3:AbortMultipartUpload","s3:ListMultipartUploadParts"'

# Política de la API: leer, escribir y borrar bajo jobs/ de ESTE bucket, y nada más.
cat > /tmp/policy-api.json <<JSON
{"Version":"2012-10-17","Statement":[
  {"Effect":"Allow","Action":["s3:ListBucket"],"Resource":["arn:aws:s3:::$S3_BUCKET"],
   "Condition":{"StringLike":{"s3:prefix":["jobs/*"]}}},
  {"Effect":"Allow","Action":["s3:ListBucketMultipartUploads"],"Resource":["arn:aws:s3:::$S3_BUCKET"]},
  {"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject",$MULTIPART_OBJECT],
   "Resource":["arn:aws:s3:::$S3_BUCKET/jobs/*"]}
]}
JSON

# Política del worker: igual pero sin borrar (la retención la gestiona la caducidad del bucket).
cat > /tmp/policy-worker.json <<JSON
{"Version":"2012-10-17","Statement":[
  {"Effect":"Allow","Action":["s3:ListBucket"],"Resource":["arn:aws:s3:::$S3_BUCKET"],
   "Condition":{"StringLike":{"s3:prefix":["jobs/*"]}}},
  {"Effect":"Allow","Action":["s3:ListBucketMultipartUploads"],"Resource":["arn:aws:s3:::$S3_BUCKET"]},
  {"Effect":"Allow","Action":["s3:GetObject","s3:PutObject",$MULTIPART_OBJECT],
   "Resource":["arn:aws:s3:::$S3_BUCKET/jobs/*"]}
]}
JSON

rc admin policy create local cf-api /tmp/policy-api.json
rc admin policy create local cf-worker /tmp/policy-worker.json

rc admin user add local "$S3_API_ACCESS_KEY" "$S3_API_SECRET_KEY"
rc admin user add local "$S3_WORKER_ACCESS_KEY" "$S3_WORKER_SECRET_KEY"
rc admin policy attach local cf-api --user "$S3_API_ACCESS_KEY"
rc admin policy attach local cf-worker --user "$S3_WORKER_ACCESS_KEY"

echo "S3 listo: bucket '$S3_BUCKET', caducidad 1 día, cuentas cf-api y cf-worker."
