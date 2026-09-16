# Diseño — WhatsApp API definitiva: fachada sobre WAHA (NOWEB) + web UI

| | |
|---|---|
| **Fecha** | 2026-09-16 |
| **Autor** | Juan Guillermo Nieto Martinez — Analista y Desarrollador nivel 3, TI AYNN - OROEXPRESS |
| **Estado** | Diseño aprobado (pendiente review del spec) |

## 1. Problema y objetivo

La API actual (`server.js` con `whatsapp-web.js@^1.19.1` + Chromium/puppeteer) se rompe
en producción con dos fallos encadenados:

- `TypeError: Cannot read properties of undefined (reading 'getChat')` al enviar — el
  *Store* interno que la librería inyecta en Chromium quedó `undefined` porque la versión
  (mediados de 2023) es incompatible con la WhatsApp Web actual.
- Loop de `LOGOUT` + `Execution context was destroyed` que **tumba el proceso Node**
  (excepción no capturada) y deja el contenedor pidiendo QR eternamente.

**Objetivo:** una solución que (a) **no haya que re-desplegar cada vez que WhatsApp
cambia**, (b) tenga **interfaz gráfica** para gestionar todo (QR, estado, envío), (c) se
despliegue **una sola vez con Docker**, y (d) **conserve intactas las rutas HTTP actuales**
para que los sistemas que ya las consumen no se enteren del cambio.

## 2. Decisión de arquitectura

**Patrón fachada sobre un motor mantenido por la comunidad.**

Ninguna librería no-oficial es "para siempre": todas leen WhatsApp Web por ingeniería
inversa y se rompen cuando Meta cambia algo. La estrategia definitiva no es mantener el
`server.js` a mano, sino **delegar la conexión frágil a un motor que una comunidad
actualiza** (WAHA), y quedarnos solo con una capa fina propia que preserva nuestro
contrato y sirve la UI.

**Motor elegido: WAHA Core con engine NOWEB.**
- NOWEB (basado en Baileys) **no usa Chromium/puppeteer** → elimina la clase entera de
  fallos del log actual (`getChat`, "Execution context was destroyed").
- Un solo contenedor, bajo consumo, API REST gratis (Core), imagen oficial mantenida
  (`devlikeapro/waha`).

```
                    ┌───────────────────────────────────────────┐
   Sistemas    ───▶ │  whatsapp-api  (Node/Express — nuestro)     │
   existentes       │                                             │
   (mismas rutas)   │  A) Fachada legacy (contrato idéntico):     │
                    │     GET  /qr        GET  /status             │
                    │     POST /connect   POST /disconnect         │──┐ HTTP
                    │     POST /send-message                       │  │ interno
                    │     GET  /send-message-get                   │  │ (red docker)
   Navegador   ───▶ │  B) Web UI en /  (QR, estado, envío, log)    │  │
                    └───────────────────────────────────────────┘  │
                                                                    ▼
                    ┌───────────────────────────────────────────────┐
                    │  waha  (devlikeapro/waha, engine NOWEB)         │
                    │  maneja la sesión de WhatsApp. Volumen persist. │
                    └───────────────────────────────────────────────┘
        Todo en UN docker-compose. Se despliega una vez y queda.
```

**Por qué mantener nuestra capa Node (y no solo exponer WAHA):**
1. Preserva el contrato HTTP actual (rutas, campos, forma de respuesta) → cero cambios
   en los consumidores.
2. Nos deja servir una web UI propia y simple, sin depender del dashboard de WAHA (que
   en Core es limitado / de pago en Plus).
3. Oculta la `WAHA_API_KEY` y la URL del motor detrás de nuestra capa: los consumidores
   siguen hablando con nuestra API como hoy.

## 3. Componentes

### 3.1 `waha` (motor, contenedor)
- Imagen: `devlikeapro/waha` (Core).
- Config por entorno:
  - `WHATSAPP_DEFAULT_ENGINE=NOWEB`
  - `WHATSAPP_API_KEY=<secreto>` → exige header `X-Api-Key` en cada request.
  - (opcional) `WHATSAPP_HOOK_URL` / webhooks — **diferido**, no en v1.
- Persistencia: volumen para la carpeta de sesiones de WAHA (ruta exacta a confirmar
  contra la doc de WAHA durante la implementación; típicamente `/app/.sessions`).
