// server.js — שרת רב-משתמשי (SaaS)
// כל לקוח מקבל קישור /u/<id> משלו, סורק QR משלו, ורואה רק את ההודעות שלו.
// למנהל יש /admin עם סקירה של כל הלקוחות.
//
// ⚠️ חוקי כל עוד כל לקוח מחבר את המספר של עצמו (הוא צד בשיחות). לא כלי לריגול.
// החיבור לא-רשמי (Baileys) נוגד את תנאי השימוש של WhatsApp — ייתכן חסימת מספר.

import express from 'express';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import pino from 'pino';
import qrcode from 'qrcode';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  Browsers,
} from 'baileys';

import { store } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/app/data') ? '/app/data' : __dirname);
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const AUTH_ROOT = path.join(DATA_DIR, 'auth');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });

const ADMIN_KEY = process.env.ADMIN_KEY || 'michael'; // מפתח כניסה לפאנל הניהול
const logger = pino({ level: 'warn' });

// ---------- שרת web + socket ----------
const app = express();
const httpServer = createServer(app);
const io = new SocketIO(httpServer);

app.use(express.json());
app.use('/media', express.static(MEDIA_DIR));
// index:false כדי שנתיב "/" יגיע לדף הכניסה (landing) ולא ל-index.html אוטומטית
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ---------- מנהל הסשנים (סשן לכל לקוח) ----------
const sessions = {}; // userId -> { sock, qr, status, reconnecting }

function cleanId(id = '') { return String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40); }

const MEDIA_TYPES = ['image', 'video', 'audio', 'voice', 'sticker', 'document'];

// המרת הודעה קולית (OGG/Opus) ל-MP3 כדי שתתנגן בכל מכשיר, כולל אייפון/ספארי
function transcodeToMp3(inPath, outPath) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('no ffmpeg'));
    const p = spawn(ffmpegPath, ['-y', '-i', inPath, '-codec:a', 'libmp3lame', '-qscale:a', '4', outPath]);
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg ' + code + ': ' + err.slice(-200))));
    p.on('error', reject);
  });
}

// פותח עטיפות של הודעות "נעלמות" / חד-פעמיות / נערכות, כדי לחלץ את התוכן האמיתי
function unwrap(msg, depth = 0) {
  if (!msg || depth > 5) return msg || {};
  const inner = msg.ephemeralMessage?.message
    || msg.viewOnceMessage?.message
    || msg.viewOnceMessageV2?.message
    || msg.viewOnceMessageV2Extension?.message
    || msg.documentWithCaptionMessage?.message
    || msg.editedMessage?.message
    || msg.protocolMessage?.editedMessage;
  return inner ? unwrap(inner, depth + 1) : msg;
}

function extractContent(m) {
  const msg = unwrap(m.message || {});
  let type = 'unknown', text = '';
  if (msg.conversation) { type = 'text'; text = msg.conversation; }
  else if (msg.extendedTextMessage) { type = 'text'; text = msg.extendedTextMessage.text || ''; }
  else if (msg.imageMessage) { type = 'image'; text = msg.imageMessage.caption || ''; }
  else if (msg.videoMessage) { type = 'video'; text = msg.videoMessage.caption || ''; }
  else if (msg.audioMessage) { type = msg.audioMessage.ptt ? 'voice' : 'audio'; }
  else if (msg.stickerMessage) { type = 'sticker'; }
  else if (msg.documentMessage) { type = 'document'; text = msg.documentMessage.fileName || ''; }
  else if (msg.contactMessage) { type = 'contact'; text = msg.contactMessage.displayName || ''; }
  else if (msg.locationMessage) { type = 'location'; text = `${msg.locationMessage.degreesLatitude}, ${msg.locationMessage.degreesLongitude}`; }
  return { type, text };
}

