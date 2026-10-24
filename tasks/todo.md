# Tareas del Issue #13 (v1.1): calidad de subtítulos y subtítulos dinámicos ASS

Plan: [plan.md](plan.md). Reglas: rojo → verde en cada tarea, verificación local (una suite del API a la vez), un PR, commits por tarea,
no fusionar sin orden del Tech Lead. **Estado: borrador, nada aprobado ni empezado.**

## Fase 0: decisiones
- [ ] T0 (S) ADR 0021 (calidad) y ADR 0022 (estilos dinámicos y licencias) en «Propuesta»; el Tech Lead resuelve las 6 decisiones pendientes del plan.

## Fase 1: contratos y datos
- [~] T1 (S) Perfiles (hechos como módulo TS tipado; falta contrastar los umbrales con cada fuente) `netflix`, `bbc`, `accessible`, `shorts` como JSON con esquema, fuente citada y pruebas de tabla.
  - Criterios: cada umbral cita su guía; el esquema rechaza reglas desconocidas.
- [ ] T2 (S) `Segment` y `Word` formales en `packages/contracts` (opcionales, aditivo); `burn-job` con `template` y `canvas` opcionales.
  - Verificación: `contracts:check` y paridad Node/Python; el quemado sin campos nuevos no cambia.

## Fase 2: calidad (API + UI)
- [x] T3 (M) Verificador puro (CPS, CPL, líneas, duración, separación, solape, equilibrio) y `GET /v1/jobs/:id/quality`.
  - Criterios: mismo permiso que ver segmentos; 404/409 coherentes; sin tocar la base.
  - Verificación: pruebas de tabla + `quality.e2e.spec.ts`.
- [ ] T4 (M) Propuesta de arreglo (`POST …/quality/fix`), invariantes con pruebas de propiedades.
  - Criterios: texto idéntico sin saltos; sin solapes nuevos; idempotente.
- [ ] T5 (M) Panel «Calidad» en la interfaz, 6 idiomas, accesible, aplicar la propuesta con el flujo de edición (ETag).
  - Verificación: pruebas web + e2e de navegador (clics DOM).

### Punto de control: calidad
- [ ] Informe correcto en transcripciones de prueba reales, arreglo seguro, suite verde.

## Fase 3: subtítulos dinámicos
- [ ] T6 (S) Exponer `words` en `GET /segments` y normalizador de palabras (orden, límites, solapes).
- [ ] T7 (M) Política de texto editado: alineación por palabra + reparto proporcional con marca `approximate`.
- [ ] T8 (M) Plantillas JSON validadas + generador ASS (escape del texto, pantallas de N palabras, resalte `sweep`/`pop`/`color`).
  - Verificación: archivos de referencia (golden) y pruebas con cargas hostiles (`{\\...}`, `\\N`, nombres de plantilla).
- [ ] T9 (M) Canvas 9:16 en `burn.py` (fondo desenfocado y recorte), topes de duración, cancelación y limpieza de `/work`.
  - Verificación: `test_burn_template.py` con ffmpeg real: fotograma de salida de 1080×1920 y el color de resalte presente en un fotograma muestreado.
- [ ] T10 (M) Interfaz: selector de plantilla y formato, vista previa de un fotograma, 6 idiomas, e2e de navegador.

### Punto de control: estilos
- [ ] Quemado de punta a punta con plantilla y 9:16 sobre un clip real; RAM y tiempo medidos.

## Fase 4: licencias, documentación y cierre
- [ ] T11 (S) `THIRD_PARTY_NOTICES.md` (ffmpeg con oferta de fuente, fuentes con su licencia), versión del binario fijada y prueba de CI que prohíbe bibliotecas de FFmpeg enlazadas en proceso.
- [ ] T12 (S) ADR 0021 y 0022 a «Aceptada», `architecture_and_security.md`, guías ES/EN, `CHANGELOG.md` v1.1, `graphify update`.
- [ ] T13 (XS) Revisión independiente (seguridad, base de datos, fallos silenciosos), apagar infraestructura, PR único.

### Punto de control: listo para revisión
- [ ] Criterios cumplidos, CI verde, sin cambios de comportamiento para quien no use las funciones nuevas.
