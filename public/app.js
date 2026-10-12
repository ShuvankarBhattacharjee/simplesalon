// ---- api client ----
let token = localStorage.getItem('token') || '';

async function api(path, opts = {}) {
  try {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {})
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  } catch (err) {
    if (!navigator.onLine || err.name === 'TypeError' || String(err.message).includes('fetch')) {
      err.isNetwork = true;
    }
    throw err;
  }
}

// ---- offline queue (keyed per user) ----
const OFFLINE_KEY = () => 'offline_sales_' + (user || 'guest');
function getOfflineQueue() {
  try { return JSON.parse(localStorage.getItem(OFFLINE_KEY()) || '[]'); } catch { return []; }
}
function saveOfflineQueue(q) {
  try { localStorage.setItem(OFFLINE_KEY(), JSON.stringify(q)); } catch {}
}
function queueOfflineSale(s) {
  const q = getOfflineQueue();
  if (!q.some(x => x.id === s.id)) { q.push(s); saveOfflineQueue(q); }
}
function removeFromOfflineQueue(id) {
  saveOfflineQueue(getOfflineQueue().filter(x => x.id !== id));
}

// ---- sheet-confirmed IDs ----
const CONFIRMED_CACHE_KEY = () => 'sheet_confirmed_ids_' + (user || 'guest');
function loadCachedConfirmedIds() {
  try {
    const raw = JSON.parse(localStorage.getItem(CONFIRMED_CACHE_KEY()) || '[]');
    return new Set(raw.map(String));
  } catch { return new Set(); }
}
function saveCachedConfirmedIds(set) {
  try {
    localStorage.setItem(CONFIRMED_CACHE_KEY(), JSON.stringify(Array.from(set)));
  } catch {}
}

let sheetConfirmedIds = loadCachedConfirmedIds();
let sheetIdsFetched = sheetConfirmedIds.size > 0;

async function fetchSheetIds() {
  if (!navigator.onLine || !token) return;
  try {
    const r = await api('/api/sales/sheet');
    if (r && Array.isArray(r.ids)) {
      if (r.fromSheet) {
        // Sheet was actually reached — REPLACE (not merge) confirmed IDs
        // This means rows deleted from the sheet will flip back to "Not Uploaded"
        sheetConfirmedIds = new Set(r.ids.map(String));
      } else {
        // Sheet unreachable — only add from local cache fallback, never remove
        for (const id of r.ids) sheetConfirmedIds.add(String(id));
      }
      sheetIdsFetched = true;
      saveCachedConfirmedIds(sheetConfirmedIds);
      renderSales();
      updateNetStatus();
    }
  } catch {}
}

function isUploaded(saleId) {
  return sheetConfirmedIds.has(String(saleId));
}

function isInQueue(saleId) {
  return getOfflineQueue().some(x => x.id === saleId);
}

// Calculate total non-uploaded / non-synced items across offline queue & server sales
function countTotalPending() {
  const q = getOfflineQueue();
  const notUploadedSales = typeof activeSales === 'function' ? activeSales().filter(s => {
    const st = getUploadStatus(s.id);
    return st === 'not-uploaded' || st === 'unknown';
  }) : [];
  const idSet = new Set(notUploadedSales.map(s => String(s.id)));
  for (const s of q) idSet.add(String(s.id));
  return idSet.size;
}

// Update all sync button states and badges
function updateSyncBadges() {
  const pending = countTotalPending();

  // Header sync button & badge
  const headerBtn = $('btnHeaderSync');
  if (headerBtn) {
    if (isSyncing) {
      headerBtn.disabled = true;
      headerBtn.innerHTML = '<span class="h-sync-icon spinning">↻</span> <span class="h-sync-text">Syncing…</span>';
    } else {
      headerBtn.disabled = false;
      headerBtn.innerHTML = `<span class="h-sync-icon">☁️</span> <span class="h-sync-text">Sync Data</span> <span class="h-sync-badge ${pending > 0 ? '' : 'hide'}" id="hSyncBadge">${pending}</span>`;
      if (pending > 0) {
        headerBtn.classList.add('has-pending');
        headerBtn.title = `Upload ${pending} non-synced entry(s) to Google Sheet`;
      } else {
        headerBtn.classList.remove('has-pending');
        headerBtn.title = 'All data synced. Click to check and upload manually.';
      }
    }
  }

  // Sales tab button
  const upAllBtn = $('btnUploadAll');
  if (upAllBtn) {
    if (isSyncing) {
      upAllBtn.disabled = true;
      upAllBtn.className = 'btn upload-all-btn';
      upAllBtn.innerHTML = '<span class="up-ic spinning">↻</span> Uploading all…';
    } else if (pending > 0) {
      upAllBtn.disabled = false;
      upAllBtn.className = 'btn upload-all-btn has-pending';
      upAllBtn.innerHTML = `<span class="up-ic">↑</span> Upload all non-synced <span class="up-badge" id="salesUpBadge">${pending}</span>`;
      upAllBtn.title = `Upload ${pending} non-synced entry(s) to Google Sheet`;
    } else {
      upAllBtn.disabled = false;
      upAllBtn.className = 'btn ghost upload-all-btn all-synced';
      upAllBtn.innerHTML = '<span class="up-ic">✓</span> All synced (Upload all)';
      upAllBtn.title = 'All sales are confirmed in Google Sheet. Click to re-check and sync.';
    }
  }
}

