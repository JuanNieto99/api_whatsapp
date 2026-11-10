# WhatsApp API

API para enviar mensajes de WhatsApp (texto y adjuntos) con panel web para vincular la
cuenta (QR), ver el estado y enviar. Por dentro delega la conexión con WhatsApp al motor
**WAHA** (engine NOWEB, sin Chromium); nuestra capa Node expone las rutas de siempre
(fachada) más una web UI en `/`.

> Este README es **bitácora viva del proyecto**. Cada iteración suma una sección al final
> con lo que se hizo, las decisiones tomadas, problemas encontrados y pendientes. Está
> pensado para que cualquiera (incluyendo Claude en sesiones futuras) pueda recuperar
> contexto rápido.

## Arquitectura general

```
  Sistemas / navegador
        │  (mismas rutas HTTP de siempre + web UI en /)
        ▼
  whatsapp-api  (Node/Express — fachada legacy + web UI)   ← nuestro código
        │  HTTP interno (red docker), header X-Api-Key
        ▼
  waha  (devlikeapro/waha, engine NOWEB)                   ← motor mantenido por la comunidad
        │  sesión persistida en volumen ./waha-sessions
        ▼
  WhatsApp
```

## Stack técnico

- **Node 18+ / Express** — capa propia (`server.js` + `wahaClient.js`).
- **WAHA (`devlikeapro/waha`, engine NOWEB)** — motor WhatsApp, sin Chromium.
- **Docker Compose** — dos servicios (`waha` + `whatsapp-api`), un solo despliegue.

## URLs y endpoints (contrato de la fachada)

Todas las rutas aceptan un parámetro **opcional** `session` (body o query) para elegir
el número; si se omite, operan sobre la sesión por defecto (`WAHA_SESSION`, `default`).
Si `FACADE_API_KEY` está definida, todas exigen el header `X-Api-Key` (la web UI en `/`
sigue pública y lo adjunta desde el navegador).

| Ruta | Método | Descripción |
|---|---|---|
| `/` | GET | Web UI (sesiones, QR, estado, envío, historial). Pública. |
| `/sessions` | GET | `{ sessions: [{ name, status }] }` — lista las sesiones (números) con su estado. |
| `/sessions` | POST | `{ name }` → crea/arranca una sesión. `{ ok: true, name }`. |
| `/status` | GET | `{ ready: true|false }` (`ready` = sesión `WORKING`). `?session=`. |
| `/qr` | GET | `{ qr: <dataURL PNG> }`; `404` si ya está conectado o sin QR. `?session=`. |
| `/connect` | POST | Crea/arranca la sesión. `{ ok: true }`. `?session=`. |
| `/disconnect` | POST | Detiene la sesión (conserva autenticación). `{ ok: true }`. `?session=`. |
| `/logout` | POST | Cierra sesión de verdad (borra auth, fuerza nuevo QR). `?session=`. |
| `/send-message` | POST | `multipart/form-data`: `number`, `message` (opc.), `file` (opc.), `session` (opc.). |
| `/send-message-get` | GET | query: `number`, `message`, `file` (base64), `fileName`, `fileType`, `session`. |

Envío — ejemplos `curl`:

```bash
# Texto
curl -X POST http://localhost/send-message \
  -F 'number=573001234567' -F 'message=Hola desde la API'

# Con archivo
curl -X POST http://localhost/send-message \
  -F 'number=573001234567' -F 'message=Adjunto' -F 'file=@/ruta/archivo.jpg'
```

## Despliegue

```bash
cp .env.example .env         # y poné un valor propio en WAHA_API_KEY
docker compose up -d --build # primera vez (o cuando cambie el código)
```

1. Abrí `http://<host>/`, aparece el QR, escanealo **una vez** desde WhatsApp →
   Dispositivos vinculados.
2. En adelante, cada `docker compose up -d` **reconecta solo, sin QR** (la sesión queda
   en el volumen `./waha-sessions`). Solo se vuelve a pedir QR si cerrás sesión a
   propósito o WhatsApp te desvincula desde el teléfono.

## Tests

```bash
node test/smoke.js   # smoke test de la fachada contra un WAHA simulado (sin WhatsApp real)
```

## Iteraciones planificadas

| # | Objetivo | Estado |
|---|---|---|
| 1.0 | Migrar de whatsapp-web.js roto a fachada sobre WAHA + web UI | 🔨 Lista para deploy |
| 1.1 | Multi-sesión (varios números) + auth de fachada opt-in | ✅ Desplegada (2026-11-03, chillones.lat) |
| 1.2 | Login de admin + token obligatorio en toda la API | 🔨 Lista para deploy (pendiente commit de Juan + `git pull` y rebuild en el server) |

