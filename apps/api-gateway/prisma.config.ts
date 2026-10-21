import { defineConfig } from "prisma/config";

// DATABASE_URL la pone el entorno (scripts/with-env.mjs en local, el compose en despliegue).
// Para migraciones debe ser la del dueño del esquema (cf_owner), nunca la de cf_api.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
