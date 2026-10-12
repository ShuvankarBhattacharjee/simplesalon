const crypto = require('crypto');
const db = require('./db');
const gsheet = require('./gsheet');

let configSecret = '';
try {
  const cfg = require('../config.json');
  configSecret = cfg.jwtSecret || cfg.sheetSecret || '';
} catch {}
const JWT_SECRET = process.env.JWT_SECRET || configSecret || 'dev-secret-change-in-production';
const JWT_EXPIRY = '30d';

// Optional hardcoded admin from environment variables
const ADMIN_USERNAME = process.env.ADMIN_USERNAME?.toLowerCase().trim() || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_DISPLAY_NAME = process.env.ADMIN_DISPLAY_NAME || 'Admin';

const hashPassword = (password, salt) =>
  crypto.scryptSync(password, salt, 64).toString('hex');

function verifyPassword(password, user) {
  if (!user) return false;
  // 1. Verify against salt and scrypt hash if present
  if (user.salt && user.hash) {
    try {
      const h = Buffer.from(hashPassword(password, user.salt));
      const stored = Buffer.from(user.hash);
      if (h.length === stored.length && crypto.timingSafeEqual(h, stored)) {
        return true;
      }
    } catch {}
  }
  // 2. Verify against plain text password (from manual sheet entries)
  if (user.plainPassword && String(user.plainPassword) === String(password)) {
    return true;
  }
  return false;
}

function normalizeRole(rawRole) {
  const r = String(rawRole || '').toLowerCase().trim();
  if (r === 'admin' || r === 'owner') return 'admin';
  return 'member'; // Staff / Worker
}

function normalizeStatus(rawStatus) {
  const s = String(rawStatus || '').toLowerCase().trim();
  if (s === 'active' || s === 'approved') return 'active';
  if (s === 'pending') return 'pending';
  if (s === 'inactive' || s === 'disabled' || s === 'blocked' || s === 'rejected') return 'inactive';
  return 'pending';
}

const statusOf = user => normalizeStatus(user?.status);

function isAdmin(username) {
  const key = String(username || '').toLowerCase().trim();
  if (ADMIN_USERNAME && key === ADMIN_USERNAME) return true;
  if (key === 'admin' || key === 'owner') return true;
  const user = db.getUsers()[key];
  if (!user) return false;
  return user.role === 'admin';
}

const roleOf = username => (isAdmin(username) ? 'admin' : 'member');

// Sync users from Google Sheet (Team tab) into local database
async function syncFromSheet() {
  try {
    const sheetUsers = await gsheet.pullUsers();
    if (!sheetUsers || !Array.isArray(sheetUsers) || sheetUsers.length === 0) {
      return false;
    }
    const users = db.getUsers();
    let updated = false;

    for (const su of sheetUsers) {
      const key = String(su.user || su.username || '').toLowerCase().trim();
      if (!key) continue;

      const role = normalizeRole(su.role);
      const status = normalizeStatus(su.status);
      const plainPassword = String(su.password || '').trim();
      const existing = users[key];

      let salt = existing?.salt;
      let hash = existing?.hash;

      // Update password hash if plainPassword changed or not yet hashed
      if (plainPassword && (!hash || !salt || existing?.plainPassword !== plainPassword)) {
        salt = crypto.randomBytes(16).toString('hex');
        hash = hashPassword(plainPassword, salt);
      }

      users[key] = {
        name: su.name || existing?.name || key,
        salt: salt || '',
        hash: hash || '',
        plainPassword: plainPassword || existing?.plainPassword || '',
        created: su.joined || existing?.created || new Date().toISOString(),
        role,
        status
      };
      updated = true;
    }

    if (updated) {
      db.saveUsers(users);
    }
    return true;
  } catch (err) {
    console.error('syncFromSheet error:', err.message);
    return false;
  }
}

// Ensure admin exists (from sheet sync or env vars)
async function ensureAdmin() {
  await syncFromSheet();
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) return;
  const users = db.getUsers();
  const salt = crypto.randomBytes(16).toString('hex');
  users[ADMIN_USERNAME] = {
    ...(users[ADMIN_USERNAME] || {}),
    name: ADMIN_DISPLAY_NAME,
    salt,
    hash: hashPassword(ADMIN_PASSWORD, salt),
    plainPassword: ADMIN_PASSWORD,
    created: users[ADMIN_USERNAME]?.created || new Date().toISOString(),
    role: 'admin',
    status: 'active'
  };
  db.saveUsers(users);
}

