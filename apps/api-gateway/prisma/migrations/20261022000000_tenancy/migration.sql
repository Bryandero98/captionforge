-- Tenencia (ADR 0015): Tenant, User y ApiKey, y todo Job pasa a pertenecer a un Tenant.
--
-- Orden obligatorio sobre una base con datos: la columna nace NULA, se crea el tenant por defecto y se le asignan los
-- trabajos que ya existían, y solo entonces pasa a NOT NULL. Con `ADD COLUMN ... NOT NULL` directo la migración fallaría en
-- cualquier instalación que ya tenga trabajos. (Generada con `prisma migrate diff`: cf_owner no puede crear la shadow
-- database que exige `migrate dev`, por mínimo privilegio.)

-- CreateTable
CREATE TABLE "Tenant" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "provider" TEXT,
    "subject" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- 1. Columna nula
ALTER TABLE "Job" ADD COLUMN "tenantId" UUID;

-- 2. Tenant por defecto (id fijo: la semilla y las pruebas lo reconocen) y relleno de los trabajos existentes
INSERT INTO "Tenant" ("id", "name") VALUES ('00000000-0000-4000-8000-000000000001', 'Default');
UPDATE "Job" SET "tenantId" = '00000000-0000-4000-8000-000000000001' WHERE "tenantId" IS NULL;

-- 3. Permisos ANTES de endurecer la columna. Los privilegios por defecto darían DML completo a cf_api y lectura a
--    cf_worker sobre las tablas nuevas: se quitan y se concede solo lo necesario. El API solo LEE las claves y anota
--    cuándo se usaron; no puede crear ni borrar claves, tenants ni personas (eso lo hace el dueño: migración y semilla).
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cf_api') THEN
    REVOKE ALL ON "Tenant", "User", "ApiKey" FROM cf_api;
    GRANT SELECT ON "Tenant", "ApiKey" TO cf_api;
    GRANT UPDATE ("lastUsedAt") ON "ApiKey" TO cf_api;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cf_worker') THEN
    REVOKE ALL ON "Tenant", "User", "ApiKey" FROM cf_worker;
  END IF;
END
$$;

-- 4. NOT NULL
ALTER TABLE "Job" ALTER COLUMN "tenantId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_tenantId_idx" ON "User"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "User_provider_subject_key" ON "User"("provider", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_tenantId_idx" ON "ApiKey"("tenantId");

-- CreateIndex
CREATE INDEX "Job_tenantId_createdAt_idx" ON "Job"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "Job_tenantId_status_idx" ON "Job"("tenantId", "status");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