async function startSession(userId) {
  userId = cleanId(userId);
  if (!userId) return;
  if (sessions[userId]?.sock) return sessions[userId]; // כבר רץ

  const authDir = path.join(AUTH_ROOT, userId);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sess = sessions[userId] || (sessions[userId] = { sock: null, qr: null, status: 'מתחבר...', reconnecting: false });

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 15000,
    defaultQueryTimeoutMs: undefined,
    qrTimeout: 60000,
    syncFullHistory: false,
  });
  sess.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      sess.qr = await qrcode.toDataURL(qr);
      sess.status = 'סרוק את ה-QR דרך וואטסאפ › מכשירים מקושרים';
      store.setStatus(userId, 'waiting_qr');
      io.to(userId).emit('qr', sess.qr);
      io.to(userId).emit('status', sess.status);
    }

    if (connection === 'open') {
      sess.qr = null;
      sess.status = '✅ מחובר — מאזין להודעות';
      const phone = sock.user?.id?.split(':')[0] || null;
      if (phone) store.setPhone(userId, phone);
      store.setStatus(userId, 'connected');
      io.to(userId).emit('status', sess.status);
      io.to(userId).emit('connected');
      console.log(`✅ [${userId}] מחובר`);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      sess.status = loggedOut ? '🔌 נותק (יצא מהמכשירים המקושרים)' : '🔌 נותק — מתחבר מחדש...';
      store.setStatus(userId, loggedOut ? 'disconnected' : 'connected');
      io.to(userId).emit('status', sess.status);
      console.log(`[${userId}] נותק. קוד: ${code}`);
      sess.sock = null;
      if (loggedOut) {
        // התנתקות יזומה — מוחקים auth כדי לאפשר סריקה מחדש
        try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
      } else if (!sess.reconnecting) {
        sess.reconnecting = true;
        setTimeout(() => { sess.reconnecting = false; startSession(userId).catch(console.error); }, 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      if (!m.message) continue;
      const id = m.key.id;
      const chat_jid = m.key.remoteJid || '';
      // סינון לפי הגדרות המשתמש: פרטי / קבוצות
      const isGroup = chat_jid.endsWith('@g.us');
      const st = store.getSettings(userId);
      if (isGroup && !st.capture_groups) continue;
      if (!isGroup && !st.capture_private) continue;
      const from_me = m.key.fromMe ? 1 : 0;
      const sender_jid = m.key.participant || chat_jid;
      const sender_name = m.pushName || '';
      const timestamp = Number(m.messageTimestamp) || Math.floor(Date.now() / 1000);
      const { type: msgType, text } = extractContent(m);

      let media_path = null;
      if (MEDIA_TYPES.includes(msgType)) {
        try {
          const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
          const ext = { image: 'jpg', video: 'mp4', audio: 'ogg', voice: 'ogg', sticker: 'webp', document: 'bin' }[msgType] || 'bin';
          const base = `${userId}_${id}`;
          const rawName = `${base}.${ext}`;
          const rawPath = path.join(MEDIA_DIR, rawName);
          fs.writeFileSync(rawPath, buffer);
          // הודעה קולית/אודיו → המרה ל-MP3 שמתנגן בכל מכשיר (אייפון כולל)
          if (msgType === 'voice' || msgType === 'audio') {
            try {
              const mp3Name = `${base}.mp3`;
              await transcodeToMp3(rawPath, path.join(MEDIA_DIR, mp3Name));
              media_path = `/media/${mp3Name}`;
              try { fs.unlinkSync(rawPath); } catch {}
            } catch (e) { console.warn(`[${userId}] המרת אודיו נכשלה`, e.message); media_path = `/media/${rawName}`; }
          } else {
            media_path = `/media/${rawName}`;
          }
        } catch (e) { console.warn(`[${userId}] מדיה נכשלה`, e.message); }
      }

      const record = { id, user_id: userId, chat_jid, sender_jid, sender_name, from_me, type: msgType, text, media_path, timestamp };
      store.saveMessage(record);
      io.to(userId).emit('message', record);
    }
  });

  sock.ev.on('messages.update', (updates) => {
    for (const u of updates) {
      const revoked = u.update?.message === null || u.update?.messageStubType === 1 || u.update?.message?.protocolMessage?.type === 0;
      if (revoked) {
        const id = u.key?.id;
        if (!id) continue;
        const original = store.markDeleted(userId, id);
        if (original) {
          console.log(`🗑️ [${userId}] מחיקה זוהתה:`, original.text || original.type);
          io.to(userId).emit('deleted', original);
        }
      }
    }
  });

  return sess;
}

// ---------- Socket.IO: כל לקוח מצטרף ל"חדר" משלו ----------
io.on('connection', (socket) => {
  socket.on('join', async (payload) => {
    const rawId = typeof payload === 'object' && payload ? payload.id : payload;
    const name = typeof payload === 'object' && payload ? payload.name : null;
    const userId = cleanId(rawId);
    if (!userId) return;
    socket.join(userId);
    store.upsertUser(userId, name || null);
    socket.emit('name', store.getUser(userId)?.name || userId);
    // היסטוריה + QR נוכחי
    socket.emit('history', store.recent(userId, 100));
    socket.emit('deletedList', store.deletedOnly(userId, 1000)); // נטען בנפרד כדי שישרוד רענון
    socket.emit('settings', store.getSettings(userId));
    const sess = sessions[userId];
    if (sess?.qr) socket.emit('qr', sess.qr);
    if (sess?.status) socket.emit('status', sess.status);
    if (!sess?.sock) startSession(userId).catch(console.error); // הפעלת סשן אם לא רץ
  });
});

