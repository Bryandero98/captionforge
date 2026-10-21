# Cómo contribuir

El repositorio tiene dos partes con flujos distintos:

- **Paquete heredado** (`legacy/`, el que se publica en PyPI): ver [legacy/CONTRIBUTING.md](legacy/CONTRIBUTING.md).
- **Monorepo nuevo** (`packages/`, `docker/`, `tools/`, `apps/`): esta guía.

## Antes de abrir un PR en el monorepo

```sh
npm install
npm run contracts:check      # lo generado coincide con los esquemas
npm run contracts:test       # Ajv y Pydantic aceptan y rechazan lo mismo
npm run compose:check        # el compose es válido con y sin el perfil app
npm run infra:up && npm run infra:verify && npm run smoke   # si tocaste docker/ o los contratos
npm run infra:down
```

## Reglas

- **Los esquemas son la fuente de verdad.** Cambia `packages/contracts/schemas/*.json`, añade un
  ejemplo válido y uno inválido en `examples/`, ejecuta `npm run contracts:gen` y sube también lo
  generado. Un cambio incompatible crea `*.v2.json`; no se edita un `v1` publicado.
- **Una decisión importante, un ADR** en `docs/adr/` (siguiente número libre).
- **Secretos nunca en git.** Van en `.env` (ignorado); `.env.example` solo lista los nombres.
- Una prueba que falla primero, y luego el arreglo.
