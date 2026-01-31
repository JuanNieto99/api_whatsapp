# WhatsApp API sencilla

API minimal para enviar mensajes de WhatsApp (texto y archivo) y generar QR para vincular la cuenta.

Endpoints principales:
- `GET /qr` -> devuelve `qr` como DataURL (base64 PNG) si hay QR pendiente.
- `GET /status` -> devuelve `{ ready: true|false }`.
- `POST /connect` -> fuerza inicialización (genera QR si es necesario).
- `POST /disconnect` -> desconecta y destruye la sesión.
- `POST /send-message` -> enviar mensaje. Acepta `multipart/form-data` con:
  - `number` (form field) — número con código de país (ej: 54911... para Argentina)
  - `message` (opcional si hay file)
  - `file` (opcional) — archivo adjunto

Ejemplo con `curl` (mensaje de texto):

```bash
curl -X POST http://localhost:3000/send-message \
  -F 'number=5491123456789' \
  -F 'message=Hola desde la API'
```

Ejemplo con archivo:

```bash
curl -X POST http://localhost:3000/send-message \
  -F 'number=5491123456789' \
  -F 'message=Archivo adjunto' \
  -F 'file=@/ruta/al/archivo.jpg'
```

Ejecución con Docker Compose:

```bash
docker compose up --build -d
```

Notas:
- Las sesiones se persisten en `./sessions` (mapeado como volumen). Para escalar en nube usar un volumen compartido o almacenar las sesiones en un almacenamiento persistente.
- El servicio usa `whatsapp-web.js` y Chromium; la primera vez te pedirá escanear el QR mostrado en `GET /qr`.

Autenticación
-------------

No se requiere autenticación para usar los endpoints; las rutas son públicas por defecto. El sistema ya no solicita ni valida `x-api-key`.

Si deseas volver a añadir autenticación o rate limiting, edita `server.js` para reintroducir un middleware de verificación y configuración correspondiente.
