/**
 * SessionManager — administra sesiones Baileys en memoria y persiste auth state
 * en disco. Cada sesión tiene un sessionId (Guid generado por el caller),
 * un socket Baileys (`sock`) y un último QR base64.
 */

import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } from 'baileys';
import { Boom } from '@hapi/boom';
import { EventEmitter } from 'events';
import pino from 'pino';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const SESSIONS_PATH = process.env.SESSIONS_PATH || '/app/sessions';

/**
 * Resuelve un JID al teléfono crudo (solo dígitos, p.ej. "51949236969").
 *
 * WhatsApp emite muchos eventos con JID en formato "@lid" (Linked ID — un
 * identificador opaco que protege la privacidad del contacto). Sin resolverlo,
 * el backend crearía una conversación nueva por cada lid y los mensajes
 * entrantes no se asocian a la conversación existente del usuario.
 *
 * Normaliza varios formatos a teléfono crudo:
 *   "51949236969:0@s.whatsapp.net" → "51949236969"
 *   "83129259827359@lid"           → resuelve a PN y normaliza
 *   "51949236969"                  → "51949236969"
 */
async function resolveJidToPhone(sock, jid) {
  if (!jid) return jid;
  let target = jid;
  if (jid.endsWith('@lid')) {
    try {
      const pn = await sock?.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) target = pn;
    } catch (err) {
      logger.warn({ err: err.message, jid }, 'resolveJidToPhone failed');
    }
  }
  // Stripear "@dominio" y ":deviceId" — el backend guarda solo dígitos.
  return target.split('@')[0].split(':')[0];
}

/**
 * Descarga el buffer de la media del mensaje y lo empaqueta como base64
 * con sus metadatos. Devuelve null si:
 *   - El mensaje no tiene media (mediaType es null).
 *   - La descarga falla (media expirada en el CDN de WhatsApp, sin permisos, etc).
 *
 * Los metadatos (mimeType, filename, durationSec, dimensions) son opcionales —
 * los pasamos como los tenga el mensaje para que gomessenger arme el content-type
 * correcto en MinIO y el frontend renderice el widget adecuado.
 */
async function tryDownloadMedia(sock, msg, mediaType) {
  if (!mediaType) return null;

  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
      logger,
      reuploadRequest: sock.updateMediaMessage,
    });
    if (!buffer || buffer.length === 0) return null;

    // Extraemos metadatos del nodo específico (imageMessage, audioMessage, etc).
    // Los stickers de WhatsApp llegan como stickerMessage (image/webp) y los
    // tratamos como image — el frontend detecta el mime y los muestra flotantes
    // sin borde como corresponde.
    const node =
      msg.message?.imageMessage    ??
      msg.message?.videoMessage    ??
      msg.message?.audioMessage    ??
      msg.message?.documentMessage ??
      msg.message?.stickerMessage;
    const mimeType = node?.mimetype ?? null;
    // documentMessage.fileName solo aplica a documentos. Los stickers no traen
    // filename — le damos uno derivado del extension del mime.
    const filename = msg.message?.documentMessage?.fileName
      ?? (msg.message?.stickerMessage ? `sticker.webp` : null);
    // audioMessage.seconds y videoMessage.seconds son la duración cuando existe.
    const durationSec = node?.seconds ?? null;
    // imageMessage/videoMessage traen width/height del CDN de WA.
    const width  = node?.width  ?? null;
    const height = node?.height ?? null;

    return {
      type:        mediaType,           // image | video | audio | document
      base64:      buffer.toString('base64'),
      byteLength:  buffer.length,
      mimeType,
      filename,
      durationSec,
      width,
      height,
    };
  } catch (err) {
    logger.warn({ err: err.message, mediaType, msgId: msg.key.id }, 'downloadMediaMessage failed');
    return null;
  }
}

export class SessionManager {
  constructor(onEvent) {
    /** @type {Map<string, { sock: any; qrBase64: string | null; status: string; phoneNumber: string | null; emitter: EventEmitter; }>} */
    this.sessions = new Map();
    /** Callback que se llama cada vez que un evento relevante ocurre (qr, conexión, mensaje, etc.) */
    this.onEvent = onEvent || (() => {});
  }