// ---- auto-sync ----
let isSyncing = false;

async function syncPendingSales() {
  if (isSyncing || !token) return;
  const q = getOfflineQueue();
  if (!q.length) { updateNetStatus(); return; }
  if (!navigator.onLine) { updateNetStatus(); return; }
  isSyncing = true;
  updateNetStatus();
  try {
    const res = await api('/api/sales/sync', { method: 'POST', body: { sales: q } });
    if (res && res.ok) {
      saveOfflineQueue([]);
      if (Array.isArray(res.sales)) {
        sales = norm(res.sales);
        if (role === 'admin') loadAllSales();
        renderSales();
        stats();
      }
      showBanner(`✓ ${res.synced || q.length} sale${(res.synced || q.length) === 1 ? '' : 's'} synced with Google Sheet`, 'synced');
      fetchSheetIds();
    }
  } catch (e) {
    console.warn('Auto-sync failed:', e.message);
  } finally {
    isSyncing = false;
    updateNetStatus();
  }
}

// ---- banners ----
let bannerTimer = null;
function showBanner(msg, type) {
  const el = $('netStatus');
  if (!el) return;
  clearTimeout(bannerTimer);
  el.className = 'net-status banner-' + (type || 'synced');
  el.innerHTML = '<span>' + msg + '</span>';
  el.classList.remove('hide');
  bannerTimer = setTimeout(() => { updateNetStatus(); }, 4200);
}

// ---- floating prompt toast ----
let promptTimer = null;
function showPrompt(msg, type, duration) {
  const el = $('toastPrompt');
  if (!el) return;
  clearTimeout(promptTimer);
  const icons = { success: '✓', offline: '⚡', error: '✕', upload: '☁️' };
  const cls = type === 'offline' ? 'toast-offline' : type === 'error' ? 'toast-error' : 'toast-success';
  const icon = icons[type] || '✓';
  el.innerHTML = '<span class="toast-icon">' + icon + '</span><span>' + msg + '</span>';
  el.className = 'toast-prompt ' + cls;
  promptTimer = setTimeout(hidePrompt, duration || 3500);
}
function hidePrompt() {
  clearTimeout(promptTimer);
  const el = $('toastPrompt');
  if (el) el.className = 'toast-prompt hide';
}

function updateNetStatus() {
  const el = $('netStatus');
  if (!el || !user) return;
  const q = getOfflineQueue();
  const pending = countTotalPending();
  updateSyncBadges();

  if (isSyncing) {
    el.className = 'net-status banner-syncing';
    el.innerHTML = '<span><i class="spinning" style="display:inline-block;margin-right:6px">↻</i> Syncing with Google Sheet…</span>';
    el.classList.remove('hide');
    return;
  }
  if (!navigator.onLine) {
    el.className = 'net-status banner-offline';
    el.innerHTML = '<span>⚡ Offline — ' + (q.length ? q.length + ' entry(s) pending upload' : 'ready') + '. Auto-syncs on reconnect.</span>';
    el.classList.remove('hide');
    return;
  }
  if (pending > 0) {
    el.className = 'net-status banner-offline';
    el.innerHTML = '<span>⚡ ' + pending + ' sale' + (pending === 1 ? '' : 's') + ' not uploaded to Google Sheet</span><button class="sync-btn" onclick="uploadAll()">Upload now</button>';
    el.classList.remove('hide');
    return;
  }
  el.className = 'net-status hide';
  el.innerHTML = '';
}

window.addEventListener('online', () => { updateNetStatus(); syncPendingSales(); });
window.addEventListener('offline', () => { updateNetStatus(); });
setInterval(() => {
  if (navigator.onLine && getOfflineQueue().length > 0) syncPendingSales();
}, 8000);
setInterval(() => {
  if (navigator.onLine && user) fetchSheetIds();
}, 60000);

