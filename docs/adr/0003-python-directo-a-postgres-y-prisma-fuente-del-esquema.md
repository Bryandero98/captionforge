# ADR 0003: El worker Python se conecta directo a PostgreSQL; Prisma es la única fuente del esquema

## Estado
Aceptada

## Fecha
2026-10-21

## Contexto
El worker debe dejar el estado del trabajo (progreso, error, artefactos) en la base de datos.
Podría hacerlo llamando de vuelta al API, o escribiendo directamente.

## Decisión
El worker se conecta directamente a PostgreSQL con el rol `cf_worker`. El esquema lo define
**solo Prisma** (migraciones del API Gateway); el worker no crea ni altera tablas y no duplica
el esquema en un ORM propio (se usa SQL explícito y estrecho).

`cf_worker` empieza con `SELECT` únicamente. Los `UPDATE` se conceden **por columna** en la
migración de Prisma que crea la tabla `Job` (los permisos por columna no se pueden dar antes de
que la tabla exista). No inserta ni borra filas.

## Alternativas consideradas

### El worker llama a un endpoint interno del API
- Pro: un solo punto de acceso a la base.
- Contra: el API se vuelve un cuello de botella y un punto único de fallo para cada actualización
  de progreso; hay que autenticar y versionar una segunda API interna.
- Rechazada por la complejidad extra; el rol de columnas acotadas da un aislamiento comparable.

### Un ORM Python (SQLAlchemy) con su propio modelo
- Contra: dos fuentes de verdad del esquema que divergen.
- Rechazada.

## Consecuencias
- Las migraciones corren con `cf_owner`, un rol **sin superusuario** que es dueño de la base y del
  esquema; el superusuario del contenedor nunca llega a una aplicación. Los `ALTER DEFAULT
  PRIVILEGES` de `docker/postgres/init-roles.sql` se declaran `FOR ROLE cf_owner`: aplican a las
  tablas que cree ese rol y a ningún otro (lo comprueba `verify-infra.sh`).
- La migración inicial de Prisma debe hacer `REVOKE ALL ON "_prisma_migrations" FROM cf_api,
  cf_worker` (si no, la API podría falsear el historial de migraciones) y valorar si `cf_worker`
  necesita `SELECT` en todas las tablas futuras o solo en `"Job"`. Los `GRANT` de columnas a
  `cf_worker` se envuelven en una comprobación de que el rol existe (CI y otros entornos).
- La API usa `?connection_limit=10&pool_timeout=10`: el pool por defecto de Prisma crece con los
  núcleos y podría superar el límite de 20 conexiones del rol.
- Un cambio de nombre de columna en Prisma puede romper el worker: la migración y el SQL del worker
  se cambian juntos, y una prueba de integración lo vigila (Fase 3).
- Los roles y sus contraseñas los aplica la tarea `pg-roles` en **cada** `npm run infra:up`
  (idempotente), no un script `initdb`, que solo corre con el volumen vacío. Así rotar una
  contraseña en `.env` y volver a levantar la aplica de verdad (probado: la vieja deja de valer).
  La contraseña del superusuario (`POSTGRES_PASSWORD`) no se rota así: exige `ALTER ROLE` manual.
