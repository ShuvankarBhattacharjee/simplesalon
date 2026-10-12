const SECRET = 'simple_salon_OS';

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const body = JSON.parse(e.postData.contents);
    if (SECRET && body.secret !== SECRET) {
      return out({ ok: false, error: 'Bad secret' });
    }
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sales = sheet_(ss, 'Sales', ['ID', 'Date', 'Member', 'Services', 'Payment', 'Calculated', 'Total', 'Notes', 'Recorded At']);
    // Team structure matching sheet: Name, Username, Password, Status, Joined, Synced At, Role
    const team = sheet_(ss, 'Team', ['Name', 'Username', 'Password', 'Status', 'Joined', 'Synced At', 'Role']);
    const now = new Date();

    if (body.type === 'get_users' || body.type === 'get_team') {
      return out({ ok: true, users: getTeamUsers_(ss) });
    }

    if (body.type === 'sale_created') {
      const r = body.data;
      if (findRowByCol_(sales, String(r.id), 1) < 0) {
        sales.appendRow([r.id, r.date, r.member, r.services, r.pay, r.calc, r.total, r.note, now]);
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
        const rawStatus = body.type === 'user_approved' ? 'Active' : (r.status || 'Pending');
        const status = (rawStatus.toLowerCase() === 'active' || rawStatus.toLowerCase() === 'approved') ? 'Active' : 'Pending';
        const role = (r.role && (r.role.toLowerCase() === 'admin' || r.role.toLowerCase() === 'owner')) ? 'Owner' : 'Worker';
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
    if (action === 'get_users' || action === 'get_team') {
      return out({ ok: true, users: getTeamUsers_(ss) });
    }
    return out({ ok: true, message: 'Salon sheet endpoint is live' });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
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
        status: status || 'Pending',
        joined: joined,
        syncedAt: syncedAt,
        role: role || 'Worker'
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
