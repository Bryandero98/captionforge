-- ADR 0022: modelo opcional del proveedor (texto plano: no es un secreto). Aditiva: la columna es nula y las claves existentes no cambian.

-- AlterTable
ALTER TABLE "TenantExternalKey" ADD COLUMN "model" TEXT;

-- Permisos: cf_api lo reemplaza junto con la clave; cf_worker sigue sin ningún permiso sobre la tabla (se repite en docker/postgres/init-roles.sql).
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cf_api') THEN
    GRANT UPDATE ("model") ON "TenantExternalKey" TO cf_api;
  END IF;
END
$$;
