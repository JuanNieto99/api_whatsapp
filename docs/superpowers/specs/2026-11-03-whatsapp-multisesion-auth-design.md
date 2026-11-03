# Diseño — WhatsApp API multi-sesión + auth de fachada

| | |
|---|---|
| **Fecha** | 2026-11-03 |
| **Autor** | Juan Guillermo Nieto Martinez — Analista y Desarrollador nivel 3, TI AYNN - OROEXPRESS |
| **Estado** | Implementado y testeado (smoke 18/18); pendiente deploy + re-escaneo de QR por sesión |

## 1. Problema y objetivo

La fachada sobre WAHA (iteración 1.0) maneja **una sola sesión** (`WAHA_SESSION`
fija por env) y **no tiene auth propia** — ambos puntos estaban marcados como ⏳
diferidos. Aparece el requisito concreto: una **APK de gestión de tienda** (proyecto
aparte) va a tener **varias tiendas**, y cada tienda debe elegir **de qué número/sesión
de WhatsApp** salen sus notificaciones. Además, para exponer la API a internet con varias
tiendas apuntándole, hace falta **autenticación**.

**Objetivo:** que un mismo servidor maneje **varias sesiones simultáneas** (WAHA ya lo
soporta nativo) y que la API quede **protegible con una API key**, **sin romper** a los
consumidores actuales (chillones.lat, la web de TIENDA) que llaman a `/send-message` con
el contrato de una sola sesión y sin auth.

## 2. Decisiones de diseño

| Decisión | Razón |
|---|---|
| Sesión **parametrizada por request** (`session` opcional en body/query); sin ella → sesión por defecto | Retrocompatibilidad total: el consumidor viejo no cambia nada y cae en `default`. |
| Nuevos endpoints `GET /sessions` y `POST /sessions` | La APK/UI necesita **listar** sesiones conectadas (para elegir) y **crear** nuevas. |
| Resto de rutas (`/status`, `/qr`, `/connect`, `/disconnect`, `/logout`, envíos) aceptan `?session=` | Operar cada número de forma independiente con el mismo contrato. |
| Auth de fachada **opt-in** vía `FACADE_API_KEY` (header `X-Api-Key`) | Si está vacía, la API queda abierta (legacy, no rompe nada); si se define, exige la key. Permite activar seguridad al exponer a internet sin forzar a los consumidores actuales. |
| La key se lee **por request** (no al boot) | Activarla/rotarla sin reiniciar; y testeable en un solo proceso. |
| `FACADE_API_KEY` ≠ `WAHA_API_KEY` | Una protege la fachada hacia afuera; la otra es el secreto interno fachada↔motor. |
| Validación del nombre de sesión `[A-Za-z0-9_-]+` | Evita inyección de segmentos de ruta en las URLs de WAHA. |
| Web UI estática en `/` **pública**; su JS adjunta la key | La página carga sin auth; las llamadas a la API sí la llevan (guardada en localStorage). |

## 3. Cambios por archivo

- **`wahaClient.js`** — cada función recibe `session` como primer argumento; helper
  `sess()` resuelve default + valida; nueva `listSessions()`. Export `DEFAULT_SESSION`
  (antes `SESSION`).
- **`server.js`** — `getSession(req)` (body/query); middleware `requireApiKey` opt-in
  (lee `process.env.FACADE_API_KEY` por request); `GET/POST /sessions`; todas las rutas
  legacy propagan `session`. Static ANTES del middleware (UI pública).
- **`public/index.html`** — barra con **selector de sesión** + botón “Nueva” + campo
  **API key** (localStorage); helper `api()` que agrega `?session=` y header `X-Api-Key`;
  estado/QR/envío operan sobre la sesión activa.
- **`test/smoke.js`** — mock de WAHA multi-sesión (regex por sesión); aserciones de
  `session` (default y explícita); `/sessions`; y caso de auth (401 sin key / 200 con key).
- **`.env.example`, `docker-compose.yml`** — `FACADE_API_KEY` opcional documentada.

## 4. Contrato (lo que consume la APK, proyecto B)

- `GET /sessions` → `{ sessions: [{ name, status }] }` — para poblar el selector de la tienda.
- `POST /send-message` (multipart) con campo **`session`** + header **`X-Api-Key`** →
  `{ ok, id }`. Sin `session` → sesión `default` (compat).
- Mismos `409` (no conectado) y normalización de número → chatId de antes.

## 5. Qué queda fuera (⏳ diferido)

- ⏳ **Auth real de la web UI** (login de usuario): la página sigue pública; la key vive en
  localStorage del navegador. Suficiente para exposición controlada; si se quiere login por
  usuario, es otra iteración.
- ⏳ **Webhooks / recepción** — sigue siendo solo envío.
- ⏳ **Persistencia server-side del historial** — el log vive en el navegador.
- ⏳ **QR por sesión en el primer deploy** — cada número nuevo exige escanear su QR una vez.

## 6. Verificación

- **Smoke test:** `node test/smoke.js` → **18 checks** en verde (fachada legacy, sesión
  default/explícita, `/sessions`, guard 409, auth opt-in).
- **End-to-end (pendiente de deploy):** levantar compose con y sin `FACADE_API_KEY`,
  crear 2 sesiones desde la UI, escanear 2 QR, enviar por cada una, y confirmar que
  `/send-message` sin `session` sigue usando `default`.

## 7. Notas de proceso

- **Claude no ejecuta `git commit`.** Código y spec quedan listos en el árbol; el commit
  lo hace Juan.
- **Deviación de política TI registrada:** esta iteración se implementó desde una sesión de
  Claude Code anclada a la carpeta del proyecto **TIENDA** (no a la de `api_whatsapp`), por
  decisión explícita de Juan ("procede con todos los proyectos"). Ver README, iteración 1.1.
