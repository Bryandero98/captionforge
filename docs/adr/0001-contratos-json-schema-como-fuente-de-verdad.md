# ADR 0001: Contratos en JSON Schema como fuente de verdad

## Estado
Aceptada

## Fecha
2026-10-21

## Contexto
El API Gateway (TypeScript) y el AI Worker (Python) intercambian mensajes por una cola. Si cada
lado define su propia forma del mensaje, divergen sin que nadie lo note hasta producción
(un campo renombrado, un número que llega como texto, una ruta con `..`).

## Decisión
Los mensajes se definen una vez, como JSON Schema 2020-12 en `packages/contracts/schemas/`
(`*.v1.json`, `additionalProperties: false`). De ahí se **generan** los tipos TypeScript
(`json-schema-to-typescript`) y los modelos Pydantic v2 (`datamodel-code-generator`); lo generado
se versiona y `npm run contracts:check` falla si no coincide con los esquemas.

La paridad se prueba con **los mismos ejemplos** (`examples/valid` e `invalid`) en Ajv estricto
(Node) y Pydantic estricto (Python, sin coerciones, `model_validate_json(raw, strict=True)`).

## Alternativas consideradas

### Definir los tipos en TypeScript y generar el esquema
- Pro: cómodo para quien solo escribe TypeScript.
- Contra: el generador de esquema pierde matices (patrones, formatos) y el lado Python queda como
  ciudadano de segunda.
- Descartada: el contrato es de los dos lados; ninguno debe ser el dueño.

### Protocol Buffers
- Pro: contrato fuerte, compatibilidad hacia atrás incorporada.
- Contra: BullMQ transporta JSON; habría que codificar y decodificar en cada extremo y se pierde
  legibilidad al depurar en Redis.
- Descartada: añade una capa sin un problema que resolver.

### Escribir los modelos a mano en cada lado
- Descartada: es exactamente el problema que se quiere evitar.

## Consecuencias
- Un cambio de contrato es un cambio de esquema + ejemplos + regeneración; la CI lo exige.
- Los patrones de los esquemas no pueden usar *lookahead*: Pydantic usa un motor de expresiones
  regulares (Rust) que no lo soporta, y Ajv (JavaScript) sí; un patrón que solo funcione en uno rompe
  la paridad.
- Los cambios incompatibles crean `*.v2.json`; un `v1` publicado no se edita.
