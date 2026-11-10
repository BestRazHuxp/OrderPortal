const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const db = new DatabaseSync(path.join(__dirname, 'database.sqlite'));

db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS "user" (
    id INTEGER PRIMARY KEY,
    user_name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(user_name)) > 0),
    password_hash TEXT NOT NULL CHECK (length(password_hash) > 0),
    role TEXT NOT NULL DEFAULT 'client' CHECK (role IN ('client', 'staff')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS "session" (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) > 0),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_session_user_id ON "session"(user_id);
`);

// Preserve existing users when upgrading the original email-based schema.
const userColumns = db.prepare('PRAGMA table_info("user")').all();
if (userColumns.some((column) => column.name === 'email') &&
    !userColumns.some((column) => column.name === 'user_name')) {
  db.exec('ALTER TABLE "user" RENAME COLUMN email TO user_name');
}

if (!userColumns.some((column) => column.name === 'role')) {
  db.exec("ALTER TABLE \"user\" ADD COLUMN role TEXT NOT NULL DEFAULT 'client' CHECK (role IN ('client', 'staff'))");
}

module.exports = db;