// ---- services data ----
const PRESETS=[
 {id:'p1',name:'Haircut',price:300,cat:'Hair',ic:'✂️'},
 {id:'p2',name:'Hair Wash & Style',price:200,cat:'Hair',ic:'💇'},
 {id:'p3',name:'Hair Colour',price:1200,cat:'Hair',ic:'🎨'},
 {id:'p4',name:'Shave',price:100,cat:'Grooming',ic:'🪒'},
 {id:'p5',name:'Beard Trim',price:150,cat:'Grooming',ic:'🧔'},
 {id:'p6',name:'Spa',price:1500,cat:'Spa',ic:'🧖'},
 {id:'p7',name:'Body Massage',price:1800,cat:'Spa',ic:'💆'},
 {id:'p8',name:'Facial',price:900,cat:'Skin',ic:'✨'},
 {id:'p9',name:'Manicure',price:500,cat:'Nails',ic:'💅'}
];
function normSale(s) {
  if (!s) return null;
  let items = s.items;
  if (!items || !Array.isArray(items) || items.length === 0) {
    if (s.services) {
      items = String(s.services).split(',').map(name => ({ name: name.trim(), qty: 1, price: 0 }));
    } else if (s.service) {
      items = [{ name: s.service, cat: s.cat, price: s.price || s.total, qty: s.qty || 1 }];
    } else {
      items = [{ name: 'Service', qty: 1, price: Number(s.total) || 0 }];
    }
  }
  return {
    ...s,
    id: String(s.id),
    items,
    services: s.services || items.map(i => i.name + (i.qty > 1 ? ' ×' + i.qty : '')).join(', '),
    by: s.by || (s.member ? s.member.toLowerCase() : '') || 'admin',
    byName: s.byName || s.member || s.by || '',
    calc: Number(s.calc != null ? s.calc : s.total) || 0,
    total: Number(s.total) || 0,
    pay: s.pay || 'Cash',
    date: s.date || today(),
    note: s.note || ''
  };
}
const norm = a => (a || []).map(normSale).filter(Boolean);
let custom=[], sales=[], cat='All', user='', uname='', role='member', dashCharts={};
let allSales=[], teamUsers=[];
const $=id=>document.getElementById(id);
const inr=n=>'₹'+Number(n||0).toLocaleString('en-IN');
const today=()=>new Date().toISOString().slice(0,10);
const all=()=>[...PRESETS,...custom];
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function tab(n){tabN=n;updateCart();
  $('p1').classList.toggle('hide',n!==1);$('p2').classList.toggle('hide',n!==2);$('p3').classList.toggle('hide',n!==3);
  $('t1').classList.toggle('on',n===1);$('t2').classList.toggle('on',n===2);$('t3').classList.toggle('on',n===3);
  if(n===2){renderSales();if(role==='admin')loadAllSales()}
  if(n===3)loadDash();
}
function cats(){return ['All',...new Set(all().map(s=>s.cat))]}
function renderSvc(){
  $('chips').innerHTML=cats().map(c=>`<button class="chip ${c===cat?'on':''}" onclick="setCat('${esc(c)}')">${esc(c)}</button>`).join('');
  const q=$('q').value.toLowerCase();
  const list=all().filter(s=>(cat==='All'||s.cat===cat)&&s.name.toLowerCase().includes(q));
  $('grid').innerHTML=list.map(s=>`
    <div class="svc ${s.custom?'custom':''} ${cart[s.id]?'sel':''}" onclick="addCart('${s.id}')">
      ${cart[s.id]?`<span class="badge">${cart[s.id]}</span>`:''}${s.custom?`<span class="x" onclick="event.stopPropagation();delSvc('${s.id}')">✕</span>`:''}
      <div class="ic">${s.ic||'⭐'}</div><h3>${esc(s.name)}</h3><p>${esc(s.cat)}</p><div class="pr">${inr(s.price)}</div>
    </div>`).join('')+`<div class="svc add" onclick="openSvc()"><div style="font-size:22px;line-height:1">＋</div><p>Add</p></div>`;
}
function setCat(c){cat=c;renderSvc()}

// ---- cart & sale entry ----
let cart={},edited=false,tabN=1;
const calcTotal=()=>Object.entries(cart).reduce((a,[id,q])=>a+(all().find(s=>s.id===id)?.price||0)*q,0);
function addCart(id){cart[id]=(cart[id]||0)+1;renderSvc();updateCart()}
function updateCart(){
  const n=Object.values(cart).reduce((a,b)=>a+b,0);
  $('cN').textContent=n+(n===1?' item':' items');$('cS').textContent=inr(calcTotal());
  $('cartBar').classList.toggle('show',n>0&&tabN===1);
}
function clearCart(){cart={};renderSvc();updateCart()}
function openCheckout(){edited=false;$('cDate').value=today();$('cNote').value='';$('cPay').value='Cash';ckRender();$('mSale').classList.add('show')}
function ckRender(){
  const ids=Object.keys(cart);
  if(!ids.length){closeM('mSale');return}
  $('ckItems').innerHTML=ids.map(id=>{const s=all().find(x=>x.id===id);return `<div class="ci"><div>${esc(s.name)}<small>${inr(s.price)} each</small></div>
   <div class="st"><button onclick="qty('${id}',-1)">−</button><b>${cart[id]}</b><button onclick="qty('${id}',1)">+</button></div></div>`}).join('');
  $('ckCalc').textContent=inr(calcTotal());
  if(!edited)$('cTot').value=calcTotal();
}
function qty(id,d){cart[id]+=d;if(cart[id]<=0)delete cart[id];renderSvc();updateCart();ckRender()}

