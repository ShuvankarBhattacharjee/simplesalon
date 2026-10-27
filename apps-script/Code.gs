const SECRET = 'simple_salon_OS';

const DEFAULT_SERVICES = [
  ['p1', 'Haircut', 300, 'Hair', '✂️'],
  ['p2', 'Hair Wash & Style', 200, 'Hair', '💇'],
  ['p3', 'Hair Colour', 1200, 'Hair', '🎨'],
  ['p4', 'Shave', 100, 'Grooming', '🪒'],
  ['p5', 'Beard Trim', 150, 'Grooming', '🧔'],
  ['p6', 'Spa', 1500, 'Spa', '🧖'],
  ['p7', 'Body Massage', 1800, 'Spa', '💆'],
  ['p8', 'Facial', 900, 'Skin', '✨'],
  ['p9', 'Manicure', 500, 'Nails', '💅']
];

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const body = JSON.parse(e.postData.contents);
    if (SECRET && body.secret !== SECRET) {
      return out({ ok: false, error: 'Bad secret' });
    }
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sales = sheet_(ss, 'Sales', ['ID', 'Date', 'Member', 'Services', 'Payment', 'Calculated', 'Total', 'Notes', 'Recorded At', 'By']);
    const team = sheet_(ss, 'Team', ['Name', 'Username', 'Password', 'Status', 'Joined', 'Synced At', 'Role']);
    const servicesSheet = sheet_(ss, 'Services', ['ID', 'Name', 'Price', 'Category', 'Icon', 'Audit Log']);
    if (servicesSheet.getLastColumn() < 6 || !servicesSheet.getRange(1, 6).getValue()) {
      servicesSheet.getRange(1, 6).setValue('Audit Log').setFontWeight('bold');
    }
    const now = new Date();

    if (body.type === 'get_services') {
      return out({ ok: true, services: getServices_(ss) });
    }

    if (body.type === 'get_users' || body.type === 'get_team') {
      return out({ ok: true, users: getTeamUsers_(ss) });
    }

    if (body.type === 'get_sales' || body.type === 'get_sheet_sales') {
      return out({ ok: true, sales: getSheetSales_(ss) });
    }

    if (body.type === 'service_created') {
      const s = body.data;
      const row = findRowByCol_(servicesSheet, s.id, 1);
      const auditLog = s.auditEntry || s.auditLog || '';
      if (row > 0) {
        servicesSheet.getRange(row, 1, 1, 6).setValues([[s.id, s.name, Number(s.price) || 0, s.cat || 'General', s.ic || '⭐', auditLog]]);
      } else {
        servicesSheet.appendRow([s.id, s.name, Number(s.price) || 0, s.cat || 'General', s.ic || '⭐', auditLog]);
      }
    } else if (body.type === 'service_updated') {
      const s = body.data;
      const row = findRowByCol_(servicesSheet, String(s.id), 1);
      const auditEntry = String(s.auditEntry || '').trim();
      if (row > 0) {
        let existingAudit = String(servicesSheet.getRange(row, 6).getValue() || '').trim();
        let fullAudit = existingAudit ? (auditEntry + '\n' + existingAudit) : auditEntry;
        servicesSheet.getRange(row, 1, 1, 6).setValues([[s.id, s.name, Number(s.price) || 0, s.cat || 'General', s.ic || '⭐', fullAudit]]);
      } else {
        servicesSheet.appendRow([s.id, s.name, Number(s.price) || 0, s.cat || 'General', s.ic || '⭐', auditEntry]);
      }
    } else if (body.type === 'service_deleted') {
      const row = findRowByCol_(servicesSheet, String(body.data.id), 1);
      if (row > 0) servicesSheet.deleteRow(row);
    } else if (body.type === 'sale_created') {
      const r = body.data;
      if (findRowByCol_(sales, String(r.id), 1) < 0) {
        sales.appendRow([r.id, r.date, r.member, r.services, r.pay, r.calc, r.total, r.note, now, r.by || '']);
      }
    } else if (body.type === 'sales_batch' || body.type === 'batch_sales_created') {
      const list = Array.isArray(body.data) ? body.data : [];
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (findRowByCol_(sales, String(r.id), 1) < 0) {
          sales.appendRow([r.id, r.date, r.member, r.services, r.pay, r.calc, r.total, r.note, now, r.by || '']);
        }
      }
    } else if (body.type === 'sale_deleted') {
      const row = findRowByCol_(sales, String(body.data.id), 1);
      if (row > 0) sales.deleteRow(row);
    } else if (body.type === 'user_created' || body.type === 'user_approved' || body.type === 'user_removed') {
      const r = body.data;
      // In Team sheet: Col 1 is Name, Col 2 is Username, Col 3 is Password, Col 4 is Status, Col 5 is Joined, Col 6 is Synced At, Col 7 is Role
      const row = findRowByCol_(team, r.user, 2);
      if (body.type === 'user_removed') {
        if (row > 0) team.deleteRow(row);
      } else {
        const rawStatus = body.type === 'user_approved' ? 'Active' : (r.status || 'Deactivated');
        const status = (rawStatus.toLowerCase() === 'active' || rawStatus.toLowerCase() === 'approved') ? 'Active' : 'Deactivated';
        const role = (r.role && (r.role.toLowerCase() === 'admin' || r.role.toLowerCase() === 'owner')) ? 'Owner' : 'Team';
        const password = r.password || '';
        const name = r.name || r.user;
        const joined = r.joined || now;

        if (row > 0) {
          const currentPassword = team.getRange(row, 3).getValue();
          const finalPassword = password || currentPassword || '';
          const currentJoined = team.getRange(row, 5).getValue() || joined;
          team.getRange(row, 1, 1, 7).setValues([[name, r.user, finalPassword, status, currentJoined, now, role]]);
        } else {
          team.appendRow([name, r.user, password, status, joined, now, role]);
        }
      }
    }
    return out({ ok: true });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  try {
    const action = e && e.parameter && e.parameter.action;
    const secret = e && e.parameter && e.parameter.secret;
    if (SECRET && secret && secret !== SECRET) {
      return out({ ok: false, error: 'Bad secret' });
    }
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (action === 'get_services') {
      return out({ ok: true, services: getServices_(ss) });
    }
    if (action === 'get_users' || action === 'get_team') {
      return out({ ok: true, users: getTeamUsers_(ss) });
    }
    if (action === 'get_sales' || action === 'get_sheet_sales') {
      return out({ ok: true, sales: getSheetSales_(ss) });
    }
    return out({ ok: true, message: 'Salon sheet endpoint is live' });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

function getServices_(ss) {
  let sheet = ss.getSheetByName('Services');
  if (!sheet) {
    sheet = sheet_(ss, 'Services', ['ID', 'Name', 'Price', 'Category', 'Icon']);
    for (let i = 0; i < DEFAULT_SERVICES.length; i++) {
      sheet.appendRow(DEFAULT_SERVICES[i]);
    }
  }
  const last = sheet.getLastRow();
  if (last < 2) {
    for (let i = 0; i < DEFAULT_SERVICES.length; i++) {
      sheet.appendRow(DEFAULT_SERVICES[i]);
    }
  }
  const numCols = Math.max(sheet.getLastColumn(), 6);
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, numCols).getValues();
  const list = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const id = String(r[0] || '').trim();
    const name = String(r[1] || '').trim();
    if (!name) continue;
    list.push({
      id: id || ('s_' + (i + 1)),
      name: name,
      price: Number(r[2]) || 0,
      cat: String(r[3] || 'General').trim(),
      ic: String(r[4] || '⭐').trim(),
      auditLog: String(r[5] || '').trim()
    });
  }
  return list;
}

