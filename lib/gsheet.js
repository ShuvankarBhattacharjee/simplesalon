const fs = require('fs');
const path = require('path');

const isVercel = !!process.env.VERCEL;
const CONFIG_FILE = path.join(__dirname, '..', 'config.json');
const QUEUE_FILE = isVercel
  ? '/tmp/sync-queue.json'
  : path.join(__dirname, '..', 'data', 'sync-queue.json');

let queue = loadQueue();
let lastOk = null;
let lastError = null;

function loadQueue() {
  try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch { return []; }
}

function saveQueue() {
  try {
    fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
  } catch {}
}

function conf() {
  let c = {};
  try {
    c = require('../config.json');
  } catch {
    try { c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  }
  return {
    url: process.env.SHEET_WEBAPP_URL || c.sheetWebappUrl || '',
    secret: process.env.SHEET_SECRET || c.sheetSecret || ''
  };
}

async function send(evt) {
  const { url, secret } = conf();
  if (!url) throw new Error('No sheet webapp URL configured');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...evt, secret, at: new Date().toISOString() }),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error('Sheet endpoint HTTP ' + res.status);
  lastOk = new Date().toISOString();
  lastError = null;
}

function enqueue(evt) {
  queue.push(evt);
  if (queue.length > 500) queue.shift();
  saveQueue();
}

let autoTimer = null;
function startAutoFlush() {
  if (autoTimer) return;
  autoTimer = setInterval(() => {
    if (queue.length > 0 && conf().url) {
      flush().catch(() => {});
    }
  }, 15000);
  if (autoTimer && autoTimer.unref) autoTimer.unref();
}
startAutoFlush();

async function push(evt) {
  if (!conf().url) return false;
  try {
    await send(evt);
    if (queue.length > 0) flush().catch(() => {});
    return true;
  } catch (err) {
    lastError = String(err.message || err);
    enqueue(evt);
    return false;
  }
}

async function pullUsers() {
  const { url, secret } = conf();
  if (!url) return null;
  // Try fast GET first (avoids Apps Script LockService delay)
  try {
    const getUrl = new URL(url);
    getUrl.searchParams.set('action', 'get_users');
    if (secret) getUrl.searchParams.set('secret', secret);
    const res = await fetch(getUrl.toString(), {
      signal: AbortSignal.timeout(12000)
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.ok && Array.isArray(data.users)) {
        lastOk = new Date().toISOString();
        lastError = null;
        return data.users;
      }
    }
  } catch (err) {}

  // Fallback to POST
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'get_users', secret }),
      signal: AbortSignal.timeout(12000)
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.ok && Array.isArray(data.users)) {
        lastOk = new Date().toISOString();
        lastError = null;
        return data.users;
      }
    }
  } catch (err) {
    lastError = String(err.message || err);
  }
  return null;
}

async function pullSales() {
  const { url, secret } = conf();
  if (!url) return null;
  // Try fast GET first (avoids Apps Script LockService delay)
  try {
    const getUrl = new URL(url);
    getUrl.searchParams.set('action', 'get_sales');
    if (secret) getUrl.searchParams.set('secret', secret);
    const res = await fetch(getUrl.toString(), {
      signal: AbortSignal.timeout(12000)
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.ok && Array.isArray(data.sales)) {
        lastOk = new Date().toISOString();
        lastError = null;
        return data.sales;
      }
    }
  } catch (err) {}

  // Fallback to POST
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'get_sales', secret }),
      signal: AbortSignal.timeout(12000)
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.ok && Array.isArray(data.sales)) {
        lastOk = new Date().toISOString();
        lastError = null;
        return data.sales;
      }
    }
  } catch (err) {
    lastError = String(err.message || err);
  }
  return null;
}

async function pullServices() {
  const { url, secret } = conf();
  if (!url) return null;
  // Try fast GET first (avoids Apps Script LockService delay)
  try {
    const getUrl = new URL(url);
    getUrl.searchParams.set('action', 'get_services');
    if (secret) getUrl.searchParams.set('secret', secret);
    const res = await fetch(getUrl.toString(), {
      signal: AbortSignal.timeout(12000)
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.ok && Array.isArray(data.services)) {
        lastOk = new Date().toISOString();
        lastError = null;
        return data.services;
      }
    }
  } catch (err) {}

  // Fallback to POST
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'get_services', secret }),
      signal: AbortSignal.timeout(12000)
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.ok && Array.isArray(data.services)) {
        lastOk = new Date().toISOString();
        lastError = null;
        return data.services;
      }
    }
  } catch (err) {
    lastError = String(err.message || err);
  }
  return null;
}

async function flush() {
  if (!conf().url) return;
  while (queue.length) {
    try {
      await send(queue[0]);
      queue.shift();
      saveQueue();
    } catch (err) {
      lastError = String(err.message || err);
      break;
    }
  }
  if (queue.length === 0) {
    lastError = null;
  }
}

const status = () => ({
  configured: !!conf().url,
  queued: queue.length,
  lastOk,
  lastError: queue.length > 0 ? lastError : null
});

module.exports = { push, pullUsers, pullSales, pullServices, flush, status };