async function saveSale(){
  const total=+$('cTot').value;
  if($('cTot').value===''||total<0)return alert('Enter a valid total');
  const items=Object.entries(cart).map(([id,q])=>{const s=all().find(x=>x.id===id);return{name:s.name,cat:s.cat,price:s.price,qty:q}});
  const saleObj = {
    id: Date.now(),
    items,
    calc: calcTotal(),
    total,
    pay: $('cPay').value,
    date: $('cDate').value||today(),
    note: $('cNote').value.trim()
  };

  cart={};closeM('mSale');renderSvc();updateCart();

  if (!navigator.onLine) {
    queueOfflineSale(saleObj);
    sales.unshift(saleObj);
    if(role==='admin') allSales.unshift({...saleObj,by:user,byName:uname});
    stats(); updateNetStatus(); renderSales();
    showPrompt('💾 Saved to your device — will upload when online', 'offline');
    return;
  }

  try{
    const sale=await api('/api/sales',{method:'POST',body:saleObj});
    sheetConfirmedIds.add(String(sale.id));
    sheetIdsFetched = true;
    saveCachedConfirmedIds(sheetConfirmedIds);
    sales.unshift(sale);
    if(role==='admin')allSales.unshift({...sale,by:user,byName:uname});
    stats();
    renderSales();
    updateNetStatus();
    showPrompt('✓ Data saved & uploaded to Google Sheet!', 'success');
    syncPendingSales();
    setTimeout(fetchSheetIds, 1500);
  }catch(e){
    if (e.isNetwork || !navigator.onLine) {
      queueOfflineSale(saleObj);
      sales.unshift(saleObj);
      if(role==='admin') allSales.unshift({...saleObj,by:user,byName:uname});
      stats(); updateNetStatus(); renderSales();
      showPrompt('💾 Saved to your device — will upload when online', 'offline');
    } else {
      showPrompt('✕ Error: ' + e.message, 'error', 5000);
    }
  }
}

// ---- custom services ----
function openSvc(){
  $('nName').value='';$('nPrice').value='';$('nCatNew').value='';
  $('nCat').innerHTML=cats().filter(c=>c!=='All').map(c=>`<option>${esc(c)}</option>`).join('');
  $('mSvc').classList.add('show');
}
async function saveSvc(){
  const name=$('nName').value.trim(),price=+$('nPrice').value,c=$('nCatNew').value.trim()||$('nCat').value;
  if(!name||!(price>=0)||$('nPrice').value==='')return alert('Enter name and price');
  if(!c)return alert('Enter a category');
  try{
    const s=await api('/api/services',{method:'POST',body:{name,price,cat:c}});
    custom.push(s);closeM('mSvc');renderSvc();
  }catch(e){alert(e.message)}
}
async function delSvc(id){
  if(!confirm('Remove this service?'))return;
  try{await api('/api/services/'+id,{method:'DELETE'});custom=custom.filter(s=>s.id!==id);renderSvc()}
  catch(e){alert(e.message)}
}

// ---- sales log ----
let showOnlyNotUploaded = false;

function activeSales(){
  if(role!=='admin')return sales;
  const v=$('sm').value;
  return v?allSales.filter(s=>s.by===v):allSales;
}
async function loadAllSales(){
  try{
    const d = await api('/api/admin/sales');
    allSales = norm(d.sales);
    renderSales();
    stats();
  }catch(e){
    console.warn('loadAllSales error:', e.message);
  }
}
function filtered(){
  const q=$('sq').value.toLowerCase(),d=$('sd').value,p=$('sp').value;
  let list = activeSales().filter(s=>(!q||(names(s)+s.note).toLowerCase().includes(q))&&(!d||s.date===d)&&(!p||s.pay===p));
  if (showOnlyNotUploaded) {
    // Include: items in offline queue, items not confirmed in sheet, AND unknowns (not yet checked)
    list = list.filter(s => {
      const st = getUploadStatus(s.id);
      return st === 'not-uploaded' || st === 'unknown';
    });
  }
  return list;
}
const names = s => (s && s.items && Array.isArray(s.items) && s.items.length)
  ? s.items.map(i => (i.name || 'Service') + (i.qty > 1 ? ' ×' + i.qty : '')).join(', ')
  : (s?.services || 'Service');

function getUploadStatus(saleId) {
  if (isInQueue(saleId)) return 'not-uploaded';
  if (sheetIdsFetched) return sheetConfirmedIds.has(String(saleId)) ? 'uploaded' : 'not-uploaded';
  return 'unknown'; // sheet IDs not yet fetched
}

// Count how many entries are not uploaded or unknown
function countPending() {
  return activeSales().filter(s => {
    const st = getUploadStatus(s.id);
    return st === 'not-uploaded' || st === 'unknown';
  }).length;
}

function renderSales(){
  const l = filtered();
  updateSyncBadges();

  $('list').innerHTML = l.length ? l.map(s => {
    const status = getUploadStatus(s.id);
    let statusBtn;
    if (status === 'uploaded') {
      statusBtn = `<button class="upload-tag uploaded" title="Confirmed in Google Sheet — click to re-check" onclick="refreshSheetStatus()">✓ Uploaded</button>`;
    } else if (status === 'not-uploaded') {
      statusBtn = `<button class="upload-tag not-uploaded" title="Not found in Google Sheet — click to upload" onclick="uploadSingle(${s.id})">↑ Not Uploaded</button>`;
    } else {
      // unknown = sheet not yet checked. Show upload button so user can act immediately
      statusBtn = `<button class="upload-tag not-uploaded" title="Upload status unknown — click to upload to Google Sheet" onclick="uploadSingle(${s.id})">↑ Upload to Sheet</button>`;
    }
    return `<div class="item" id="sale-${s.id}"><div><b>${esc(names(s))}</b>
      <small>${s.date} · ${s.pay}${role==='admin'&&s.byName?' · '+esc(s.byName):''}${s.note?' · '+esc(s.note):''}${s.total!==s.calc?' · adjusted from '+inr(s.calc):''}</small>
      <div class="sale-tags">${statusBtn}</div></div>
      <div class="amt">${inr(s.total)}</div>
      <button class="del" onclick="delSale(${s.id})" title="Delete">✕</button></div>`;
  }).join('') : '<div class="empty">No sales found</div>';
  $('ft').textContent = inr(l.reduce((a, s) => a + s.total, 0));
}