## Bitácora de iteraciones

### Iteración 1.0 — Fachada sobre WAHA (NOWEB) + web UI

| | |
|---|---|
| **Fecha** | 2026-09-16 |
| **Estado** | 🔨 Lista para deploy (pendiente re-escaneo de QR en el primer arranque) |
| **Objetivo** | La versión anterior (`whatsapp-web.js@1.19.1` + Chromium) se caía en producción con `Cannot read ... 'getChat'` y un loop `LOGOUT` + "Execution context was destroyed" que tumbaba el proceso. Se buscó una solución que no haya que re-desplegar cada vez que WhatsApp cambia, con interfaz gráfica y despliegue de una sola vez. Diseño en [docs/superpowers/specs/2026-09-16-whatsapp-waha-facade-design.md](docs/superpowers/specs/2026-09-16-whatsapp-waha-facade-design.md). |

#### Qué se hizo
- Se delegó la conexión con WhatsApp al motor **WAHA** (engine NOWEB, sin Chromium),
  como contenedor aparte en el `docker-compose.yml`. Esto elimina la clase de fallos de
  puppeteer del log (todos venían de la capa Chromium).
- [`wahaClient.js`](wahaClient.js) — cliente HTTP fino contra WAHA (único módulo que
  conoce su API): estado, arranque/parada/logout de sesión, QR y envío de texto/media.
- [`server.js`](server.js) reescrito como **fachada**: expone las mismas rutas legacy
  (`/qr`, `/status`, `/connect`, `/disconnect`, `/send-message`, `/send-message-get`) con
  el mismo contrato, traduciendo por dentro a WAHA; sirve la **web UI**; engancha la
  sesión al boot con reintentos; agrega handlers de `unhandledRejection`/`uncaughtException`.
- [`public/index.html`](public/index.html) — web UI (estado, QR, formulario de envío,
  historial, botones conectar/detener/cerrar sesión).
- `Dockerfile` simplificado (ya no instala Chromium); `docker-entrypoint.sh` eliminado
  (limpiaba locks de Chromium, ya no aplica); `package.json` sin `whatsapp-web.js` ni
  `qrcode`; `docker-compose.yml` con `waha` + `whatsapp-api` y volumen `./waha-sessions`.
- [`test/smoke.js`](test/smoke.js) — smoke test de la fachada contra un WAHA simulado.

#### Decisiones tomadas (con el usuario)
- **Enfoque:** plataforma mantenida en vez de seguir manteniendo `server.js` a mano
  (Juan lo eligió), para no re-desplegar ante cada cambio de WhatsApp.
- **Motor WAHA + engine NOWEB** (recomendación de Claude, aceptada): sin Chromium →
  ataca de raíz los crashes del log.
- **Conservar el contrato HTTP actual** (requisito explícito de Juan): los consumidores
  existentes no cambian nada; se suma la web UI encima.

#### ⏳ Diferido — NO perder
- ⏳ **Re-escaneo de QR una vez** — la sesión de `whatsapp-web.js` no es reutilizable por
  WAHA; en el primer deploy hay que escanear el QR. Después persiste en el volumen.
- ⏳ **Webhooks / recepción de mensajes** — la API es solo de envío; no se agregó
  recepción. Retomar si se necesita responder/registrar entrantes.
- ⏳ **Multi-número / multi-sesión** — v1 usa una sola sesión (`WAHA_SESSION=default`).
- ⏳ **Auth de la web UI** — v1 asume exposición controlada. Si queda pública en internet,
  agregar login antes de operar.
- ⏳ **Historial de envíos server-side** — hoy el historial vive solo en el navegador.
- ⏳ **TLS + puerto 80 en el EC2 (`chillones.lat`)** — el deploy usa certbot standalone,
  que compite por el puerto 80 con el contenedor (en `despliegue` se hacía `docker stop`
  antes de renovar). Definir esquema estable (reverse proxy / certbot webroot) para que
  la renovación no choque con la API. No bloqueante para levantar el stack.

#### Cambio de contrato a tener en cuenta
- El campo `id` de la respuesta de envío mantiene el **nombre**, pero su **valor cambia de
  forma** (lo genera WAHA/NOWEB, no `whatsapp-web.js`). Sigue siendo un id de mensaje.
- Mejora: si la sesión no está conectada, `/send-message[-get]` responde **`409`** (antes
  era un `500` con el error `getChat`).

#### Notas de despliegue
- Destino: **EC2 AWS** (`ubuntu@ec2-...us-east-2`, amd64) — la imagen `devlikeapro/waha`
  corre nativa; no aplica el tema ARM.

