const crypto = require('crypto');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const JWT_EXPIRY = '30d';

const hashPassword = (password, salt) =>
  crypto.scryptSync(password, salt, 64).toString('hex');

function verifyPassword(password, user) {
  const h = Buffer.from(hashPassword(password, user.salt));
  const stored = Buffer.from(user.hash);
  return h.length === stored.length && crypto.timingSafeEqual(h, stored);
}

const statusOf = user => user.status || 'active';

function createUser(username, displayName, password) {
  const users = db.getUsers();
  if (users[username]) return { error: 'That username is already taken' };
  const salt = crypto.randomBytes(16).toString('hex');
  const isFirst = !Object.values(users).some(u => u.role === 'admin');
  users[username] = {
    name: displayName,
    salt,
    hash: hashPassword(password, salt),
    created: new Date().toISOString(),
    ...(isFirst ? { role: 'admin', status: 'active' } : { status: 'pending' })
  };
  db.saveUsers(users);
  return isFirst ? { user: users[username] } : { pending: true };
}

function isAdmin(username) {
  const users = db.getUsers();
  if (Object.values(users).some(u => u.role === 'admin'))
    return users[username]?.role === 'admin';
  const first = Object.keys(users).sort((a, b) =>
    String(users[a].created || '').localeCompare(String(users[b].created || ''))
  )[0];
  return first === username;
}

const roleOf = username => (isAdmin(username) ? 'admin' : 'member');

function authenticate(username, password) {
  const user = db.getUsers()[username];
  if (!user || !verifyPassword(password, user)) return { error: 'Wrong username or password' };
  if (statusOf(user) !== 'active') return { pending: true };
  return { user };
}

function listUsers() {
  return Object.entries(db.getUsers())
    .map(([key, u]) => ({
      user: key,
      name: u.name,
      role: u.role || 'member',
      status: statusOf(u),
      created: u.created || ''
    }))
    .sort((a, b) => a.created.localeCompare(b.created));
}

function approveUser(username) {
  const users = db.getUsers();
  if (!users[username]) return { error: 'User not found' };
  users[username].status = 'active';
  db.saveUsers(users);
  return { ok: true };
}

function removeUser(username) {
  const users = db.getUsers();
  if (!users[username]) return { error: 'User not found' };
  if ((users[username].role || 'member') === 'admin')
    return { error: 'Cannot remove the owner account' };
  delete users[username];
  db.saveUsers(users);
  return { ok: true };
}

// JWT-based stateless sessions (no server-side storage needed)
function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64urlDecode(input) {
  input = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = input.length % 4;
  if (pad) input += '='.repeat(4 - pad);
  return Buffer.from(input, 'base64').toString();
}

function signJWT(payload) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60 }));
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${header}.${body}.${signature}`;
}

function verifyJWT(token) {
  try {
    const [header, body, signature] = token.split('.');
    if (!header || !body || !signature) return null;
    const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    if (signature !== expectedSig) return null;
    const payload = JSON.parse(base64urlDecode(body));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function createSession(username) {
  return signJWT({ username, role: roleOf(username) });
}

function getSessionUser(token) {
  if (!token) return null;
  const payload = verifyJWT(token);
  if (!payload) return null;
  const user = db.getUsers()[payload.username];
  if (!user || statusOf(user) !== 'active') return null;
  return { username: payload.username, name: user.name };
}

function destroySession(token) {
  // No-op with stateless JWT
}

module.exports = {
  createUser,
  authenticate,
  createSession,
  getSessionUser,
  destroySession,
  isAdmin,
  roleOf,
  listUsers,
  approveUser,
  removeUser
};
