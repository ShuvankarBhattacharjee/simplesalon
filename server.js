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

const USER_RE = /^[a-z0-9_.-]+$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PAYMENTS = ['Cash', 'UPI', 'Card'];

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

function normalizeSheetSale(s) {
  if (!s || !s.id) return null;
  const memberName = String(s.member || s.byName || s.by || 'Admin').trim();
  const username = String(s.by || s.user || (memberName.toLowerCase() === 'admin' ? 'admin' : memberName.toLowerCase())).trim();
  let items = s.items;
  if (!items || !Array.isArray(items) || items.length === 0) {
    if (s.services) {
      items = String(s.services).split(',').map(name => ({ name: name.trim(), qty: 1, price: 0 }));
    } else {
      items = [{ name: 'Service', qty: 1, price: Number(s.total) || 0 }];
    }
  }
  return {
    id: String(s.id),
    date: s.date || new Date().toISOString().slice(0, 10),
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

async function hydrateSalesFromSheet() {
  try {
    const sheetSales = await gsheet.pullSales();
    if (!Array.isArray(sheetSales) || sheetSales.length === 0) return false;

    const byUser = {};
    const sheetIds = [];
    const users = db.getUsers();

    for (const raw of sheetSales) {
      const s = normalizeSheetSale(raw);
      if (!s) continue;
      sheetIds.push(s.id);
      const key = s.by;
      if (!byUser[key]) byUser[key] = [];
      byUser[key].push(s);
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
    for (const [key, list] of Object.entries(byUser)) {
      db.saveSales(key, list);
    }
    db.markUploaded(sheetIds);
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

function validateCredentials(body) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (username.length < 3 || password.length < 4)
    return { error: 'Username: min 3 characters. Password: min 4.' };
  if (!USER_RE.test(username))
    return { error: 'Username: letters, numbers, . _ - only' };
  return { key: username.toLowerCase(), username };
}

// ---- auth ----
app.get('/api/status', (req, res) => {
  res.json({ hasUsers: Object.keys(db.getUsers()).length > 0 });
});

app.post('/api/auth/signup', async (req, res) => {
  const v = validateCredentials(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const result = await auth.createUser(v.key, v.username, req.body.password);
  if (result.error) return res.status(409).json({ error: result.error });
  res.json({
    pending: true,
    message: 'Staff account created. Please wait for owner approval.'
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
  if (result.pending) {
    return res.status(403).json({
      error: result.error || 'Your account is waiting for owner approval',
      code: 'pending'
    });
  }
  const user = result.user;

  let userSales = db.getSales(v.key);
  if (userSales.length === 0) {
    await hydrateSalesFromSheet();
    userSales = db.getSales(v.key);
  }

  const services = await getOrSyncServices();

  res.json({
    token: auth.createSession(v.key, user),
    user: v.key,
    name: user.name,
    role: user.role,
    status: user.status,
    services,
    sales: userSales
  });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  auth.destroySession(req.token);
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

app.get('/api/bootstrap', requireAuth, async (req, res) => {
  let sales = db.getSales(req.user.username);
  if (sales.length === 0) {
    await hydrateSalesFromSheet();
    sales = db.getSales(req.user.username);
  }
  const services = await getOrSyncServices();
  res.json({
    user: req.user.username,
    name: req.user.name,
    role: req.user.role || (auth.isAdmin(req.user.username) ? 'admin' : 'member'),
    services,
    sales
  });
});

// ---- admin dashboard ----
function daysBetween(from, to) {
  const out = [];
  const d = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (d <= end && out.length < 400) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

app.get('/api/admin/summary', requireAuth, requireAdmin, async (req, res) => {
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

  let users = db.getUsers();
  const totalLocalSales = Object.keys(users).reduce((n, k) => n + db.getSales(k).length, 0);
  if (totalLocalSales === 0) {
    await hydrateSalesFromSheet();
    users = db.getUsers();
  }

  if (member && !users[member])
    return res.status(400).json({ error: 'Unknown member' });

  const memberOptions = Object.entries(users)
    .map(([key, u]) => ({ user: key, name: u.name }))
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
    const sales = db.getSales(key).filter(match);
    let mTotal = 0;
    for (const s of sales) {
      const t = Number(s.total) || 0;
      const calc = Number(s.calc) || 0;
      mTotal += t;
      revenue += t;
      count++;
      trendMap[s.date] = (trendMap[s.date] || 0) + t;
      if (payMap[s.pay]) {
        payMap[s.pay].total += t;
        payMap[s.pay].count++;
      }
      const items = (s.items && s.items.length)
        ? s.items
        : (s.services ? s.services.split(',').map(name => ({ name: name.trim(), qty: 1, price: 0 })) : []);
      for (const i of items) {
        const name = String(i.name || 'Service');
        const line = (Number(i.price) || 0) * (Number(i.qty) || 1);
        const share = calc > 0 ? (line / calc) * t : (line > 0 ? line : (items.length ? t / items.length : t));
        if (!svcMap[name]) svcMap[name] = { name, qty: 0, total: 0 };
        svcMap[name].qty += Number(i.qty) || 1;
        svcMap[name].total += share;
      }
    }
    members.push({ user: key, name: u.name, count: sales.length, total: mTotal });
  }
  members.sort((a, b) => b.total - a.total);

  const dates = Object.keys(trendMap).sort();
  let trend = [];
  if (dates.length) {
    const days = daysBetween(dates[0], dates[dates.length - 1]);
    trend = days[days.length - 1] === dates[dates.length - 1]
      ? days.map(d => ({ date: d, total: trendMap[d] || 0 }))
      : dates.map(d => ({ date: d, total: trendMap[d] }));
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

app.post('/api/admin/users/:user/approve', requireAuth, requireAdmin, (req, res) => {
  const result = auth.approveUser(req.params.user);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
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
app.get('/api/admin/sales', requireAuth, requireAdmin, async (req, res) => {
  let users = db.getUsers();
  const totalLocalSales = Object.keys(users).reduce((n, k) => n + db.getSales(k).length, 0);

  if (totalLocalSales === 0) {
    await hydrateSalesFromSheet();
    users = db.getUsers();
  }

  const out = [];
  for (const [key, u] of Object.entries(users)) {
    for (const s of db.getSales(key)) {
      const norm = normalizeSheetSale({ ...s, by: key, byName: u.name });
      if (norm) out.push(norm);
    }
  }
  out.sort((a, b) => String(b.date).localeCompare(String(a.date)) || Number(b.id) - Number(a.id));
  res.json({ sales: out });
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
app.get('/api/sync/status', requireAuth, requireAdmin, (req, res) => {
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
    note: String(b.note || '').trim()
  };
  const sales = db.getSales(req.user.username);
  const existing = sales.find(s => s.id === saleId);
  if (existing) {
    return res.status(200).json(existing);
  }
  sales.unshift(sale);
  db.saveSales(req.user.username, sales);
  const ok = await gsheet.push({
    type: 'sale_created',
    data: {
      id: sale.id,
      date: sale.date,
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
  if (ok) db.markUploaded([sale.id]);
  res.status(201).json(sale);
});

// Auto-sync multiple offline sales from mobile
app.post('/api/sales/sync', requireAuth, async (req, res) => {
  const incoming = Array.isArray(req.body.sales) ? req.body.sales : [];
  if (!incoming.length) return res.json({ ok: true, synced: 0 });

  const sales = db.getSales(req.user.username);
  let synced = 0;
  const syncedIds = [];

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
      date: DATE_RE.test(b.date) ? b.date : new Date().toISOString().slice(0, 10),
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
        member: req.user.name,
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
      date: sale.date,
      member: memberName,
      services: (sale.items || [])
        .map(i => i.name + (i.qty > 1 ? ' ×' + i.qty : ''))
        .join(', '),
      pay: sale.pay,
      calc: sale.calc,
      total: sale.total,
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
          salesToInspect.push({ sale: s, memberName: u.name });
        }
      }
    } else {
      const mySales = db.getSales(req.user.username);
      const myName = req.user.name || req.user.username;
      for (const s of mySales) {
        salesToInspect.push({ sale: s, memberName: myName });
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
            date: s.date,
            member: item.memberName,
            services: (s.items || [])
              .map(i => i.name + (i.qty > 1 ? ' ×' + i.qty : ''))
              .join(', '),
            pay: s.pay,
            calc: s.calc,
            total: s.total,
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
