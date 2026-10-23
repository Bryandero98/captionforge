-- Invitaciones y gestión de miembros (ADR 0019). La estructura sale de `prisma migrate diff`; los permisos están escritos a mano.
-- Solo se guarda el SHA-256 del token: el enlace se enseña una vez al crearlo.


-- CreateTable
CREATE TABLE "Invitation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedBy" UUID,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_tenantId_idx" ON "Invitation"("tenantId");

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_acceptedBy_fkey" FOREIGN KEY ("acceptedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Permisos de mínimo privilegio (se repiten en docker/postgres/init-roles.sql para sobrevivir a una re-ejecución).
-- Miembros: cambiar el ROL y quitar a alguien (la regla del Último Dueño la aplica el servicio, dentro de una transacción con
-- bloqueo de filas; FOR UPDATE necesita el permiso UPDATE). No se pueden reescribir las claves (a quién pertenece cada fila).
-- Invitaciones: crear, leer y marcarlas como aceptadas o revocadas; nunca borrarlas ni cambiar su rol, su espacio o su token.
-- Sesión: solo el espacio activo.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cf_api') THEN
    GRANT UPDATE ("role") ON "Membership" TO cf_api;
    GRANT DELETE ON "Membership" TO cf_api;
    REVOKE ALL ON "Invitation" FROM cf_api;
    GRANT SELECT, INSERT ON "Invitation" TO cf_api;
    GRANT UPDATE ("acceptedAt", "acceptedBy", "revokedAt") ON "Invitation" TO cf_api;
    GRANT UPDATE ("tenantId") ON "Session" TO cf_api;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cf_worker') THEN
    REVOKE ALL ON "Invitation" FROM cf_worker;
  END IF;
END
$$;
