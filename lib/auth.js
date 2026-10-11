const crypto = require('crypto');
const db = require('./db');

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
  const sessions = db.getSessions();
  let dirty = false;
  for (const [token, u] of Object.entries(sessions)) {
    if (u === username) {
      delete sessions[token];
      dirty = true;
    }
  }
  if (dirty) db.saveSessions(sessions);
  return { ok: true };
}

function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  const sessions = db.getSessions();
  sessions[token] = username;
  db.saveSessions(sessions);
  return token;
}

function getSessionUser(token) {
  if (!token) return null;
  const sessions = db.getSessions();
  const username = sessions[token];
  if (!username) return null;
  const user = db.getUsers()[username];
  if (!user || statusOf(user) !== 'active') return null;
  return { username, name: user.name };
}

function destroySession(token) {
  const sessions = db.getSessions();
  if (token in sessions) {
    delete sessions[token];
    db.saveSessions(sessions);
  }
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
