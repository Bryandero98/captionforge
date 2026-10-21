# ADR 0004: Almacenamiento S3 con RustFS en lugar de MinIO

## Estado
Aceptada

## Fecha
2026-10-21

## Contexto
El diseño aprobado usaba MinIO como almacenamiento S3 local y de despliegue. Al levantar la
infraestructura (2026-10-21) `docker pull minio/minio` falló con *repository does not exist*, y
`quay.io/minio/minio` y `minio/mc` tampoco se pueden descargar, ni con `latest` ni con etiquetas
de versión. Las imágenes oficiales de MinIO ya no se publican, así que una infraestructura que
depende de ellas no arranca.

## Decisión
Usar **RustFS** (`rustfs/rustfs:1.0.3`, Apache-2.0, ~109 MB), con su cliente `rustfs/rc` para
inicializar (bucket, regla de caducidad, usuarios y políticas IAM). El servicio del compose se
llama `s3` (no el nombre del producto), y la aplicación solo conoce el protocolo S3
(`S3_ENDPOINT`, `S3_BUCKET`, claves de acceso).

Comprobado en frío: crea el bucket, importa la regla de caducidad (1 día sobre `jobs/`), crea
políticas por usuario y las hace cumplir (`docker/verify-infra.sh`: el worker no borra, nadie
escribe fuera de `jobs/`, el acceso anónimo se deniega).

## Alternativas consideradas

### Garage
- Pro: ligero, AGPL, pensado para autoalojar.
- Contra: modelo de permisos por clave y bucket (no políticas IAM por prefijo) y paso extra de
  asignar el *layout* del clúster; no cubre el aislamiento por prefijo `jobs/*`.
- Descartada para esta fase.

### SeaweedFS
- Pro: maduro y escalable, API S3.
- Contra: varios procesos (master, volume, filer, s3) para un caso de uso pequeño.
- Descartada por peso operativo.

### Compilar MinIO desde el código fuente
- Contra: fijarse a una base de código que ya no distribuye binarios, y mantener la compilación.
- Descartada.

### S3 gestionado (AWS, Cloudflare R2…)
- Pro: nada que operar.
- Contra: el desarrollo local pasaría a depender de una cuenta y de internet.
- Válida en producción (cambiando solo variables de entorno), pero no para el desarrollo local.

## Consecuencias
- RustFS es un proyecto joven y ha tenido avisos de seguridad (la revisión de seguridad cita
  CVE-2025-68926, CVE-2026-22782, CVE-2026-73290 y CVE-2026-73287, **sin verificar en la fuente**;
  tampoco se confirmó que `1.0.3` los incluya corregidos). Antes de un despliegue real: revisar las
  GHSA de `rustfs/rustfs`, suscribirse a sus avisos de seguridad y valorar un S3 gestionado.
- Las imágenes `rustfs/rustfs` y `rustfs/rc` están fijadas por versión **y digest**.
- Las políticas incluyen `AbortMultipartUpload`, `ListMultipartUploadParts` y
  `ListBucketMultipartUploads`: las subidas grandes son multiparte y, sin ellas, las partes de una
  subida abandonada ocuparían disco. Comprobado subiendo 24 MiB con la cuenta de la API.
- Como el código solo habla S3, cambiar de implementación toca `docker-compose.yml` y
  `docker/s3/init-bucket.sh`, nada más.
- En despliegue conviene valorar un S3 gestionado o revisar el estado del proyecto antes de salir
  a producción.