- No expone puerto al host (solo accesible en la red interna de compose). Su dashboard
  queda opcional detrás de la red interna; nuestra UI es la cara pública.

### 3.2 `whatsapp-api` (nuestra capa Node/Express)
Un único servicio con dos responsabilidades bien separadas en archivos distintos:

- `wahaClient.js` — cliente HTTP fino contra WAHA (un módulo, con docstring). Encapsula:
  `getSessionStatus()`, `startSession()`, `stopSession()`, `getQrDataUrl()`,
  `sendText()`, `sendMedia()`. Inyecta `X-Api-Key` y `WAHA_URL`. Único lugar que conoce
  la forma de la API de WAHA.
- `server.js` — Express: monta la **fachada legacy** (sección 4) y la **web UI**
  (sección 5). No habla con WAHA directamente; usa `wahaClient.js`.
- Config por entorno: `WAHA_URL` (ej. `http://waha:3000`), `WAHA_SESSION` (ej.
  `default`), `WAHA_API_KEY`, `PORT` (80).

## 4. Mapeo de la fachada legacy → WAHA

Sesión fija: `WAHA_SESSION` (por defecto `default`). `chatId = <solo dígitos>@c.us`
(misma normalización actual: `number.replace(/[^0-9]/g,'')`).

| Ruta legacy (contrato actual) | Traducción a WAHA | Respuesta que devolvemos |
|---|---|---|
| `GET /status` → `{ ready }` | `GET /api/sessions/{session}` → status | `ready = (status === 'WORKING')` |
| `GET /qr` → `{ qr: dataUrl }` | `GET /api/{session}/auth/qr` con `Accept: application/json` → `{mimetype,data}` | `{ qr: "data:image/png;base64,"+data }`; si ya está `WORKING` (no hay QR) → `404 { error:'QR no disponible' }` (igual que hoy) |
| `POST /connect` → `{ ok:true }` | crear si no existe (`POST /api/sessions {name, start:true}`) o `POST /api/sessions/{session}/start` | `{ ok:true }` |
| `POST /disconnect` → `{ ok:true }` | `POST /api/sessions/{session}/stop` | `{ ok:true }` |
| `POST /send-message` (multipart: `number`, `message`, `file`) | ver 4.1 | `{ ok:true, id:<messageId> }` |
| `GET /send-message-get` (query: `number`, `message`, `file` base64, `fileName`, `fileType`) | ver 4.1 | `{ ok:true, id:<messageId> }` |

### 4.1 Envío (texto y media)
- Sin archivo → `POST /api/sendText { session, chatId, text: message }`.
- Con archivo → base64 del contenido:
  - `POST /send-message`: `req.file.buffer.toString('base64')`, `mimetype=req.file.mimetype`,
    `filename=req.file.originalname`.
  - `GET /send-message-get`: usa `file` (ya base64), `fileType`, `fileName`.
  - Si `mimetype` empieza con `image/` → `POST /api/sendImage`, si no → `POST /api/sendFile`,
    con body `{ session, chatId, file:{ mimetype, filename, data:<base64> }, caption:message }`.
- Respuesta: `id = resp.id?._serialized ?? resp.id ?? resp.key?.id ?? null`.

### 4.2 Diferencias intencionales respecto al comportamiento actual (documentadas)
- ⚠️ **`id` en la respuesta:** hoy es `sent.id._serialized`. Con WAHA/NOWEB el id es un
  string con formato distinto (p.ej. `true_...@c.us_...`). Se mantiene el **nombre del
  campo `id`** y que sea un identificador de mensaje; **el valor exacto cambia de forma**.
  Aceptable (los consumidores hoy solo lo reciben, no lo reconstruyen). Registrar en la
  bitácora.
- ✅ **Guard de readiness (mejora):** si la sesión no está `WORKING`, `/send-message` y
  `/send-message-get` responden **`409 { error:'WhatsApp no está conectado' }`** en vez
  del `500` con `getChat` de hoy. Es una mejora de robustez; mismo campo `error`.
- ✅ **`/disconnect`:** hoy hace `client.destroy()` (cierra puppeteer, conserva la sesión
  local). Se mapea a `stop` (detiene la sesión, conserva la autenticación). Para
  **cerrar sesión de verdad** (borrar auth y regenerar QR) habrá un botón aparte en la
  web UI que llama a `POST /api/sessions/{session}/logout` — no se toca el contrato legacy.

