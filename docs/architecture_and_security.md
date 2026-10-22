# CaptionForge: arquitectura y postura de seguridad

> Documento de referencia técnica. Las afirmaciones remiten, cuando existe, al código o al ADR que las respalda; lo
> que **no** está resuelto se declara en [Límites declarados](#límites-declarados) en lugar de omitirse.

## 1. Resumen ejecutivo

CaptionForge nació como un **paquete local de un solo proceso** (hoy en [`legacy/`](../legacy)): una interfaz
web FastAPI que, en la misma máquina y en el mismo proceso, recibía un video, lo transcribía con Whisper, lo
traducía con Argos y quemaba los subtítulos con ffmpeg. Funcionaba para una persona con un equipo propio y
se quedaba corto en cuanto había más de una persona: el modelo, el video y la petición HTTP competían por la
misma memoria, y un fallo de ffmpeg o de Whisper compartía proceso con el servidor web.

La reescritura lo separó en un **servicio distribuido y tolerante a fallos** con tres decisiones de fondo:

1. **Dos procesos que no comparten disco ni memoria.** Un API Gateway (NestJS) atiende a las personas usuarias;
   un AI Worker (Python) hace el trabajo pesado. Se hablan por una cola (Redis/BullMQ) y por un almacén de
   objetos S3 (RustFS), con contratos JSON Schema versionados
   ([ADR 0001](adr/0001-contratos-json-schema-como-fuente-de-verdad.md),
   [ADR 0005](adr/0005-bullmq-con-worker-python.md)).
2. **Estado en una sola fuente de verdad.** PostgreSQL guarda el estado del trabajo con transiciones
   condicionales (`UPDATE … WHERE status = …`): si el API que cancela un trabajo en cola y el worker que lo toma
   compiten, gana exactamente uno ([arquitectura](architecture.md#reglas-del-worker), regla 6). Una vez en
   ejecución, la cancelación es cooperativa por pub/sub.
3. **Fallar cerrado.** Cada componente tiene el mínimo privilegio (roles de base de datos y políticas S3
   separados), cada recurso compartido tiene un tope, y ante la duda el sistema rechaza, corta o no ejecuta.

El resultado se verifica con pruebas contra PostgreSQL, Redis y S3 reales en contenedores (Whisper real solo en
una prueba opcional; el resto usa un doble), y la cadena de entrega (CI/CD y publicación) está endurecida con los
mismos criterios.

## 2. Diagrama de arquitectura

```mermaid
flowchart TD
  subgraph Cliente["Cliente"]
    WEB["Navegador / cliente HTTP<br/>subida multipart, REST y SSE"]
  end

  subgraph Gateway["API Gateway · NestJS 12 + Fastify"]
    GUARD["Guardia de navegador<br/>Host 421 · Origin 403 · Sec-Fetch-Site 403"]
    RL["Límite de uso por IP<br/>y limitadores de concurrencia"]
    UP["Subida en streaming<br/>multipart a S3, partes de 5 MiB"]
    SSE["Flujos SSE de progreso<br/>tope total, por cliente y duración"]
    GUARD --> RL --> UP
    RL --> SSE
  end

  subgraph Datos["Estado y mensajería"]
    PG[("PostgreSQL<br/>fuente de verdad del Job<br/>roles cf_api y cf_worker")]
    RDS[("Redis + BullMQ<br/>colas transcribe y burn<br/>canal de cancelación")]
    S3[("RustFS · API S3<br/>jobs/ID/input y out<br/>credenciales separadas")]
  end

  subgraph Worker["AI Worker · Python, un trabajo pesado por proceso"]
    CONS["Consumidor BullMQ<br/>valida el contrato en modo estricto"]
    WH["Whisper<br/>faster-whisper, fuera del bucle de eventos"]
    ARG["Argos Translate"]
    FF["FFmpeg<br/>subproceso con entorno mínimo"]
    TMP["/work efímero<br/>se borra por trabajo y al arrancar"]
    CONS --> WH --> ARG
    CONS --> FF
    WH -.-> TMP
    FF -.-> TMP
  end

  WEB -->|"POST /v1/jobs/transcribe"| GUARD
  UP -->|"stream directo, sin disco, con RAM acotada"| S3
  UP -->|"INSERT Job"| PG
  UP -->|"encola con jobId idempotente"| RDS
  WEB <-->|"GET estado, PUT subtítulos con etag, descarga con Range"| GUARD
  SSE -->|"consulta ~1 s tras la anterior"| PG
  SSE -->|"evento si cambia, ping cada 15 s"| WEB

  RDS -->|"entrega el trabajo"| CONS
  S3 <-->|"lee entrada, escribe artefactos"| CONS
  CONS -->|"UPDATE condicional del estado"| PG
  RDS -.->|"captionforge:cancel"| CONS
```

Quién puede qué (verificado por [`docker/verify-infra.sh`](../docker/verify-infra.sh) y las pruebas de privilegios
de la base de datos del API): el API usa `cf_api`
(DML sin DDL) y una cuenta S3 con lectura, escritura y borrado bajo `jobs/*`; el worker usa `cf_worker`
(`SELECT` y `UPDATE` solo de columnas concretas de `Job`) y una cuenta S3 que **no borra**. Un rol comprometido
no puede borrar tablas ni salir de `jobs/` en el bucket ([arquitectura](architecture.md#quién-puede-qué)). El
mínimo privilegio es por recurso, no por trabajo: ver [Límites declarados](#límites-declarados).

## 3. Postura de seguridad y hardening (AppSec)

### 3.1 DNS rebinding y CORS/Host fail-closed (H10)

**Amenaza.** El API no usa cookies, así que un token anti-CSRF no protegería nada. Lo que sí está expuesto,
sobre todo ejecutado en `127.0.0.1` sin `API_KEY`, son dos vías de un navegador engañado:

- Un `POST multipart/form-data` cross-origin es una *petición simple*: **no lleva preflight**. Cualquier página
  abierta en la pestaña de al lado podía crear o cancelar trabajos y gastar CPU.
- **DNS rebinding:** un dominio del atacante que resuelve a `127.0.0.1` hace que el navegador lo trate como
  mismo origen y deje **leer** las respuestas.

**Control.** Una guardia pura, con pruebas unitarias y de extremo a extremo
([`request-guard.ts`](../apps/api-gateway/src/security/request-guard.ts)) corre en `onRequest`, antes de
multipart, CORS y límites de uso, de modo que una petición ajena no consume cuota ni procesa su cuerpo:

| Comprobación | Regla | Respuesta |
|---|---|---|
| `Host` | debe estar en `ALLOWED_HOSTS` (por defecto `localhost`, `127.0.0.1`, `[::1]`); cabecera ausente o malformada también falla | **421** |
| `Origin` | si existe, debe estar en `ALLOWED_ORIGINS` (vacío por defecto) o ser el propio origen del API; `Origin: null` se rechaza | **403** |
| `Sec-Fetch-Site` | sin `Origin`, un método que modifica con `cross-site` o `same-site` | **403** |

Decisiones de diseño que importan:

- **Fail-closed y sin comodines.** `ALLOWED_ORIGINS` vacío significa «solo mismo origen». `*`, puertos en la
  lista de hosts o valores ambiguos **hacen fallar el arranque**: una configuración peligrosa no se interpreta
  con indulgencia, no arranca.
- **CORS solo con lista cerrada** y `credentials: false`; si no hay orígenes, ni siquiera se registra.
- **`/health` es la única excepción, y está acotada.** Se exime solo a los sondeos reales (`GET` o `HEAD` sin
  `Origin` ni marca de otro sitio), y esa exención **tampoco comprueba `Host`**: los sondeos del orquestador
  llegan con el nombre del pod. Un `<img src=".../health">` de una página ajena en un navegador que envía
  `Sec-Fetch-Site` recibe 403 antes de ejecutar `SELECT 1` y los pings a Redis y S3. Con DNS rebinding el navegador
  declara `same-origin` y la ruta responde, pero solo con el estado de las dependencias y bajo su propio contador
  (600 por minuto); no expone datos de trabajos.
- **Sin reflejo.** Los mensajes de error son fijos y no repiten el `Host` ni el `Origin` recibidos; los
  rechazos con el cuerpo sin leer descartan hasta 16 MiB (10 s) y entonces cortan, para que el navegador vea el error.
- **Observable.** Al arrancar se registra la política efectiva, de modo que un `ALLOWED_HOSTS` mal puesto se ve
  en el log y no en producción.

Detalle, alternativas descartadas (token anti-CSRF, solo CORS, `API_KEY` obligatoria) y consecuencias en
[ADR 0011](adr/0011-origen-y-host-fail-closed-contra-paginas-ajenas.md).

### 3.2 Aislamiento de secretos en subprocesos (H7)

ffmpeg procesa bytes que controla quien sube el video. Si heredara el entorno del worker, un fallo en un
decodificador tendría a mano `DATABASE_URL`, las claves S3 y la de Redis. Por eso
[`ffmpeg_env()`](../legacy/src/captionforge/ffmpeg_locator.py) construye el entorno del subproceso con una
**lista blanca** (rutas, locale, `XDG_*`, `FONTCONFIG_*`, `TZ`) en lugar de heredar `os.environ` y restar lo
sensible: una variable nueva con un secreto queda fuera **por defecto**, sin que nadie tenga que acordarse de
excluirla. Se aplica a los lanzamientos que procesan entrada no confiable: la extracción de audio y el quemado
(`pipeline.py`) y la forma de onda (`waveform.py`).

Complemento a nivel de datos: el worker no tiene `DELETE` en S3 ni `INSERT`/`DDL` en PostgreSQL, y el payload
se valida contra su alcance (`outputPrefix` es exactamente `jobs/<su id>/out/`; las entradas, por el bucket
configurado y el patrón `jobs/<uuid>/…` del contrato; si no, falla sin tocar S3). Una lista HLS disfrazada de
video **no es explotable** con ffmpeg 7.1 (prueba de regresión en `apps/ai-worker/tests/test_ssrf.py`), pero
ese resultado descansa en valores por defecto —la entrada se guarda como `input.bin` y la lista blanca de
protocolos de ffmpeg para archivos locales—, no en una restricción explícita.

### 3.3 Cadena de suministro segura (H9)

El flujo de entrega es un objetivo en sí mismo: quien controle un paso del CI puede publicar código propio con
tu identidad. Lo que se aplicó y **se comprueba en cada PR**:

- **Mínimo privilegio del `GITHUB_TOKEN`.** Cada workflow declara `permissions: contents: read` a nivel global;
  los permisos de escritura se piden solo en el job que los usa.
- **Acciones fijadas por SHA de 40 caracteres** (con el tag en un comentario) y, para `docker://`, por resumen
  `sha256`: un tag movido o un repositorio de acciones comprometido no cambia lo que se ejecuta.
- **Publicación en PyPI sin secretos de larga vida (Trusted Publishing / OIDC).**
  [`release.yml`](../.github/workflows/release.yml) se divide en dos jobs: `build` compila con solo lectura y
  **no puede** pedir el token OIDC (si una herramienta de compilación se comprometiera, no podría publicar), y
  `publish` solo descarga el artefacto y lo sube, con `id-token: write` y `environment: pypi`. El workflow ya no
  usa `PYPI_API_TOKEN`: PyPI valida la identidad del workflow y emite un token efímero por ejecución (queda
  retirar el secreto antiguo y proteger el entorno, ver límites).
- **El control no depende de la disciplina.**
  [`tools/check-workflows.mjs`](../tools/check-workflows.mjs) analiza el **árbol YAML** (no el texto) y falla si
  falta `permissions` global, hay `write`/`write-all` global, o cualquier `uses` carece de SHA. Tiene 10 pruebas,
  incluidas las elusiones que burlaban una primera versión basada en expresiones regulares (comillas, mapas de
  una línea, alias YAML, `docker://alpine:latest`). Corre en el job de contratos del CI.
- **Lo fijado no se pudre.** [`dependabot.yml`](../.github/dependabot.yml) revisa cada semana acciones, las dos
  imágenes Docker, compose, npm y los dos paquetes Python (con minor y patch agrupados donde procede): fijar sin
  actualizar congelaría también las correcciones de seguridad.

### Límites declarados

La seguridad creíble nombra lo que no cubre:

| Id | Límite | Siguiente paso |
|---|---|---|
| H7b | El entorno mínimo evita la herencia **accidental** de secretos; no frena un ffmpeg ya comprometido que corra con el mismo usuario (podría leer `/proc/<padre>/environ`). El worker ya corre sin root y con `no-new-privileges`. | ffmpeg con otro usuario o en otro contenedor, y perfil seccomp con sistema de archivos de solo lectura. |
| Imágenes | Las imágenes base (`node`, `python`, `postgres`, `redis`) se fijan por etiqueta, no por resumen `sha256`; `build==1.6.1` se instala sin hashes de sus dependencias; `check-workflows` valida la forma del SHA, no que corresponda al tag del comentario. | Fijar por resumen, instalar con `--require-hashes` y verificar SHA y tag. |
| Propiedad | Los trabajos no tienen dueño: quien conozca el UUID puede leer, cancelar, editar y quemar; la `API_KEY` es una clave compartida y opcional. El límite de uso por IP depende de `TRUST_PROXY` (con `true` se falsifica por `X-Forwarded-For`). | Autenticación y propiedad por persona usuaria (5b). |
| Alcance interno | Dentro de `jobs/*`, el worker puede sobrescribir objetos de cualquier trabajo y actualizar `status`/`result` de cualquier fila (permisos por columna, no por fila). | Credenciales o políticas por trabajo; hoy se confía en que el worker es código propio. |
| OIDC | El workflow está listo, pero el publicador de confianza hay que registrarlo en PyPI (repositorio, `release.yml`, entorno `pypi`) y crear el entorno en GitHub con revisores obligatorios. Es un paso manual del mantenedor; hasta entonces `PYPI_API_TOKEN` puede seguir en la configuración del repositorio y de PyPI. | Registrar el publicador y retirar el secreto antiguo. |
| 5b | Aún no hay autenticación de personas usuarias. Cuando lleguen las cookies, la premisa de 3.1 cambia: `SameSite`, `HttpOnly`, `Secure` y token anti-CSRF; la guardia de `Origin` queda como defensa en profundidad. | Fase 5b. |

## 4. Resiliencia y optimización de hardware

Los topes de uso y de concurrencia son configurables (`0` los desactiva; otros valores, como el límite de
tamaño de subida, el de `/health` o las partes de 5 MiB, son fijos o exigen un valor positivo) y comparten una idea: **un recurso compartido nunca debe
depender de que el cliente se porte bien**.

### 4.1 Memoria acotada: streams directos a S3 (H2)

Un video puede pesar varios GiB; cargarlo en memoria para subirlo llevaría al contenedor a un OOM con unas pocas
subidas simultáneas. El API **no guarda el video**: lo encauza como flujo desde la petición a S3 mediante
**subida multiparte con partes de 5 MiB**
([`storage.service.ts`](../apps/api-gateway/src/storage/storage.service.ts)). Cada subida retiene como mucho unas pocas
partes (cola de 2 más la que se envía, unos 15 MiB por configuración), no el tamaño del archivo; la prueba de
memoria de CI mide ~105-115 MiB de crecimiento de RSS con cuatro subidas simultáneas de 64 MiB, costes fijos
incluidos, y se declara un detector de retención, no una medida fina. El límite de tamaño se aplica contando
bytes sobre la marcha (413) en lugar de fiarse de `Content-Length`.

Una subida lenta también es un recurso retenido, así que:

- **Tope de subidas a la vez**: total (por defecto 4) y por cliente (por defecto 2).
- **Ritmo mínimo** de 16 KiB/s (128 kbit/s) medido por ventanas de 30 s: un goteo de bytes que retiene la
  plaza se corta con 408. Se mide en los bytes que pasan hacia S3, así que una contrapresión fuerte del
  almacenamiento también puede provocarlo; es configurable.

En el worker, el video tampoco vive en RAM: se descarga a un directorio por trabajo y se procesa con Whisper y
ffmpeg **fuera del bucle de eventos** (hilo o subproceso), de modo que el candado de BullMQ se sigue renovando y
no aparecen falsos `stalled`.

### 4.2 Concurrencia y agotamiento de sockets (H4)

El límite por minuto cuenta cuántas peticiones *empiezan*, no cuántas siguen vivas; y un flujo SSE puede durar
horas mientras un trabajo espera en cola. Un [`ConcurrencyLimiter`](../apps/api-gateway/src/security/concurrency-limiter.ts)
reserva un **hueco** por flujo antes de consultar nada:

| Control | Por defecto | Qué previene |
|---|---|---|
| `MAX_EVENT_STREAMS` | 200 | Agotar los descriptores de archivo y el pool de conexiones a PostgreSQL |
| `MAX_EVENT_STREAMS_PER_CLIENT` | 10 | Que una sola IP acapare todos los huecos (429 con `Retry-After`) |
| `EVENT_STREAM_MAX_SECONDS` | 1800 | Flujos eternos: el servidor cierra y `EventSource` reconecta solo, recibiendo el estado completo |

El hueco se libera al cerrarse la conexión, al fallar y al completarse; en los flujos SSE, un vencimiento de
seguridad (duración máxima más 60 s) lo libera igual si el evento de cierre nunca llegara. Es una contabilidad:
no cierra el socket. Cada flujo consulta aproximadamente una vez por segundo, emite un evento solo si cambia el
estado, la etapa, el porcentaje o el mensaje, y envía un `ping` cada 15 s para mantener la conexión; el coste
por conexión es predecible.

Del lado del worker, la concurrencia es deliberadamente baja: **un trabajo pesado a la vez por proceso**
(transcribir y quemar comparten hueco) y se escala con réplicas, no con hilos, porque Whisper y ffmpeg son lo
que agota la RAM. `attempts: 1` evita que un fallo se reintente en silencio y se multiplique la carga.

### 4.3 Apagado ordenado y volúmenes efímeros

Los contenedores se detienen en cada despliegue; lo que importa es lo que queda detrás.

- **Apagado con plazo.** Ante `SIGTERM`/`SIGINT` el worker deja de tomar trabajo y espera al que está en curso
  hasta `SHUTDOWN_GRACE_SECONDS` (45 s por defecto, por debajo de los 60 s de `stop_grace_period` de Docker).
  Si el plazo se agota, **pide parar** el trabajo (el corte es cooperativo: hilo de Whisper y ffmpeg, con 10 s
  más de margen), lo cierra como fallido con un mensaje claro y libera la conexión. Sin el plazo,
  `Worker.close()` espera sin límite, Docker mata el proceso a los 60 s y la fila quedaba en `RUNNING` hasta que
  el recolector la cerraba (20 min por defecto).
- **Nada queda en `/work`.** Cada trabajo borra su carpeta en un `finally` (`transcribe.py`, `burn.py`), porque
  un video de 4 GiB olvidado llena el volumen en pocos trabajos. En S3, el ciclo de vida del bucket expira lo de
  `jobs/` pasado un día.
- **Limpieza de lo que ningún `finally` alcanza.** Si el proceso muere por OOM o `SIGKILL`, no hay `finally`.
  Al arrancar, [`clean_stale_work`](../apps/ai-worker/src/ai_worker/workdir.py) borra las carpetas `<jobId>/` de
  `/work` cuyo trabajo ya no está vivo; conserva las de trabajos con latido reciente (otra réplica puede
  compartir el volumen) y solo toca nombres que son un UUID, de modo que no destruye modelos ni notas.
- **Trabajos huérfanos.** En el lado del API, un recolector cierra como fallidos los trabajos `RUNNING` sin
  latido o los `QUEUED` que la cola perdió
  ([ADR 0010](adr/0010-endurecimiento-del-api-y-trabajos-huerfanos.md)): el usuario ve un error accionable,
  no un progreso que no avanza.

### 4.4 Incidentes que estas decisiones evitan

| Incidente en producción | Mecanismo que lo evita |
|---|---|
| Contenedor del API muere por OOM con pocas subidas de video | Streaming multiparte de 5 MiB + tope y ritmo mínimo de subidas |
| Pool de PostgreSQL y sockets agotados por pestañas con SSE abiertas | Tope total y por cliente, duración máxima, emisión solo ante cambios |
| Una página abierta en la otra pestaña lanza o cancela trabajos | Guardia `Origin`/`Sec-Fetch-Site`; CORS de lista cerrada |
| El navegador lee el API local desde un dominio del atacante | Validación de `Host` (421) contra DNS rebinding |
| Secretos de infraestructura al alcance de un decodificador de video | Entorno de ffmpeg por lista blanca; roles de mínimo privilegio |
| Una dependencia del CI comprometida publica un paquete con tu nombre | Acciones por SHA, `permissions` de solo lectura, OIDC con jobs separados |
| Despliegue deja trabajos zombis y el disco lleno de videos | Apagado con plazo, `finally` por trabajo, limpieza de `/work` al arrancar |
| Cancelar y arrancar un trabajo a la vez deja un estado incoherente | Transiciones condicionales en PostgreSQL: gana exactamente uno |
