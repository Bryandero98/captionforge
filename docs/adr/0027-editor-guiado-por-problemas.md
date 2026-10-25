# ADR 0027: editor guiado por problemas y medición sin estado

- Estado: aceptado (v1.3.0, iniciativa 4 «Editor guiado por problemas»)
- Relacionado: [ADR 0021](0021-control-de-calidad-de-subtitulos.md) (verificador y arreglo), [ADR 0025](0025-modo-rapido-y-orquestacion-en-el-cliente.md) (Sube y olvídate), [ADR 0026](0026-temas-visuales-y-vista-previa-en-css.md); diseño en `tasks/v1.3.0/plan-phase2.md`

## Contexto

El control de calidad (ADR 0021) entregaba un informe aparte: «Revisar», «Proponer arreglo», «Aplicar». Medía solo lo **guardado**, así que quien editaba tenía que
guardar para saber si había mejorado, y los problemas no estaban donde se editaba. Ninguna regla se calcula en el navegador, y eso no cambia.

## Decisión

1. **Medición sin estado.** `POST /v1/jobs/:id/quality/check` recibe `{ profile, segments: [{ start, end, text }] }` y responde el informe más `fixes`: por subtítulo, las `rules`
   que resuelve, los `kinds` (`line_break`, `timing`) y la `edit` lista para escribirse (`text`, `start`, `end`). Reutiliza `checkQuality` y `proposeFix` tal cual, no lee ni escribe
   subtítulos y solo exige que el trabajo sea del tenant y esté terminado (404 y 409 como `GET /quality`). Topes: los mismos de `PUT /segments` (20 000 subtítulos, 2 000 caracteres
   por texto, tiempos de 0 a 1 000 000 s, cuerpo de 4 MB). Los tiempos incoherentes se aceptan: el verificador los marca (`invalid_timing`). Cuenta contra el límite general de peticiones.
2. **El navegador solo pinta.** `domain/guided-session.js` (sin DOM) hace la medición: espera de 600 ms, cancelación con `AbortController`, número de secuencia para descartar
   respuestas viejas y la bandera `fresh`, que impide aplicar un arreglo calculado sobre un texto que ya cambió. Si el editor tiene un valor que el servidor rechazaría
   (rango, largo, línea en blanco, tiempo ilegible), la medición se **pausa** y se dice por qué, en vez de mandar basura.
3. **Arreglar = escribir un borrador.** Aplicar un arreglo no guarda: escribe en el estado local (`applyFixes` en `editor-state`) y se guarda con el flujo de siempre (`PUT` con etag).
4. **Deshacer obligatorio.** `editor-state` gana una pila acotada a 50 pasos. Cada paso apunta, por subtítulo, los campos que tocó el arreglo y su borrador previo; deshacer restaura
   solo eso y no pisa lo escrito en otros subtítulos. «Arreglar todos» es un solo paso. Guardar o descartar vacía la pila.
5. **Interfaz sin color como único canal.** Cabecera con la insignia («Calidad 92 % · 3 avisos») y una ficha por regla con plural («3 demasiado rápidos», «1 solapamiento»); marca por
   fila con icono **y** palabra (Error, Aviso, Sugerencia); botón «Arreglar: <qué cambia>»; «Ignorar» (solo en la sesión); minimapa **lógico** como lista de botones (`role="list"`) que
   reparte el tiempo en tramos de al menos 24 px, sin onda. El foco vuelve al subtítulo tras arreglar o deshacer y las acciones se anuncian con `aria-live`.
6. **Convivencia con «Sube y olvídate».** No se bloquea nada: el video se crea al terminar la transcripción como en la fase 1. Al abrir el resultado se mide solo, y la insignia
   con «Revisar» lleva al primer problema.
7. **El panel de calidad anterior se conserva** (informe completo y arreglo en bloque contra lo guardado); el editor guiado es la vía para corregir mientras se edita.

## Consecuencias

- Una sola fuente de reglas (el API); el editor guiado no puede divergir del informe.
- Cada pausa al escribir cuesta una petición pequeña; la espera y la cancelación evitan ráfagas.
- Los arreglos solo tocan tiempos y saltos de línea: lo que exige decidir el texto queda marcado, sin botón.
- Un perfil o una regla nueva del API aparece sola; una regla desconocida usa un texto genérico hasta tener su frase.

## Alternativas descartadas

- **Portar las reglas a JS**: medición instantánea, pero duplica lógica y rompe el ADR 0021.
- **Guardar antes de medir**: obliga a guardar a cada pulsación o a medir con retraso.
- **Onda de audio en el minimapa**: diferida a la fase 3; el minimapa lógico ya orienta sin descargar nada.
- **Bloquear el encadenado hasta revisar**: contradice «Sube y olvídate».

## Pruebas

API: `quality-check.spec.ts` (servicio) y `quality.e2e.spec.ts` (HTTP real). Web: `editor-undo`, `quality-check-api`, `quality-view`, `quality-summary` y `guided-session`.
Navegador real: `guided-editor.e2e.spec.ts` (insignia, marcas, minimapa, arreglo de 1 clic sin guardar, nueva medición, deshacer, teclado, guardar con etag, pausa por tiempo inválido e «Ignorar»).