  async list() {
    const items = {};
    for (const [id, s] of this.sessions.entries()) {
      items[id] = {
        status:      s.status,
        phoneNumber: s.phoneNumber,
      };
    }
    return items;
  }

  has(sessionId) {
    return this.sessions.has(sessionId);
  }

  get(sessionId) {
    return this.sessions.get(sessionId) ?? null;
  }

  /**
   * Crea (o reactiva) una sesión. Idempotente: si ya existe, no hace nada.
   */
  async create(sessionId) {
    if (this.sessions.has(sessionId)) return this.sessions.get(sessionId);

    const folder = path.join(SESSIONS_PATH, sessionId);
    await fs.mkdir(folder, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(folder);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info({ sessionId, version, isLatest }, 'creating Baileys session');

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['GoMessenger', 'Chrome', '1.0.0'],
      syncFullHistory: false,
    });

    const entry = {
      sock,
      qrPayload: null, // payload crudo del QR (string que el frontend pinta como SVG)
      status: 'connecting',
      phoneNumber: null,
      emitter: new EventEmitter(),
    };
    this.sessions.set(sessionId, entry);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        entry.qrPayload = qr;
        entry.status = 'pending_qr';
        logger.info({ sessionId }, 'QR generated');
        entry.emitter.emit('qr', qr);
        this.onEvent({ event: 'qrcode.updated', sessionId, qr });
      }

      if (connection === 'open') {
        entry.status = 'open';
        entry.qrPayload = null;
        entry.phoneNumber = sock.user?.id?.split('@')[0]?.split(':')[0] ?? null;
        logger.info({ sessionId, phone: entry.phoneNumber }, 'session connected');
        entry.emitter.emit('connected', entry.phoneNumber);
        this.onEvent({ event: 'session.connected', sessionId, phoneNumber: entry.phoneNumber ? `+${entry.phoneNumber}` : null });
      }

      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        entry.status = shouldReconnect ? 'connecting' : 'close';
        logger.warn({ sessionId, statusCode, shouldReconnect }, 'session disconnected');
        entry.emitter.emit('disconnected');
        this.onEvent({ event: 'session.disconnected', sessionId });

        if (shouldReconnect) {
          // Recrear el socket. La auth state ya está persistida.
          this.sessions.delete(sessionId);
          setTimeout(() => this.create(sessionId).catch((err) => logger.error({ err, sessionId }, 'reconnect failed')), 2000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      try {
        // Los mensajes salientes desde el celular llegan con type='append'
        // (Baileys no los notifica como 'notify'). Aceptamos ambos: el filtro
        // real por contenido util (texto/media) esta mas abajo y descarta
        // ACKs y receipts.
        if (type !== 'notify' && type !== 'append') return;
        for (const msg of messages) {
          const rawFrom = msg.key.remoteJid;
          if (rawFrom === 'status@broadcast') continue;

          // Solo procesamos mensajes con contenido útil (texto o media).
          // Los ACKs / receipts pasan por acá también y no aportan.
          const hasContent =
            msg.message?.conversation !== undefined ||
            msg.message?.extendedTextMessage !== undefined ||
            msg.message?.imageMessage !== undefined ||
            msg.message?.videoMessage !== undefined ||
            msg.message?.audioMessage !== undefined ||
            msg.message?.documentMessage !== undefined ||
            msg.message?.stickerMessage !== undefined;
          if (!hasContent) continue;

          // ── Instrumentación de latencia (temporal, para diagnóstico) ──
          // t0 = ahora (evento entrante en baileys node)
          // t_wa = timestamp del mensaje WhatsApp (msg.messageTimestamp)
          // Loggeamos ambos para ver: (a) cuánto tarda desde que el cliente
          // envía hasta que baileys lo procesa, (b) qué type='' del upsert
          // (notify vs append), y (c) más abajo, cuánto tarda la descarga
          // de media.
          const t0 = Date.now();
          const waTsSec = Number(msg.messageTimestamp) || 0;
          const waLagMs = waTsSec > 0 ? (t0 - waTsSec * 1000) : null;

          const isFromMe = !!msg.key.fromMe;
          // remoteJid siempre identifica al CONTACTO, sea el emisor
          // (fromMe=false) o el destinatario (fromMe=true). Así la
          // conversación se resuelve por el mismo par (sesión, contactPhone)
          // en ambos casos.
          const contactPhone = await resolveJidToPhone(sock, rawFrom);

          const text = msg.message?.conversation
                    ?? msg.message?.extendedTextMessage?.text
                    ?? msg.message?.imageMessage?.caption
                    ?? msg.message?.videoMessage?.caption
                    ?? null;
          // Los stickers se tratan como image en el wire — llevan mime
          // image/webp y el frontend los reconoce ahí para mostrar
          // flotantes sin borde, como corresponde a un sticker.
          const mediaType = msg.message?.imageMessage    ? 'image'
                          : msg.message?.videoMessage    ? 'video'
                          : msg.message?.audioMessage    ? 'audio'
                          : msg.message?.documentMessage ? 'document'
                          : msg.message?.stickerMessage  ? 'image'
                          : null;

          // Cuando hay media, descargamos el buffer y lo mandamos base64
          // al backend. Gomessenger lo sube a MinIO y devuelve la URL
          // pública que se persiste en la BD.
          //
          // Devuelve null si el mensaje no es media o falla la descarga.
          const tBeforeMedia = Date.now();
          const mediaPayload = await tryDownloadMedia(sock, msg, mediaType);
          const mediaMs = Date.now() - tBeforeMedia;

          // Log de latencia acumulada para este mensaje. Nos permite ver
          // cuál tramo tarda:
          //   - waLagMs: cuánto se demoró desde que el cliente envió hasta
          //     que baileys node recibió el evento (red WhatsApp + baileys)
          //   - upsertType: notify (mensaje nuevo) vs append (backfill)
          //   - mediaMs: descarga del CDN si aplica
          logger.info({
            event: 'msg_pipeline',
            waLagMs,
            upsertType: type,
            mediaMs: mediaType ? mediaMs : null,
            mediaType,
            fromMe: !!msg.key.fromMe,
          }, 'inbound_timing');

          // pushName es el nombre público que el contacto configuró en su
          // perfil de WhatsApp. Solo válido para inbound (fromMe=false):
          // cuando somos nosotros los que mandamos, no hay pushName del
          // contacto en la clave.
          const pushName = isFromMe ? null : (msg.pushName ?? null);

          // Emitimos un evento distintivo para los mensajes fromMe: el
          // backend los persiste como Outbound con sent_externally=true
          // y los reenvía al webhook con `event: message.sent_externally`.
          this.onEvent({
            event:     isFromMe ? 'message.sent_externally' : 'message.received',
            sessionId,
            messageId: msg.key.id,
            message: {
              messageId: msg.key.id,
              from:      contactPhone,
              pushName,
              body:      text ?? '',
              mediaUrl:  null,
              mediaType,
              // Base64 + metadatos cuando hay media. Gomessenger los sube
              // a MinIO y persiste la URL pública en lugar del base64.
              media:     mediaPayload,
            },
            from:      contactPhone,
            pushName,
            fromMe:    isFromMe,
            body:      text,
            mediaType,
            media:     mediaPayload,
            timestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
          });
        }
      } catch (err) {
        logger.error({ err: err.message, sessionId }, 'messages.upsert handler failed');
      }
    });

    return entry;
  }

  async delete(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      try { await entry.sock.logout(); } catch { /* ignore */ }
      try { entry.sock.end(); } catch { /* ignore */ }
      this.sessions.delete(sessionId);
    }
    const folder = path.join(SESSIONS_PATH, sessionId);
    if (existsSync(folder)) {
      await fs.rm(folder, { recursive: true, force: true });
    }
  }

  /**
   * Al iniciar el server, restauramos sesiones que tengan creds persistidas en disco.
   */
  async restore() {
    if (!existsSync(SESSIONS_PATH)) return;
    const ids = await fs.readdir(SESSIONS_PATH);
    for (const id of ids) {
      const credsPath = path.join(SESSIONS_PATH, id, 'creds.json');
      if (existsSync(credsPath)) {
        logger.info({ sessionId: id }, 'restoring session');
        try { await this.create(id); }
        catch (err) { logger.error({ err, sessionId: id }, 'restore failed'); }
      }
    }
  }
}
