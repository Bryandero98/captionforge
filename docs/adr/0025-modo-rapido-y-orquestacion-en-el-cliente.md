# ADR 0025: Modo Rápido, perfiles de uso y orquestación en el navegador (fase 1)

- Estado: aceptado (v1.3.0, iniciativas «Sube y olvídate» y «Resultado rápido vs Control total»)
- Relacionado: [ADR 0024](0024-subtitulos-ass-y-formato-vertical.md) (formato vertical y su tope), [ADR 0023](0023-audio-puro-como-entrada.md) (audio como entrada); hoja de ruta en [`docs/ROADMAP.md`](../ROADMAP.md) y plan en `tasks/v1.3.0/plan.md`

## Contexto

Hasta la v1.2.0 la pantalla de subida pedía de entrada seis decisiones técnicas (modelo, idioma, traducción, limpieza de ruido, hablantes y, después, el
formato del quemado), y cada paso posterior (esperar la transcripción, abrir el resultado, crear el video) lo daba la persona a mano. Quien sube un Short
de 40 segundos quiere el video con subtítulos sin entender qué es un modelo `small`; quien sube una reunión de una hora quiere saber quién habla. El
sistema ya sabía hacer todo eso: faltaba **decidir por la persona con lo que se sabe del archivo** y **encadenar** el siguiente paso, sin ensanchar el
contrato de la API ni guardar nada sensible.

## Decisión

1. **Los perfiles son una tabla del cliente, no un concepto del servidor.** `domain/profiles.js` define cinco perfiles (`vertical`, `podcast`, `meeting`,
   `quick-clip`, `standard`) que se traducen a las **opciones explícitas de siempre** de `POST /v1/jobs/transcribe` y, si procede, a las del quemado.
   El contrato JSON, los esquemas y el worker no cambian: la intención de la persona nunca viaja ni se guarda. Un perfil jamás activa solo el idioma de
   origen, la traducción ni la limpieza de voz (cambian el resultado o cuestan tiempo); lo único que encadena es el quemado, que es local y barato.
2. **Análisis de intención como función pura.** `domain/intent.js` recibe clase (audio o video), duración y dimensiones, y devuelve un perfil y sus
   motivos como códigos cerrados (`intent.<code>`, traducidos en los 6 idiomas). Reglas ordenadas, la primera que casa gana, con **Estándar** como
   respaldo (equivale a los valores de siempre). Los umbrales viven en un solo objeto. Identificar hablantes solo se pide en Podcast y Reunión, con
   duración conocida **menor de 60 minutos** (es lento en CPU) y solo si el servidor lo ofrece; la interfaz lo dice en el resumen.
3. **Lectura de metadatos con `preload="metadata"`.** `domain/media-probe.js` crea un `<video>` o `<audio>` fuera del DOM con `preload="metadata"`, lee
   duración y dimensiones y lo suelta. No sube nada ni decodifica el archivo: uno de 4 GiB cuesta lo mismo que uno de 4 MiB. Tiene un tiempo máximo de 4 s,
   la URL del objeto se revoca siempre y una sola vez, y nunca lanza: formatos que el navegador no lee (MKV o AVI en algunos) devuelven «desconocido» y el
   análisis cae a Estándar. Sin duración conocida no se promete el vertical (el servidor lo rechazaría con 413).
4. **El encadenado lo orquesta el navegador en la fase 1** (`ui/follow-up.js`). Al aceptarse la subida se registra, por archivo, qué quemado pedir; cuando
   el seguimiento SSE (o un sondeo por turnos de los demás trabajos del lote, uno cada 2 s) ve la transcripción `COMPLETED`, pide el quemado con el mismo
   `POST /v1/jobs/{id}/burn` que usa el botón manual. El encadenado se **elimina antes de esperar al servidor**, de modo que dos eventos iguales no crean
   dos quemados; un 409, un 413 o un fallo de red se avisa una vez y **no se reintenta** (no hay bucles). Un audio nunca encadena (no tiene imagen).
5. **La advertencia es parte del diseño.** Como el encadenado vive en la pestaña, la interfaz lo dice (`#quick-warning`: «Mantén esta pestaña abierta…»)
   mientras haya algo planeado o pendiente, y `beforeunload` pide confirmación si queda algún encadenado. Cerrar la pestaña pierde solo el encadenado: la
   transcripción sigue en el servidor y «Crear video» sigue disponible a mano en el resultado.