#### Tests
- Smoke test: **10 checks** de la fachada (status, qr, envío texto/imagen/archivo por POST
  y GET, guard 409, normalización de número) contra WAHA simulado. Todos en verde.
  Sin WhatsApp real (eso se verifica a mano tras el deploy).

---

### Iteración 1.1 — Multi-sesión (varios números) + auth de fachada opt-in

| | |
|---|---|
| **Fecha** | 2026-11-03 |
| **Estado** | ✅ Desplegada 2026-11-03 en chillones.lat (Oracle ARM): `/sessions` responde 200, sesión `default` sigue `WORKING`. Smoke 18/18. |
| **Objetivo** | Dar soporte a **varias sesiones de WhatsApp simultáneas** (un número por tienda) y **autenticación de la fachada**, como prerequisito de una APK de gestión de tienda (proyecto aparte) donde cada tienda elige de qué sesión salen sus notificaciones. Resuelve los diferidos "Multi-número / multi-sesión" y (parcialmente) "Auth de la web UI" de la iteración 1.0. Diseño en [docs/superpowers/specs/2026-11-03-whatsapp-multisesion-auth-design.md](docs/superpowers/specs/2026-11-03-whatsapp-multisesion-auth-design.md). |

#### Qué se hizo
- **[wahaClient.js](wahaClient.js):** cada función (`getStatus`, `isReady`, `ensureStarted`,
  `stop`, `logout`, `getQrDataUrl`, `sendText`, `sendMedia`) recibe ahora `session` como
  primer argumento; helper `sess()` resuelve el default y **valida** el nombre
  (`[A-Za-z0-9_-]+`, evita inyección de ruta). Nueva **`listSessions()`**. Se exporta
  `DEFAULT_SESSION` (antes `SESSION`).
- **[server.js](server.js):** `getSession(req)` (body o query); nuevos **`GET /sessions`**
  (lista con estado) y **`POST /sessions`** (crea/arranca); todas las rutas legacy propagan
  `session`. Middleware **`requireApiKey`** opt-in: si `FACADE_API_KEY` está definida, exige
  `X-Api-Key` (o `?apikey=`) en toda ruta de API; la UI estática en `/` queda pública. La key
  se lee **por request** (activar/rotar sin reiniciar). Es **distinta** de `WAHA_API_KEY`.
- **[public/index.html](public/index.html):** barra con **selector de sesión** + botón
  **Nueva** + campo **API key** (persistida en localStorage). Helper `api()` que agrega
  `?session=` y el header `X-Api-Key`. Estado/QR/conexión/envío operan sobre la sesión activa;
  el historial marca `[sesión]`.
- **[test/smoke.js](test/smoke.js):** mock de WAHA **multi-sesión** (match por regex de
  sesión); aserciones de `session` (default y explícita), de `/sessions`, y **caso de auth**
  (401 sin key, 200 con key correcta, 401 con key equivocada). **18 checks**, todos en verde.
- **[.env.example](.env.example) + [docker-compose.yml](docker-compose.yml):**
  `FACADE_API_KEY` opcional documentada (vacía = API abierta, legacy).

#### Decisiones tomadas (con el usuario)
- **Juan** (brainstorming 2026-11-03): la conexión de WhatsApp es **el mismo gateway (WAHA) en
  varias sesiones**, y la tienda elige la sesión. Pidió "procede con todos los proyectos, se
  muy meticuloso".
- **Retrocompatibilidad como requisito duro:** `/send-message` sin `session` → `default`; auth
  **opt-in** para no romper a chillones.lat ni a la web de TIENDA que hoy llaman sin auth.

#### ⏳ Diferido — NO perder
- ⏳ **Auth real de la web UI (login por usuario)** — la página sigue pública; la key vive en
  localStorage. Suficiente para exposición controlada; login por usuario sería otra iteración.
- ⏳ **Re-escaneo de QR por sesión** — cada número nuevo exige escanear su QR una vez (igual que
  la sesión única de la 1.0, ahora por sesión).
- ⏳ **Webhooks/recepción** y **persistencia server-side del historial** — siguen diferidos de la 1.0.

#### Notas de proceso
- ⚠️ **Deviación de política TI (una-carpeta-un-repo):** esta iteración se implementó desde una
  sesión de Claude Code anclada a la carpeta del proyecto **TIENDA**, no a la de `api_whatsapp`,
  por **decisión explícita de Juan** ("procede con todos los proyectos"). Queda la constancia
  acá como manda la política; la responsabilidad es de quien decide romperla.
- **Claude no ejecutó `git commit`:** el árbol queda listo; el commit lo hace Juan.

