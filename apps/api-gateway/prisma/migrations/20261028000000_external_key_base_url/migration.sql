-- ADR 0022: URL base propia del proveedor (opcional). Aditiva: las dos columnas son nulas y las claves existentes no cambian.
-- baseUrlCiphertext lleva la URL cifrada con el mismo AES-GCM que la clave; baseUrlHost solo el nombre del host, para mostrarlo.

-- AlterTable
ALTER TABLE "TenantExternalKey" ADD COLUMN "baseUrlCiphertext" TEXT,
ADD COLUMN "baseUrlHost" TEXT;

-- Permisos: cf_api puede reemplazar o borrar la URL junto con la clave (UPDATE solo de columnas concretas); cf_worker sigue sin ningún
-- permiso sobre la tabla (se repite en docker/postgres/init-roles.sql).
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cf_api') THEN
    GRANT UPDATE ("baseUrlCiphertext", "baseUrlHost") ON "TenantExternalKey" TO cf_api;
  END IF;
END
$$;
