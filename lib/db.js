const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.SALON_DATA_DIR
  ? path.resolve(process.env.SALON_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const SALES_DIR = path.join(DATA_DIR, 'sales');
const CUSTOM_DIR = path.join(DATA_DIR, 'custom');

fs.mkdirSync(SALES_DIR, { recursive: true });
fs.mkdirSync(CUSTOM_DIR, { recursive: true });

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const safeName = u => u.replace(/[^a-z0-9_.-]/gi, '_');

module.exports = {
  getUsers: () => readJSON(USERS_FILE, {}),
  saveUsers: users => writeJSON(USERS_FILE, users),

  getSessions: () => readJSON(SESSIONS_FILE, {}),
  saveSessions: sessions => writeJSON(SESSIONS_FILE, sessions),

  getSales: user => readJSON(path.join(SALES_DIR, safeName(user) + '.json'), []),
  saveSales: (user, sales) => writeJSON(path.join(SALES_DIR, safeName(user) + '.json'), sales),

  getCustom: user => readJSON(path.join(CUSTOM_DIR, safeName(user) + '.json'), []),
  saveCustom: (user, list) => writeJSON(path.join(CUSTOM_DIR, safeName(user) + '.json'), list),

  removeData: user => {
    for (const file of [
      path.join(SALES_DIR, safeName(user) + '.json'),
      path.join(CUSTOM_DIR, safeName(user) + '.json')
    ]) {
      try { fs.unlinkSync(file); } catch {}
    }
  }
};