// Signup process is STRICTLY for staff/workers only. Admin accounts can NEVER be created through signup.
async function createUser(username, displayName, password) {
  // Sync first to avoid username collisions with manually added sheet users
  await syncFromSheet().catch(() => {});

  const key = String(username || '').toLowerCase().trim();
  const users = db.getUsers();

  if (users[key]) return { error: 'That username is already taken' };
  if (key === 'admin' || key === 'owner') return { error: 'This username is reserved' };

  const salt = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString();

  // New signups are ALWAYS staff/member with pending status
  users[key] = {
    name: displayName || username,
    salt,
    hash: hashPassword(password, salt),
    plainPassword: password,
    created: now,
    role: 'member',   // Staff only
    status: 'pending' // Requires owner approval
  };
  db.saveUsers(users);

  // Sync new staff to Google Sheets Team tab
  await gsheet.push({
    type: 'user_created',
    data: {
      user: key,
      name: displayName || username,
      role: 'Worker',
      status: 'Pending',
      password,
      joined: now
    }
  });

  return { pending: true, user: users[key] };
}

// Authenticate by checking username, password, status, and role
async function authenticate(username, password) {
  const key = String(username || '').toLowerCase().trim();

  // Fast path: If user exists in local database and credentials match and active,
  // authenticate immediately and sync in the background
  let users = db.getUsers();
  let user = users[key];
  if (user && verifyPassword(password, user)) {
    const status = statusOf(user);
    if (status === 'active') {
      // Background sync so sheet changes eventually propagate
      syncFromSheet().catch(() => {});
      return {
        user: {
          username: key,
          name: user.name,
          role: roleOf(key),
          status: user.status
        }
      };
    }
  }

  // Fallback: Check Google Sheet for new users or recent status/password updates
  await syncFromSheet().catch(() => {});

  users = db.getUsers();
  user = users[key];

  if (!user || !verifyPassword(password, user)) {
    return { error: 'Wrong username or password' };
  }

  const status = statusOf(user);
  if (status === 'pending') {
    return {
      pending: true,
      error: 'Your account is waiting for owner approval',
      code: 'pending'
    };
  }
  if (status !== 'active') {
    return {
      error: 'Your account is inactive or disabled. Contact administrator.',
      code: 'inactive'
    };
  }

  return {
    user: {
      username: key,
      name: user.name,
      role: roleOf(key),
      status: user.status
    }
  };
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
  const key = String(username || '').toLowerCase().trim();
  const users = db.getUsers();
  if (!users[key]) return { error: 'User not found' };
  users[key].status = 'active';
  db.saveUsers(users);

  // Sync approval to Google Sheet
  const u = users[key];
  gsheet.push({
    type: 'user_approved',
    data: {
      user: key,
      name: u.name,
      role: u.role === 'admin' ? 'Owner' : 'Worker',
      status: 'Active',
      password: u.plainPassword || ''
    }
  });

  return { ok: true };
}

function removeUser(username) {
  const key = String(username || '').toLowerCase().trim();
  const users = db.getUsers();
  if (!users[key]) return { error: 'User not found' };
  if (users[key].role === 'admin')
    return { error: 'Cannot remove an admin/owner account' };

  const existing = users[key];
  delete users[key];
  db.saveUsers(users);

  // Sync removal to Google Sheet
  gsheet.push({
    type: 'user_removed',
    data: { user: key, name: existing ? existing.name : key }
  });

  return { ok: true };
}

// JWT-based stateless sessions
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

function createSession(username, userObj) {
  const key = String(username || '').toLowerCase().trim();
  const u = userObj || db.getUsers()[key] || {};
  const role = u.role || (isAdmin(key) ? 'admin' : roleOf(key));
  return signJWT({
    username: key,
    name: u.name || username,
    role,
    status: u.status || 'active'
  });
}

function getSessionUser(token) {
  if (!token) return null;
  const payload = verifyJWT(token);
  if (!payload || !payload.username) return null;
  const key = String(payload.username).toLowerCase().trim();

  // If user is cached in local DB, check status
  const localUser = db.getUsers()[key];
  if (localUser) {
    if (statusOf(localUser) !== 'active') return null;
    return {
      username: key,
      name: localUser.name || payload.name || key,
      role: localUser.role || payload.role || (isAdmin(key) ? 'admin' : 'member')
    };
  }

  // Stateless JWT verification for serverless (Vercel) cold starts:
  // HMAC-SHA256 signature is already verified above
  if (payload.status && payload.status !== 'active') return null;
  return {
    username: key,
    name: payload.name || key,
    role: payload.role || (isAdmin(key) ? 'admin' : 'member')
  };
}

function destroySession(token) {
  // Stateless JWT
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
  removeUser,
  ensureAdmin,
  syncFromSheet
};
