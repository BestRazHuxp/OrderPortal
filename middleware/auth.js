const { createHash } = require('node:crypto');
const db = require('../database/database');

function getSessionHash(req) {
  const cookie = (req.headers.cookie || '').split(';')
    .map((part) => part.trim()).find((part) => part.startsWith('session_id='));
  if (!cookie) return null;
  try {
    const token = decodeURIComponent(cookie.slice('session_id='.length));
    return token ? createHash('sha256').update(token).digest('hex') : null;
  } catch {
    return null;
  }
}

function sessionCookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || process.env.NODE_ENV === 'production',
    path: '/',
  };
}

// Optional authentication: missing/expired sessions leave req.user as null.
async function loadSession(req, res, next) {
  req.user = null;
  req.session = null;
  const tokenHash = getSessionHash(req);
  if (!tokenHash) return next();
  try {
    const { rows: [session] } = await db.query(`
      SELECT s.id AS session_id, s.expires_at, u.id AS user_id, u.user_name, u.role
      FROM "session" s JOIN "user" u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > CURRENT_TIMESTAMP
    `, [tokenHash]);
    if (session) {
      req.user = { user_id: session.user_id, user_name: session.user_name, role: session.role };
      req.session = { id: session.session_id, expires_at: session.expires_at };
    } else {
      res.clearCookie('session_id', sessionCookieOptions(req));
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

// Use after loadSession for API routes that require a logged-in user.
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ message: 'Vui lòng đăng nhập để tiếp tục.' });
  return next();
}

function requirePageAuth(req, res, next) {
  if (!req.user) return res.redirect('/login.html');
  return next();
}

// Example: loadSession, requireRole('staff'). Roles always come from the database.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: 'Vui lòng đăng nhập để tiếp tục.' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Bạn không có quyền thực hiện thao tác này.' });
    }
    return next();
  };
}

module.exports = { loadSession, requireAuth, requirePageAuth, requireRole, getSessionHash, sessionCookieOptions };
