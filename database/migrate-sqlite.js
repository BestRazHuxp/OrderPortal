const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const db = require('./database');

async function migrate() {
  let source;
  let client;
  try {
    source = new DatabaseSync(path.join(__dirname, 'database.sqlite'), { readOnly: true });
    await db.initialize();
    client = await db.connect();
    await client.query('BEGIN');
    await client.query('LOCK TABLE "user", "session" IN ACCESS EXCLUSIVE MODE');
    const { rows: [counts] } = await client.query(`
      SELECT (SELECT count(*) FROM "user") AS users,
             (SELECT count(*) FROM "session") AS sessions
    `);
    if (Number(counts.users) || Number(counts.sessions)) {
      throw new Error('PostgreSQL tables must be empty before importing SQLite data.');
    }
    const users = source.prepare('SELECT * FROM "user"').all();
    const sessions = source.prepare('SELECT * FROM "session"').all();
    const timestamp = (value) => /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? value : `${value.replace(' ', 'T')}Z`;
    for (const user of users) {
      await client.query(`
        INSERT INTO "user" (id, user_name, password_hash, role, created_at)
        VALUES ($1, $2, $3, $4, $5)
      `, [user.id, user.user_name, user.password_hash, user.role, timestamp(user.created_at)]);
    }
    for (const session of sessions) {
      await client.query(`
        INSERT INTO "session" (id, user_id, token_hash, expires_at, created_at)
        VALUES ($1, $2, $3, $4, $5)
      `, [session.id, session.user_id, session.token_hash, timestamp(session.expires_at), timestamp(session.created_at)]);
    }
    for (const table of ['user', 'session']) {
      await client.query(`
        SELECT setval(pg_get_serial_sequence($1, 'id'),
          COALESCE((SELECT MAX(id) FROM "${table}"), 1),
          EXISTS(SELECT 1 FROM "${table}"))
      `, [`"${table}"`]);
    }
    await client.query('COMMIT');
    console.log(`Imported ${users.length} users and ${sessions.length} sessions into PostgreSQL.`);
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error('Migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    if (client) client.release();
    if (source) source.close();
    await db.end();
  }
}

migrate();
