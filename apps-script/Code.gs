const SECRET = '';

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
    const team = sheet_(ss, 'Team', ['Username', 'Name', 'Role', 'Status', 'Password', 'Joined', 'Synced At']);
    const now = new Date();

    if (body.type === 'sale_created') {
      const r = body.data;
      if (findRow_(sales, String(r.id)) < 0) {
        sales.appendRow([r.id, r.date, r.member, r.services, r.pay, r.calc, r.total, r.note, now]);
      }
    } else if (body.type === 'sale_deleted') {
      const row = findRow_(sales, String(body.data.id));
      if (row > 0) sales.deleteRow(row);
    } else if (body.type === 'user_created' || body.type === 'user_approved' || body.type === 'user_removed') {
      const r = body.data;
      const row = findRow_(team, r.user);
      if (body.type === 'user_removed') {
        if (row > 0) team.deleteRow(row);
      } else {
        const status = body.type === 'user_approved' ? 'Approved' : r.status || 'Pending';
        const role = r.role === 'admin' ? 'Owner' : 'Worker';
        const password = r.password || '';
        if (row > 0) {
          team.getRange(row, 3, 1, 4).setValues([[role, status, password, now]]);
        } else {
          team.appendRow([r.user, r.name, role, status, password, now, now]);
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

function doGet() {
  return out({ ok: true, message: 'Salon sheet endpoint is live' });
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

function findRow_(sh, id) {
  const last = sh.getLastRow();
  if (last < 2) return -1;
  const values = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]) === id) return i + 2;
  }
  return -1;
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
