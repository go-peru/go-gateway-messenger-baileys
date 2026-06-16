/**
 * GoMessenger Baileys microservice.
 *
 * Wrapper HTTP alrededor de la librería @whiskeysockets/baileys. Expone los
 * endpoints necesarios para que go-gateway-messenger-backend (.NET) gestione
 * sesiones WhatsApp y operaciones de chat/grupos.
 *
 * Endpoints (en /api):
 *   POST   /sessions                                 — crear sesión
 *   GET    /sessions/:id/status                      — estado actual
 *   GET    /sessions/:id/qr                          — QR (base64 data URL) si existe
 *   DELETE /sessions/:id                             — borrar sesión
 *   POST   /sessions/:id/send                        — enviar mensaje (texto / media)
 *   POST   /sessions/:id/contacts/check              — verificar contactos
 *
 *   GET    /sessions/:id/groups                      — listar grupos del usuario
 *   POST   /sessions/:id/groups                      — crear grupo
 *   GET    /sessions/:id/groups/:jid                 — metadata del grupo
 *   PUT    /sessions/:id/groups/:jid/subject         — cambiar nombre
 *   PUT    /sessions/:id/groups/:jid/description     — cambiar descripción
 *   PUT    /sessions/:id/groups/:jid/setting         — modo announcement/locked
 *   POST   /sessions/:id/groups/:jid/participants    — add/remove/promote/demote
 *   POST   /sessions/:id/groups/:jid/leave           — salir del grupo
 *   GET    /sessions/:id/groups/:jid/invite          — código de invitación
 *   POST   /sessions/:id/groups/:jid/invite/revoke   — revocar e invalidar
 *
 *   GET    /health                                   — health probe
 *
 * Autenticación: header X-Internal-Secret debe coincidir con INTERNAL_SECRET.
 */

import Fastify from 'fastify';
import { SessionManager } from './sessionManager.js';
import { WebhookDispatcher } from './webhook.js';

const PORT             = Number(process.env.PORT || 3001);
const INTERNAL_SECRET  = process.env.INTERNAL_SECRET || '';
const fastify = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });

const webhook = new WebhookDispatcher();
const sessions = new SessionManager((event) => webhook.dispatch(event));

// ─── Auth gate ────────────────────────────────────────────────────────────────
fastify.addHook('preHandler', async (req, reply) => {
  if (req.url === '/api/health') return;
  const provided = req.headers['x-internal-secret'];
  if (!INTERNAL_SECRET || provided !== INTERNAL_SECRET) {
    reply.code(401).send({ error: 'unauthorized' });
  }
});

// ─── Health ───────────────────────────────────────────────────────────────────
fastify.get('/api/health', async () => ({
  status:    'ok',
  timestamp: new Date().toISOString(),
  uptime:    process.uptime(),
  sessions:  await sessions.list(),
}));

// ─── Sesiones ─────────────────────────────────────────────────────────────────
fastify.post('/api/sessions', async (req, reply) => {
  const { session_id } = req.body || {};
  if (!session_id) return reply.code(400).send({ error: 'session_id is required' });
  if (sessions.has(session_id)) return { session_id, status: sessions.get(session_id).status, existed: true };
  await sessions.create(session_id);
  return reply.code(201).send({ session_id, status: 'connecting' });
});

fastify.get('/api/sessions/:id/status', async (req, reply) => {
  const entry = sessions.get(req.params.id);
  if (!entry) return reply.code(404).send({ error: 'session_not_found' });
  return {
    session_id:  req.params.id,
    status:      entry.status,
    phoneNumber: entry.phoneNumber,
  };
});

fastify.get('/api/sessions/:id/qr', async (req, reply) => {
  const entry = sessions.get(req.params.id);
  if (!entry) return reply.code(404).send({ error: 'session_not_found' });

  reply.raw.writeHead(200, {
    'Content-Type':       'text/event-stream',
    'Cache-Control':      'no-cache',
    'Connection':         'keep-alive',
    'X-Accel-Buffering':  'no',
  });

  const writeQr = (qr) => {
    if (reply.raw.writableEnded) return;
    reply.raw.write(`event: qr\ndata: ${JSON.stringify({ qr })}\n\n`);
  };

  // Emite QR inicial si ya hay uno generado
  if (entry.qrPayload) writeQr(entry.qrPayload);

  // Suscríbete a futuros QRs / conexión
  const onQr = (qr) => writeQr(qr);
  const onConnected = () => {
    if (!reply.raw.writableEnded) {
      reply.raw.write(`event: connected\ndata: {}\n\n`);
      reply.raw.end();
    }
  };
  entry.emitter.on('qr', onQr);
  entry.emitter.on('connected', onConnected);

  // Heartbeat cada 20s
  const heartbeat = setInterval(() => {
    if (!reply.raw.writableEnded) reply.raw.write(':ping\n\n');
  }, 20_000);

  req.raw.on('close', () => {
    clearInterval(heartbeat);
    entry.emitter.off('qr', onQr);
    entry.emitter.off('connected', onConnected);
  });
});

