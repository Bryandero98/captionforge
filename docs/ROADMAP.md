# Hoja de ruta de producto

Documento vivo. Cada versión tiene un objetivo de producto; el detalle técnico de cada iniciativa vive en `tasks/<versión>/plan.md` y, una vez decidido, en un [ADR](adr).
Las versiones publicadas están en el [CHANGELOG](../CHANGELOG.md).

## Hecho

| Versión | Tema |
|---|---|
| 1.0 | Servicio completo: subida, transcripción, traducción, doblaje, edición, quemado, equipos, claves propias |
| 1.1 | Multi-LLM con URL base propia y audio puro |
| 1.2 | Subtítulos dinámicos ASS y formato vertical 9:16, parches de seguridad (carrera y TOCTOU) |
| 1.3.0 | Modo Rápido, galería de temas con vista previa y editor guiado por problemas |
| 1.3.1 | Guía interactiva, más formatos, acceso para IAs (MCP, llms.txt, OpenAPI) y asistente removible |

## v1.3.0: Experiencia de usuario y Product-Led Growth

**Objetivo.** Que una persona nueva llegue a un video con subtítulos sin tomar ninguna decisión técnica, y que quien quiera control lo encuentre sin estorbar a los demás.
El producto ya hace mucho; la fricción está en cuánto hay que saber para empezar. Esta versión no añade capacidad de procesamiento: reorganiza lo que existe alrededor de la intención.

**Métrica guía.** Tiempo desde abrir la página hasta la primera descarga o el primer video generado, medido solo en pruebas de usabilidad locales (el producto no envía telemetría).
**Principios.** Defaults seguros y baratos; mejora progresiva (sin la función nueva todo funciona como hoy); nada sensible fuera del servidor; cada decisión automática se explica y se puede cambiar.

### Iniciativa 1: «Sube y olvídate»

Detección automática de la intención a partir del archivo y perfiles rápidos.

- Al elegir un archivo se lee solo lo que el navegador ya sabe (tipo, tamaño, duración y dimensiones del medio, nombre) y se propone un **perfil**: por ejemplo *Podcast o entrevista*, *Clase o reunión*, *Short vertical*, *Clip rápido*.
- Un perfil es un conjunto de opciones que ya existen (modelo, limpieza de audio, hablantes, formato y plantilla de quemado). Nada nuevo en el servidor: el navegador las traduce a las opciones de siempre.
- «Sube y olvídate»: el perfil puede encadenar el quemado al terminar la transcripción, sin otra pulsación.
- Toda sugerencia se muestra con su motivo («Es vertical y dura 48 s») y se descarta con un clic.

### Iniciativa 2: «Resultado rápido» frente a «Control total»

Interfaz progresiva en dos niveles.

- **Resultado rápido** (por defecto): un solo botón grande «Generar subtítulos» con valores seguros y un resumen de una línea de lo que se va a hacer.
- **Control total**: un panel «Avanzado» plegado con modelo, idioma, traducción, limpieza de audio, hablantes, karaoke, formato, plantillas y claves propias (BYOK).
- Las preferencias no sensibles se recuerdan en el navegador; las claves y cualquier secreto, jamás.

### Iniciativa 3: estilos ASS como «temas visuales»

Galería de plantillas pre-renderizadas.

- Las tres plantillas de la 1.2 pasan de una lista a una **galería con vista previa** (miniaturas generadas una vez, empaquetadas con la interfaz) y nombre de tema.
- Elegir un tema fija estilo, plantilla y formato a la vez; el modo Control total sigue permitiendo combinarlos.
- Los temas son datos (nombre, miniatura, plantilla, lienzo), no código: añadir uno no exige tocar el compilador.

### Iniciativa 4: editor guiado por problemas

Integración visual del motor de calidad.

- El motor de calidad existente (verificador y corrector) deja de ser un panel aparte: sus hallazgos aparecen **sobre los propios subtítulos**, con la línea marcada, el motivo y un botón «Arreglar» o «Ir al siguiente problema».
- Cola de problemas ordenada por gravedad; el editor salta de uno a otro con el teclado.
- Cada arreglo automático se puede deshacer y respeta los tiempos por palabra siempre que sea posible.

### Iniciativa 5: cola explicable y recuperable

Transparencia en los estados de la cola y puntos de reanudación.

- «En cola» deja de ser una caja negra: posición aproximada, qué etapa corre, cuánto lleva y qué esperar. Un fallo dice qué parte falló y qué se conservó.
- **Checkpoints**: los resultados intermedios ya generados (audio extraído, transcripción, traducción) se conservan para que reintentar reanude desde el último paso correcto en lugar de empezar de cero.
- Un trabajo detenido o fallido ofrece «Reanudar», «Reintentar desde cero» y «Descargar lo que haya».

### Orden de entrega

| Fase | Iniciativas | Por qué en este orden |
|---|---|---|
| 1 | 1 y 2 | Cambian la primera pantalla y no tocan el procesamiento; se apoyan en lo que ya existe y se pueden medir solas. |
| 2 | 3 y 4 | Reutilizan la interfaz progresiva de la fase 1 y los activos de la 1.2 y del motor de calidad. |
| 3 | 5 | Toca el contrato de trabajos y la persistencia del worker; es la de mayor riesgo y se beneficia de que la interfaz ya sepa explicar estados. |

La fase 1 está diseñada en [`tasks/v1.3.0/plan.md`](../tasks/v1.3.0/plan.md).

### Fuera de alcance de la 1.3.0

Cuentas con cobro, planes de pago, telemetría de uso, aplicaciones móviles y nuevos proveedores de IA.

## Más adelante (sin compromiso)

Publicación directa a plataformas, plantillas de marca por equipo y traducción de la interfaz a más idiomas.
