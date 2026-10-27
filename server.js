const path = require('path');
const express = require('express');
const db = require('./lib/db');
const auth = require('./lib/auth');
const gsheet = require('./lib/gsheet');

// Ensure hardcoded admin exists
auth.ensureAdmin().catch(console.error);

const app = express();
const PORT = process.env.PORT || 3000;

// CORS for Vercel serverless
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const USER_OR_EMAIL_RE = /^[a-z0-9_.@+-]+$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PAYMENTS = ['Cash', 'UPI', 'Pending', 'Card'];

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor', express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist')));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ---- helpers ----
const DEFAULT_PRESETS = [
  { id: 'p1', name: 'Haircut', price: 300, cat: 'Hair', ic: '✂️' },
  { id: 'p2', name: 'Hair Wash & Style', price: 200, cat: 'Hair', ic: '💇' },
  { id: 'p3', name: 'Hair Colour', price: 1200, cat: 'Hair', ic: '🎨' },
  { id: 'p4', name: 'Shave', price: 100, cat: 'Grooming', ic: '🪒' },
  { id: 'p5', name: 'Beard Trim', price: 150, cat: 'Grooming', ic: '🧔' },
  { id: 'p6', name: 'Spa', price: 1500, cat: 'Spa', ic: '🧖' },
  { id: 'p7', name: 'Body Massage', price: 1800, cat: 'Spa', ic: '💆' },
  { id: 'p8', name: 'Facial', price: 900, cat: 'Skin', ic: '✨' },
  { id: 'p9', name: 'Manicure', price: 500, cat: 'Nails', ic: '💅' }
];

async function getOrSyncServices() {
  let services = db.getServices();
  try {
    const sheetServices = await gsheet.pullServices();
    if (Array.isArray(sheetServices) && sheetServices.length > 0) {
      services = sheetServices;
      db.saveServices(services);
    }
  } catch {}
  if (!services || services.length === 0) {
    services = DEFAULT_PRESETS;
    db.saveServices(services);
  }
  return services;
}

