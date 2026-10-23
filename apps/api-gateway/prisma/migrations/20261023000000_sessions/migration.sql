-- Inicio de sesión (ADR 0016): sesiones de navegador y los permisos que necesita el API para crear personas, tenants,
-- sesiones y claves. Sustituye lo que decía la migración de tenencia (el API no creaba nada): ahora el inicio de sesión lo
-- hace el propio API, así que cf_api recibe lo MÍNIMO para eso y nada más (no borra tenants, personas ni claves, no cambia
-- hashes ni dueños).

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Permisos de mínimo privilegio (se repiten en docker/postgres/init-roles.sql para sobrevivir a una re-ejecución).
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cf_api') THEN
    REVOKE ALL ON "Tenant", "User", "ApiKey", "Session" FROM cf_api;
    GRANT SELECT, INSERT ON "Tenant" TO cf_api;
    GRANT SELECT, INSERT ON "User" TO cf_api;
    GRANT SELECT, INSERT ON "ApiKey" TO cf_api;
    GRANT UPDATE ("lastUsedAt", "revokedAt") ON "ApiKey" TO cf_api;
    GRANT SELECT, INSERT, DELETE ON "Session" TO cf_api;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cf_worker') THEN
    REVOKE ALL ON "Session" FROM cf_worker;
  END IF;
END
$$;
