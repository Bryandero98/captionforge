-- ADR 0019: quién creó cada clave de API. Al dejar de ser Dueño de un espacio, las claves que creó en él se revocan en la misma
-- transacción que el cambio de rol. Las claves anteriores a esta columna quedan con createdBy nulo (no se pueden atribuir) y no
-- se tocan. Sin permisos nuevos: cf_api ya tiene INSERT en la tabla y UPDATE("revokedAt"), que es con lo que se revoca.

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "createdBy" UUID;

-- CreateIndex
CREATE INDEX "ApiKey_createdBy_idx" ON "ApiKey"("createdBy");

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