#### Tests
Suite final: **18 checks** del smoke test (baseline 10 de la 1.0 + 8 nuevos: sesión
default/explícita en envío POST y GET, `GET/POST /sessions`, 400 sin name, y 4 de auth).
Sin WhatsApp real (se verifica a mano tras el deploy). Sin migración de datos.

---

### Iteración 1.2 — Login admin + token al loguearse (DISEÑO acordado, sin código)

| | |
|---|---|
| **Fecha** | 2026-11-05 |
| **Estado** | 🚧 Diseño acordado en brainstorming (desde la sesión de TIENDA); **cero código tocado**. Spec pendiente. |
| **Objetivo** | Pedido de Juan: la API de envío exige token **siempre**; la gestión (crear sesiones, QR) queda detrás de un **login** de un solo admin. El token lo obtienen los sistemas al loguearse. Resuelve el diferido "Auth real de la web UI" de la 1.1. |

#### Diseño acordado (brainstorming 2026-11-05, en la sesión de TIENDA)
1. Credenciales (user/pass) y token en `./data/auth.json` (volumen persistido); `ADMIN_USER`/`ADMIN_PASS`
   (env) solo siembran el primer arranque.
2. `POST /login` `{ user, pass }` → `{ ok, token }` + cookie firmada para el panel.
3. `POST /change-password` `{ user, passActual, passNueva }` → valida la actual y cambia. Lo usa el
   panel y también TIENDA (que sincroniza su Configuración contra este endpoint).
4. **Toda** la API exige cookie de admin o `X-Api-Key` con el token vigente — se elimina el modo
   opt-in de `FACADE_API_KEY` (su valor pasa a sembrar el token inicial, para no romper consumidores).
5. Panel: pantalla de login, muestra el token y permite **rotarlo**. Token fijo (sin expiración ni
   JWT — decidido con Juan: un solo admin, consumidores máquina-a-máquina).
6. Descartado con Juan: límite de 3 sesiones nuevas/día (idea inicial; el login basta).

#### ⏳ Diferido — NO perder
- ⏳ **Implementación completa de este diseño** — escribir spec + plan y ejecutar DESDE ESTA carpeta
  (política una-carpeta-un-repo). Falta que Juan defina usuario/contraseña por defecto.
- ⏳ **Contraparte en TIENDA** — properties `WHATSAPP_USER`/`WHATSAPP_PASS` (defaults quemados,
  editables en Configuración), re-login automático ante 401 y cambio de contraseña sincronizado.
  Detalle completo en la bitácora de TIENDA (Iteración 2.4).

---

### Iteración 1.1b — Deploy de la 1.1 en el server Oracle (2026-11-09)

| | |
|---|---|
| **Fecha** | 2026-11-09 |
| **Estado** | ✅ Desplegada y verificada (desde la sesión de TIENDA, a pedido de Juan) |
| **Objetivo** | Bajar los cambios del repo al server y reconstruir el servicio. |

#### Qué se hizo
- Server actual: **Oracle Cloud `140.84.161.116`** (host `vnic-servidor`, ARM; llave
  `ssh-key-2026-02-03.key`). El EC2 viejo de `despliegue` ya no responde; `chillones.lat`
  pasa por Cloudflare (no sirve para SSH).
- El árbol del server tenía la 1.1 aplicada A MANO (idéntica al repo) + docs viejas: respaldo
  en `~/backup-pre-pull-20261109/`, `git reset --hard` + `pull` → `4b78b37`.
- Re-aplicado el pin ARM `devlikeapro/waha:noweb-arm` en docker-compose.yml y
  `docker compose up -d --build` (solo recrea `whatsapp-api`; `waha` ni se tocó).

#### Verificación end-to-end
- `https://chillones.lat/status` → `{"ready":true}`; `/sessions` → Camila, default y juan en WORKING
  (las sesiones sobrevivieron al rebuild, sin re-escanear QR).

#### ⏳ Diferido — NO perder
- ⏳ **Pin ARM del compose solo vive en el server** — `docker-compose.yml` del repo dice
  `devlikeapro/waha` a secas; en el server se re-aplica a mano `noweb-arm`. Contra la política
  "nada manual": hay que commitear el pin (o parametrizarlo por env) en el repo. Retomar en la 1.2.
- ⏳ **`levantar_mi_app.sh` (cron diario) solo vive en el server** — no está versionado; traerlo
  al repo. Retomar en la 1.2.

---

### Iteración 1.2 — Login de admin + token obligatorio (auth SIEMPRE encendida)

