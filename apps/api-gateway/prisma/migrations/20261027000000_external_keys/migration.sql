-- ADR 0020: claves externas propias (BYOK) y los trabajos de traducir y doblar.
-- Aditiva: sin APP_SECRET la función queda apagada y nada de lo anterior cambia. Los valores nuevos de JobKind no se usan dentro de
-- esta misma transacción (PostgreSQL 12 o posterior lo permite).

-- CreateEnum
CREATE TYPE "ExternalProvider" AS ENUM ('openai', 'elevenlabs');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JobKind" ADD VALUE 'TRANSLATE';
ALTER TYPE "JobKind" ADD VALUE 'DUB';

-- CreateTable
CREATE TABLE "TenantExternalKey" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "provider" "ExternalProvider" NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "last4" TEXT NOT NULL,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3),

    CONSTRAINT "TenantExternalKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TenantExternalKey_createdBy_idx" ON "TenantExternalKey"("createdBy");

-- CreateIndex
CREATE UNIQUE INDEX "TenantExternalKey_tenantId_provider_key" ON "TenantExternalKey"("tenantId", "provider");

-- AddForeignKey
ALTER TABLE "TenantExternalKey" ADD CONSTRAINT "TenantExternalKey_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantExternalKey" ADD CONSTRAINT "TenantExternalKey_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Permisos de mínimo privilegio (se repiten en docker/postgres/init-roles.sql, que vuelve a conceder SELECT sobre todas las tablas
-- a cf_worker en cada `infra:up`: sin repetir aquí el REVOKE, el worker recuperaría la lectura del cifrado).
-- cf_api: crear, leer, reemplazar el cifrado (UPDATE solo de esas columnas: ni a quién ni a qué proveedor pertenece, ni quién la guardó primero) y borrar de
-- verdad: una clave retirada no debe quedar cifrada en la base. Sin TRUNCATE. cf_worker: NINGÚN permiso; la clave le llega del API.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cf_api') THEN
    REVOKE ALL ON "TenantExternalKey" FROM cf_api;
    GRANT SELECT, INSERT, DELETE ON "TenantExternalKey" TO cf_api;
    GRANT UPDATE ("ciphertext", "keyVersion", "last4", "rotatedAt") ON "TenantExternalKey" TO cf_api;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cf_worker') THEN
    REVOKE ALL ON "TenantExternalKey" FROM cf_worker;
  END IF;
END
$$;