async function refreshSheetStatus() {
  showBanner('↻ Checking Google Sheet for upload status…', 'syncing');
  await fetchSheetIds();
}

async function uploadSingle(saleId) {
  // If in offline queue, do a full queue sync
  if (getOfflineQueue().some(x => x.id === saleId)) {
    await syncPendingSales();
    renderSales();
    updateNetStatus();
    return;
  }
  // Disable the button immediately
  const btn = document.querySelector('#sale-' + saleId + ' .upload-tag');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span style="opacity:.6">↑ Uploading…</span>'; }
  try {
    const r = await api('/api/sales/' + saleId + '/upload', { method: 'POST' });
    if (r.ok) {
      sheetConfirmedIds.add(String(saleId));
      showBanner('✓ Entry uploaded to Google Sheet!', 'payment');
    } else {
      showBanner('Upload failed — check sheet connection', 'error');
    }
  } catch (e) {
    showBanner('Upload failed: ' + e.message, 'error');
  }
  renderSales();
  updateNetStatus();
}

// Upload ALL not-uploaded / non-synced entries at once
async function uploadAll() {
  if (isSyncing) return;
  if (!navigator.onLine) {
    showBanner('⚡ Device is offline — connect to internet to upload', 'error');
    return;
  }

  isSyncing = true;
  updateSyncBadges();
  showBanner('↻ Uploading all non-synced data to Google Sheet…', 'syncing');

  let uploadedCount = 0;
  let offlineSyncedCount = 0;

  try {
    // 1. Sync client offline queue first
    const q = getOfflineQueue();
    if (q.length > 0) {
      try {
        const res = await api('/api/sales/sync', { method: 'POST', body: { sales: q } });
        if (res && res.ok) {
          saveOfflineQueue([]);
          offlineSyncedCount = res.synced || q.length;
          if (Array.isArray(res.sales)) {
            sales = norm(res.sales);
            if (role === 'admin') await loadAllSales();
          }
        }
      } catch (err) {
        console.warn('Offline queue sync error:', err);
      }
    }

    // 2. Call server bulk upload endpoint
    try {
      const bulkRes = await api('/api/sales/upload-all', { method: 'POST' });
      if (bulkRes && bulkRes.ok) {
        uploadedCount = (bulkRes.uploaded || 0) + offlineSyncedCount;
        if (Array.isArray(bulkRes.confirmedIds)) {
          sheetConfirmedIds = new Set(bulkRes.confirmedIds.map(String));
          sheetIdsFetched = true;
        }
      } else {
        throw new Error((bulkRes && bulkRes.error) || 'Bulk upload failed');
      }
    } catch (bulkErr) {
      console.warn('Bulk upload fallback to sequential:', bulkErr.message);
      // Fallback: Individual upload if /api/sales/upload-all had an issue
      const allS = activeSales();
      for (const s of allS) {
        const st = getUploadStatus(s.id);
        if (st === 'not-uploaded' || st === 'unknown') {
          if (getOfflineQueue().some(x => x.id === s.id)) continue;
          try {
            const r = await api('/api/sales/' + s.id + '/upload', { method: 'POST' });
            if (r.ok) {
              sheetConfirmedIds.add(String(s.id));
              uploadedCount++;
            }
          } catch {}
        }
      }
      sheetIdsFetched = true;
    }

    // 3. Re-verify sheet IDs from Google Sheet
    await fetchSheetIds();

    if (role === 'admin') {
      await loadAllSales();
    }
    renderSales();
    stats();

    if (uploadedCount > 0) {
      showBanner(`✓ Successfully uploaded ${uploadedCount} entr${uploadedCount === 1 ? 'y' : 'ies'} to Google Sheet!`, 'payment');
    } else {
      showBanner('All data is already synced with Google Sheet ✓', 'synced');
    }
  } catch (err) {
    showBanner('Upload error: ' + err.message, 'error');
  } finally {
    isSyncing = false;
    updateNetStatus();
    renderSales();
  }
}

