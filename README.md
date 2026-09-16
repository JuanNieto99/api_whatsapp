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

| Ruta | Método | Descripción |
|---|---|---|
| `/` | GET | Web UI (QR, estado, envío, historial). |
| `/status` | GET | `{ ready: true|false }` (`ready` = sesión `WORKING`). |
| `/qr` | GET | `{ qr: <dataURL PNG> }`; `404` si ya está conectado o sin QR. |
| `/connect` | POST | Crea/arranca la sesión. `{ ok: true }`. |
| `/disconnect` | POST | Detiene la sesión (conserva autenticación). `{ ok: true }`. |
| `/logout` | POST | Cierra sesión de verdad (borra auth, fuerza nuevo QR). |
| `/send-message` | POST | `multipart/form-data`: `number`, `message` (opc.), `file` (opc.). |
| `/send-message-get` | GET | query: `number`, `message`, `file` (base64), `fileName`, `fileType`. |

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
