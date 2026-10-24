# Guía de uso del cliente web

[English version](user-guide.md)

La interfaz web se sirve desde la propia API (mismo origen): abre `http://localhost:3000/` con el servicio en marcha
(`npm run infra:up` y el API Gateway). Esta misma guía aparece dentro de la página, en «Cómo usar CaptionForge, paso a paso».

## Idioma

La interfaz usa el idioma de tu navegador si lo conoce: **español, inglés, portugués, francés, alemán o italiano**.
Se cambia con los botones ES · EN · PT · FR · DE · IT de la esquina y la elección se recuerda en este navegador.

Español e inglés están revisados. **Portugués, francés, alemán e italiano son traducción automática** pendiente de
revisión por hablantes nativos; la página lo avisa cuando se usan. Para corregir un texto, edita su tabla en
`apps/web/public/js/i18n/messages.<idioma>.js` y abre un PR (una prueba comprueba que no falte ninguna clave ni cambie
ningún marcador `{x}`).

## Paso a paso

1. **Elige tus videos.** Arrastra hasta 20 a la zona punteada o pulsa «Elige un archivo». Formatos: MP4, MOV, MKV, WEBM
   y AVI. Los archivos que no sirven se descartan y se explica por qué.
2. **Ajusta las opciones.** *Modelo*: Base es el más rápido y Medium el más preciso. *Idioma del audio*: déjalo en
   «Autodetectar» salvo que lo sepas. *Traducir a*: opcional, para obtener los subtítulos en otro idioma.
   *Limpiar ruido de fondo* (desactivado por defecto): actívalo si hay música o ruido fuerte sobre la voz. Tarda más, porque
   antes de transcribir se aísla la voz. Si no se puede limpiar, el trabajo sigue con el audio original y el resultado lo
   avisa («Audio limpiado: No»); con la limpieza aplicada indica «Audio limpiado: Sí».
   *Identificar quién habla* (desactivado por defecto): pone a cada subtítulo el nombre de quien lo dice, útil en
   entrevistas y reuniones. Tarda más y solo aparece activa si el servidor tiene un token de Hugging Face (ver
   «Activar la identificación de hablantes»). Si no se puede, el trabajo entrega la transcripción normal y el
   resultado lo avisa («Hablantes identificados: No»).
3. **Genera los subtítulos.** Pulsa «Generar subtítulos». Verás la subida y después las etapas del trabajo (preparar el
   audio, transcribir, traducir…). Con varios videos, se suben de uno en uno; si uno falla, la cola se detiene ahí y lo
   ya subido se conserva. Puedes cerrar la página: el trabajo sigue en el servidor y queda en «Recientes».
4. **Revisa y corrige.** Edita el texto y los tiempos de cada subtítulo. Guarda con «Guardar cambios» o con Ctrl+S. Si los
   subtítulos cambiaron mientras los editabas (otra pestaña, otra persona), la página lo avisa y te deja elegir entre
   cargar la versión nueva o guardar tus cambios encima. Si se identificaron hablantes, cada subtítulo muestra quién
   habla (con un color) y el panel «Hablantes» deja renombrarlos: el cambio vale para todos sus subtítulos y se
   guarda con el resto.
5. **Descarga.** El `.srt` sirve en casi cualquier reproductor y editor; el `.vtt` es para la web. Guarda antes los
   cambios para que el `.srt` los incluya. Con hablantes, la casilla «Poner el nombre del hablante delante del texto»
   añade «Nombre: » en el `.srt` y el `.vtt`.
6. **Pon los subtítulos en el video.** Elige un estilo (Moderno, TikTok, YouTube, Minimalista) y, si el video tiene
   tiempos por palabra, activa el karaoke. «Crear video con subtítulos» lanza un trabajo aparte; al terminar puedes
   verlo en la página y descargarlo.
7. **Traduce o dobla (opcional).** Con una transcripción terminada y los cambios guardados, «Traducir los subtítulos» y
   «Doblar con voz sintética» crean trabajos aparte. Traducir funciona sin cuenta externa; doblar necesita la clave de un
   proveedor guardada por el Dueño. Ver las secciones siguientes.

