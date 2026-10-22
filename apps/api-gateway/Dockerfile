# API Gateway (NestJS + Prisma). Contexto de construcción: la RAÍZ del repositorio.
#   docker build -f apps/api-gateway/Dockerfile .
# La misma imagen sirve para el servicio `migrate` (prisma migrate deploy) y para `api-gateway`.

FROM node:25-alpine AS build
WORKDIR /repo

# Primero solo los package.json: la capa de dependencias se reutiliza mientras no cambien.
COPY package.json package-lock.json ./
COPY apps/api-gateway/package.json apps/api-gateway/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY tools/smoke/package.json tools/smoke/
RUN npm ci --ignore-scripts

COPY apps/api-gateway apps/api-gateway
COPY packages/contracts/schemas packages/contracts/schemas
COPY packages/contracts/generated/ts packages/contracts/generated/ts
RUN npm run build -w @captionforge/api-gateway \
 && npm prune --omit=dev --ignore-scripts

FROM node:25-alpine
ENV NODE_ENV=production
WORKDIR /repo

COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/package.json ./
COPY --from=build /repo/packages/contracts/package.json packages/contracts/package.json
COPY --from=build /repo/packages/contracts/schemas packages/contracts/schemas
COPY --from=build /repo/apps/api-gateway/package.json apps/api-gateway/package.json
COPY --from=build /repo/apps/api-gateway/dist apps/api-gateway/dist
COPY --from=build /repo/apps/api-gateway/prisma apps/api-gateway/prisma
COPY --from=build /repo/apps/api-gateway/prisma.config.ts apps/api-gateway/prisma.config.ts
# La interfaz web (JavaScript sin compilar) la sirve el propio API: por defecto /repo/apps/web/public (WEB_ROOT=off la desactiva).
COPY apps/web/public apps/web/public

# Sin privilegios de root. Los archivos de la imagen son de solo lectura para este usuario.
USER node
WORKDIR /repo/apps/api-gateway
EXPOSE 3000
CMD ["node", "dist/main.js"]
