-- Roles de mínimo privilegio de CaptionForge.
--
-- Se ejecuta al crear el volumen de PostgreSQL (init-roles.sh) y es IDEMPOTENTE: también se puede
-- volver a ejecutar a mano para aplicar cambios o rotar contraseñas (ver README, "Rotar
-- contraseñas"). Corre conectado como el superusuario del contenedor (POSTGRES_USER) sobre la base
-- POSTGRES_DB. Las contraseñas se leen del entorno del contenedor con \getenv: no pasan por la
-- línea de comandos de psql ni se escriben en este archivo.
--
-- Reparto de responsabilidades (Prisma es la ÚNICA fuente de verdad del esquema):
--   * POSTGRES_USER  -> superusuario del contenedor; solo administración. Nunca llega a una app.
--   * cf_owner       -> dueño de la base y del esquema; sin superusuario. Solo lo usa
--                       `prisma migrate deploy` (servicio `migrate`). Crea las tablas.
--   * cf_api         -> el API Gateway en ejecución: lectura y escritura de datos, sin DDL.
--   * cf_worker      -> el AI Worker: SOLO LEE y actualiza columnas concretas de "Job". Nunca
--                       inserta ni borra filas. Esas columnas se conceden en una migración de
--                       Prisma (los permisos por columna no se pueden dar por adelantado a
--                       tablas que todavía no existen).
--
-- Variable de psql esperada: db_name. Variables de entorno: CF_OWNER_DB_PASSWORD,
-- CF_API_DB_PASSWORD, CF_WORKER_DB_PASSWORD.

\set ON_ERROR_STOP on

-- Una sentencia ALTER ROLE ... PASSWORD fallida escribiría la contraseña en el registro del servidor.
SET log_statement = 'none';
SET log_min_error_statement = 'panic';

\getenv owner_password CF_OWNER_DB_PASSWORD
\getenv api_password CF_API_DB_PASSWORD
\getenv worker_password CF_WORKER_DB_PASSWORD

-- Ningún rol hereda permisos por defecto sobre la base ni el esquema público.
REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Roles: solo inician sesión; sin superusuario, sin crear bases ni roles.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cf_owner') THEN
    CREATE ROLE cf_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cf_api') THEN
    CREATE ROLE cf_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cf_worker') THEN
    CREATE ROLE cf_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;

-- Las contraseñas se fijan fuera del bloque DO para poder usar las variables de psql.
ALTER ROLE cf_owner  PASSWORD :'owner_password';
ALTER ROLE cf_api    PASSWORD :'api_password';
ALTER ROLE cf_worker PASSWORD :'worker_password';

-- Límite de conexiones: el worker procesa de a un trabajo; la API necesita un pool pequeño
-- (fijar connection_limit en DATABASE_URL por debajo de 20) y las migraciones usan una sola.
ALTER ROLE cf_owner  CONNECTION LIMIT 3;
ALTER ROLE cf_api    CONNECTION LIMIT 20;
ALTER ROLE cf_worker CONNECTION LIMIT 5;

-- Tiempos máximos: una consulta o transacción colgada no puede retener una conexión para siempre.
-- OJO (worker): un trabajo dura horas, así que su conexión debe usar autocommit o transacciones
-- cortas; abierta en transacción sin actividad más de 30 s, el servidor la cierra.
ALTER ROLE cf_api    SET statement_timeout = '30s';
ALTER ROLE cf_api    SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE cf_worker SET statement_timeout = '30s';
ALTER ROLE cf_worker SET idle_in_transaction_session_timeout = '30s';

-- Las bases de mantenimiento tampoco quedan abiertas a cualquier rol que inicie sesión.
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;

-- El dueño del esquema NO es superusuario: es dueño de la base y del esquema público, y nada más.
ALTER DATABASE :"db_name" OWNER TO cf_owner;
ALTER SCHEMA public OWNER TO cf_owner;

GRANT CONNECT ON DATABASE :"db_name" TO cf_api, cf_worker;
GRANT USAGE ON SCHEMA public TO cf_api, cf_worker;

-- Tablas y secuencias que cree cf_owner (Prisma):
--   la API recibe lectura/escritura; el worker, solo lectura. Las columnas que el worker puede
--   actualizar se conceden explícitamente en la migración que crea la tabla "Job". La migración
--   inicial también debe quitarles todo sobre "_prisma_migrations" (historial de migraciones).
ALTER DEFAULT PRIVILEGES FOR ROLE cf_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cf_api;
ALTER DEFAULT PRIVILEGES FOR ROLE cf_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO cf_api;
ALTER DEFAULT PRIVILEGES FOR ROLE cf_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO cf_worker;

-- Para tablas que ya existían antes de aplicar este archivo (re-ejecución sobre un volumen con
-- datos): los privilegios por defecto no son retroactivos.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cf_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cf_api;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO cf_worker;

-- ...pero el historial de migraciones es solo del dueño: los GRANT de arriba se lo habrían devuelto
-- a cf_api y cf_worker (la migración inicial lo revoca; esto lo mantiene así al re-ejecutar).
DO $$
BEGIN
  IF to_regclass('public."_prisma_migrations"') IS NOT NULL THEN
    REVOKE ALL ON "_prisma_migrations" FROM cf_api, cf_worker;
  END IF;
END
$$;

-- Tenencia y sesiones (ADR 0015 y 0016): lo mismo para sus tablas. cf_api crea tenants, personas, sesiones y claves (el inicio
-- de sesión lo hace el API) pero no borra tenants, personas ni claves, ni cambia hashes ni dueños; cf_worker no las ve. Se
-- repite aquí lo que conceden las migraciones, para que re-ejecutar este archivo no lo deshaga.
DO $$
BEGIN
  IF to_regclass('public."Tenant"') IS NOT NULL THEN
    REVOKE ALL ON "Tenant", "User", "ApiKey" FROM cf_api, cf_worker;
    GRANT SELECT, INSERT ON "Tenant" TO cf_api;
    GRANT SELECT, INSERT ON "User" TO cf_api;
    GRANT SELECT, INSERT ON "ApiKey" TO cf_api;
    GRANT UPDATE ("lastUsedAt", "revokedAt") ON "ApiKey" TO cf_api;
  END IF;
  IF to_regclass('public."Session"') IS NOT NULL THEN
    REVOKE ALL ON "Session" FROM cf_api, cf_worker;
    GRANT SELECT, INSERT, DELETE ON "Session" TO cf_api;
  END IF;
  -- Membresías e invitaciones (ADR 0019): el API cambia el ROL de un miembro y lo quita (no reescribe a quién pertenece cada
  -- fila); las invitaciones se crean, se leen y se marcan aceptadas o revocadas, nunca se borran; la sesión solo cambia de espacio activo.
  IF to_regclass('public."Membership"') IS NOT NULL THEN
    REVOKE ALL ON "Membership" FROM cf_api, cf_worker;
    GRANT SELECT, INSERT, DELETE ON "Membership" TO cf_api;
    GRANT UPDATE ("role") ON "Membership" TO cf_api;
  END IF;
  IF to_regclass('public."Invitation"') IS NOT NULL THEN
    REVOKE ALL ON "Invitation" FROM cf_api, cf_worker;
    GRANT SELECT, INSERT ON "Invitation" TO cf_api;
    GRANT UPDATE ("acceptedAt", "acceptedBy", "revokedAt") ON "Invitation" TO cf_api;
  END IF;
  IF to_regclass('public."Session"') IS NOT NULL THEN
    GRANT UPDATE ("tenantId") ON "Session" TO cf_api;
  END IF;
  -- Claves externas (ADR 0020): el GRANT SELECT ... ON ALL TABLES de arriba le habría dado a cf_worker la lectura del cifrado.
  -- cf_api reemplaza el cifrado y borra de verdad; sin TRUNCATE. cf_worker no tiene ningún permiso: la clave le llega del API.
  IF to_regclass('public."TenantExternalKey"') IS NOT NULL THEN
    REVOKE ALL ON "TenantExternalKey" FROM cf_api, cf_worker;
    GRANT SELECT, INSERT, DELETE ON "TenantExternalKey" TO cf_api;
    GRANT UPDATE ("ciphertext", "keyVersion", "last4", "rotatedAt") ON "TenantExternalKey" TO cf_api;
  END IF;
END
$$;
