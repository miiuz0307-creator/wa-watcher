// db.js — שכבת שמירה ב-SQLite
// שומר כל הודעה נכנסת ברגע שהיא מגיעה, כך שגם אם השולח מוחק אותה אחר כך,
// הטקסט/המדיה המקוריים כבר אצלנו.

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// שומרים את מסד הנתונים על ה-volume הקבוע (אם קיים), כדי שהודעות שנתפסו לא יאבדו בפריסה
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/app/data') ? '/app/data' : __dirname);
const db = new Database(path.join(DATA_DIR, 'messages.db'));

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,   -- מזהה ההודעה של וואטסאפ
    chat_jid    TEXT,               -- מזהה הצ'אט (מספר / קבוצה)
    sender_jid  TEXT,               -- מי שלח בפועל (חשוב בקבוצות)
    sender_name TEXT,               -- שם תצוגה אם קיים
    from_me     INTEGER DEFAULT 0,  -- 1 אם אני שלחתי
    type        TEXT,               -- text / image / audio / video / sticker / document ...
    text        TEXT,               -- תוכן טקסטואלי / כיתוב
    media_path  TEXT,               -- נתיב לקובץ מדיה שהורד (אם יש)
    timestamp   INTEGER,            -- חותמת זמן (שניות)
    deleted     INTEGER DEFAULT 0,  -- 1 אם ההודעה נמחקה ע"י השולח
    deleted_at  INTEGER             -- מתי זוהתה המחיקה
  );

  CREATE INDEX IF NOT EXISTS idx_chat ON messages(chat_jid);
  CREATE INDEX IF NOT EXISTS idx_deleted ON messages(deleted);
`);

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO messages
    (id, chat_jid, sender_jid, sender_name, from_me, type, text, media_path, timestamp)
  VALUES
    (@id, @chat_jid, @sender_jid, @sender_name, @from_me, @type, @text, @media_path, @timestamp)
`);

const markDeletedStmt = db.prepare(`
  UPDATE messages SET deleted = 1, deleted_at = @deleted_at WHERE id = @id
`);

const getByIdStmt = db.prepare(`SELECT * FROM messages WHERE id = ?`);

const recentStmt = db.prepare(`
  SELECT * FROM messages ORDER BY timestamp DESC LIMIT @limit OFFSET @offset
`);

const deletedStmt = db.prepare(`
  SELECT * FROM messages WHERE deleted = 1 ORDER BY deleted_at DESC LIMIT @limit
`);

export const store = {
  saveMessage(msg) {
    insertStmt.run(msg);
  },
  markDeleted(id) {
    markDeletedStmt.run({ id, deleted_at: Math.floor(Date.now() / 1000) });
    return getByIdStmt.get(id); // מחזיר את ההודעה המקורית המלאה
  },
  getById(id) {
    return getByIdStmt.get(id);
  },
  recent(limit = 100, offset = 0) {
    return recentStmt.all({ limit, offset });
  },
  deletedOnly(limit = 200) {
    return deletedStmt.all({ limit });
  },
};

export default db;
