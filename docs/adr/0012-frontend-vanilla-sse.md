# ADR 0012: Frontend Vanilla JS con ES Modules y cliente SSE personalizado (fetch/ReadableStream)

## Estado
Aceptada

## Fecha
2026-10-21

## Contexto
Hace falta un cliente web para el nuevo API Gateway (fase 4b). El manejo asíncrono de eventos de servidor (SSE) es
crítico: el progreso de un trabajo (`GET /v1/jobs/:id/events`) es lo que el usuario mira durante minutos.

Restricciones del API que condicionan al cliente:

- El stream emite eventos con nombre `job` (el `JobView` completo) y `ping` cada 15 s, y tiene topes (200 flujos en
  total, 10 por cliente, 1800 s de duración). Rechazar con 429/503 y `Retry-After` es parte del contrato.
- `EventSource` no deja enviar cabeceras (`Authorization`, `X-API-Key`) ni leer el código de estado ni `Retry-After`
  de una respuesta fallida: ante cualquier error reintenta solo, a su ritmo, sin que el código se entere de por qué.
- La interfaz se sirve desde el propio API (mismo origen, CSP `default-src 'self'`, ADR 0011) y no hay un servidor web
  aparte.

## Decisión
1. **Vanilla JS, ES Modules nativos y cero build.** Sin framework, sin bundler: módulos `import`/`export` servidos tal
   cual desde `apps/web/public`, tipados con JSDoc y comprobados con `tsc --checkJs` (`npm run web:check`) y probados con
   el ejecutor de pruebas de Node (`npm run web:test`).
2. **Sin `EventSource`.** El seguimiento de trabajos usa un cliente SSE propio sobre `fetch` y `ReadableStream`
   (`apps/web/public/js/api/sse.js`): analiza el formato `text/event-stream`, expone los eventos al resto de la
   interfaz y se cierra al llegar el trabajo a un estado terminal (`COMPLETED`, `FAILED`, `CANCELLED`).
3. **Servido por `@fastify/static`** desde el mismo proceso que el API, sin Nginx ni otro servidor delante.

## Alternativas consideradas
- **`EventSource` nativo.** Más corto, pero sin acceso al estado HTTP ni a `Retry-After`, sin cabeceras de
  autenticación y con reintentos automáticos que ignoran los topes del API. Descartado.
- **Un framework (React, Vue, Svelte) con bundler.** Aporta componentes y estado reactivo, pero añade cadena de
  compilación, dependencias que auditar y un paso de despliegue; la interfaz son pocas pantallas con estado sencillo.
  Descartado por ahora; se revisa si crece el número de vistas.
- **Biblioteca de SSE de terceros (`@microsoft/fetch-event-source`).** Hace lo mismo que el cliente propio, pero
  añade una dependencia para unas decenas de líneas y obligaría a empaquetar. Descartada.

## Consecuencias
1. **Control del ciclo HTTP.** Se leen el 429/503 y `Retry-After` antes de abrir el stream, y el cliente decide si
   reintentar, cuándo y cuántas veces; permite también cabeceras si algún día se activa `API_KEY`.
2. **Rendimiento.** Cero bytes de bundle y sin paso de compilación: la página carga solo los módulos que usa y el
   tiempo hasta interactivo es el de descargarlos.
3. **Simplicidad operativa.** Un único proceso lo sirve todo; la imagen del API solo copia `apps/web/public`.
4. **Coste.** El analizador SSE y su reconexión son código nuestro y hay que probarlos a fondo (fragmentos partidos
   a mitad de línea, `\r\n`, comentarios, `ping`, corte a mitad de evento, cierre por estado terminal). Sin plantillas
   ni reactividad, la lógica de pintado la escribimos a mano, con `textContent` siempre (nunca `innerHTML`).
5. **Navegadores.** Se exige `fetch` con cuerpo en streaming (`response.body.getReader()`), disponible en todos los
   navegadores actuales; no se da soporte a los que no lo tengan.