async function delSale(id){
  if(!confirm('Delete this entry?'))return;
  const s=activeSales().find(x=>x.id===id);
  try{
    if(role==='admin'&&s)await api('/api/admin/sales/'+s.by+'/'+id,{method:'DELETE'});
    else await api('/api/sales/'+id,{method:'DELETE'});
    sales=sales.filter(x=>x.id!==id);
    allSales=allSales.filter(x=>!(x.id===id&&x.by===(s?s.by:user)));
    removeFromOfflineQueue(id);
    sheetConfirmedIds.delete(String(id));
    renderSales();stats()
  }catch(e){alert(e.message)}
}
function clearF(){$('sq').value='';$('sd').value='';$('sp').value='';if(role==='admin')$('sm').value='';showOnlyNotUploaded=false;updateFilterBtn();renderSales()}
function toggleNotUploaded(){
  showOnlyNotUploaded=!showOnlyNotUploaded;
  updateFilterBtn();
  renderSales();
}
function updateFilterBtn(){
  const btn=$('btnNotUploaded');
  if(!btn)return;
  if (showOnlyNotUploaded) {
    btn.classList.add('active');
    btn.innerHTML='✕ Show all entries';
  } else {
    btn.classList.remove('active');
    btn.innerHTML='⚠ Not uploaded only';
  }
}
function stats(){
  const t=today(),m=t.slice(0,7);
  const src = (role === 'admin' && allSales && allSales.length) ? allSales : sales;
  $('sToday').textContent=inr(src.filter(s=>s.date===t).reduce((a,s)=>a+s.total,0));
  $('sMonth').textContent=inr(src.filter(s=>s.date.startsWith(m)).reduce((a,s)=>a+s.total,0));
  $('sCount').textContent=src.filter(s=>s.date===t).length;
}
function exportCSV(){
  const adminView=role==='admin';
  const rows=adminView
    ?[['Date','Member','Services','Calculated','Total','Payment','Notes'],
      ...filtered().map(s=>[s.date,s.byName||s.by||'',names(s),s.calc,s.total,s.pay,s.note])]
    :[['Date','Services','Calculated','Total','Payment','Notes'],
      ...filtered().map(s=>[s.date,names(s),s.calc,s.total,s.pay,s.note])];
  const csv=rows.map(r=>r.map(c=>'"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\n');
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  a.download='sales-'+user+'-'+today()+'.csv';a.click();
}
function closeM(id){$(id).classList.remove('show')}
document.querySelectorAll('.modal').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)m.classList.remove('show')}));

// ---- admin dashboard ----
const fmtAxis=v=>new Intl.NumberFormat('en-IN',{notation:'compact',maximumFractionDigits:1}).format(v);
function mkChart(id,cfg){
  const el=$(id);
  if(dashCharts[id]){dashCharts[id].destroy();delete dashCharts[id]}
  if(typeof Chart==='undefined'||!el)return;
  Chart.defaults.font.family='Inter,system-ui,sans-serif';
  Chart.defaults.color='#8a8780';
  dashCharts[id]=new Chart(el.getContext('2d'),cfg);
}
const tooltipCfg={callbacks:{label:c=>(c.chart.config.options.plugins.doughnut?' ':'')+(c.dataset.label?c.dataset.label+': ':'')+inr(c.parsed.y??c.parsed)}};

async function refreshTeamUsers(){
  try{
    const d=await api('/api/admin/users');
    teamUsers=d.users;
    const sel=$('sm').value;
    $('sm').innerHTML='<option value="">Everyone</option>'+
      teamUsers.map(u=>`<option value="${esc(u.user)}">${esc(u.name)}</option>`).join('');
    $('sm').value=sel;
    const p=teamUsers.filter(u=>u.status==='pending').length;
    $('tBadge').textContent=p;
    $('tBadge').classList.toggle('hide',p===0);
    return teamUsers;
  }catch{return teamUsers}
}

async function loadDash(){
  if(role!=='admin')return;
  const p=new URLSearchParams();
  if($('fFrom').value)p.set('from',$('fFrom').value);
  if($('fTo').value)p.set('to',$('fTo').value);
  if($('fUser').value)p.set('user',$('fUser').value);
  if($('fPay').value)p.set('pay',$('fPay').value);
  try{
    const [d,,st]=await Promise.all([
      api('/api/admin/summary?'+p),
      refreshTeamUsers(),
      api('/api/sync/status')
    ]);
    renderDash(d);
    renderTeam(teamUsers);
    renderSync(st);
  }catch(e){alert(e.message)}
}
function clearDashF(){$('fFrom').value='';$('fTo').value='';$('fUser').value='';$('fPay').value='';loadDash()}

function renderSync(s){
  const el=$('syncBar');
  if(!s.configured){
    el.innerHTML='<span>Google Sheet: <b>not connected</b> — paste your web app URL into <b>config.json</b> (sheetWebappUrl), then restart</span>';
    return;
  }
  el.innerHTML=
    '<span>Google Sheet: <b>connected</b></span>'+
    (s.lastOk?`<span class="pill">last push ${new Date(s.lastOk).toLocaleTimeString()}</span>`:'')+
    (s.queued?`<span class="pill warn">${s.queued} queued</span>`:'')+
    (s.lastError?`<span class="sb-err" title="${esc(s.lastError)}">${esc(s.lastError)}</span>`:'')+
    `<button class="btn ghost" onclick="syncRetry()" ${s.queued?'':'disabled style="opacity:.5"'}>Retry${s.queued?' ('+s.queued+')':''}</button>`+
    '<button class="btn ghost" onclick="syncBackfill()">Sync all records</button>';
}
async function syncRetry(){
  try{renderSync(await api('/api/sync/retry',{method:'POST'}))}
  catch(e){alert(e.message)}
}
async function syncBackfill(){
  if(!confirm('Push every recorded sale to the sheet? Existing rows are not duplicated.'))return;
  try{
    const r=await api('/api/sync/backfill',{method:'POST'});
    alert('Pushed '+r.pushed+' sale'+(r.pushed===1?'':'s')+' to the sheet.');
    renderSync(r);
    setTimeout(fetchSheetIds, 1500);
  }catch(e){alert(e.message)}
}