function normalizeDateStr(d) {
  if (!d) return new Date().toISOString().slice(0, 10);
  if (typeof d === 'string') {
    const m = d.trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (m) {
      return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    }
  }
  try {
    const dt = new Date(d);
    if (!isNaN(dt.getTime())) {
      const year = dt.getFullYear();
      const month = String(dt.getMonth() + 1).padStart(2, '0');
      const day = String(dt.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  } catch {}
  return String(d).slice(0, 10);
}

function resolveUserKey(memberName, rawBy, users) {
  if (rawBy && users && users[rawBy.toLowerCase()]) {
    return rawBy.toLowerCase();
  }
  const cleanMember = String(memberName || '').trim().toLowerCase();
  if (!cleanMember || cleanMember === 'admin' || cleanMember === 'owner') return 'admin';
  if (users) {
    if (users[cleanMember]) return cleanMember;
    for (const [k, u] of Object.entries(users)) {
      if (u && u.name && u.name.trim().toLowerCase() === cleanMember) {
        return k;
      }
    }
  }
  if (rawBy) return String(rawBy).trim().toLowerCase();
  return cleanMember.replace(/\s+/g, '_');
}

function normalizeSheetSale(s, users = null) {
  if (!s || !s.id) return null;
  const currentUsers = users || db.getUsers();
  const memberName = String(s.member || s.byName || s.by || 'Admin').trim();
  const username = resolveUserKey(memberName, s.by || s.user, currentUsers);
  let items = s.items;
  if (!items || !Array.isArray(items) || items.length === 0) {
    if (s.services) {
      items = String(s.services).split(',').map(name => ({ name: name.trim(), qty: 1, price: 0 }));
    } else {
      items = [{ name: 'Service', qty: 1, price: Number(s.total) || 0 }];
    }
  }
  const dateStr = normalizeDateStr(s.date);
  const timeStr = s.time || (s.timestamp ? new Date(s.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) : '');
  const timestamp = s.timestamp || (s.recordedAt ? new Date(s.recordedAt).toISOString() : '');

  return {
    id: String(s.id),
    date: dateStr,
    time: timeStr,
    timestamp: timestamp,
    member: memberName,
    by: username,
    byName: memberName,
    services: s.services || items.map(i => i.name).join(', '),
    items,
    pay: s.pay || 'Cash',
    calc: Number(s.calc != null ? s.calc : s.total) || 0,
    total: Number(s.total) || 0,
    note: s.note || ''
  };
}

function getAllSalesMerged() {
  const users = db.getUsers();
  const out = [];
  const seenIds = new Set();
  for (const [key, u] of Object.entries(users)) {
    for (const s of db.getSales(key)) {
      const idStr = String(s.id);
      if (!seenIds.has(idStr)) {
        seenIds.add(idStr);
        const norm = normalizeSheetSale({ ...s, by: key, byName: (u && u.name) ? u.name : key }, users);
        if (norm) out.push(norm);
      }
    }
  }
  out.sort((a, b) => String(b.date).localeCompare(String(a.date)) || Number(b.id) - Number(a.id));
  return out;
}

let lastSheetHydration = 0;
async function hydrateSalesFromSheet(force = false) {
  const now = Date.now();
  if (!force && now - lastSheetHydration < 12000) return true;
  try {
    const sheetSales = await gsheet.pullSales();
    if (!Array.isArray(sheetSales) || sheetSales.length === 0) return false;

    const users = db.getUsers();
    const sheetIds = [];
    const incomingByUser = {};

    for (const raw of sheetSales) {
      const s = normalizeSheetSale(raw, users);
      if (!s) continue;
      sheetIds.push(s.id);
      const key = s.by;
      if (!incomingByUser[key]) incomingByUser[key] = [];
      incomingByUser[key].push(s);
      if (!users[key]) {
        users[key] = {
          name: s.byName,
          role: key === 'admin' ? 'admin' : 'member',
          status: 'active',
          created: s.date
        };
      }
    }

    db.saveUsers(users);

    for (const [key, incomingList] of Object.entries(incomingByUser)) {
      const existing = db.getSales(key);
      const map = new Map();
      for (const s of existing) map.set(String(s.id), s);
      for (const s of incomingList) {
        if (!map.has(String(s.id))) {
          map.set(String(s.id), s);
        }
      }
      const merged = Array.from(map.values());
      merged.sort((a, b) => String(b.date).localeCompare(String(a.date)) || Number(b.id) - Number(a.id));
      db.saveSales(key, merged);
    }

    db.markUploaded(sheetIds);
    lastSheetHydration = Date.now();
    return true;
  } catch (err) {
    console.error('hydrateSalesFromSheet error:', err.message);
    return false;
  }
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const user = auth.getSessionUser(token);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.token = token;
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin' && !auth.isAdmin(req.user?.username))
    return res.status(403).json({ error: 'Admin access only' });
  next();
}

function validateCredentials(body, isSignup = false) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const name = String(body.name || '').trim();

  if (isSignup && name.length < 2) {
    return { error: 'Please enter your full name (minimum 2 characters).' };
  }
  if (username.length < 3 || password.length < 4) {
    return { error: 'Username / Email: min 3 characters. Password: min 4.' };
  }
  if (!USER_OR_EMAIL_RE.test(username)) {
    return { error: 'Username / Email: letters, numbers, @ . _ - + only' };
  }
  return { key: username.toLowerCase(), username, name: name || username };
}

// ---- auth ----
app.get('/api/status', (req, res) => {
  res.json({ hasUsers: Object.keys(db.getUsers()).length > 0 });
});

app.post('/api/auth/signup', async (req, res) => {
  const v = validateCredentials(req.body, true);
  if (v.error) return res.status(400).json({ error: v.error });
  const result = await auth.createUser(v.key, v.name, req.body.password);
  if (result.error) return res.status(409).json({ error: result.error });
  res.json({
    pending: true,
    deactivated: true,
    message: 'Team account registered with status Deactivated. An approval request has been sent to the owner.'
  });
});

app.post('/api/auth/login', async (req, res) => {
  const v = validateCredentials(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const result = await auth.authenticate(v.key, req.body.password);
  if (result.error && !result.pending) {
    const statusCode = result.code === 'inactive' ? 403 : 401;
    return res.status(statusCode).json({ error: result.error, code: result.code });
  }
  if (result.pending || result.deactivated) {
    return res.status(403).json({
      error: result.error || 'Your account is deactivated and awaiting owner approval.',
      code: result.code || 'deactivated'
    });
  }
  const user = result.user;
  const isAdm = user.role === 'admin' || auth.isAdmin(v.key);
  let userSales = isAdm ? getAllSalesMerged() : db.getSales(v.key);
  if (userSales.length === 0) {
    hydrateSalesFromSheet().catch(() => {});
    userSales = isAdm ? getAllSalesMerged() : db.getSales(v.key);
  }

  const services = await getOrSyncServices();

  res.json({
    token: auth.createSession(v.key, user),
    user: v.key,
    name: user.name,
    role: user.role,
    status: user.status,
    services,
    sales: userSales,
    shopName: db.getSettings().shopName || 'Simple Salon'
  });
});

app.post('/api/auth/logout', (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    auth.destroySession(token);
  }
  res.json({ ok: true });
});

// Manual admin setup (for Vercel serverless)
app.post('/api/admin/setup', async (req, res) => {
  try {
    await auth.ensureAdmin();
    res.json({ ok: true, message: 'Admin ensured' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/settings', (req, res) => {
  res.json(db.getSettings());
});

app.put('/api/admin/settings', requireAuth, requireAdmin, async (req, res) => {
  const shopName = String(req.body.shopName || '').trim();
  if (!shopName || shopName.length < 2) {
    return res.status(400).json({ error: 'Shop name must be at least 2 characters' });
  }
  const current = db.getSettings();
  const updated = { ...current, shopName };
  db.saveSettings(updated);
  res.json({ ok: true, settings: updated, shopName });
});

app.get('/api/bootstrap', requireAuth, async (req, res) => {
  try {
    const isAdm = req.user.role === 'admin' || auth.isAdmin(req.user.username);
    const sales = isAdm ? getAllSalesMerged() : db.getSales(req.user.username);
    const services = await getOrSyncServices();
    res.json({
      user: req.user.username,
      name: req.user.name,
      role: req.user.role || (isAdm ? 'admin' : 'member'),
      services,
      sales,
      shopName: db.getSettings().shopName || 'Simple Salon'
    });
    // Background sheet sync so response returns to client instantly
    hydrateSalesFromSheet().catch(() => {});
  } catch (err) {
    console.error('Bootstrap error:', err.message);
    res.status(500).json({ error: 'Failed to load user data' });
  }
});

// ---- admin dashboard ----
function daysBetween(from, to) {
  const out = [];
  try {
    if (!from || !to) return [];
    const fromStr = String(from).slice(0, 10);
    const toStr = String(to).slice(0, 10);
    const d = new Date(fromStr + 'T00:00:00Z');
    const end = new Date(toStr + 'T00:00:00Z');
    if (isNaN(d.getTime()) || isNaN(end.getTime()) || d > end) {
      return [fromStr];
    }
    while (d <= end && out.length < 400) {
      out.push(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() + 1);
    }
  } catch {}
  return out.length ? out : [String(from).slice(0, 10)];
}

app.get('/api/admin/summary', requireAuth, requireAdmin, async (req, res) => {
  try {
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    const member = String(req.query.user || '');
    const pay = String(req.query.pay || '');
    if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from))
      return res.status(400).json({ error: 'Invalid from date' });
    if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to))
      return res.status(400).json({ error: 'Invalid to date' });
    if (pay && !PAYMENTS.includes(pay))
      return res.status(400).json({ error: 'Invalid payment mode' });

    try { await hydrateSalesFromSheet(); } catch {}
    let users = db.getUsers() || {};

    const memberOptions = Object.entries(users)
      .map(([key, u]) => ({ user: key, name: (u && u.name) ? u.name : key }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const match = s =>
      (!from || s.date >= from) && (!to || s.date <= to) && (!pay || s.pay === pay);

    const members = [];
    const trendMap = {};
    const payMap = Object.fromEntries(PAYMENTS.map(p => [p, { mode: p, total: 0, count: 0 }]));
    const svcMap = {};
    let revenue = 0;
    let count = 0;

    for (const [key, u] of Object.entries(users)) {
      if (member && key !== member) continue;
      const sales = (db.getSales(key) || []).filter(match);
      let mTotal = 0;
      for (const s of sales) {
        const t = Number(s.total) || 0;
        const calc = Number(s.calc) || 0;
        mTotal += t;
        revenue += t;
        count++;
        const sDate = String(s.date || '').slice(0, 10);
        if (sDate) trendMap[sDate] = (trendMap[sDate] || 0) + t;
        if (payMap[s.pay]) {
          payMap[s.pay].total += t;
          payMap[s.pay].count++;
        }
        const items = (s.items && Array.isArray(s.items) && s.items.length)
          ? s.items
          : (s.services ? String(s.services).split(',').map(name => ({ name: name.trim(), qty: 1, price: 0 })) : []);
        for (const i of items) {
          const name = String(i.name || 'Service');
          const line = (Number(i.price) || 0) * (Number(i.qty) || 1);
          const share = calc > 0 ? (line / calc) * t : (line > 0 ? line : (items.length ? t / items.length : t));
          if (!svcMap[name]) svcMap[name] = { name, qty: 0, total: 0 };
          svcMap[name].qty += Number(i.qty) || 1;
          svcMap[name].total += share;
        }
      }
      members.push({ user: key, name: (u && u.name) ? u.name : key, count: sales.length, total: mTotal });
    }
    members.sort((a, b) => b.total - a.total);

    const dates = Object.keys(trendMap).sort();
    let trend = [];
    if (dates.length) {
      const days = daysBetween(dates[0], dates[dates.length - 1]);
      trend = days.map(d => ({ date: d, total: trendMap[d] || 0 }));
    }

    res.json({
      range: { from, to },
      totals: {
        revenue,
        count,
        avg: count ? Math.round(revenue / count) : 0,
        activeMembers: members.filter(m => m.count > 0).length
      },
      memberOptions,
      members: members.map(m => ({
        ...m,
        share: revenue ? Math.round((m.total / revenue) * 1000) / 10 : 0
      })),
      trend,
      payments: Object.values(payMap).filter(p => p.count > 0),
      services: Object.values(svcMap).sort((a, b) => b.total - a.total).slice(0, 8)
    });
  } catch (err) {
    console.error('Error in /api/admin/summary:', err);
    res.json({
      range: { from: req.query.from || '', to: req.query.to || '' },
      totals: { revenue: 0, count: 0, avg: 0, activeMembers: 0 },
      memberOptions: [],
      members: [],
      trend: [],
      payments: [],
      services: []
    });
  }
});

// ---- admin: team accounts ----
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  // On Vercel, local users may be empty after cold-start — ensure we have them
  if (Object.keys(db.getUsers()).length === 0) {
    try { await auth.syncFromSheet(); } catch {}
    try { await auth.ensureAdmin(); } catch {}
  }
  res.json({ users: auth.listUsers() });
});

