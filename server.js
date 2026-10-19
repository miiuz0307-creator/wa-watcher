// server.js — שרת מרכזי
// מתחבר לוואטסאפ כ"מכשיר מקושר" דרך QR, שומר כל הודעה נכנסת,
// מזהה מחיקות של השולח, ומגיש ממשק web שמראה הכל בזמן אמת.
//
// ⚠️ חוקי כל עוד מדובר בהודעות שנשלחות אל המספר שאתה מחבר (אתה צד בשיחה).
// חיבור לא-רשמי כזה נוגד את תנאי השימוש של WhatsApp — מומלץ מספר ייעודי.

import express from 'express';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import pino from 'pino';
import qrcode from 'qrcode';

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';

import { store } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// נתונים קבועים: על Railway מותקן volume ב-/app/data — שומרים שם את ההתחברות
// והמדיה כדי שלא צריך לסרוק QR מחדש בכל פריסה. מקומית — נשמר בתיקיית הפרויקט.
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/app/data') ? '/app/data' : __dirname);
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const AUTH_DIR = path.join(DATA_DIR, 'auth');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

const logger = pino({ level: 'warn' });

// ---------- שרת web + socket ----------
const app = express();
const httpServer = createServer(app);
const io = new SocketIO(httpServer);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(MEDIA_DIR));

// API: הודעות אחרונות
app.get('/api/messages', (req, res) => {
  res.json(store.recent(Number(req.query.limit) || 100));
});
// API: רק הודעות שנמחקו
app.get('/api/deleted', (req, res) => {
  res.json(store.deletedOnly());
});

let currentQR = null;
let connectionState = 'מתחבר...';

io.on('connection', (socket) => {
  // כשממשק חדש נפתח — שלח לו את המצב הנוכחי
  if (currentQR) socket.emit('qr', currentQR);
  socket.emit('status', connectionState);
  socket.emit('history', store.recent(100));
});

// ---------- עזר: חילוץ תוכן ההודעה ----------
function extractContent(m) {
  const msg = m.message || {};
  let type = 'unknown';
  let text = '';

  if (msg.conversation) {
    type = 'text';
    text = msg.conversation;
  } else if (msg.extendedTextMessage) {
    type = 'text';
    text = msg.extendedTextMessage.text || '';
  } else if (msg.imageMessage) {
    type = 'image';
    text = msg.imageMessage.caption || '';
  } else if (msg.videoMessage) {
    type = 'video';
    text = msg.videoMessage.caption || '';
  } else if (msg.audioMessage) {
    // הודעה קולית / אודיו
    type = msg.audioMessage.ptt ? 'voice' : 'audio';
  } else if (msg.stickerMessage) {
    type = 'sticker';
  } else if (msg.documentMessage) {
    type = 'document';
    text = msg.documentMessage.fileName || '';
  } else if (msg.contactMessage) {
    type = 'contact';
    text = msg.contactMessage.displayName || '';
  } else if (msg.locationMessage) {
    type = 'location';
    text = `${msg.locationMessage.degreesLatitude}, ${msg.locationMessage.degreesLongitude}`;
  }
  return { type, text };
}

const MEDIA_TYPES = ['image', 'video', 'audio', 'voice', 'sticker', 'document'];

