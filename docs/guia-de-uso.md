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
| Dos pestañas editando lo mismo | La segunda en guardar verá el aviso de conflicto (no se pierde nada sin que lo decidas). |