## 5. Web UI (en `/`)

Una sola página servida por `whatsapp-api` (HTML/CSS/JS propio, sin build ni deps
externas, criterio de diseño con la skill frontend-design en implementación):

- **Estado de conexión:** badge que refleja `/status` (poll cada ~3 s): Conectado /
  Esperando QR / Desconectado.
- **QR:** cuando no está conectado, muestra la imagen de `/qr` y refresca al escanear.
- **Formulario de envío:** número, mensaje, adjunto opcional → llama a `/send-message`;
  muestra el resultado (ok/id o error).
- **Acciones:** botones Conectar (`/connect`), Detener (`/disconnect`) y Cerrar sesión
  (logout real, endpoint nuevo mínimo `POST /logout` que llama al logout de WAHA).
- **Log de envíos** de la sesión del navegador (en memoria del cliente; sin persistencia
  server-side en v1).

La UI consume **las mismas rutas de la fachada** (no una API paralela), de modo que la
web y los sistemas externos ejercitan el mismo camino.

## 6. Despliegue (Docker)

`docker-compose.yml` con dos servicios y persistencia, para desplegar una vez:

- `waha`: imagen oficial, env (`WHATSAPP_DEFAULT_ENGINE=NOWEB`, `WHATSAPP_API_KEY`),
  volumen de sesión, `restart: unless-stopped`, sin puerto al host.
- `whatsapp-api`: build del Dockerfile propio (Node 18), env (`WAHA_URL=http://waha:3000`,
  `WAHA_SESSION`, `WAHA_API_KEY`, `PORT=80`), `depends_on: [waha]`, publica `80:80`,
  `restart: unless-stopped`.
- `WAHA_API_KEY` se define **una vez** (variable de entorno / `.env` no versionado); no
  se hardcodea en el compose.
- El `Dockerfile` propio se simplifica: **ya no instala Chromium** (lo maneja WAHA); solo
  Node + deps. El `docker-entrypoint.sh` de limpieza de locks de Chromium **se elimina**
  (ya no aplica).

Nota de infraestructura: si el destino final es un servidor ARM (p.ej. server4 Graviton),
la imagen `devlikeapro/waha` debe tener variante `arm64`; confirmar el tag ARM en
implementación. El host del log (`/home/ubuntu/...`) parece un servidor propio distinto;
confirmar destino real antes de desplegar.

## 7. Qué queda fuera de v1 (⏳ diferido, trackeable)

- ⏳ **Webhooks de WAHA** (recibir mensajes / eventos entrantes): la API actual es solo
  de envío; no se agrega recepción en v1. Retomar si se necesita responder o registrar
  entrantes.
- ⏳ **Multi-número / multi-sesión:** WAHA lo soporta, pero el contrato legacy asume una
  sola sesión. v1 usa una única `WAHA_SESSION`. Retomar si aparece el requisito.
- ⏳ **Persistencia server-side del historial de envíos** (hoy solo en el navegador).
- ⏳ **Autenticación de la web UI:** v1 asume red/exposición controlada. Si la UI queda
  expuesta a internet, agregar login antes de operar.
- ⏳ **Migración de la sesión actual:** la sesión de `whatsapp-web.js` no es reutilizable
  por WAHA; habrá que **re-escanear el QR una vez** en el primer despliegue.

## 8. Testing (plan)

- Tests del `wahaClient.js` y de la fachada con el motor WAHA **mockeado** (sin WhatsApp
  real): verificar el mapeo de cada ruta legacy (status, qr, connect, disconnect, envío
  texto, envío media image vs file, guard 409, normalización de número → chatId, forma de
  respuesta `{ ok, id }`).
- Verificación end-to-end manual tras deploy: levantar compose, escanear QR desde la web
  UI, enviar texto y adjunto, confirmar `/status` y `/qr`, y probar `/send-message` /
  `/send-message-get` con los mismos comandos `curl` del README.

## 9. Notas de proceso (reglas del equipo)

- **Claude no ejecuta `git commit`.** Este spec y todo el código quedan listos en el árbol;
  el commit lo hace Juan. (Anula la indicación de la skill de commitear el spec.)
- **README como bitácora viva:** al cerrar la iteración se agrega la entrada
  correspondiente en `README.md` (en el mismo commit que el código).
