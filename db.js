// db.js — שכבת SQLite רב-משתמשת
// כל הודעה משויכת ל-user_id (לקוח), כך שכל לקוח רואה רק את ההודעות שלו.

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/app/data') ? '/app/data' : __dirname);
const db = new Database(path.join(DATA_DIR, 'messages.db'));

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,   -- מזהה לקוח (בקישור)
    name            TEXT,               -- שם תצוגה
    created_at      INTEGER,
    status          TEXT DEFAULT 'new', -- new / waiting_qr / connected / disconnected
    phone           TEXT,               -- המספר שחובר (אם ידוע)
    capture_private INTEGER DEFAULT 1,  -- לשאוב הודעות פרטיות (1 על 1)
    capture_groups  INTEGER DEFAULT 0,  -- לשאוב גם מקבוצות
    save_viewonce   INTEGER DEFAULT 1   -- לשמור הודעות חד-פעמיות (view-once)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    user_id     TEXT,               -- לאיזה לקוח ההודעה שייכת
    chat_jid    TEXT,
    sender_jid  TEXT,
    sender_name TEXT,
    from_me     INTEGER DEFAULT 0,
    type        TEXT,
    text        TEXT,
    media_path  TEXT,
    timestamp   INTEGER,
    deleted     INTEGER DEFAULT 0,
    deleted_at  INTEGER,
    view_once   INTEGER DEFAULT 0
  );

`);

// הגירה: אם ה-DB נוצר בגרסה החד-משתמשת (בלי עמודת user_id) — נוסיף אותה
// ונשייך את ההודעות הקיימות ל-'michael'. חייב לרוץ לפני יצירת האינדקסים על user_id.
try {
  const cols = db.prepare('PRAGMA table_info(messages)').all().map(c => c.name);
  if (!cols.includes('user_id')) {
    db.exec("ALTER TABLE messages ADD COLUMN user_id TEXT");
    db.exec("UPDATE messages SET user_id = 'michael' WHERE user_id IS NULL");
    console.log('♻️ DB: הוספה עמודת user_id והודעות קיימות שויכו ל-michael');
  }
  if (!cols.includes('view_once')) db.exec("ALTER TABLE messages ADD COLUMN view_once INTEGER DEFAULT 0");
} catch (e) { console.warn('DB migrate:', e.message); }

// הגירה: הוספת עמודות הגדרות מקור למשתמשים קיימים
try {
  const ucols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!ucols.includes('capture_private')) db.exec("ALTER TABLE users ADD COLUMN capture_private INTEGER DEFAULT 1");
  if (!ucols.includes('capture_groups')) db.exec("ALTER TABLE users ADD COLUMN capture_groups INTEGER DEFAULT 0");
  if (!ucols.includes('save_viewonce')) db.exec("ALTER TABLE users ADD COLUMN save_viewonce INTEGER DEFAULT 1");
} catch (e) { console.warn('DB migrate users:', e.message); }

// עכשיו בטוח ליצור אינדקסים על user_id (העמודה קיימת בוודאות)
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_user ON messages(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_deleted ON messages(user_id, deleted);
`);

// ---------- users ----------
const upsertUserStmt = db.prepare(`
  INSERT INTO users (id, name, created_at, status)
  VALUES (@id, @name, @created_at, 'new')
  ON CONFLICT(id) DO UPDATE SET name = COALESCE(excluded.name, users.name)
`);
const setUserStatusStmt = db.prepare(`UPDATE users SET status = @status WHERE id = @id`);
const setUserPhoneStmt = db.prepare(`UPDATE users SET phone = @phone WHERE id = @id`);
const setSettingsStmt = db.prepare(`UPDATE users SET capture_private = @capture_private, capture_groups = @capture_groups, save_viewonce = @save_viewonce WHERE id = @id`);
const getUserStmt = db.prepare(`SELECT * FROM users WHERE id = ?`);
const allUsersStmt = db.prepare(`
  SELECT u.*,
    (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id) AS msg_count,
    (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id AND m.deleted = 1) AS deleted_count
  FROM users u ORDER BY u.created_at DESC
`);