| | |
|---|---|
| **Fecha** | 2026-11-10 |
| **Estado** | 🔨 Lista para deploy — código completo y testeado; falta commit/push de Juan y `git pull` + rebuild en el server Oracle. |
| **Objetivo** | Pedido de Juan (diseño acordado el 2026-11-05 en la sesión de TIENDA, iteración 2.4 de esa bitácora): enviar mensajes debe exigir token, la gestión queda detrás de un login, y el token lo obtienen los sistemas al loguearse. Agregado del 2026-11-10: una petición sin credencial debe responder que **hay que actualizarse porque ahora se necesita iniciar sesión para enviar los mensajes**. |

#### Qué se hizo
- **[auth.js](auth.js) (nuevo):** credenciales y token persistidos en `./data/auth.json`
  (hash scrypt + salt; token plano). Siembra SOLO el primer arranque: `ADMIN_USER`/`ADMIN_PASS`
  (defaults del equipo) y token = `FACADE_API_KEY` si está definida (migración sin corte) o
  aleatorio. Sesiones de cookie en memoria (sid, TTL 12 h).
- **[server.js](server.js):** se eliminó el modo opt-in — la auth es **obligatoria** en toda
  ruta de API: cookie de admin o `X-Api-Key`/`?apikey` con el token vigente. Sin credencial →
  **401 `{ error: 'login_requerido' }`** con el mensaje: *"La API de WhatsApp ahora requiere
  iniciar sesión para enviar mensajes. Debe actualizar su aplicación o configurar usuario y
  contraseña para continuar."* Rutas nuevas: `POST /login` (token + cookie `wa_admin`),
  `POST /change-password`, `POST /logout-admin`, `GET /token`, `POST /rotate-token`.
  La web UI estática en `/` sigue pública.
- **[public/index.html](public/index.html):** overlay de login (usuario/contraseña, cookie
  `same-origin`); se eliminó el input manual de X-Api-Key (y su localStorage). La barra
  muestra el **token vigente** con botón **Rotar** y hay botón **Salir** del panel.
- **[docker-compose.yml](docker-compose.yml):** volumen `./data:/app/data` (persistencia de
  auth.json), envs de siembra `ADMIN_USER`/`ADMIN_PASS`/`FACADE_API_KEY`, y
  `image: ${WAHA_IMAGE:-devlikeapro/waha}` → cierra el diferido del **pin ARM**: en el server
  el `.env` lleva `WAHA_IMAGE=devlikeapro/waha:noweb-arm` (ya no se edita el compose a mano).
  [.env.example](.env.example) documenta las 4 variables. `data/` entró al `.gitignore` (secretos).
- Tests: **[test/auth.js](test/auth.js) (nuevo, 6 casos)** y [test/smoke.js](test/smoke.js)
  reescrito al contrato nuevo (24 casos: legacy+multisesión autenticados, 401 con mensaje de
  actualización, login/cookie, rotación, change-password, UI pública).

#### Decisiones tomadas (con el usuario)
- **Juan (2026-11-10):** aplicar ya el diseño de la 2.4 y publicarlo; el 401 debe decir
  explícitamente que hay que actualizarse porque ahora se necesita iniciar sesión.
- Mensaje y rutas según el diseño 2.4 (un solo admin, token fijo visible/rotable, sin JWT).
- **Constancia de política:** este trabajo se hizo desde la sesión de TIENDA (pedido de Juan
  del 2026-11-10), contra la regla "una carpeta por proyecto". Queda registrado aquí y en la
  bitácora de TIENDA (iteración 2.5).

#### ⏳ Diferido — NO perder
- ⏳ **`levantar_mi_app.sh` sigue sin versionar** — el acceso SSH al server desde la sesión
  automática fue denegado por permisos; traerlo al repo en el próximo acceso manual al server
  (`scp` desde `ubuntu@140.84.161.116`) y commitearlo en `despliegue/`.
- ⏳ **Deploy pendiente**: (1) Juan commitea y pushea este repo; (2) en el server:
  `cd ~/api_whatsapp && git pull`, agregar al `.env`: `WAHA_IMAGE=devlikeapro/waha:noweb-arm`
  y (si no está) `FACADE_API_KEY=<key que ya usan los consumidores>` para sembrar el token
  sin corte; (3) `docker compose up -d --build` (solo recrea `whatsapp-api`); (4) verificar:
  `/status` sin key → 401 con mensaje nuevo; con `X-Api-Key` vieja → 200; `/sessions`
  conserva Camila/default/juan; login en el panel con las credenciales default y cambiarlas.

#### Tests
Suite: **test/auth.js 6/6** + **test/smoke.js 24/24** (antes 18). Sin migración de datos
(auth.json se crea solo en el primer arranque).

---