app.post('/api/admin/sync/team', requireAuth, requireAdmin, async (req, res) => {
  try {
    const ok = await auth.syncFromSheet();
    res.json({ ok, users: auth.listUsers() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/users/:user/approve', requireAuth, requireAdmin, async (req, res) => {
  const result = await auth.approveUser(req.params.user);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

app.get('/api/admin/notifications', requireAuth, requireAdmin, (req, res) => {
  const users = db.getUsers();
  const pendingUsers = Object.entries(users)
    .filter(([_, u]) => u && (u.status === 'deactivated' || u.status === 'pending'))
    .map(([key, u]) => ({ user: key, name: u.name, created: u.created || '' }));
  res.json({ pendingUsers, count: pendingUsers.length });
});

app.delete('/api/admin/users/:user', requireAuth, requireAdmin, (req, res) => {
  if (req.params.user === req.user.username)
    return res.status(400).json({ error: 'Cannot remove your own account' });
  const result = auth.removeUser(req.params.user);
  if (result.error) return res.status(400).json({ error: result.error });
  db.removeData(req.params.user);
  res.json({ ok: true });
});

// ---- admin: all sales ----
app.get('/api/admin/sales', requireAuth, requireAdmin, (req, res) => {
  const out = getAllSalesMerged();
  res.json({ sales: out });
  // Non-blocking hydration in background
  hydrateSalesFromSheet().catch(() => {});
});

app.delete('/api/admin/sales/:user/:id', requireAuth, requireAdmin, (req, res) => {
  const target = req.params.user;
  if (!db.getUsers()[target])
    return res.status(404).json({ error: 'User not found' });
  const sales = db.getSales(target);
  const next = sales.filter(s => String(s.id) !== req.params.id);
  if (next.length === sales.length)
    return res.status(404).json({ error: 'Sale not found' });
  db.saveSales(target, next);
  gsheet.push({ type: 'sale_deleted', data: { id: Number(req.params.id), by: target } });
  res.json({ ok: true });
});

// ---- google sheet sync ----
app.get('/api/sync/status', requireAuth, (req, res) => {
  res.json(gsheet.status());
});

app.post('/api/sync/retry', requireAuth, requireAdmin, async (req, res) => {
  await gsheet.flush();
  res.json(gsheet.status());
});

app.post('/api/sync/backfill', requireAuth, requireAdmin, async (req, res) => {
  if (!gsheet.status().configured)
    return res.status(400).json({ error: 'Google Sheet not connected — set sheetWebappUrl in config.json' });
  const users = db.getUsers();
  let pushed = 0;
  for (const [key, u] of Object.entries(users)) {
    const sales = [...db.getSales(key)].reverse();
    for (const s of sales) {
      const ok = await gsheet.push({
        type: 'sale_created',
        data: {
          id: s.id,
          date: s.date,
          member: u.name,
          services: (s.items || [])
            .map(i => i.name + (i.qty > 1 ? ' ×' + i.qty : ''))
            .join(', '),
          pay: s.pay,
          calc: s.calc,
          total: s.total,
          note: s.note || ''
        }
      });
      if (!ok) return res.json({ pushed, ...gsheet.status() });
      pushed++;
    }
  }
  res.json({ pushed, ...gsheet.status() });
});

// ---- services from Google Sheet ----
app.get('/api/services', async (req, res) => {
  const services = await getOrSyncServices();
  res.json({ services });
});

app.post('/api/services', requireAuth, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const price = Number(req.body.price);
  const cat = String(req.body.cat || '').trim();
  const ic = String(req.body.ic || '⭐').trim();
  if (!name || req.body.price === '' || !Number.isFinite(price) || price < 0)
    return res.status(400).json({ error: 'Enter name and price' });
  if (!cat) return res.status(400).json({ error: 'Enter a category' });

  const service = { id: 's_' + Date.now(), name, price, cat, ic, custom: true };
  const current = await getOrSyncServices();
  current.push(service);
  db.saveServices(current);

  // Sync to Google Sheet Services tab
  await gsheet.push({
    type: 'service_created',
    data: service
  });

  res.status(201).json(service);
});

app.put('/api/services/:id', requireAuth, requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const price = Number(req.body.price);
  const cat = String(req.body.cat || '').trim();
  const ic = String(req.body.ic || '⭐').trim();

  if (!name || req.body.price === '' || !Number.isFinite(price) || price < 0)
    return res.status(400).json({ error: 'Enter valid name and price' });
  if (!cat) return res.status(400).json({ error: 'Enter a category' });

  const current = await getOrSyncServices();
  const index = current.findIndex(s => String(s.id) === String(req.params.id));
  if (index === -1)
    return res.status(404).json({ error: 'Service not found' });

  const old = current[index];
  const changes = [];
  if (old.name !== name) changes.push(`Name: "${old.name}" → "${name}"`);
  if (Number(old.price) !== price) changes.push(`Price: ₹${old.price} → ₹${price}`);
  if (old.cat !== cat) changes.push(`Category: "${old.cat}" → "${cat}"`);
  if ((old.ic || '⭐') !== ic) changes.push(`Icon: "${old.ic || '⭐'}" → "${ic}"`);

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toLocaleTimeString('en-IN', { hour12: true });
  const editor = req.user.name || req.user.username || 'Admin';
  const changeDesc = changes.length > 0 ? changes.join(', ') : 'No changes';
  const auditEntry = `[${dateStr} ${timeStr} by ${editor}]: ${changeDesc}`;

  const previousAudit = old.auditLog || '';
  const fullAudit = previousAudit ? `${auditEntry} | ${previousAudit}` : auditEntry;

  const updatedService = {
    ...old,
    name,
    price,
    cat,
    ic,
    auditLog: fullAudit,
    lastAudit: auditEntry
  };

  current[index] = updatedService;
  db.saveServices(current);

  // Sync update & audit entry to Google Sheet Services tab
  await gsheet.push({
    type: 'service_updated',
    data: {
      id: updatedService.id,
      name: updatedService.name,
      price: updatedService.price,
      cat: updatedService.cat,
      ic: updatedService.ic,
      auditEntry,
      fullAudit
    }
  });

  res.json({ ok: true, service: updatedService, auditEntry });
});

app.delete('/api/services/:id', requireAuth, async (req, res) => {
  const current = await getOrSyncServices();
  const next = current.filter(s => String(s.id) !== String(req.params.id));
  if (next.length === current.length)
    return res.status(404).json({ error: 'Service not found' });
  db.saveServices(next);

  // Sync deletion to Google Sheet Services tab
  await gsheet.push({
    type: 'service_deleted',
    data: { id: req.params.id }
  });

  res.json({ ok: true });
});

// ---- sales ----
app.post('/api/sales', requireAuth, async (req, res) => {
  const b = req.body || {};
  const total = Number(b.total);
  const calc = Number(b.calc);
  if (!Array.isArray(b.items) || !b.items.length)
    return res.status(400).json({ error: 'Sale needs at least one item' });
  if (b.total === '' || !Number.isFinite(total) || total < 0)
    return res.status(400).json({ error: 'Enter a valid total' });
  if (!PAYMENTS.includes(b.pay))
    return res.status(400).json({ error: 'Invalid payment mode' });
  const date = String(b.date || '');
  if (!DATE_RE.test(date))
    return res.status(400).json({ error: 'Invalid date' });

  const now = new Date();
  const time = b.time || now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  const timestamp = b.timestamp || now.toISOString();

  const saleId = b.id ? Number(b.id) : Date.now();
  const sale = {
    id: saleId,
    items: b.items.map(i => ({
      name: String(i.name || ''),
      cat: String(i.cat || ''),
      price: Number(i.price) || 0,
      qty: Number(i.qty) || 1
    })),
    calc: Number.isFinite(calc) ? calc : total,
    total,
    pay: b.pay,
    date,
    time,
    timestamp,
    note: String(b.note || '').trim(),
    by: req.user.username,
    byName: req.user.name || req.user.username
  };
  const sales = db.getSales(req.user.username);
  const existing = sales.find(s => s.id === saleId);
  if (existing) {
    return res.status(200).json(existing);
  }
  sales.unshift(sale);
  db.saveSales(req.user.username, sales);

  // Push to Google Sheet in background without blocking response
  gsheet.push({
    type: 'sale_created',
    data: {
      id: sale.id,
      date: sale.date,
      time: sale.time,
      timestamp: sale.timestamp,
      member: req.user.name,
      by: req.user.username,
      services: sale.items
        .map(i => i.name + (i.qty > 1 ? ' ×' + i.qty : ''))
        .join(', '),
      pay: sale.pay,
      calc: sale.calc,
      total: sale.total,
      note: sale.note
    }
  }).then(ok => {
    if (ok) db.markUploaded([sale.id]);
  }).catch(() => {});

  res.status(201).json(sale);
});

// Auto-sync multiple offline sales from mobile
app.post('/api/sales/sync', requireAuth, async (req, res) => {
  const incoming = Array.isArray(req.body.sales) ? req.body.sales : [];
  if (!incoming.length) return res.json({ ok: true, synced: 0 });

  const sales = db.getSales(req.user.username);
  let synced = 0;
  const syncedIds = [];
  const now = new Date();
  const defaultTime = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  const defaultTimestamp = now.toISOString();

  for (const b of incoming) {
    const total = Number(b.total);
    const calc = Number(b.calc);
    if (!Array.isArray(b.items) || !b.items.length || !Number.isFinite(total) || total < 0) continue;
    const saleId = b.id ? Number(b.id) : Date.now() + synced;
    if (sales.some(s => s.id === saleId)) continue;

    const sale = {
      id: saleId,
      items: b.items.map(i => ({
        name: String(i.name || ''),
        cat: String(i.cat || ''),
        price: Number(i.price) || 0,
        qty: Number(i.qty) || 1
      })),
      calc: Number.isFinite(calc) ? calc : total,
      total,
      pay: PAYMENTS.includes(b.pay) ? b.pay : 'Cash',
      date: DATE_RE.test(b.date) ? b.date : now.toISOString().slice(0, 10),
      time: b.time || defaultTime,
      timestamp: b.timestamp || defaultTimestamp,
      note: String(b.note || '').trim()
    };

    sales.unshift(sale);
    synced++;
    syncedIds.push(sale.id);

    await gsheet.push({
      type: 'sale_created',
      data: {
        id: sale.id,
        date: sale.date,
        time: sale.time,
        timestamp: sale.timestamp,
        member: req.user.name,
        by: req.user.username,
        services: sale.items
          .map(i => i.name + (i.qty > 1 ? ' ×' + i.qty : ''))
          .join(', '),
        pay: sale.pay,
        calc: sale.calc,
        total: sale.total,
        note: sale.note
      }
    });
  }

  if (synced > 0) {
    sales.sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.id - a.id);
    db.saveSales(req.user.username, sales);
    await gsheet.flush();
    db.markUploaded(syncedIds);
  }

  res.json({ ok: true, synced, sales });
});

// Any authenticated user can trigger a flush when reconnecting
app.post('/api/sync/flush', requireAuth, async (req, res) => {
  await gsheet.flush();
  res.json(gsheet.status());
});

// Get confirmed sales IDs — Google Sheet is the source of truth.
// If sheet is reachable, return ONLY what's in the sheet and overwrite local cache.
// If sheet is unreachable, fall back to local cache.
app.get('/api/sales/sheet', requireAuth, async (req, res) => {
  try {
    const list = await gsheet.pullSales();
    if (Array.isArray(list)) {
      // Sheet responded — use it as the definitive source of truth
      const sheetIds = list
        .filter(s => s && s.id != null && s.id !== '')
        .map(s => String(s.id));
      const sheetSet = new Set(sheetIds);

      // Remove any locally-tracked IDs that no longer exist in the sheet
      const allLocal = db.getUploadedIds();
      for (const id of allLocal) {
        if (!sheetSet.has(String(id))) db.unmarkUploaded(id);
      }
      // Then write exactly the sheet IDs as confirmed
      db.markUploaded(sheetIds);

      res.json({ ok: true, ids: sheetIds, count: sheetIds.length, fromSheet: true });
    } else {
      // Sheet returned something unexpected — fall back to local cache
      const ids = db.getUploadedIds().map(String);
      res.json({ ok: true, ids, count: ids.length, fromSheet: false });
    }
  } catch (err) {
    // Sheet unreachable — fall back to local cache, do NOT clear it
    const ids = db.getUploadedIds().map(String);
    res.json({ ok: true, ids, count: ids.length, fromSheet: false, error: err.message });
  }
});

// Manually upload a single sale to Google Sheet
app.post('/api/sales/:id/upload', requireAuth, async (req, res) => {
  let sale = null;
  let memberName = req.user.name;
  const mySales = db.getSales(req.user.username);
  sale = mySales.find(s => String(s.id) === String(req.params.id));

  if (!sale && auth.isAdmin(req.user.username)) {
    const users = db.getUsers();
    for (const [key, u] of Object.entries(users)) {
      const uSales = db.getSales(key);
      const found = uSales.find(s => String(s.id) === String(req.params.id));
      if (found) {
        sale = found;
        memberName = u.name;
        break;
      }
    }
  }

  if (!sale) return res.status(404).json({ error: 'Sale not found' });
  const ok = await gsheet.push({
    type: 'sale_created',
    data: {
      id: sale.id,
      date: normalizeDateStr(sale.date),
      member: memberName,
      by: sale.by || req.user.username,
      services: (sale.items || [])
        .map(i => i.name + (i.qty > 1 ? ' ×' + i.qty : ''))
        .join(', '),
      pay: sale.pay,
      calc: Number(sale.calc) || 0,
      total: Number(sale.total) || 0,
      note: sale.note || ''
    }
  });
  await gsheet.flush();
  if (ok) db.markUploaded([sale.id]);
  res.json({ ok, id: sale.id });
});

// Manually upload all non-uploaded sales to Google Sheet
app.post('/api/sales/upload-all', requireAuth, async (req, res) => {
  try {
    const isAdmin = auth.isAdmin(req.user.username);
    const users = db.getUsers();
    let salesToInspect = [];

    if (isAdmin) {
      for (const [key, u] of Object.entries(users)) {
        for (const s of db.getSales(key)) {
          salesToInspect.push({ sale: s, memberName: u.name, userKey: key });
        }
      }
    } else {
      const mySales = db.getSales(req.user.username);
      const myName = req.user.name || req.user.username;
      for (const s of mySales) {
        salesToInspect.push({ sale: s, memberName: myName, userKey: req.user.username });
      }
    }

    // Pull already uploaded IDs from Google Sheet + local db
    let sheetIds = new Set(db.getUploadedIds().map(String));
    try {
      let sheetSales = await gsheet.pullSales();
      if (Array.isArray(sheetSales)) {
        for (const s of sheetSales) {
          if (s && s.id != null) sheetIds.add(String(s.id));
        }
      }
    } catch {}

    let uploaded = 0;
    for (const item of salesToInspect) {
      const s = item.sale;
      if (!sheetIds.has(String(s.id))) {
        await gsheet.push({
          type: 'sale_created',
          data: {
            id: s.id,
            date: normalizeDateStr(s.date),
            member: item.memberName,
            by: s.by || item.userKey || req.user.username,
            services: (s.items || [])
              .map(i => i.name + (i.qty > 1 ? ' ×' + i.qty : ''))
              .join(', '),
            pay: s.pay,
            calc: Number(s.calc) || 0,
            total: Number(s.total) || 0,
            note: s.note || ''
          }
        });
        sheetIds.add(String(s.id));
        uploaded++;
      }
    }

    // Flush any pending events in the queue to Google Sheet
    await gsheet.flush();
    db.markUploaded(Array.from(sheetIds));

    res.json({
      ok: true,
      uploaded,
      total: salesToInspect.length,
      confirmedIds: Array.from(sheetIds)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sales/:id', requireAuth, (req, res) => {
  const sales = db.getSales(req.user.username);
  const next = sales.filter(s => String(s.id) !== req.params.id);
  if (next.length === sales.length)
    return res.status(404).json({ error: 'Sale not found' });
  db.saveSales(req.user.username, next);
  db.unmarkUploaded(req.params.id);
  gsheet.push({ type: 'sale_deleted', data: { id: Number(req.params.id), by: req.user.username } });
  res.json({ ok: true });
});

// For local development
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Salon Sales Book running at http://localhost:${PORT}`);
  });
}

// For Vercel serverless
module.exports = app;
