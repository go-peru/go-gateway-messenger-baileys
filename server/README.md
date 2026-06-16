# go-gateway-messenger-baileys (servidor)

Wrapper HTTP minimalista alrededor de la librería [`baileys`](https://github.com/WhiskeySockets/Baileys) (fork en `..`) que expone los endpoints necesarios para que **go-gateway-messenger-backend** (.NET) gestione WhatsApp.

Es el reemplazo de la imagen `gleyendeker/pulzo-baileys` que solo soportaba `GET metadata` de grupos. Este wrapper expone todos los endpoints administrativos (crear/listar/agregar/quitar/promote/demote/cambiar nombre/etc.) además del envío estándar.

## Endpoints

Todos requieren header `X-Internal-Secret: ${INTERNAL_SECRET}`.

### Sesiones
- `POST   /api/sessions` `{ session_id }`
- `GET    /api/sessions/:id/status`
- `GET    /api/sessions/:id/qr` (SSE)
- `DELETE /api/sessions/:id`

### Mensajes
- `POST   /api/sessions/:id/send` `{ to, message: { type, text|url|caption|filename } }`

### Contactos
- `POST   /api/sessions/:id/contacts/check` `{ jids: [...] }`

### Grupos
- `GET    /api/sessions/:id/groups`
- `POST   /api/sessions/:id/groups` `{ subject, participants: [phones...] }`
- `GET    /api/sessions/:id/groups/:jid`
- `PUT    /api/sessions/:id/groups/:jid/subject` `{ subject }`
- `PUT    /api/sessions/:id/groups/:jid/description` `{ description }`
- `PUT    /api/sessions/:id/groups/:jid/setting` `{ action: announcement|not_announcement|locked|unlocked }`
- `POST   /api/sessions/:id/groups/:jid/participants` `{ action: add|remove|promote|demote, participants: [...] }`
- `POST   /api/sessions/:id/groups/:jid/leave`
- `GET    /api/sessions/:id/groups/:jid/invite`
- `POST   /api/sessions/:id/groups/:jid/invite/revoke`

### Health
- `GET    /api/health` (sin auth)

## Variables de entorno

| Variable | Descripción | Default |
|---|---|---|
| `PORT` | Puerto HTTP | `3001` |
| `INTERNAL_SECRET` | Shared secret entre backend y este servicio | (vacío → rechaza todo) |
| `SESSIONS_PATH` | Carpeta donde se persisten las creds | `/app/sessions` |
| `WEBHOOK_URL` | URL del backend para eventos (QR, mensajes, conexión) | (vacío → no se envía) |
| `LOG_LEVEL` | pino log level | `info` |

## Webhook payload

```json
{ "event": "qrcode.updated",        "sessionId": "...", "qr": "data:image/png;base64,..." }
{ "event": "session.connected",     "sessionId": "...", "phoneNumber": "+51..." }
{ "event": "session.disconnected",  "sessionId": "..." }
{ "event": "message.received",      "sessionId": "...", "messageId": "...", "from": "51999@s.whatsapp.net", "body": "...", "mediaType": null|"image"|"video"|"audio"|"document", "timestamp": 1234567890 }
```

## Dev local sin Docker

```bash
cd ..
npm install   # compila la lib
cd server
npm install
INTERNAL_SECRET=dev npm start
```
