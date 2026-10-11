const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');
const QUEUE_FILE = path.join(__dirname, '..', 'data', 'sync-queue.json');

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
  try { c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  return {
    url: process.env.SHEET_WEBAPP_URL || c.sheetWebappUrl || '',
    secret: process.env.SHEET_SECRET || c.sheetSecret || ''
  };
}

async function send(evt) {
  const { url, secret } = conf();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...evt, secret, at: new Date().toISOString() }),
    signal: AbortSignal.timeout(10000)
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

async function push(evt) {
  if (!conf().url) return false;
  try {
    await send(evt);
    return true;
  } catch (err) {
    lastError = String(err.message || err);
    enqueue(evt);
    return false;
  }
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
}

const status = () => ({
  configured: !!conf().url,
  queued: queue.length,
  lastOk,
  lastError
});

module.exports = { push, flush, status };