## Claves externas (solo el Dueño)

«Doblar» y la traducción con OpenAI usan **tu propia cuenta** de OpenAI o ElevenLabs (BYOK, *bring your own key*). CaptionForge
no cobra ese cómputo: lo cobra tu proveedor, al precio de tu cuenta. Las claves se guardan por espacio de trabajo
(ADR [0020](adr/0020-ia-avanzada-y-claves-externas-byok.md)).

1. Inicia sesión (`LOCAL_MODE=false`) con un usuario **Dueño** del espacio. El botón **Claves externas** de la barra superior solo
   aparece para el Dueño.
2. Crea una clave de API en tu cuenta de [OpenAI](https://platform.openai.com/api-keys) o de ElevenLabs.
3. Pégala en el campo del proveedor y pulsa **Guardar**. Para cambiarla, pega la nueva y pulsa **Reemplazar**. Para quitarla,
   **Borrar** y confirma pulsando otra vez.

Qué hay que saber:

- La clave se guarda cifrada y **no se vuelve a mostrar**: la lista solo enseña «Guardada: …» con sus últimos 4 caracteres.
  Si la pierdes, vuelve a pegarla.
- Solo el Dueño, con sesión, guarda, reemplaza o borra. El **Editor usa** las claves al lanzar trabajos sin verlas; el **Lector**
  no lanza trabajos. Las claves de API del espacio tampoco pueden gestionarlas.
- Las claves son del espacio, no de la persona: si dejas de ser Dueño, siguen en uso para el equipo.
- Una clave debe tener el formato del proveedor (OpenAI empieza por `sk-`) y 20 o más caracteres; si no, se rechaza sin repetir lo
  que pegaste.
- Nunca pegues una clave en un chat, un issue o un commit. Si se filtra, revócala en el panel de tu proveedor y pega otra.
- Si el servidor no tiene activada la función (no hay `APP_SECRET`), no hay panel y «Doblar» queda bloqueado. Quien administra el
  servidor la activa según el [runbook de `APP_SECRET`](runbook-app-secret.md).

### Otras IA compatibles con OpenAI: DeepSeek, Groq, OpenRouter, modelos locales

La fila de OpenAI tiene dos campos opcionales, **URL base (API compatible)** y **Modelo**. Con ellos la traducción usa otro
servicio que hable el mismo protocolo que OpenAI, con tu propia clave de ese servicio (ADR [0022](adr/0022-url-base-propia-para-proveedores-de-ia.md)).

| Servicio | URL base | Modelo de ejemplo |
|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| OpenRouter | `https://openrouter.ai/api/v1` | `openai/gpt-4o-mini` |
| Gemini (capa compatible) | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` |
| Ollama en tu equipo* | `http://localhost:11434/v1` | `llama3.1:8b` |

Revisa en la documentación de cada servicio la URL y los nombres de modelo vigentes; los de la tabla son ejemplos.
Vacíos, se usa OpenAI con su modelo por defecto (`gpt-4o-mini`).

- La **URL no se vuelve a mostrar**: queda cifrada y la lista solo enseña el servidor («Servidor: api.deepseek.com»). Al
  reemplazar la clave hay que volver a escribirla; un reemplazo sin URL vuelve a OpenAI. El modelo sí se ve y se propone de nuevo.
- Solo se aceptan servidores **públicos por https**. El worker resuelve el DNS antes de cada petición y, si el nombre apunta a una
  red privada, cancela el trabajo **sin enviar la clave**.
- \* Para usar un modelo local (Ollama, vLLM) quien administra el servidor pone `ALLOW_PRIVATE_BASE_URLS=true` en el `.env`
  (por defecto está apagada). Entonces se aceptan direcciones locales y privadas, también por http. Los metadatos de nube
  (`169.254.x.x`) siguen bloqueados siempre. Desde Docker, un Ollama en tu equipo se alcanza con `http://host.docker.internal:11434/v1`.
- La confirmación de gasto y la estimación de «Traducir» muestran el servidor y el modelo que configuraste.

## Calidad de los subtítulos

Debajo de los datos de la transcripción está el panel **Calidad de los subtítulos**. Elige una **norma** (Netflix en inglés o en español, BBC, Accesible o Cortos verticales) y pulsa **Revisar**: te dice qué subtítulos leen demasiado rápido, tienen líneas largas, duran poco o mucho, o están pegados o solapados con el anterior, y por cuánto. Cada aviso dice su gravedad con palabras (Error, Aviso, Sugerencia).

- Cada norma indica cuánto se verificó contra su guía oficial. Es una medida, no una certificación.
- **Proponer arreglo** (Editor o Dueño) muestra qué cambiaría antes de tocar nada: solo el final de cada subtítulo y los saltos de línea; **el texto nunca se modifica**. Con **Aplicar el arreglo** se guarda y se vuelve a revisar; **Descartar** no cambia nada.
- Lo que no se puede resolver sin cambiar el texto (por ejemplo, una frase demasiado larga para leerla a tiempo) queda como pendiente para que lo decidas tú.
- Si tienes cambios sin guardar en el editor, primero guárdalos o descártalos.

## Traducir los subtítulos

1. Con la transcripción terminada y **sin cambios sin guardar** (si los hay, el botón se desactiva y la página lo explica),
   abre «Traducir los subtítulos».
2. En *Motor* elige **En este equipo (sin costo)**, que usa Argos en el servidor, u **OpenAI (con tu clave)**, que necesita la clave
   de OpenAI guardada por el Dueño. En *Traducir a* elige el idioma de destino, que debe ser distinto del detectado.
3. Pulsa **Traducir**. Con OpenAI aparece antes la [confirmación de gasto](#confirmación-de-gasto-y-topes).
4. Al terminar descarga el **.srt traducido** o el **.vtt traducido**. La traducción es un trabajo aparte: los subtítulos
   originales no cambian.

Solo puede haber una traducción en curso por transcripción; espera a que termine o cancélala.

## Doblar con voz sintética

1. Con la transcripción terminada y los cambios guardados, abre «Doblar con voz sintética».
2. *Voz de*: OpenAI o ElevenLabs. En *Voz* escribe el nombre de la voz de OpenAI (por ejemplo `alloy`, `nova` u `onyx`; viene
   `alloy` propuesta) o pega el ID de una voz de tu cuenta de ElevenLabs.
3. *Texto a doblar*: los subtítulos originales o una traducción ya terminada.
4. *Salida*: solo la pista de voz (`.mp3`), el video con la voz doblada **en lugar** del audio original (`replace`), o el video
   con el audio original **bajado** bajo la voz (`duck`).
5. Pulsa **Doblar**, confirma el gasto y descarga el **audio (.mp3)** o el **video doblado (.mp4)** al terminar.

Cómo encaja la voz en el tiempo: cada frase se acelera o se frena entre 0,85x y 1,25x para caber en su hueco, y nunca se
solapan dos voces. Si una frase no cabe ni acelerando al máximo, termina después de lo previsto y el resultado avisa
(«N frases no caben en su tiempo…»): acorta ese subtítulo o acepta el desfase. Los segmentos en blanco no se envían ni se
cobran. Solo puede haber un doblaje en curso por transcripción.

## Confirmación de gasto y topes

Antes de enviar texto a un proveedor externo, la página abre un cuadro: «Esta operación usa tu cuenta de OpenAI. Estimación:
≈ N caracteres (≈ M tokens). El cobro lo hace tu proveedor y no se puede deshacer». El foco empieza en **Cancelar** y Esc también cancela,
así que Enter no gasta por descuido. La traducción local no pregunta, porque no cuesta.

Como referencia de consumo (la misma tabla está en la guía de la página y en «Claves externas»):

| Duración del habla | Caracteres enviados a la IA | Tokens aprox. |
|---|---|---|
| 15 s | 200 | 50 |
| 30 s | 400 | 100 |
| 45 s | 600 | 150 |
| 60 s | 800 | 200 |

Es una estimación: 1 token ≈ 4 caracteres, y la respuesta de la IA gasta otros tantos tokens, así que cuenta aproximadamente
el doble. El precio por token lo fija tu proveedor.

Cada trabajo tiene un tope de **50 000 caracteres** y **1 000 subtítulos**, valores por defecto que quien administra el servidor
ajusta con `MAX_JOB_CHARACTERS` y `MAX_JOB_SEGMENTS`. Si el texto lo supera, el servidor lo rechaza **antes** de pedir nada al
proveedor. Aún no hay topes diarios ni mensuales por espacio: el gasto total depende de tu cuenta con el proveedor, así que
conviene fijar un límite de gasto allí.

## En modo local

En una instalación de una sola persona sin inicio de sesión (`LOCAL_MODE=true`, la predeterminada) no se ofrece BYOK:
no hay botón «Claves externas» (guardar claves exige ser Dueño con sesión) y «Doblar» queda bloqueado con la explicación «este
servidor no las tiene activadas (no están disponibles en modo local)». **Traducir sigue funcionando con el motor local (Argos)**,
sin clave ni costo. Para doblar o traducir con OpenAI, usa un servidor con inicio de sesión (`LOCAL_MODE=false`).

## Qué hay que saber

- Los resultados se **borran del servidor pasado un día**. «Recientes» solo guarda los identificadores en este
  navegador, no los videos.
- La interfaz web usa la clave de API del `.env` (`DEFAULT_API_KEY`, la crea `start.sh` / `start.bat`) y la manda sola. Si ves
  «La clave de acceso de esta interfaz falta, no es válida o fue revocada», revisa esa variable y reinicia el servicio (ADR 0015). En un servidor compartido con inicio de sesión (`LOCAL_MODE=false`) entras con GitHub o Google y creas tus propias claves de API con el botón **Claves de API** (ADR 0016).
- Los trabajos son de quien tiene la clave: con otra clave no se ven (ni se pueden cancelar, editar o descargar).
- **Equipos** (servidor compartido, ADR 0019): un espacio de trabajo puede tener varias personas. **Dueño** gestiona el equipo y las claves;
  **Editor** sube y edita; **Lector** solo ve y descarga. Para invitar, el Dueño abre **Equipo**, elige el rol y copia el enlace: sirve una
  sola vez y vence en 7 días. Quien lo abre inicia sesión (o se registra) y ve «¿Deseas unirte a este espacio?» con el nombre del espacio y el rol; entra al pulsar **Unirme** (nunca se une solo). Si tienes varios espacios, el selector de
  la barra superior cambia entre ellos. El último Dueño no se puede quitar ni degradar: promueve antes a otra persona.
- El video con subtítulos se previsualiza en la página solo hasta 256 MiB; por encima, la descarga funciona igual.
- Teclado: toda la interfaz se maneja con Tab/Enter/Espacio; Ctrl+S guarda los cambios; los avisos importantes se
  anuncian a lectores de pantalla.

## Activar la identificación de hablantes

Es opcional y la hace el servidor, no el navegador. Quien administra el servidor necesita:

1. Una cuenta gratuita en <https://huggingface.co> y, con ella iniciada, aceptar las condiciones de uso de los
   modelos <https://huggingface.co/pyannote/speaker-diarization-3.1> y
   <https://huggingface.co/pyannote/segmentation-3.0> (un botón en cada página; la aceptación es inmediata).
2. Un token en <https://huggingface.co/settings/tokens> → *Create new token* → tipo **Read** (solo lectura).
3. Poner el token SOLO en el entorno del worker: `HF_TOKEN=hf_...` en el `.env` de Docker Compose o
   `HF_TOKEN_FILE=ruta/al/archivo` (un archivo con el token o con una línea `HF_TOKEN=...`). El API no recibe el
   token; solo sabe que la función está disponible (`GET /v1/capabilities`) y la web activa la casilla.
4. Construir el worker con el componente: `docker build --build-arg WITH_DIARIZATION=1 …` (o instalar
   `apps/ai-worker/requirements-diarization.txt`). El modelo (~100 MB) se descarga la primera vez.

Nunca pegues el token en un chat, un issue ni un commit. Si se filtra, revócalo en la misma página de tokens.

## Si algo falla

| Síntoma | Qué hacer |
|---|---|
| «El servidor está ocupado. Reintenta en N s.» | Es el límite de subidas por minuto: espera la cuenta atrás, se reintenta con el botón. |
| «Estos subtítulos ya no están en el servidor» | Pasó más de un día: sube el video de nuevo. |
| La subida de un archivo enorme termina en error de red | El servidor rechaza antes de recibirlo si supera el máximo; revisa el tamaño que indica la zona de subida. |
| «No se pudo limpiar el ruido de fondo…» en el resultado | La separación de voz falló (por ejemplo, sin memoria de GPU o sin el componente instalado) y se transcribió el audio original: revisa los subtítulos con más atención o prueba sin la opción. |
| La casilla «Identificar quién habla» está desactivada | El servidor no tiene el token de Hugging Face ni el componente instalado: ver «Activar la identificación de hablantes». |
| «No se pudo identificar quién habla…» en el resultado | La identificación falló (token sin permiso o revocado, sin red, sin memoria o tiempo agotado) y se entregó la transcripción normal. Comprueba que aceptaste las condiciones de los dos modelos y vuelve a intentarlo. |
| «Falta la clave del proveedor. Un Dueño del espacio debe guardarla antes en “Claves externas”» (409, o el trabajo falla con `EXTERNAL_KEY_MISSING`) | El espacio no tiene guardada la clave de ese proveedor. Pide a un Dueño que la pegue en **Claves externas** y vuelve a lanzar el trabajo. |
| «Este servidor no tiene activadas las claves externas propias» | El servidor no tiene `APP_SECRET`. Quien lo administra debe definirlo (ver el [runbook](runbook-app-secret.md)); en modo local la función no existe. |
| «El proveedor rechazó la clave…» (`EXTERNAL_AUTH_FAILED`) | La clave es incorrecta, está revocada o no tiene permiso. El Dueño la reemplaza en **Claves externas**. No se reintenta. |
| «Tu cuenta del proveedor se quedó sin saldo o llegó a su límite» (`EXTERNAL_QUOTA_EXCEEDED`) | Recarga la cuenta o sube su límite en el panel del proveedor y lanza el trabajo de nuevo. No se reintenta. |
| «El proveedor está recibiendo demasiadas peticiones» (`EXTERNAL_RATE_LIMITED`) | El servidor ya reintentó con esperas crecientes. Espera unos minutos y vuelve a lanzarlo. |
| «El proveedor tardó demasiado» o «no está disponible» (`EXTERNAL_TIMEOUT`, `EXTERNAL_UNAVAILABLE`) | Fallo temporal del proveedor, tras varios reintentos. Inténtalo más tarde. Si ocurre con todos los trabajos y la clave estaba bien, avisa a quien administra el servidor: puede ser un problema de `APP_SECRET` (ver el [runbook](runbook-app-secret.md)). |
| «El texto es demasiado largo para un solo trabajo» (413 o `JOB_TOO_LARGE`) | Superas 50 000 caracteres o 1 000 subtítulos (valores por defecto). Divide el video en partes. |
| «Los subtítulos ya están en ese idioma» | El idioma de destino coincide con el detectado: elige otro. |
| «Ya hay una traducción (o un doblaje) en curso…» | Solo uno por transcripción. Espera a que termine o cancélalo. |
| «N frases no caben en su tiempo…» en un doblaje | El audio se entrega completo; esas frases terminan después de lo previsto. Acórtalas en el editor y dobla de nuevo si importa el sincronismo. |
| Dos pestañas editando lo mismo | La segunda en guardar verá el aviso de conflicto (no se pierde nada sin que lo decidas). |