function renderTeam(list){
  $('teamList').innerHTML=list.length?list.map(u=>{
    const isAdm = u.role === 'admin';
    const isPend = u.status === 'pending';
    const isAct = u.status === 'active';
    const statusBadge = isPend
      ? '<span class="pill warn">Pending approval</span>'
      : (isAct ? '<span class="pill okp">Active</span>' : '<span class="pill sb-err">Inactive</span>');
    const roleBadge = `<span class="pill ${isAdm ? 'okp' : ''}">${isAdm ? 'Admin / Owner' : 'Staff / Worker'}</span>`;
    return `<div class="item"><div><b>${esc(u.name)}</b><small>@${esc(u.user)} · joined ${u.created?u.created.slice(0,10):'—'}</small></div>
    <div style="display:flex;gap:6px;align-items:center">${roleBadge} ${statusBadge}</div>
    <div class="acts2">
      ${isPend?`<button class="btn" onclick="approveUser('${esc(u.user)}')">Approve</button>`:''}
      ${u.user!==user && !isAdm?`<button class="btn ghost" onclick="removeUser('${esc(u.user)}')">Remove</button>`:''}
    </div></div>`;
  }).join('')
  :'<div class="empty">No team members yet</div>';
}
async function syncTeamFromSheet(){
  try{
    const r=await api('/api/admin/sync/team',{method:'POST'});
    teamUsers=r.users;
    renderTeam(teamUsers);
    await refreshTeamUsers();
    alert('Team accounts synced from Google Sheet!');
  }catch(e){alert(e.message)}
}
async function approveUser(u){
  try{await api('/api/admin/users/'+u+'/approve',{method:'POST'});await loadDash()}
  catch(e){alert(e.message)}
}
async function removeUser(u){
  if(!confirm('Remove this team member? Their sales and services will be deleted.'))return;
  try{
    await api('/api/admin/users/'+u,{method:'DELETE'});
    allSales=allSales.filter(s=>s.by!==u);
    await loadDash();renderSales();
  }catch(e){alert(e.message)}
}

function renderDash(d){
  $('dRev').textContent=inr(d.totals.revenue);
  $('dCount').textContent=d.totals.count;
  $('dAvg').textContent=inr(d.totals.avg);
  $('dAct').textContent=d.totals.activeMembers;

  const sel=$('fUser').value;
  $('fUser').innerHTML='<option value="">All members</option>'+
    d.memberOptions.map(m=>`<option value="${esc(m.user)}">${esc(m.name)}</option>`).join('');
  $('fUser').value=sel;

  mkChart('chTrend',{
    type:'line',
    data:{labels:d.trend.map(t=>t.date),datasets:[{
      label:'Revenue',data:d.trend.map(t=>t.total),
      borderColor:'#c8a46a',backgroundColor:'rgba(200,164,106,.15)',fill:true,tension:.3,pointRadius:2
    }]},
    options:{maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:tooltipCfg},
      scales:{y:{beginAtZero:true,ticks:{callback:fmtAxis}},x:{ticks:{maxTicksLimit:10,autoSkip:true}}}}
  });

  const mem=d.members.filter(m=>m.total>0);
  mkChart('chMembers',{
    type:'bar',
    data:{labels:mem.map(m=>m.name),datasets:[{
      label:'Revenue',data:mem.map(m=>m.total),backgroundColor:'#c8a46a',borderRadius:6
    }]},
    options:{indexAxis:'y',maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:tooltipCfg},
      scales:{x:{beginAtZero:true,ticks:{callback:fmtAxis}},y:{grid:{display:false}}}}
  });

  mkChart('chPay',{
    type:'doughnut',
    data:{labels:d.payments.map(p=>p.mode),datasets:[{
      data:d.payments.map(p=>p.total),backgroundColor:['#c8a46a','#1c1c1a','#8a8780'],borderWidth:0
    }]},
    options:{maintainAspectRatio:false,cutout:'65%',plugins:{legend:{position:'bottom'},
      tooltip:{callbacks:{label:c=>c.label+': '+inr(c.parsed)}}}}
  });

  mkChart('chSvc',{
    type:'bar',
    data:{labels:d.services.map(s=>s.name),datasets:[{
      label:'Revenue',data:d.services.map(s=>Math.round(s.total)),backgroundColor:'#1c1c1a',borderRadius:6
    }]},
    options:{maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:tooltipCfg},
      scales:{y:{beginAtZero:true,ticks:{callback:fmtAxis}},x:{grid:{display:false}}}}
  });

  $('mList').innerHTML=d.members.length?d.members.map(m=>`
    <div class="mrow"><div><b>${esc(m.name)}</b><small>${m.count} ${m.count===1?'entry':'entries'}</small></div>
    <div class="amt">${inr(m.total)}</div>
    <div><div class="prog"><i style="width:${Math.min(m.share,100)}%"></i></div><span class="prog-lbl">${m.share}% of revenue</span></div>
    <div style="font-size:12px;color:var(--mute)">${m.count?inr(Math.round(m.total/m.count))+' avg':'—'}</div></div>`).join('')
    :'<div class="empty">No team members yet</div>';
}