// ---------- messages ----------
const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO messages
    (id, user_id, chat_jid, sender_jid, sender_name, from_me, type, text, media_path, timestamp, view_once)
  VALUES
    (@id, @user_id, @chat_jid, @sender_jid, @sender_name, @from_me, @type, @text, @media_path, @timestamp, @view_once)
`);
const markDeletedStmt = db.prepare(`UPDATE messages SET deleted = 1, deleted_at = @deleted_at WHERE id = @id AND user_id = @user_id`);
const getByIdStmt = db.prepare(`SELECT * FROM messages WHERE id = ? AND user_id = ?`);
const recentStmt = db.prepare(`SELECT * FROM messages WHERE user_id = @user_id ORDER BY timestamp DESC LIMIT @limit`);
const deletedStmt = db.prepare(`SELECT * FROM messages WHERE user_id = @user_id AND deleted = 1 ORDER BY COALESCE(deleted_at, timestamp) DESC LIMIT @limit`);
const viewOnceStmt = db.prepare(`SELECT * FROM messages WHERE user_id = @user_id AND view_once = 1 ORDER BY timestamp DESC LIMIT @limit`);
// ניקוי יומי: הודעות כלליות (לא נמחקו ולא חד-פעמיות) ישנות מ-cutoff. נמחקות וחד-פעמיות נשמרות.
const purgeMediaStmt = db.prepare(`SELECT media_path FROM messages WHERE deleted = 0 AND view_once = 0 AND timestamp < @cutoff AND media_path IS NOT NULL`);
const purgeStmt = db.prepare(`DELETE FROM messages WHERE deleted = 0 AND view_once = 0 AND timestamp < @cutoff`);

export const store = {
  // users
  upsertUser(id, name = null) { upsertUserStmt.run({ id, name, created_at: Math.floor(Date.now() / 1000) }); },
  setStatus(id, status) { setUserStatusStmt.run({ id, status }); },
  setPhone(id, phone) { setUserPhoneStmt.run({ id, phone }); },
  getUser(id) { return getUserStmt.get(id); },
  allUsers() { return allUsersStmt.all(); },
  getSettings(id) {
    const u = getUserStmt.get(id);
    return {
      capture_private: u ? u.capture_private : 1,
      capture_groups: u ? u.capture_groups : 0,
      save_viewonce: u ? (u.save_viewonce ?? 1) : 1,
    };
  },
  setSettings(id, { capture_private, capture_groups, save_viewonce }) {
    setSettingsStmt.run({
      id,
      capture_private: capture_private ? 1 : 0,
      capture_groups: capture_groups ? 1 : 0,
      save_viewonce: save_viewonce ? 1 : 0,
    });
  },

  // messages
  saveMessage(msg) { insertStmt.run({ view_once: 0, ...msg }); },
  markDeleted(userId, id) {
    markDeletedStmt.run({ user_id: userId, id, deleted_at: Math.floor(Date.now() / 1000) });
    return getByIdStmt.get(id, userId);
  },
  recent(userId, limit = 100) { return recentStmt.all({ user_id: userId, limit }); },
  deletedOnly(userId, limit = 1000) { return deletedStmt.all({ user_id: userId, limit }); },
  viewOnceOnly(userId, limit = 1000) { return viewOnceStmt.all({ user_id: userId, limit }); },
  // מחיקת הודעות כלליות ישנות; מחזיר כמה נמחקו ואת נתיבי המדיה לניקוי
  purgeOldGeneral(cutoff) {
    const media = purgeMediaStmt.all({ cutoff }).map(r => r.media_path);
    const info = purgeStmt.run({ cutoff });
    return { count: info.changes, media };
  },
};

export default db;