// ---------- החיבור לוואטסאפ ----------
let reconnecting = false;
async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  // משיכת גרסת הפרוטוקול העדכנית של וואטסאפ — בלעדיה ההתחברות נכשלת (קוד 408)
  // וה-QR לא נוצר. זה היה הבאג.
  const { version } = await fetchLatestBaileysVersion();
  console.log('גרסת WhatsApp:', version.join('.'));

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'), // מזהה מכשיר — נדרש כדי שהשרת ינפיק QR
    markOnlineOnConnect: false, // לא "להדליק" נוכחות — נשאר דיסקרטי
    connectTimeoutMs: 60000,        // זמן ארוך יותר לחיבור — מונע 408 מוקדם
    keepAliveIntervalMs: 15000,     // ping תכוף יותר לשמירת החיבור
    defaultQueryTimeoutMs: undefined, // בלי timeout אגרסיבי על שאילתות
    retryRequestDelayMs: 2000,
    qrTimeout: 60000,               // חלון ארוך יותר להצגת ה-QR
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // --- עדכוני חיבור + QR ---
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = await qrcode.toDataURL(qr); // מייצר תמונת QR לממשק
      connectionState = 'סרוק את ה-QR דרך וואטסאפ › מכשירים מקושרים';
      io.emit('qr', currentQR);
      io.emit('status', connectionState);
    }

    if (connection === 'open') {
      currentQR = null;
      connectionState = '✅ מחובר — מאזין להודעות';
      io.emit('status', connectionState);
      io.emit('connected');
      console.log('✅ מחובר לוואטסאפ');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      connectionState = '🔌 נותק' + (shouldReconnect ? ' — מתחבר מחדש...' : ' (יצאת מהמכשירים המקושרים)');
      io.emit('status', connectionState);
      console.log('נותק. קוד:', code, 'מתחבר מחדש:', shouldReconnect);
      // השהיה קצרה לפני חיבור מחדש, ומניעת סוקטים כפולים שהורגים זה את זה
      if (shouldReconnect && !reconnecting) {
        reconnecting = true;
        setTimeout(() => { reconnecting = false; startWhatsApp().catch(console.error); }, 3000);
      }
    }
  });

  // --- הודעות נכנסות: שמור הכל מיד ---
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const m of messages) {
      if (!m.message) continue;

      const id = m.key.id;
      const chat_jid = m.key.remoteJid || '';
      const from_me = m.key.fromMe ? 1 : 0;
      const sender_jid = m.key.participant || chat_jid; // בקבוצה — מי שלח בפועל
      const sender_name = m.pushName || '';
      const timestamp = Number(m.messageTimestamp) || Math.floor(Date.now() / 1000);

      const { type: msgType, text } = extractContent(m);

      let media_path = null;
      // הורדת מדיה מיד — כולל הודעות קוליות — לפני מחיקה אפשרית
      if (MEDIA_TYPES.includes(msgType)) {
        try {
          const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
          const ext = { image: 'jpg', video: 'mp4', audio: 'ogg', voice: 'ogg', sticker: 'webp', document: 'bin' }[msgType] || 'bin';
          const fileName = `${id}.${ext}`;
          fs.writeFileSync(path.join(MEDIA_DIR, fileName), buffer);
          media_path = `/media/${fileName}`;
        } catch (e) {
          console.warn('לא הצלחתי להוריד מדיה עבור', id, e.message);
        }
      }

      const record = {
        id, chat_jid, sender_jid, sender_name, from_me,
        type: msgType, text, media_path, timestamp,
      };

      store.saveMessage(record);
      io.emit('message', record); // דחיפה לממשק בזמן אמת
    }
  });

  // --- עדכוני הודעות: כאן נתפסות המחיקות של השולח ---
  sock.ev.on('messages.update', (updates) => {
    for (const u of updates) {
      // מחיקה "לכולם" מגיעה כ-protocolMessage מסוג REVOKE,
      // או כ-messageStubType שמציין מחיקה.
      const revoked =
        u.update?.message === null ||
        u.update?.messageStubType === 1 || // REVOKE
        u.update?.message?.protocolMessage?.type === 0;

      if (revoked) {
        const id = u.key?.id;
        if (!id) continue;
        const original = store.markDeleted(id); // מחזיר את ההודעה המקורית
        if (original) {
          console.log('🗑️ זוהתה מחיקה:', id, '| המקור:', original.text || original.type);
          io.emit('deleted', original); // הממשק יראה "הודעה נמחקה — הנה מה שהיה כתוב"
        }
      }
    }
  });
}

// ---------- הפעלה ----------
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`\n🌐 הממשק פתוח בכתובת: http://localhost:${PORT}\n`);
  startWhatsApp().catch((e) => console.error('שגיאת הפעלה:', e));
});