fastify.delete('/api/sessions/:id', async (req, reply) => {
  await sessions.delete(req.params.id);
  return reply.code(204).send();
});

// ─── Envío de mensajes (texto y media) ────────────────────────────────────────
fastify.post('/api/sessions/:id/send', async (req, reply) => {
  const entry = sessions.get(req.params.id);
  if (!entry) return reply.code(404).send({ error: 'session_not_found' });
  if (entry.status !== 'open') return reply.code(400).send({ error: 'session_not_connected', status: entry.status });

  const { to, message } = req.body || {};
  if (!to || !message) return reply.code(400).send({ error: 'to and message are required' });

  const jid = to.includes('@') ? to : `${to.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
  let content;
  switch (message.type || 'text') {
    case 'text':     content = { text: message.text || '' }; break;
    case 'image':    content = { image:    { url: message.url }, caption: message.caption }; break;
    case 'video':    content = { video:    { url: message.url }, caption: message.caption }; break;
    case 'audio':    content = { audio:    { url: message.url }, mimetype: 'audio/ogg; codecs=opus', ptt: !!message.ptt }; break;
    case 'document': content = { document: { url: message.url }, mimetype: 'application/octet-stream', fileName: message.filename || 'archivo' }; break;
    default:         return reply.code(400).send({ error: 'unsupported_message_type' });
  }

  try {
    const sent = await entry.sock.sendMessage(jid, content);
    return { success: true, messageId: sent?.key?.id ?? null };
  } catch (err) {
    fastify.log.error({ err, sessionId: req.params.id }, 'send failed');
    return reply.code(500).send({ error: err.message });
  }
});

// ─── Contactos ────────────────────────────────────────────────────────────────
fastify.post('/api/sessions/:id/contacts/check', async (req, reply) => {
  const entry = sessions.get(req.params.id);
  if (!entry) return reply.code(404).send({ error: 'session_not_found' });
  if (entry.status !== 'open') return reply.code(400).send({ error: 'session_not_connected', status: entry.status });

  const { jids } = req.body || {};
  if (!Array.isArray(jids) || jids.length === 0) return reply.code(400).send({ error: 'jids array required' });
  try {
    const results = await entry.sock.onWhatsApp(...jids);
    return { results: results.map((r) => ({ jid: r.jid, exists: r.exists })) };
  } catch (err) {
    fastify.log.error({ err }, 'contacts check failed');
    return reply.code(500).send({ error: err.message });
  }
});

// ─── Grupos ───────────────────────────────────────────────────────────────────
function withConnectedSession(req, reply) {
  const entry = sessions.get(req.params.id);
  if (!entry) { reply.code(404).send({ error: 'session_not_found' }); return null; }
  if (entry.status !== 'open') { reply.code(400).send({ error: 'session_not_connected', status: entry.status }); return null; }
  return entry;
}

fastify.get('/api/sessions/:id/groups', async (req, reply) => {
  const entry = withConnectedSession(req, reply); if (!entry) return;
  try {
    const all = await entry.sock.groupFetchAllParticipating();
    const items = Object.values(all).map((g) => ({
      jid:          g.id,
      subject:      g.subject,
      participants: g.participants?.length ?? 0,
      isAdmin:      g.participants?.some((p) => p.id === entry.sock.user?.id && (p.admin === 'admin' || p.admin === 'superadmin')) ?? false,
    }));
    return { items };
  } catch (err) {
    fastify.log.error({ err }, 'fetch groups failed');
    return reply.code(500).send({ error: err.message });
  }
});

fastify.post('/api/sessions/:id/groups', async (req, reply) => {
  const entry = withConnectedSession(req, reply); if (!entry) return;
  const { subject, participants } = req.body || {};
  if (!subject || !Array.isArray(participants) || participants.length === 0) {
    return reply.code(400).send({ error: 'subject and participants[] required' });
  }
  try {
    const jids = participants.map((p) => p.includes('@') ? p : `${p.replace(/[^0-9]/g, '')}@s.whatsapp.net`);
    const group = await entry.sock.groupCreate(subject, jids);
    return reply.code(201).send({ jid: group.id, subject: group.subject });
  } catch (err) {
    fastify.log.error({ err }, 'create group failed');
    return reply.code(500).send({ error: err.message });
  }
});

fastify.get('/api/sessions/:id/groups/:jid', async (req, reply) => {
  const entry = withConnectedSession(req, reply); if (!entry) return;
  try {
    const meta = await entry.sock.groupMetadata(req.params.jid);
    return meta;
  } catch (err) {
    fastify.log.error({ err }, 'group metadata failed');
    return reply.code(500).send({ error: err.message });
  }
});

fastify.put('/api/sessions/:id/groups/:jid/subject', async (req, reply) => {
  const entry = withConnectedSession(req, reply); if (!entry) return;
  const { subject } = req.body || {};
  if (!subject) return reply.code(400).send({ error: 'subject required' });
  try { await entry.sock.groupUpdateSubject(req.params.jid, subject); return { ok: true }; }
  catch (err) { return reply.code(500).send({ error: err.message }); }
});

fastify.put('/api/sessions/:id/groups/:jid/description', async (req, reply) => {
  const entry = withConnectedSession(req, reply); if (!entry) return;
  const { description } = req.body || {};
  try { await entry.sock.groupUpdateDescription(req.params.jid, description ?? ''); return { ok: true }; }
  catch (err) { return reply.code(500).send({ error: err.message }); }
});

fastify.put('/api/sessions/:id/groups/:jid/setting', async (req, reply) => {
  const entry = withConnectedSession(req, reply); if (!entry) return;
  const { action } = req.body || {};
  const allowed = ['announcement', 'not_announcement', 'locked', 'unlocked'];
  if (!allowed.includes(action)) return reply.code(400).send({ error: `action must be one of ${allowed.join(', ')}` });
  try { await entry.sock.groupSettingUpdate(req.params.jid, action); return { ok: true }; }
  catch (err) { return reply.code(500).send({ error: err.message }); }
});

fastify.post('/api/sessions/:id/groups/:jid/participants', async (req, reply) => {
  const entry = withConnectedSession(req, reply); if (!entry) return;
  const { action, participants } = req.body || {};
  const allowed = ['add', 'remove', 'promote', 'demote'];
  if (!allowed.includes(action)) return reply.code(400).send({ error: `action must be one of ${allowed.join(', ')}` });
  if (!Array.isArray(participants) || participants.length === 0) {
    return reply.code(400).send({ error: 'participants[] required' });
  }
  const jids = participants.map((p) => p.includes('@') ? p : `${p.replace(/[^0-9]/g, '')}@s.whatsapp.net`);
  try {
    const result = await entry.sock.groupParticipantsUpdate(req.params.jid, jids, action);
    return { results: result };
  } catch (err) {
    return reply.code(500).send({ error: err.message });
  }
});

fastify.post('/api/sessions/:id/groups/:jid/leave', async (req, reply) => {
  const entry = withConnectedSession(req, reply); if (!entry) return;
  try { await entry.sock.groupLeave(req.params.jid); return { ok: true }; }
  catch (err) { return reply.code(500).send({ error: err.message }); }
});

fastify.get('/api/sessions/:id/groups/:jid/invite', async (req, reply) => {
  const entry = withConnectedSession(req, reply); if (!entry) return;
  try {
    const code = await entry.sock.groupInviteCode(req.params.jid);
    return { code, link: `https://chat.whatsapp.com/${code}` };
  } catch (err) {
    return reply.code(500).send({ error: err.message });
  }
});

fastify.post('/api/sessions/:id/groups/:jid/invite/revoke', async (req, reply) => {
  const entry = withConnectedSession(req, reply); if (!entry) return;
  try {
    const code = await entry.sock.groupRevokeInviteCode(req.params.jid);
    return { code, link: `https://chat.whatsapp.com/${code}` };
  } catch (err) {
    return reply.code(500).send({ error: err.message });
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    await sessions.restore();
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    fastify.log.info(`Baileys microservice listening on :${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
})();