// ---- auth ----
let mode='in';
function authMode(m){
  mode=m;
  $('aIn').classList.toggle('on',m==='in');
  $('aUp').classList.toggle('on',m==='up');
  const btn = $('aBtn');
  btn.disabled = false;
  btn.classList.remove('btn-loading');
  btn.textContent=m==='in'?'Log in':'Register Staff Account';
  $('aSub').textContent=m==='in'?'Log in to record sales':'Staff registration';
  if($('aUpNotice')) $('aUpNotice').classList.toggle('hide', m==='in');
  $('aErr').textContent='';
  $('aErr').className='err';
}
async function submitAuth(){
  const btn = $('aBtn');
  const n = $('aUser').value.trim(), pw = $('aPass').value;
  const originalText = mode === 'in' ? 'Log in' : 'Register Staff Account';
  const e = (t, ok) => {
    btn.disabled = false;
    btn.classList.remove('btn-loading');
    btn.textContent = originalText;
    $('aErr').textContent = t;
    $('aErr').className = ok ? 'err ok' : 'err shake';
  };

  if (n.length < 3 || pw.length < 4) return e('Username: min 3 characters. Password: min 4.');
  if (!/^[a-z0-9_.-]+$/.test(n)) return e('Username: letters, numbers, . _ - only');

  btn.disabled = true;
  btn.classList.add('btn-loading');
  btn.innerHTML = `<span class="btn-spinner"></span><span>${mode === 'in' ? 'Logging in…' : 'Creating account…'}</span>`;
  $('aErr').textContent = '';
  $('aErr').className = 'err';

  try {
    const r = await api('/api/auth/' + (mode === 'up' ? 'signup' : 'login'), {
      method: 'POST',
      body: { username: n, password: pw }
    });

    if (r.pending) {
      btn.disabled = false;
      btn.classList.remove('btn-loading');
      btn.textContent = originalText;
      authMode('in');
      e('Staff account created — the owner must approve it before you can log in.', true);
      $('aUser').value = n;
      $('aPass').value = '';
      return;
    }

    btn.innerHTML = `<span>✓ Verified</span>`;
    token = r.token;
    localStorage.setItem('token', token);
    setTimeout(() => {
      btn.disabled = false;
      btn.classList.remove('btn-loading');
      btn.textContent = originalText;
      start(r);
    }, 250);
  } catch (err) {
    btn.disabled = false;
    btn.classList.remove('btn-loading');
    btn.textContent = originalText;
    e(err.message);
  }
}
function start(d){
  user=d.user;uname=d.name;role=d.role||'member';custom=d.custom||[];sales=norm(d.sales);allSales=norm(d.sales);cart={};cat='All';
  sheetConfirmedIds = loadCachedConfirmedIds();
  sheetIdsFetched = sheetConfirmedIds.size > 0;
  showOnlyNotUploaded = false;
  $('t3').classList.toggle('hide',role!=='admin');
  $('tBadge').classList.add('hide');
  $('uRole').textContent=role==='admin'?'Owner':'Worker';
  $('uRole').className='tag'+(role==='admin'?'':' w');
  $('sm').classList.toggle('hide',role!=='admin');
  $('sm').value='';
  $('auth').classList.add('hide');$('app').classList.remove('hide');$('uName').textContent=d.name;
  $('aUser').value='';$('aPass').value='';$('aErr').textContent='';$('aErr').className='err';
  tab(1);renderSvc();stats();updateCart();
  updateNetStatus();
  syncPendingSales();
  if(role==='admin'){
    refreshTeamUsers();
    loadAllSales();
  }
  setTimeout(fetchSheetIds, 1500);
}
async function logout(){
  try{await api('/api/auth/logout',{method:'POST'})}catch{}
  token='';localStorage.removeItem('token');user='';role='member';cart={};allSales=[];teamUsers=[];
  sheetConfirmedIds=new Set();sheetIdsFetched=false;showOnlyNotUploaded=false;
  $('t3').classList.add('hide');$('tBadge').classList.add('hide');$('uRole').className='tag hide';
  $('sm').classList.add('hide');$('sm').value='';
  updateCart();
  $('app').classList.add('hide');$('auth').classList.remove('hide');authMode('in');
}
(async function(){
  if(token){
    try{start(await api('/api/bootstrap'));return}
    catch{token='';localStorage.removeItem('token')}
  }
  authMode('in');
})();
