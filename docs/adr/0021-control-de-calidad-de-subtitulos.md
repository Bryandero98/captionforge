# ADR 0021: Control de calidad de subtítulos (perfiles, verificador en el API)

## Estado
**Propuesta** (issue [#13](https://github.com/Bryandero98/captionforge/issues/13), PR #31). El Tech Lead aprobó el enfoque: el verificador vive **solo en el API**
y la interfaz únicamente consume y pinta el informe. Pasa a «Aceptada» al cerrar el PR. Plan y tareas: `tasks/plan.md` y `tasks/todo.md`.

## Contexto
Los subtítulos que salen de Whisper son correctos como texto pero no siempre aptos para leerse: demasiados caracteres por segundo (CPS), líneas largas (CPL),
subtítulos solapados o demasiado breves. Cada plataforma y cada norma de accesibilidad pide umbrales distintos. Queremos decir **qué incumple y por cuánto**,
sin cambiar el texto de nadie y sin duplicar la lógica en el navegador.

## Decisiones
1. **Perfiles como datos.** `apps/api-gateway/src/quality/profiles.ts` define `netflix`, `bbc`, `accessible` y `shorts` (obligatorio en la primera entrega).
   Cada uno cita su fuente y se valida al cargar (`validateProfile`): un perfil con números imposibles impide arrancar. Se eligió un módulo TypeScript tipado
   en lugar de JSON en `packages/contracts` porque el API es el único consumidor y la imagen de despliegue no incluye ese paquete; si más adelante lo consume otro
   componente, se mueve a JSON con esquema sin cambiar la forma.
2. **Verificador puro.** `checkQuality(segmentos, perfil)` no accede a base de datos, red ni reloj. Reglas: `cps`, `cpl`, `lines`, `duration_min`, `duration_max`,
   `gap_min`, `overlap`, `invalid_timing` y `balance`. Mide por puntos de código, sin etiquetas de formato ni espacios en los extremos (Whisper entrega « Hola»).
   Gravedad: `error`, `warning`, `info`. La nota es el porcentaje de subtítulos sin errores ni avisos.
3. **Solo lectura y mismo permiso que ver segmentos.** `GET /v1/jobs/:id/quality?profile=` (por defecto `netflix`) y `GET /v1/quality/profiles`. El informe lleva el
   `etag` de los subtítulos medidos para que la interfaz sepa cuándo quedó viejo. Reutiliza `getSegments`, así que hereda el aislamiento por tenant y los 404/409.
4. **Un perfil desconocido o mal formado es 400** y se rechaza antes de leer el almacenamiento.
5. **La propuesta de arreglo** (siguiente tarea) solo tocará tiempos y saltos de línea; el texto no cambia.

## Consecuencias
- La interfaz no necesita reglas propias: lo que ve es lo que midió el servidor.
- Los umbrales son una aproximación razonable de guías públicas; se contrastan con cada fuente antes de la v1.1 y pueden ajustarse sin tocar el verificador.
- Las reglas dependen de `fps` solo para convertir fotogramas de separación a milisegundos.

## Qué no cubre
- No evalúa la calidad de la transcripción ni la traducción, solo la presentación temporal y tipográfica.
- Una norma que exija reglas distintas (p. ej. por idioma) requiere un perfil nuevo.
