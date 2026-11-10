const express = require('express');
const path = require('node:path');
const { createReadStream } = require('node:fs');
const { pipeline } = require('node:stream');
const { createHash, randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const db = require('./database/database');

const app = express();
const port = process.env.PORT || 3000;
const deriveKey = promisify(scrypt);
const sessionDuration = 7 * 24 * 60 * 60 * 1000;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const findSessionUser = db.prepare(`
  SELECT session.user_id, user.user_name
  FROM "session"
  JOIN "user" ON user.id = session.user_id
  WHERE token_hash = ? AND julianday(expires_at) > julianday('now')
`);

function getSessionHash(req) {
  const cookie = (req.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('session_id='));

  if (!cookie) return null;

  let sessionId;
  try {
    sessionId = decodeURIComponent(cookie.slice('session_id='.length));
  } catch {
    return null;
  }

  if (!sessionId) return null;

  return createHash('sha256').update(sessionId).digest('hex');
}

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const tokenHash = getSessionHash(req);
  const session = tokenHash ? findSessionUser.get(tokenHash) : null;
  return res.json(session || { user_id: null });
});

app.post('/api/login', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { user_name, password } = req.body || {};
  if (typeof user_name !== 'string' || !user_name.trim() || user_name.length > 255 ||
      typeof password !== 'string' || !password || password.length > 1024) {
    return res.status(400).json({ message: 'Vui lòng nhập tên đăng nhập và mật khẩu hợp lệ.' });
  }

  const user = db.prepare('SELECT id, user_name, password_hash FROM "user" WHERE user_name = ?')
    .get(user_name.trim());
  // Password hashes use scrypt$salt$hex (64-byte derived key).
  const parts = user ? user.password_hash.split('$') : [];
  const validHash = parts.length === 3 && parts[0] === 'scrypt' &&
    /^[a-f0-9]{32}$/i.test(parts[1]) && /^[a-f0-9]{128}$/i.test(parts[2]);
  const salt = validHash ? parts[1] : '00000000000000000000000000000000';
  const expected = validHash ? Buffer.from(parts[2], 'hex') : Buffer.alloc(64);
  const actual = await deriveKey(password, salt, 64);
  const matches = timingSafeEqual(actual, expected);
  if (!validHash || !matches) {
    return res.status(401).json({ message: 'Tên đăng nhập hoặc mật khẩu không đúng.' });
  }

  const sessionId = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(sessionId).digest('hex');
  const oldHash = getSessionHash(req);
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO "session" (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
      .run(user.id, tokenHash, new Date(Date.now() + sessionDuration).toISOString());
    if (oldHash) db.prepare('DELETE FROM "session" WHERE token_hash = ?').run(oldHash);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  res.cookie('session_id', sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: sessionDuration,
  });
  return res.json({ user_id: user.id, user_name: user.user_name });
});

app.post('/api/logout', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const tokenHash = getSessionHash(req);
  if (tokenHash) {
    db.prepare('DELETE FROM "session" WHERE token_hash = ?').run(tokenHash);
  }
  res.clearCookie('session_id', {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || process.env.NODE_ENV === 'production',
    path: '/',
  });
  return res.sendStatus(204);
});

app.get(['/', '/login', '/login.html'], (req, res, next) => {
  res.type('html');
  pipeline(
    createReadStream(path.join(__dirname, 'public', 'login.html')),
    res,
    (error) => {
      if (error) next(error);
    }
  );
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.listen(port, () => {
  console.log(`Server đang chạy tại http://localhost:${port}`);
});
