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
3. **Genera los subtítulos.** Pulsa «Generar subtítulos». Verás la subida y después las etapas del trabajo (preparar el
   audio, transcribir, traducir…). Con varios videos, se suben de uno en uno; si uno falla, la cola se detiene ahí y lo
   ya subido se conserva. Puedes cerrar la página: el trabajo sigue en el servidor y queda en «Recientes».
4. **Revisa y corrige.** Edita el texto y los tiempos de cada subtítulo. Guarda con «Guardar cambios» o con Ctrl+S. Si los
   subtítulos cambiaron mientras los editabas (otra pestaña, otra persona), la página lo avisa y te deja elegir entre
   cargar la versión nueva o guardar tus cambios encima.
5. **Descarga.** El `.srt` sirve en casi cualquier reproductor y editor; el `.vtt` es para la web. Guarda antes los
   cambios para que el `.srt` los incluya.
6. **Pon los subtítulos en el video.** Elige un estilo (Moderno, TikTok, YouTube, Minimalista) y, si el video tiene
   tiempos por palabra, activa el karaoke. «Crear video con subtítulos» lanza un trabajo aparte; al terminar puedes
   verlo en la página y descargarlo.

## Qué hay que saber

- Los resultados se **borran del servidor pasado un día**. «Recientes» solo guarda los identificadores en este
  navegador, no los videos.
- Con `API_KEY` configurada en el servidor la interfaz web no puede autenticarse (ver ADR 0011): úsala sin clave en local
  o detrás de un proxy que la gestione.
- Teclado: toda la interfaz se maneja con Tab/Enter/Espacio; Ctrl+S guarda los cambios; los avisos importantes se
  anuncian a lectores de pantalla.

## Si algo falla

| Síntoma | Qué hacer |
|---|---|
| «El servidor está ocupado. Reintenta en N s.» | Es el límite de subidas por minuto: espera la cuenta atrás, se reintenta con el botón. |
| «Estos subtítulos ya no están en el servidor» | Pasó más de un día: sube el video de nuevo. |
| La subida de un archivo enorme termina en error de red | El servidor rechaza antes de recibirlo si supera el máximo; revisa el tamaño que indica la zona de subida. |
| Dos pestañas editando lo mismo | La segunda en guardar verá el aviso de conflicto (no se pierde nada sin que lo decidas). |