6. **Persistencia no sensible en `localStorage`** (`domain/prefs.js`, clave `cf-prefs`, versión 1). Una lista blanca de enums y booleanos con lectura
   estricta: lo que no es de la lista se descarta campo a campo, más de 2048 caracteres se ignora entero y un fallo de lectura o escritura (modo privado,
   datos bloqueados, cuota) deja los valores de siempre. **Nunca** se guardan claves de API, URL base, modelos de claves propias, nombres de archivo ni
   duraciones. Solo se escribe cuando la persona cambia un control; los perfiles y el análisis no se guardan.
7. **Siempre se abre en Modo Rápido.** El modo no se persiste: «Control total» (`<details id="advanced">`) nace plegado y se abre a mano cada vez. Tocar
   cualquier control pasa a **manual** (mandan los controles, para todos los archivos, y se guardan); elegir un perfil en el selector lo aplica a todos
   los archivos sin guardarlo; «Restablecer preferencias» borra solo `cf-prefs` (el idioma, la clave y el historial no se tocan). Sincronizar los
   controles desde el código no dispara `change`, así que solo los gestos de la persona cambian de modo.
8. **Lo único que se añade al servidor** es informativo: `GET /v1/capabilities` devuelve `limits.verticalMaxSeconds` y `burn.templates`, y
   `VERTICAL_MAX_SECONDS` (por defecto 600, máximo 86 400) se comparte entre el API y el worker. Así el cliente no codifica un 600 a ciegas y no
   promete lo que el servidor rechazaría.
9. **Accesibilidad.** El resumen es una región `role="status"` con `aria-live="polite"` que solo cambia de texto cuando cambia el plan (el texto inicial no
   se lee al cargar); la sugerencia tiene botones «Cambiar» (abre «Control total» y enfoca el selector de perfil) y «Descartar» (fija Estándar).

## Consecuencias

- Un solo clic con los valores por defecto crea el mismo trabajo que antes; los controles técnicos siguen existiendo con los mismos `id`.
- Los perfiles se afinan sin migraciones ni despliegue de servidor: es una tabla del cliente con pruebas puras.
- **Coste asumido:** el encadenado depende de que la pestaña siga abierta. No hay servidor que lo complete si se cierra; la interfaz lo avisa y el
  resultado conserva el botón manual. Con varios archivos, solo el último quemado encadenado queda abierto en pantalla (todos quedan en «Recientes»).
- La lectura de metadatos añade como mucho 4 s antes de subir un archivo que el navegador no sabe leer; para el resto es inmediata.
- Cada archivo analizado solo existe en memoria: no se guarda en el historial ni viaja al servidor ninguna señal del perfil sugerido.

## Alternativas descartadas

- **Orquestar en el servidor ya** (un `followUp` en el contrato de la transcripción): lo correcto a largo plazo, porque sobrevive a cerrar la pestaña,
  pero exige cambiar esquemas, encolado y reintentos. Queda para la fase 3 de la hoja de ruta; esta fase valida primero que los perfiles son los
  correctos sin tocar el contrato.
- **Perfiles en el servidor:** acoplaría un concepto de interfaz al contrato y obligaría a desplegar para afinar umbrales.
- **Analizar el archivo en el servidor tras subirlo:** gastaría ancho de banda y tiempo de cola antes de poder decidir; el navegador ya tiene los metadatos.
- **Guardar el último modo usado:** quien abre «Control total» una vez se quedaría sin la ayuda del modo rápido sin darse cuenta; se prefiere abrir siempre
  en rápido y recordar solo los valores.
- **Detectar el idioma o inferir la traducción:** cambia el resultado sin que la persona lo pida; no se hace nunca.

## Pruebas

- Dominio puro (`node --test`): `profiles`, `intent`, `media-probe`, `prefs`, `plan`, `capabilities`.
- Orquestación y modo: `follow-up` (una sola vez, 409/413 sin bucle, sondeo por turnos) y `quick-mode` (resumen, sugerencia, manual, lote mixto, almacenamiento roto).
- API: `capabilities.e2e`, `config.spec`, `compose-internal.spec` y `burn.e2e` (tope vertical compartido).
- Navegador (`web-browser.e2e.spec.ts`): flujo «Sube y olvídate» de un video vertical (sugerencia, aviso, quemado 9:16 encadenado), «Descartar» sin encadenado,
  «Control total» plegado que conserva lo ajustado al plegar y recargar, «Restablecer», y almacenamiento del navegador bloqueado.
