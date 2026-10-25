-- Un solo trabajo derivado ACTIVO (quemar, traducir, doblar) por transcripción y clase. Antes lo garantizaba un count() previo al create(),
-- que no es atómico: dos peticiones simultáneas pasaban las dos y encolaban dos trabajos idénticos. Ahora lo impone la base de datos.
-- Prisma no expresa índices parciales: vive solo en esta migración (no en schema.prisma).

-- Si ya hubiera duplicados activos (la carrera ocurrió), se conserva el más antiguo y los demás se cancelan, para que el índice se pueda crear.
UPDATE "Job" SET status = 'CANCELLED', "finishedAt" = now(), "updatedAt" = now()
WHERE id IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (PARTITION BY "parentJobId", kind ORDER BY "createdAt", id) AS n
    FROM "Job"
    WHERE "parentJobId" IS NOT NULL AND kind IN ('BURN', 'TRANSLATE', 'DUB') AND status IN ('QUEUED', 'RUNNING')
  ) ranked WHERE n > 1
);

CREATE UNIQUE INDEX "Job_one_active_derived_per_parent"
  ON "Job" ("parentJobId", kind)
  WHERE "parentJobId" IS NOT NULL AND kind IN ('BURN', 'TRANSLATE', 'DUB') AND status IN ('QUEUED', 'RUNNING');
