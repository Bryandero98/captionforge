# Runbook: `APP_SECRET` y `WORKER_INTERNAL_TOKEN`

Para quien administra un servidor de CaptionForge con claves externas propias (BYOK, [ADR 0020](adr/0020-ia-avanzada-y-claves-externas-byok.md)).
Contexto de seguridad en [architecture_and_security.md, sección 3.4](architecture_and_security.md#34-claves-externas-propias-byok-adr-0020).

> **Re-cifrado automático aplazado.** Hoy no existe un comando que re-cifre las claves guardadas con un `APP_SECRET` nuevo.
> El esquema ya guarda `keyVersion`, pero la rotación con `APP_SECRET_PREVIOUS` queda para un issue futuro. Cambiar o perder
> `APP_SECRET` obliga a que cada Dueño vuelva a pegar sus claves externas. Este documento describe ese procedimiento.

## 1. Qué es y qué protege

| Variable | Qué es | Quién la recibe | Si se pierde |
|---|---|---|---|
| `APP_SECRET` | Secreto de partida con el que se *deriva* (HKDF-SHA256) la clave AES-256-GCM que cifra las claves de OpenAI y ElevenLabs de cada espacio de trabajo. | Solo `api-gateway`. El worker **nunca** lo ve. | Las claves guardadas quedan ilegibles (sección 4). El resto del producto no se afecta. |
| `WORKER_INTERNAL_TOKEN` | Contraseña con la que el worker pide al API, por un puerto interno (3100, solo red de Docker), la clave de su trabajo. | `api-gateway` y `ai-worker`. | Nada se pierde: se genera otro y se reinician ambos (sección 6). |

Las claves externas están en la tabla `"TenantExternalKey"` de PostgreSQL. Quien tenga **la base (o un respaldo) y `APP_SECRET`**
puede descifrarlas: por eso deben guardarse por separado (sección 3).

## 2. Cómo se genera

Los dos deben ser **distintos**, aleatorios, de 32 bytes o más, en hexadecimal (64 caracteres) o base64. El API se niega a
arrancar si uno está definido y es débil (una frase, pocos símbolos distintos) o si son iguales; el mensaje nunca repite el valor.

- **Con los scripts:** `start.sh` y `start.bat` los generan en el `.env` si faltan y **nunca sobrescriben** uno existente.
- **A mano**, con Node.js o con OpenSSL:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# o
openssl rand -hex 32
```

Ejecútalo dos veces: una para `APP_SECRET` y otra para `WORKER_INTERNAL_TOKEN`. Pégalos en el `.env` (fuera de git):

```dotenv
APP_SECRET=<64 caracteres hexadecimales>
WORKER_INTERNAL_TOKEN=<otros 64 caracteres hexadecimales>
```

Sin `APP_SECRET` la función queda apagada (no se cifra con un valor por defecto). Sin `WORKER_INTERNAL_TOKEN` el canal interno
no se abre, y traducir con OpenAI o doblar fallan con `EXTERNAL_KEY_MISSING`.

## 3. Dónde guardarlo y respaldarlo

- **Un gestor de secretos o contraseñas**, con un respaldo fuera del servidor. Es la única copia que te permite descifrar un
  respaldo de la base si algún día restauras en otra máquina.
- **Aparte de la base y de sus respaldos.** Si el volcado de la base y `APP_SECRET` viajan juntos, un robo del respaldo entrega
  todas las claves.
- **Aparte del repositorio.** El `.env` está fuera de git: no lo versiones ni lo copies a un wiki o un ticket.
- **Nunca en un chat, un issue, un commit ni un registro.** Si lo pegaste en alguno, trátalo como filtrado y rota (sección 5).
- Restringe el `.env` al usuario que ejecuta Docker (`chmod 600 .env`; `start.sh` ya lo hace al crearlo).

Al restaurar un respaldo de la base en otro servidor, restaura también el **mismo** `APP_SECRET`: con otro, las claves guardadas
no se leen (sección 4).

## 4. Qué pasa si se pierde o se cambia

### Síntoma

Con un `APP_SECRET` distinto del que cifró las filas:

- **El panel «Claves externas» sigue mostrando «Guardada: …últimos 4»**, porque esos 4 caracteres están en una columna aparte
  que no se cifra. No hay ninguna señal en la interfaz de que la clave ya no se lee.
- Crear un trabajo de traducir o doblar **sí se acepta** (solo se comprueba que exista una fila).
- El trabajo falla al empezar con `EXTERNAL_UNAVAILABLE` y el mensaje «No se pudo obtener la clave del espacio. Inténtalo de
  nuevo en un momento.» Parece una caída del proveedor, pero **ni siquiera llegó a llamarlo**: el canal interno respondió 500.
  Reintentar no sirve.

La causa es que el descifrado falla (el cifrado GCM autentica los datos con la clave derivada): el canal interno responde
`500 internal_error` y el worker reintenta tres veces, con esperas de 0,5 y 1,5 s, antes de rendirse.

### Diagnóstico

1. En los registros del API aparece, por cada intento fallido, una línea con la causa y sin el valor:

   ```bash
   docker compose --profile app logs --since 30m api-gateway
   ```

   Busca `Error al entregar una clave: no se pudo descifrar`. Si aparece, es este problema.
2. Comprueba que el servidor no arrancó **sin** `APP_SECRET`: `curl http://localhost:3000/v1/capabilities` debe devolver
   `"byok":{"enabled":true,...}`. Con `"enabled":false` el secreto falta o está vacío: la función está apagada y las filas
   siguen intactas (al restaurar el mismo secreto, todo vuelve a funcionar).
3. Descarta otros motivos con la misma pantalla de síntoma: un token interno distinto entre API y worker no produce este
   error, sino «El worker no pudo obtener la clave del espacio» y, en el API, `Petición interna rechazada: token ausente o incorrecto`.

| En los registros del API | Causa |
|---|---|
| `Error al entregar una clave: no se pudo descifrar` | `APP_SECRET` distinto del que cifró las filas |
| `Petición interna rechazada: token ausente o incorrecto` | `WORKER_INTERNAL_TOKEN` distinto entre API y worker |
| `APP_SECRET no está definido: las claves externas propias están desactivadas.` (al arrancar) | Falta `APP_SECRET`: función apagada, nada perdido |
| El API no arranca y el mensaje empieza por `APP_SECRET debe ser un secreto aleatorio…` | `APP_SECRET` con formato débil |

### Qué se pierde y qué no

| Se pierde | No se pierde |
|---|---|
| Las claves de OpenAI y ElevenLabs guardadas (hay que pegarlas de nuevo). | Trabajos, transcripciones, subtítulos, traducciones y audios ya generados. |
| | Cuentas, espacios, miembros, claves de API del espacio y sesiones. |
| | Las claves en los paneles de OpenAI y ElevenLabs: siguen vigentes, solo las pega de nuevo el Dueño. |
| | Los trabajos de traducir con Argos (local): no usan claves. |

## 5. Rotación planificada de `APP_SECRET`

Úsala si el secreto se filtró, si se perdió o si quieres cambiarlo por política. **Si se filtró junto con un volcado de la
base, las claves de OpenAI y ElevenLabs deben considerarse comprometidas: pide a cada Dueño que, además, las revoque en el
panel de su proveedor y cree otras antes de pegarlas.**

Duración estimada: **10 a 15 minutos** en total, de los cuales el servicio entero está parado unos **2 a 3 minutos** (pasos 2
a 5: sin API no hay subidas ni seguimiento). Avisa antes a los Dueños.

1. **Elige un momento sin trabajos de IA en curso.** Los trabajos de traducir y doblar activos fallarán al reiniciar.
2. **Para el API y el worker** (la base y Redis siguen arriba). El worker puede tardar hasta 60 s en cerrar, que es el plazo de
   apagado ordenado:

   ```bash
   docker compose --profile app stop api-gateway ai-worker
   ```

3. **Cambia `APP_SECRET` en el `.env`** por un valor nuevo (sección 2). Guarda el nuevo valor en tu gestor de secretos **antes**
   de continuar; conserva el anterior hasta terminar.
4. **Vacía las claves guardadas** con el rol dueño del esquema (`cf_owner`, el mismo que aplica las migraciones). Abre `psql`
   en el contenedor de PostgreSQL; si pide contraseña, es `CF_OWNER_DB_PASSWORD` de tu `.env`:

   ```bash
   docker compose exec postgres sh -c 'psql -h 127.0.0.1 -U cf_owner -d "$POSTGRES_DB"'
   ```

   Primero mira qué hay y luego borra:

   ```sql
   SELECT "tenantId", provider, "keyVersion", "createdAt" FROM "TenantExternalKey";
   DELETE FROM "TenantExternalKey";
   \q
   ```

   Es la única tabla afectada. Borrar es lo recomendable porque, si no, el panel seguiría mostrando «Guardada: …1234» de claves
   que ya no se leen y los trabajos fallarían con el síntoma engañoso de la sección 4. (Cada Dueño podría sobrescribir su fila
   pegando la clave de nuevo; las filas de quien no lo haga seguirían rotas.)
5. **Arranca de nuevo.** Usa `up -d`, no `restart`: solo `up` vuelve a leer el `.env` y recrea los contenedores con el valor nuevo.

   ```bash
   docker compose --profile app up -d api-gateway ai-worker
   docker compose --profile app ps
   ```

   Espera a que `api-gateway` figure como `healthy` (normalmente menos de un minuto).
6. **Comprueba que la función está activa:**

   ```bash
   curl http://localhost:3000/v1/capabilities
   ```

   Debe incluir `"byok":{"enabled":true,"providers":["openai","elevenlabs"]}`.
7. **Avisa a los Dueños** de cada espacio: deben abrir **Claves externas** y volver a pegar sus claves de OpenAI y ElevenLabs.
   Hasta que lo hagan, traducir con OpenAI y doblar responden «Falta la clave del proveedor» (409), que es el comportamiento
   correcto y avisa en lugar de fallar en silencio.
8. **Guarda la fecha de la rotación** y la ubicación del secreto nuevo donde tu equipo documente cambios.

## 6. Rotación de `WORKER_INTERNAL_TOKEN` (sin pérdida)

El token solo autentica al worker ante el API; no cifra nada. Se rota sin tocar la base ni pedir nada a los Dueños.
Duración estimada: **2 a 3 minutos**.

1. Genera otro (sección 2) y reemplaza `WORKER_INTERNAL_TOKEN` en el `.env`. Debe ser distinto de `APP_SECRET`.
2. Recrea **los dos** servicios a la vez; si uno se queda con el valor viejo, el worker recibe 401 y el trabajo falla con
   «El worker no pudo obtener la clave del espacio»:

   ```bash
   docker compose --profile app up -d api-gateway ai-worker
   ```

3. Lanza una traducción de prueba con OpenAI (o con ElevenLabs) y comprueba que termina. Los trabajos en curso durante el cambio
   fallan y se lanzan de nuevo.

Rótalo siempre que sospeches que se filtró. Con el token filtrado solo se pueden pedir claves de trabajos de traducir o doblar
**en curso**, y solo desde la red interna de Docker.

## 7. Qué NO hacer

- **No cambies `APP_SECRET` «por probar»** ni lo borres del `.env` durante una actualización: dejaría ilegibles las claves de
  todos los espacios. Si el secreto desaparece, la función se apaga con un aviso; restaurar el mismo valor la recupera.
- **No uses `restart`** para aplicar un cambio de `.env`: no relee el archivo. Usa `up -d`.
- **No reutilices `APP_SECRET` como `WORKER_INTERNAL_TOKEN`**: el API se niega a arrancar con valores iguales. Tampoco uses
  `DEFAULT_API_KEY` para ninguno de los dos: es una clave de espacio, con permisos de espacio, no un secreto de servicio.
- **No pegues ninguno en un chat, un issue o un commit**, ni los publiques en un puerto: el 3100 solo se alcanza dentro de la
  red de Docker y no debe añadirse a `ports:` ni al proxy (una prueba del repositorio lo vigila).
- **No edites ni copies filas de `"TenantExternalKey"` a mano.** El cifrado está atado al espacio y al proveedor de cada fila;
  una fila movida no descifra.
- **No des a `cf_worker` permisos sobre la tabla** para «arreglar» un fallo: es la barrera que impide al worker leer el cifrado.
- **No intentes un re-cifrado casero.** Aún no existe el comando oficial.

## 8. Lista de comprobación posterior

- [ ] `docker compose --profile app ps` muestra `api-gateway` y `ai-worker` en marcha y `api-gateway` en `healthy`.
- [ ] `GET /v1/capabilities` devuelve `byok.enabled: true`.
- [ ] En los registros del API no aparece `Error al entregar una clave: no se pudo descifrar` ni `token ausente o incorrecto`
      tras arrancar.
- [ ] Un Dueño pegó de nuevo sus claves y el panel muestra «Guardada: …» con los 4 últimos caracteres correctos.
- [ ] Una traducción de prueba con OpenAI termina (o un doblaje corto con la voz que uses).
- [ ] El `APP_SECRET` nuevo está en el gestor de secretos, separado de los respaldos de la base.
- [ ] El `APP_SECRET` anterior se retiró del lugar donde se guardaba y, si se filtró, las claves de los proveedores se revocaron.
- [ ] Los Dueños fueron avisados.
