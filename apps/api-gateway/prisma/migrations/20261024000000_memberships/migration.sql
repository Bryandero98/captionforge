-- Equipos (ADR 0019): membresías con roles. Primera mitad de «expandir y contraer»: se AÑADE el modelo nuevo y se rellena
-- desde el anterior; User.tenantId se queda como está (se retira en una entrega posterior, cuando nada lo lea).
-- La estructura sale de `prisma migrate diff`; el relleno y los permisos están escritos a mano.


-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'EDITOR', 'VIEWER');

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "tenantId" UUID;

-- CreateTable
CREATE TABLE "Membership" (
    "userId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("userId","tenantId")
);

-- CreateIndex
CREATE INDEX "Membership_tenantId_idx" ON "Membership"("tenantId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Relleno: hasta hoy cada persona tenía acceso completo a su tenant (Tenant 1:N User), es decir, era Dueña. Se conserva ese
-- acceso: una membresía OWNER por cada User existente, sobre el tenant que ya tenía. No inventa roles ni espacios.
INSERT INTO "Membership" ("userId", "tenantId", "role")
SELECT "id", "tenantId", 'OWNER'::"Role" FROM "User";

-- Permisos de mínimo privilegio (se repiten en docker/postgres/init-roles.sql para sobrevivir a una re-ejecución).
-- Por ahora el API solo lee membresías y crea la del Dueño al registrarse una persona; cambiar roles y quitar miembros
-- llegan con su propia migración.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cf_api') THEN
    REVOKE ALL ON "Membership" FROM cf_api;
    GRANT SELECT, INSERT ON "Membership" TO cf_api;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cf_worker') THEN
    REVOKE ALL ON "Membership" FROM cf_worker;
  END IF;
END
$$;
