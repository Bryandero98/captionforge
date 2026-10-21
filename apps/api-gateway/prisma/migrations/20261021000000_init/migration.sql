-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "JobKind" AS ENUM ('TRANSCRIBE', 'BURN');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Job" (
    "id" UUID NOT NULL,
    "kind" "JobKind" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "stage" TEXT,
    "percent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "message" TEXT,
    "inputBucket" TEXT NOT NULL,
    "inputKey" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "outputPrefix" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "parentJobId" UUID,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Job_status_createdAt_idx" ON "Job"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Job_parentJobId_idx" ON "Job"("parentJobId");


-- Permisos de mínimo privilegio (ADR 0003). Los roles los crea la tarea pg-roles; si no existen
-- (CI, otro entorno, shadow database de `migrate dev`) la migración sigue funcionando sin ellos.
DO $$
BEGIN
  -- El worker nunca inserta ni borra trabajos: solo actualiza estas columnas.
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cf_worker') THEN
    GRANT UPDATE ("status", "stage", "percent", "message", "errorCode", "errorMessage",
                  "result", "startedAt", "finishedAt", "updatedAt")
      ON "Job" TO cf_worker;
  END IF;

  -- Nadie salvo el dueño toca el historial de migraciones (los privilegios por defecto se lo
  -- habrían dado a cf_api y, de lectura, a cf_worker).
  IF to_regclass('public."_prisma_migrations"') IS NOT NULL THEN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cf_api') THEN
      REVOKE ALL ON "_prisma_migrations" FROM cf_api;
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cf_worker') THEN
      REVOKE ALL ON "_prisma_migrations" FROM cf_worker;
    END IF;
  END IF;
END
$$;