// ---------- API ----------
app.get('/api/:userId/messages', (req, res) => res.json(store.recent(cleanId(req.params.userId), 100)));
app.get('/api/:userId/deleted', (req, res) => res.json(store.deletedOnly(cleanId(req.params.userId))));
// הגדרות מקור (פרטי / קבוצות)
// שינוי שם תצוגה לחשבון
app.post('/api/:userId/name', (req, res) => {
  const id = cleanId(req.params.userId);
  store.upsertUser(id, (req.body.name || '').trim() || null);
  const name = store.getUser(id)?.name || id;
  io.to(id).emit('name', name);
  res.json({ name });
});
app.get('/api/:userId/settings', (req, res) => res.json(store.getSettings(cleanId(req.params.userId))));
app.post('/api/:userId/settings', (req, res) => {
  const id = cleanId(req.params.userId);
  store.upsertUser(id);
  store.setSettings(id, { capture_private: req.body.capture_private, capture_groups: req.body.capture_groups });
  const s = store.getSettings(id);
  io.to(id).emit('settings', s);
  res.json(s);
});

// פאנל ניהול — רשימת כל הלקוחות
app.get('/api/admin/users', (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ error: 'unauthorized' });
  const users = store.allUsers().map(u => ({ ...u, live_status: sessions[u.id]?.status || '—' }));
  res.json(users);
});

// ---------- נתיבי דפים ----------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/u/:userId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------- הגירה מגרסה חד-משתמשת: creds ישירות ב-auth/ → auth/michael/ ----------
function migrateLegacyAuth() {
  try {
    const legacyCreds = path.join(AUTH_ROOT, 'creds.json');
    if (fs.existsSync(legacyCreds)) {
      const dest = path.join(AUTH_ROOT, 'michael');
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      for (const f of fs.readdirSync(AUTH_ROOT)) {
        const src = path.join(AUTH_ROOT, f);
        if (fs.statSync(src).isFile()) fs.renameSync(src, path.join(dest, f));
      }
      store.upsertUser('michael', 'Michael');
      console.log('♻️ הועבר הסשן הקיים ל-user: michael');
    }
  } catch (e) { console.warn('migrateLegacyAuth:', e.message); }
}

// ---------- חידוש אוטומטי של סשנים מחוברים בעליית השרת ----------
function resumeSessions() {
  try {
    for (const dir of fs.readdirSync(AUTH_ROOT)) {
      const full = path.join(AUTH_ROOT, dir);
      if (!fs.statSync(full).isDirectory()) continue;
      const credsPath = path.join(AUTH_ROOT, dir, 'creds.json');
      if (fs.existsSync(credsPath)) {
        console.log(`♻️ מחדש סשן: ${dir}`);
        store.upsertUser(dir);
        startSession(dir).catch(console.error);
      }
    }
  } catch (e) { console.warn('resumeSessions:', e.message); }
}

// ---------- ניקוי יומי: מוחק הודעות כלליות ישנות, שומר רק את הנמחקות ----------
// משאירים חלון של 24 שעות כדי שעדיין נוכל לזהות מחיקה של הודעה טרייה.
function dailyCleanup() {
  const cutoff = Math.floor(Date.now() / 1000) - 24 * 3600;
  const { count, media } = store.purgeOldGeneral(cutoff);
  for (const mp of media) {
    if (!mp) continue;
    try { fs.unlinkSync(path.join(MEDIA_DIR, mp.replace('/media/', ''))); } catch {}
  }
  if (count) console.log(`🧹 נוקו ${count} הודעות כלליות ישנות (הנמחקות נשמרו)`);
}

// ---------- הפעלה ----------
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`\n🌐 השרת רץ על פורט ${PORT}`);
  console.log(`   פאנל ניהול: /admin   (מפתח: ${ADMIN_KEY})\n`);
  migrateLegacyAuth();
  resumeSessions();
  dailyCleanup();
  setInterval(dailyCleanup, 6 * 3600 * 1000); // כל 6 שעות
});