function getTeamUsers_(ss) {
  const team = ss.getSheetByName('Team');
  if (!team) return [];
  const last = team.getLastRow();
  if (last < 2) return [];
  // Row 1 is header: Name, Username, Password, Status, Joined, Synced At, Role
  const values = team.getRange(2, 1, last - 1, 7).getValues();
  const list = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const name = String(row[0] || '').trim();
    const user = String(row[1] || '').trim();
    const password = String(row[2] || '').trim();
    const status = String(row[3] || '').trim();
    const joined = row[4] ? (row[4] instanceof Date ? row[4].toISOString().slice(0, 10) : String(row[4])) : '';
    const syncedAt = row[5] ? (row[5] instanceof Date ? row[5].toISOString() : String(row[5])) : '';
    const role = String(row[6] || '').trim();
    if (user) {
      list.push({
        name: name || user,
        user: user,
        password: password,
        status: status || 'Deactivated',
        joined: joined,
        syncedAt: syncedAt,
        role: role || 'Team'
      });
    }
  }
  return list;
}

function getSheetSales_(ss) {
  const sales = ss.getSheetByName('Sales');
  if (!sales) return [];
  const last = sales.getLastRow();
  if (last < 2) return [];
  const values = sales.getRange(2, 1, last - 1, 10).getValues();
  const list = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const id = row[0];
    if (id !== '' && id != null) {
      let timeStr = '';
      let timestamp = '';
      if (row[8]) {
        if (row[8] instanceof Date) {
          timeStr = Utilities.formatDate(row[8], ss.getSpreadsheetTimeZone() || "Asia/Kolkata", "hh:mm a");
          timestamp = Utilities.formatDate(row[8], "GMT", "yyyy-MM-dd'T'HH:mm:ss'Z'");
        } else {
          timeStr = String(row[8]);
        }
      }
      list.push({
        id: String(id),
        date: row[1] ? (row[1] instanceof Date ? Utilities.formatDate(row[1], ss.getSpreadsheetTimeZone() || "Asia/Kolkata", "yyyy-MM-dd") : String(row[1]).slice(0, 10)) : '',
        time: timeStr,
        timestamp: timestamp,
        member: String(row[2] || ''),
        services: String(row[3] || ''),
        pay: String(row[4] || ''),
        calc: Number(row[5]) || 0,
        total: Number(row[6]) || 0,
        note: String(row[7] || ''),
        by: String(row[9] || (String(row[2] || '').toLowerCase() === 'admin' ? 'admin' : String(row[2] || '').toLowerCase())).trim()
      });
    }
  }
  return list;
}

function sheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function findRowByCol_(sh, val, colIndex) {
  const last = sh.getLastRow();
  if (last < 2) return -1;
  const values = sh.getRange(2, colIndex, last - 1, 1).getValues();
  const searchVal = String(val).toLowerCase().trim();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]).toLowerCase().trim() === searchVal) return i + 2;
  }
  return -1;
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
