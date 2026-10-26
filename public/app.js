// ---- api client ----
let token = localStorage.getItem('token') || '';
let isLoggingOut = false;

function saveSessionCache(data) {
  try {
    const prev = JSON.parse(localStorage.getItem('cached_session') || '{}');
    const session = {
      user: data?.user || user || prev.user || '',
      name: data?.name || uname || prev.name || '',
      role: data?.role || role || prev.role || 'member',
      status: data?.status || prev.status || 'active',
      shopName: data?.shopName || shopName || prev.shopName || 'Simple Salon',
      services: (data?.services && data.services.length) ? data.services : (services && services.length ? services : (prev.services || [])),
      sales: (data?.sales && Array.isArray(data.sales)) ? data.sales : (sales && sales.length ? sales : (prev.sales || []))
    };
    if (session.user) {
      localStorage.setItem('cached_session', JSON.stringify(session));
    }
  } catch {}
}

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
    if (!res.ok) {
      const err = new Error(data.error || 'Request failed');
      err.status = res.status;
      err.code = data.code;
      if (res.status === 401 && !path.startsWith('/api/auth/login') && !path.startsWith('/api/auth/signup') && !path.startsWith('/api/status')) {
        err.isAuthError = true;
        if (token && !isLoggingOut) {
          logout('Your session has expired. Please log in again.');
        }
      }
      throw err;
    }
    return data;
  } catch (err) {
    if (!navigator.onLine || err.name === 'TypeError' || String(err.message).includes('fetch') || String(err.message).includes('NetworkError')) {
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
const DEFAULT_PRESETS=[
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
let services = [];
try {
  const cached = JSON.parse(localStorage.getItem('cached_services') || '[]');
  if (Array.isArray(cached) && cached.length) services = cached;
} catch {}

async function fetchServices() {
  try {
    const res = await api('/api/services');
    if (res && Array.isArray(res.services) && res.services.length) {
      services = res.services;
      localStorage.setItem('cached_services', JSON.stringify(services));
      renderSvc();
    }
  } catch {}
}
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
let shopName = 'Simple Salon';
let salesDateFilter = 'today';

function applyShopName(name) {
  shopName = name || 'Simple Salon';
  document.title = `${shopName} - Sales Book`;
  const brandEl = $('brandShopName');
  if (brandEl) brandEl.textContent = shopName;
  const editBtn = $('btnEditShop');
  if (editBtn) editBtn.classList.toggle('hide', role !== 'admin');
}

function openEditShopModal() {
  if (role !== 'admin') {
    showPrompt('🔒 Only owner/admin can change shop name', 'error', 3000);
    return;
  }
  const inp = $('shopNameInput');
  if (inp) inp.value = shopName;
  $('mShopName').classList.add('show');
  setTimeout(() => {
    if (inp) { inp.focus(); inp.select(); }
  }, 100);
}

async function saveShopName() {
  const inp = $('shopNameInput');
  if (!inp) return;
  const newName = inp.value.trim();
  if (!newName || newName.length < 2) {
    alert('Please enter a shop name (at least 2 characters)');
    return;
  }
  const btn = $('btnSaveShopName');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Saving…';
  }
  try {
    const res = await api('/api/admin/settings', {
      method: 'PUT',
      body: { shopName: newName }
    });
    if (res && res.ok) {
      applyShopName(res.shopName || newName);
      saveSessionCache({ shopName: res.shopName || newName });
      closeM('mShopName');
      showPrompt(`✓ Shop name updated to "${res.shopName || newName}"!`, 'success', 3500);
    }
  } catch (err) {
    alert('Failed to update shop name: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Save Shop Name';
    }
  }
}
const $=id=>document.getElementById(id);
const inr=n=>'₹'+Number(n||0).toLocaleString('en-IN');
const today=()=>{
  const d=new Date();
  const year=d.getFullYear();
  const month=String(d.getMonth()+1).padStart(2,'0');
  const day=String(d.getDate()).padStart(2,'0');
  return `${year}-${month}-${day}`;
};
const all=()=>(services && services.length) ? services : DEFAULT_PRESETS;
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function tab(n){tabN=n;updateCart();
  $('p1').classList.toggle('hide',n!==1);$('p2').classList.toggle('hide',n!==2);$('p3').classList.toggle('hide',n!==3);
  $('t1').classList.toggle('on',n===1);$('t2').classList.toggle('on',n===2);$('t3').classList.toggle('on',n===3);
  if(n===2){renderSales();if(role==='admin')loadAllSales()}
  if(n===3)loadDash();
}
function cats(){return ['All',...new Set(all().map(s=>s.cat))]}

// ---- service holding gesture detection ----
let holdTimeout = null;
let holdTriggered = false;
let holdStartX = 0;
let holdStartY = 0;
let activeHoldEl = null;

function clearHold() {
  if (holdTimeout) {
    clearTimeout(holdTimeout);
    holdTimeout = null;
  }
  if (activeHoldEl) {
    activeHoldEl.classList.remove('holding');
    activeHoldEl = null;
  }
}

function initServiceHoldGestures() {
  const grid = $('grid');
  if (!grid || grid._holdInit) return;
  grid._holdInit = true;

  grid.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.x') || e.target.closest('.add')) return;
    const card = e.target.closest('.svc');
    if (!card || !card.dataset.id) return;

    holdTriggered = false;
    holdStartX = e.clientX;
    holdStartY = e.clientY;
    activeHoldEl = card;
    card.classList.add('holding');

    holdTimeout = setTimeout(() => {
      holdTriggered = true;
      if (activeHoldEl) activeHoldEl.classList.remove('holding');
      if (navigator.vibrate) {
        try { navigator.vibrate(45); } catch {}
      }
      handleServiceHold(card.dataset.id);
    }, 550);
  });

  grid.addEventListener('pointermove', (e) => {
    if (!holdTimeout) return;
    const dx = Math.abs(e.clientX - holdStartX);
    const dy = Math.abs(e.clientY - holdStartY);
    if (dx > 10 || dy > 10) {
      clearHold();
    }
  });

  grid.addEventListener('pointerup', clearHold);
  grid.addEventListener('pointercancel', clearHold);
  grid.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.svc');
    if (card && !card.classList.contains('add')) {
      e.preventDefault();
    }
  });
}

function handleServiceHold(id) {
  if (role !== 'admin') {
    showPrompt('🔒 Only owner/admin can edit services', 'error', 3000);
    return;
  }
  openEditSvc(id);
}

function onSvcClick(event, id) {
  if (holdTriggered) {
    holdTriggered = false;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  addCart(id);
}

function renderSvc(){
  $('chips').innerHTML=cats().map(c=>`<button class="chip ${c===cat?'on':''}" onclick="setCat('${esc(c)}')">${esc(c)}</button>`).join('');
  const q=$('q').value.toLowerCase();
  const list=all().filter(s=>(cat==='All'||s.cat===cat)&&s.name.toLowerCase().includes(q));
  $('grid').innerHTML=list.map(s=>`
    <div class="svc ${cart[s.id]?'sel':''}" data-id="${s.id}" onclick="onSvcClick(event, '${s.id}')" title="${role==='admin'?'Tap to add • Hold to edit':'Tap to add'}">
      ${cart[s.id]?`<span class="badge">${cart[s.id]}</span>`:''}
      ${role==='admin'?`<span class="x" onclick="event.stopPropagation();delSvc('${s.id}')" title="Delete service">✕</span>`:''}
      <div class="ic">${s.ic||'⭐'}</div><h3>${esc(s.name)}</h3><p>${esc(s.cat)}</p><div class="pr">${inr(s.price)}</div>
      ${role==='admin'?'<span class="svc-hold-hint">hold to edit</span>':''}
    </div>`).join('')+`<div class="svc add" onclick="openSvc()"><div style="font-size:22px;line-height:1">＋</div><p>Add</p></div>`;
  initServiceHoldGestures();
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
  if (n === 0 && $('mSale') && $('mSale').classList.contains('show')) {
    closeM('mSale');
  }
}
function clearCart(){cart={};renderSvc();updateCart()}

function setPayMode(m) {
  $('cPay').value = m;
  ['Cash', 'UPI', 'Pending'].forEach(id => {
    const el = $('btnPay' + id);
    if (el) el.classList.toggle('on', id === m);
  });
}

function openCheckout(){
  const ids = Object.keys(cart);
  if (!ids.length) return;
  edited=false;
  $('cDate').value=today();
  $('cNote').value='';
  setPayMode('Cash');
  ckRender();
  $('mSale').classList.add('show');
  try {
    history.pushState({ modal: 'checkout' }, '');
  } catch {}
}

function handleCheckoutBack() {
  if (history.state && history.state.modal === 'checkout') {
    history.back();
  } else {
    closeM('mSale');
  }
}

window.addEventListener('popstate', (e) => {
  if ($('mSale') && $('mSale').classList.contains('show')) {
    closeM('mSale');
  }
  if ($('mEditSvc') && $('mEditSvc').classList.contains('show')) {
    closeM('mEditSvc');
  }
  if ($('mSvc') && $('mSvc').classList.contains('show')) {
    closeM('mSvc');
  }
  if ($('mShare') && $('mShare').classList.contains('show')) {
    closeM('mShare');
  }
  if ($('mShopName') && $('mShopName').classList.contains('show')) {
    closeM('mShopName');
  }
});

function ckRender(){
  const ids=Object.keys(cart);
  if(!ids.length){
    if (history.state && history.state.modal === 'checkout') {
      try { history.replaceState(null, ''); } catch {}
    }
    closeM('mSale');
    return;
  }
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

  cart={};
  closeM('mSale');
  if (history.state && history.state.modal === 'checkout') {
    try { history.replaceState(null, ''); } catch {}
  }
  renderSvc();
  updateCart();

  if (!navigator.onLine) {
    queueOfflineSale(saleObj);
    sales.unshift(saleObj);
    if(role==='admin') allSales.unshift({...saleObj,by:user,byName:uname});
    stats(); updateNetStatus(); renderSales();
    saveSessionCache();
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
    saveSessionCache();
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
      saveSessionCache();
      showPrompt('💾 Saved to your device — will upload when online', 'offline');
    } else {
      showPrompt('✕ Error: ' + e.message, 'error', 5000);
    }
  }
}

// ---- services synced with Google Sheet ----
function openSvc(){
  $('nName').value='';$('nPrice').value='';$('nCatNew').value='';$('nIc').value='⭐';
  $('nCat').innerHTML=cats().filter(c=>c!=='All').map(c=>`<option>${esc(c)}</option>`).join('');
  // Always reset button to clean state when modal opens
  const btn=$('btnSaveSvc'), cancelBtn=$('btnCancelSvc');
  if(btn){ btn.removeAttribute('disabled'); btn.classList.remove('svc-btn-loading'); btn.innerHTML='<span class="svc-btn-text">Add service</span>'; }
  if(cancelBtn) cancelBtn.removeAttribute('disabled');
  $('mSvc').classList.add('show');
}
async function saveSvc(){
  const name=$('nName').value.trim(),price=+$('nPrice').value,c=$('nCatNew').value.trim()||$('nCat').value,ic=$('nIc').value.trim()||'⭐';
  if(!name||!(price>=0)||$('nPrice').value==='')return alert('Enter name and price');
  if(!c)return alert('Enter a category');
  const btn=$('btnSaveSvc'), cancelBtn=$('btnCancelSvc');
  // Instantly lock the button using native disabled attribute
  btn.setAttribute('disabled','');
  btn.classList.add('svc-btn-loading');
  btn.innerHTML='<span class="svc-spinner"></span><span class="svc-btn-text">Adding…</span>';
  if(cancelBtn) cancelBtn.setAttribute('disabled','');
  // Yield to browser to paint the new state BEFORE starting the network call
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  try{
    const s=await api('/api/services',{method:'POST',body:{name,price,cat:c,ic}});
    services.push(s);
    localStorage.setItem('cached_services', JSON.stringify(services));
    closeM('mSvc');
    renderSvc();
    showPrompt('✓ Service added and synced with Google Sheet!', 'success');
  }catch(e){
    // Re-enable so user can retry
    btn.removeAttribute('disabled');
    btn.classList.remove('svc-btn-loading');
    btn.innerHTML='<span class="svc-btn-text">Add service</span>';
    if(cancelBtn) cancelBtn.removeAttribute('disabled');
    showPrompt('✕ Error: '+e.message, 'error', 5000);
  }
}
async function delSvc(id){
  if(!confirm('Remove this service from all devices?'))return;
  try{
    await api('/api/services/'+id,{method:'DELETE'});
    services=services.filter(s=>String(s.id)!==String(id));
    localStorage.setItem('cached_services', JSON.stringify(services));
    renderSvc();
  }catch(e){alert(e.message)}
}

// ---- edit service (Admin only with Google Sheet audit log) ----
function openEditSvc(id) {
  const s = all().find(x => String(x.id) === String(id));
  if (!s) return;
  $('eId').value = s.id;
  $('eName').value = s.name || '';
  $('ePrice').value = s.price != null ? s.price : '';
  $('eCatNew').value = '';
  $('eIc').value = s.ic || '⭐';
  $('eCat').innerHTML = cats().filter(c => c !== 'All').map(c =>
    `<option value="${esc(c)}" ${c === s.cat ? 'selected' : ''}>${esc(c)}</option>`
  ).join('');
  if (s.lastAudit || s.auditLog) {
    $('eAuditInfo').classList.remove('hide');
    $('eAuditText').textContent = s.lastAudit || String(s.auditLog).split('|')[0].trim();
  } else {
    $('eAuditInfo').classList.add('hide');
  }
  const btn = $('btnSaveEditSvc'), cancelBtn = $('btnCancelEditSvc');
  if (btn) {
    btn.removeAttribute('disabled');
    btn.classList.remove('svc-btn-loading');
    btn.innerHTML = '<span class="svc-btn-text">Save changes</span>';
  }
  if (cancelBtn) cancelBtn.removeAttribute('disabled');
  $('mEditSvc').classList.add('show');
}

async function saveEditSvc() {
  const id = $('eId').value;
  const name = $('eName').value.trim();
  const price = +$('ePrice').value;
  const cat = $('eCatNew').value.trim() || $('eCat').value;
  const ic = $('eIc').value.trim() || '⭐';

  if (!name || $('ePrice').value === '' || !(price >= 0)) return alert('Enter valid name and price');
  if (!cat) return alert('Enter a category');

  const btn = $('btnSaveEditSvc'), cancelBtn = $('btnCancelEditSvc');
  btn.setAttribute('disabled', '');
  btn.classList.add('svc-btn-loading');
  btn.innerHTML = '<span class="svc-spinner"></span><span class="svc-btn-text">Saving…</span>';
  if (cancelBtn) cancelBtn.setAttribute('disabled', '');

  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  try {
    const res = await api('/api/services/' + encodeURIComponent(id), {
      method: 'PUT',
      body: { name, price, cat, ic }
    });
    if (res && res.service) {
      const idx = services.findIndex(x => String(x.id) === String(id));
      if (idx !== -1) {
        services[idx] = res.service;
      } else {
        services.push(res.service);
      }
      localStorage.setItem('cached_services', JSON.stringify(services));
      closeM('mEditSvc');
      renderSvc();
      showPrompt('✓ Service updated & audited in Google Sheet!', 'success');
    }
  } catch (e) {
    btn.removeAttribute('disabled');
    btn.classList.remove('svc-btn-loading');
    btn.innerHTML = '<span class="svc-btn-text">Save changes</span>';
    if (cancelBtn) cancelBtn.removeAttribute('disabled');
    showPrompt('✕ Error: ' + e.message, 'error', 5000);
  }
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
function getActiveSalesFilterDate() {
  if (salesDateFilter === 'today') return today();
  if (salesDateFilter === 'yesterday') return getYesterday();
  if (salesDateFilter === 'custom') return $('sd') ? $('sd').value : '';
  return '';
}

function setSalesDateFilter(mode) {
  salesDateFilter = mode;
  const btnToday = $('btnSalesToday');
  const btnYesterday = $('btnSalesYesterday');
  const btnCustom = $('btnSalesCustom');
  const customBox = $('salesCustomDateBox');

  if (btnToday) btnToday.classList.toggle('on', mode === 'today');
  if (btnYesterday) btnYesterday.classList.toggle('on', mode === 'yesterday');
  if (btnCustom) btnCustom.classList.toggle('on', mode === 'custom');

  if (customBox) {
    if (mode === 'custom') {
      customBox.classList.remove('hide');
      if ($('sd') && !$('sd').value) {
        $('sd').value = today();
      }
    } else {
      customBox.classList.add('hide');
    }
  }
  renderSales();
}

function filtered(){
  const q=$('sq').value.toLowerCase(),d=getActiveSalesFilterDate(),p=$('sp').value;
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
      <small>${s.date} · <span class="${s.pay==='Pending'?'pill warn':''}">${s.pay}</span>${role==='admin'&&s.byName?' · '+esc(s.byName):''}${s.note?' · '+esc(s.note):''}${s.total!==s.calc?' · adjusted from '+inr(s.calc):''}</small>
      <div class="sale-tags">
        ${statusBtn}
        <button type="button" class="sale-invoice-btn wa" onclick="shareSingleSaleWhatsApp(${s.id})" title="Share this sale Invoice on WhatsApp">
          <span class="wa-ico">💬</span> Invoice
        </button>
        <button type="button" class="sale-invoice-btn share" onclick="shareSingleSaleAnywhere(${s.id})" title="Share or Download this sale Invoice PDF">
          <span>📤</span> PDF
        </button>
      </div></div>
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
    renderSales();stats();
    saveSessionCache();
  }catch(e){alert(e.message)}
}
function clearF(){
  $('sq').value='';
  if ($('sd')) $('sd').value='';
  $('sp').value='';
  if(role==='admin')$('sm').value='';
  showOnlyNotUploaded=false;
  salesDateFilter = 'today';
  const btnToday = $('btnSalesToday');
  const btnYesterday = $('btnSalesYesterday');
  const btnCustom = $('btnSalesCustom');
  const customBox = $('salesCustomDateBox');
  if (btnToday) btnToday.classList.add('on');
  if (btnYesterday) btnYesterday.classList.remove('on');
  if (btnCustom) btnCustom.classList.remove('on');
  if (customBox) customBox.classList.add('hide');
  updateFilterBtn();
  renderSales();
}
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
    ?[['Date','Team','Services','Calculated','Total','Payment','Notes'],
      ...filtered().map(s=>[s.date,s.byName||s.by||'',names(s),s.calc,s.total,s.pay,s.note])]
    :[['Date','Services','Calculated','Total','Payment','Notes'],
      ...filtered().map(s=>[s.date,names(s),s.calc,s.total,s.pay,s.note])];
  const csv=rows.map(r=>r.map(c=>'"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\n');
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  const safeName = (shopName || 'Simple_Salon').replace(/[^a-zA-Z0-9_-]/g, '_');
  a.download=`${safeName}_sales_${user}_${today()}.csv`;
  a.click();
}

// ---- WhatsApp & PDF Sales Report ----
let currentSharePeriod = 'today';

function getYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateDisplay(dStr) {
  if (!dStr) return '';
  const parts = dStr.split('-');
  if (parts.length !== 3) return dStr;
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function getSelectedShareRange() {
  const t = today();
  const y = getYesterday();
  if (currentSharePeriod === 'today') {
    return { from: t, to: t, label: `Today (${formatDateDisplay(t)})` };
  }
  if (currentSharePeriod === 'yesterday') {
    return { from: y, to: y, label: `Yesterday (${formatDateDisplay(y)})` };
  }
  const f = $('shareFrom')?.value || t;
  const to = $('shareTo')?.value || f;
  const label = f === to
    ? `Custom (${formatDateDisplay(f)})`
    : `Custom (${formatDateDisplay(f)} to ${formatDateDisplay(to)})`;
  return { from: f, to: to, label };
}

function selectPeriod(period) {
  currentSharePeriod = period;
  ['today', 'yesterday', 'custom'].forEach(p => {
    const el = $('pill' + p.charAt(0).toUpperCase() + p.slice(1));
    if (el) el.classList.toggle('on', p === period);
  });
  const customBox = $('customDateRange');
  if (customBox) {
    customBox.classList.toggle('hide', period !== 'custom');
  }
  updateSharePreview();
}

function openShareModal() {
  const t = today();
  if ($('shareFrom')) $('shareFrom').value = t;
  if ($('shareTo')) $('shareTo').value = t;
  selectPeriod('today');
  $('mShare').classList.add('show');
}

function getReportSales() {
  const { from, to } = getSelectedShareRange();
  const src = (role === 'admin' && allSales && allSales.length) ? allSales : sales;
  const memberFilter = ($('sm') && $('sm').value) ? $('sm').value : '';
  let list = (role === 'admin' && memberFilter) ? src.filter(s => s.by === memberFilter) : src;
  return list.filter(s => s.date >= from && s.date <= to);
}

function updateSharePreview() {
  const { label } = getSelectedShareRange();
  const list = getReportSales();
  const totalRev = list.reduce((a, s) => a + (Number(s.total) || 0), 0);
  const count = list.length;
  const cash = list.filter(s => s.pay === 'Cash').reduce((a, s) => a + (Number(s.total) || 0), 0);
  const upi = list.filter(s => s.pay === 'UPI').reduce((a, s) => a + (Number(s.total) || 0), 0);
  const pending = list.filter(s => s.pay === 'Pending').reduce((a, s) => a + (Number(s.total) || 0), 0);

  if ($('spPeriodLabel')) $('spPeriodLabel').textContent = label;
  if ($('spCount')) $('spCount').textContent = `${count} ${count === 1 ? 'sale' : 'sales'}`;
  if ($('spTotal')) $('spTotal').textContent = inr(totalRev);
  if ($('spCash')) $('spCash').textContent = inr(cash);
  if ($('spUPI')) $('spUPI').textContent = inr(upi);
  if ($('spPending')) $('spPending').textContent = inr(pending);
}

async function generateSalesPDF(options = {}) {
  const jspdfModule = window.jspdf;
  if (!jspdfModule || !jspdfModule.jsPDF) {
    throw new Error('PDF generator library is still loading, please try again in a few moments');
  }
  const { jsPDF } = jspdfModule;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  let list = options.list;
  let label = options.label;

  if (!list) {
    list = getReportSales();
    label = getSelectedShareRange().label;
  }

  const totalRev = list.reduce((a, s) => a + (Number(s.total) || 0), 0);
  const count = list.length;
  const cash = list.filter(s => s.pay === 'Cash').reduce((a, s) => a + (Number(s.total) || 0), 0);
  const upi = list.filter(s => s.pay === 'UPI').reduce((a, s) => a + (Number(s.total) || 0), 0);
  const pending = list.filter(s => s.pay === 'Pending').reduce((a, s) => a + (Number(s.total) || 0), 0);

  const activeShopTitle = (shopName || 'Simple Salon').toUpperCase();

  // Top luxury banner
  doc.setFillColor(22, 22, 20);
  doc.rect(0, 0, 210, 32, 'F');
  doc.setFillColor(197, 159, 96);
  doc.rect(0, 32, 210, 2, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(255, 255, 255);
  doc.text(activeShopTitle, 14, 15);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(216, 180, 110);
  doc.text('INVOICE', 14, 23);

  const printTime = new Date().toLocaleString('en-IN', { hour12: true });
  doc.setFontSize(8);
  doc.setTextColor(200, 200, 200);
  doc.text(`Team: ${uname || user || 'Team'} (${role === 'admin' ? 'Owner' : 'Team'})`, 196, 15, { align: 'right' });
  doc.text(`Printed: ${printTime}`, 196, 22, { align: 'right' });

  // Period header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(22, 22, 20);
  doc.text(`Invoice Period: ${label}`, 14, 43);

  // Summary Metrics Row
  const startY = 48;
  const cardW = 43;
  const cardH = 22;

  // 1. Total Revenue Card
  doc.setFillColor(250, 245, 235);
  doc.setDrawColor(216, 180, 110);
  doc.roundedRect(14, startY, cardW, cardH, 2, 2, 'FD');
  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(140, 105, 45);
  doc.text('TOTAL REVENUE', 18, startY + 6);
  doc.setFontSize(12);
  doc.setTextColor(22, 22, 20);
  doc.text(`Rs. ${totalRev.toLocaleString('en-IN')}`, 18, startY + 16);

  // 2. Entries Card
  doc.setFillColor(248, 247, 245);
  doc.setDrawColor(230, 225, 218);
  doc.roundedRect(61, startY, cardW, cardH, 2, 2, 'FD');
  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(120, 120, 120);
  doc.text('TOTAL SALES', 65, startY + 6);
  doc.setFontSize(12);
  doc.setTextColor(22, 22, 20);
  doc.text(`${count} ${count === 1 ? 'sale' : 'sales'}`, 65, startY + 16);

  // 3. Cash & UPI Card
  doc.setFillColor(248, 247, 245);
  doc.setDrawColor(230, 225, 218);
  doc.roundedRect(108, startY, cardW, cardH, 2, 2, 'FD');
  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(22, 101, 52);
  doc.text('CASH & UPI', 112, startY + 6);
  doc.setFontSize(8.5);
  doc.setTextColor(22, 22, 20);
  doc.text(`Cash: Rs. ${cash.toLocaleString('en-IN')}`, 112, startY + 13);
  doc.setTextColor(67, 56, 202);
  doc.text(`UPI: Rs. ${upi.toLocaleString('en-IN')}`, 112, startY + 19);

  // 4. Pending Card
  doc.setFillColor(255, 251, 235);
  doc.setDrawColor(253, 230, 138);
  doc.roundedRect(155, startY, cardW, cardH, 2, 2, 'FD');
  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(180, 83, 9);
  doc.text('PENDING', 159, startY + 6);
  doc.setFontSize(12);
  doc.setTextColor(180, 83, 9);
  doc.text(`Rs. ${pending.toLocaleString('en-IN')}`, 159, startY + 16);

  // Table Data
  const tableData = list.map((s, idx) => {
    const servicesText = (s.items && s.items.length)
      ? s.items.map(i => i.name + (i.qty > 1 ? ` x${i.qty}` : '')).join(', ')
      : (s.services || 'Service');
    const row = [
      String(idx + 1),
      s.date,
      servicesText,
      s.pay || 'Cash',
      `Rs. ${(Number(s.total) || 0).toLocaleString('en-IN')}`,
      s.note || '—'
    ];
    if (role === 'admin') {
      row.splice(2, 0, s.byName || s.by || '—');
    }
    return row;
  });

  const tableHeaders = role === 'admin'
    ? [['#', 'Date', 'Team', 'Services', 'Payment', 'Amount', 'Notes']]
    : [['#', 'Date', 'Services', 'Payment', 'Amount', 'Notes']];

  doc.autoTable({
    startY: 76,
    head: tableHeaders,
    body: tableData.length ? tableData : [['—', '—', 'No sales recorded for this period', '—', 'Rs. 0', '—']],
    theme: 'striped',
    headStyles: {
      fillColor: [22, 22, 20],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 8.5
    },
    bodyStyles: {
      fontSize: 8,
      textColor: [30, 30, 30]
    },
    alternateRowStyles: {
      fillColor: [250, 249, 247]
    },
    styles: {
      cellPadding: 2.8,
      valign: 'middle'
    },
    columnStyles: role === 'admin' ? {
      0: { cellWidth: 10, halign: 'center' },
      1: { cellWidth: 22 },
      2: { cellWidth: 24 },
      3: { cellWidth: 'auto' },
      4: { cellWidth: 20, halign: 'center' },
      5: { cellWidth: 25, halign: 'right', fontStyle: 'bold' },
      6: { cellWidth: 26 }
    } : {
      0: { cellWidth: 10, halign: 'center' },
      1: { cellWidth: 24 },
      2: { cellWidth: 'auto' },
      3: { cellWidth: 24, halign: 'center' },
      4: { cellWidth: 28, halign: 'right', fontStyle: 'bold' },
      5: { cellWidth: 32 }
    },
    didDrawPage: function(data) {
      const pageCount = doc.internal.getNumberOfPages();
      doc.setFontSize(8);
      doc.setTextColor(140, 140, 140);
      doc.text(
        `${shopName} Invoice & Sales Record • Page ${data.pageNumber} of ${pageCount} • Confidential`,
        14,
        290
      );
      doc.setDrawColor(220, 218, 212);
      doc.setLineWidth(0.3);
      doc.line(14, 286, 196, 286);
    }
  });

  return doc;
}

// ---- INDIVIDUAL SALE INVOICE PDF GENERATION & SHARING ----
async function generateSingleSalePDF(sale) {
  const jspdfModule = window.jspdf;
  if (!jspdfModule || !jspdfModule.jsPDF) {
    throw new Error('PDF generator library is still loading, please try again in a few moments');
  }
  const { jsPDF } = jspdfModule;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  const activeShopTitle = (shopName || 'Simple Salon').toUpperCase();
  const invNumber = `INV-${String(sale.id).slice(-6)}`;
  const invDate = formatDateDisplay(sale.date);
  const invTime = new Date(Number(sale.id)).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  const billedBy = sale.byName || sale.by || uname || user || 'Team';
  const payMode = sale.pay || 'Cash';
  const isPending = payMode === 'Pending';

  // 1. Top Luxury Banner
  doc.setFillColor(22, 22, 20);
  doc.rect(0, 0, 210, 36, 'F');
  doc.setFillColor(197, 159, 96);
  doc.rect(0, 36, 210, 2.5, 'F');

  // Shop Name
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(255, 255, 255);
  doc.text(activeShopTitle, 14, 16);

  // Subtitle
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(216, 180, 110);
  doc.text('OFFICIAL INVOICE & RECEIPT', 14, 25);

  // Top Right Info
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(255, 255, 255);
  doc.text(invNumber, 196, 16, { align: 'right' });

  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(200, 200, 200);
  doc.text(`Date: ${invDate} ${invTime}`, 196, 24, { align: 'right' });
  doc.text(`Status: ${isPending ? 'PAYMENT PENDING' : 'PAID'}`, 196, 31, { align: 'right' });

  // 2. Info Cards (Invoice Metadata Box)
  const metaY = 46;
  doc.setFillColor(250, 249, 247);
  doc.setDrawColor(228, 224, 217);
  doc.roundedRect(14, metaY, 182, 26, 2, 2, 'FD');

  // Left Column: Customer & Date
  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(140, 105, 45);
  doc.text('BILLED TO', 19, metaY + 7);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(22, 22, 20);
  doc.text('Customer / Walk-in Guest', 19, metaY + 14);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(110, 110, 110);
  doc.text(`Date: ${invDate} at ${invTime}`, 19, metaY + 20);

  // Middle Column: Team Member
  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(140, 105, 45);
  doc.text('SERVED BY', 85, metaY + 7);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(22, 22, 20);
  doc.text(billedBy, 85, metaY + 14);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(110, 110, 110);
  doc.text('Team Member', 85, metaY + 20);

  // Right Column: Payment Mode
  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(140, 105, 45);
  doc.text('PAYMENT MODE', 145, metaY + 7);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  if (isPending) {
    doc.setTextColor(180, 83, 9);
    doc.text('Pending', 145, metaY + 15);
  } else if (payMode === 'UPI') {
    doc.setTextColor(67, 56, 202);
    doc.text('UPI', 145, metaY + 15);
  } else {
    doc.setTextColor(22, 101, 52);
    doc.text(payMode, 145, metaY + 15);
  }
  doc.setFontSize(7.5);
  doc.setTextColor(120, 120, 120);
  doc.text(isPending ? 'Payment due' : 'Payment received', 145, metaY + 20);

  // 3. Itemized Services Table
  let items = sale.items;
  if (!items || !Array.isArray(items) || items.length === 0) {
    if (sale.services) {
      items = String(sale.services).split(',').map(s => ({ name: s.trim(), qty: 1, price: sale.total }));
    } else {
      items = [{ name: 'Salon Service', qty: 1, price: sale.total }];
    }
  }

  const tableData = items.map((it, idx) => {
    const qty = Number(it.qty) || 1;
    const price = Number(it.price) || 0;
    const itemTotal = qty * price;
    return [
      String(idx + 1),
      it.name || 'Service',
      it.cat || '—',
      String(qty),
      `Rs. ${price.toLocaleString('en-IN')}`,
      `Rs. ${(itemTotal > 0 ? itemTotal : Number(sale.total) || 0).toLocaleString('en-IN')}`
    ];
  });

  doc.autoTable({
    startY: metaY + 32,
    head: [['#', 'Service Description', 'Category', 'Qty', 'Unit Rate', 'Amount']],
    body: tableData,
    theme: 'striped',
    headStyles: {
      fillColor: [22, 22, 20],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 9
    },
    bodyStyles: {
      fontSize: 8.5,
      textColor: [30, 30, 30]
    },
    alternateRowStyles: {
      fillColor: [250, 249, 247]
    },
    styles: {
      cellPadding: 3.2,
      valign: 'middle'
    },
    columnStyles: {
      0: { cellWidth: 10, halign: 'center' },
      1: { cellWidth: 'auto' },
      2: { cellWidth: 32 },
      3: { cellWidth: 16, halign: 'center' },
      4: { cellWidth: 28, halign: 'right' },
      5: { cellWidth: 32, halign: 'right', fontStyle: 'bold' }
    }
  });

  const finalY = doc.lastAutoTable.finalY + 8;

  // 4. Notes & Summary
  if (sale.note) {
    doc.setFillColor(248, 247, 245);
    doc.setDrawColor(228, 224, 217);
    doc.roundedRect(14, finalY, 100, 28, 2, 2, 'FD');
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(140, 105, 45);
    doc.text('CLIENT NOTE:', 18, finalY + 7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(60, 60, 60);
    const splitNote = doc.splitTextToSize(sale.note, 92);
    doc.text(splitNote, 18, finalY + 13);
  } else {
    doc.setFillColor(250, 249, 247);
    doc.setDrawColor(235, 232, 226);
    doc.roundedRect(14, finalY, 100, 28, 2, 2, 'FD');
    doc.setFontSize(8.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(140, 105, 45);
    doc.text('THANK YOU FOR YOUR VISIT!', 18, finalY + 9);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(100, 100, 100);
    doc.text(`We appreciate your trust in ${shopName}.`, 18, finalY + 16);
    doc.text('We look forward to serving you again soon!', 18, finalY + 22);
  }

  // Right Box: Total Payable Amount
  doc.setFillColor(22, 22, 20);
  doc.roundedRect(120, finalY, 76, 28, 2, 2, 'F');
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(216, 180, 110);
  doc.text('TOTAL AMOUNT', 126, finalY + 8);

  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(255, 255, 255);
  doc.text(`Rs. ${(Number(sale.total) || 0).toLocaleString('en-IN')}`, 126, finalY + 18);

  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(180, 180, 180);
  doc.text(`Payment: ${payMode} · ${isPending ? 'Pending' : 'Paid'}`, 126, finalY + 24);

  // 5. Divider and Page Footer
  doc.setDrawColor(220, 218, 212);
  doc.setLineWidth(0.3);
  doc.line(14, 282, 196, 282);

  doc.setFontSize(8);
  doc.setTextColor(140, 140, 140);
  doc.text(
    `${shopName} • Invoice ${invNumber} • Computer Generated Tax Invoice / Bill`,
    14,
    288
  );
  doc.text(
    'Thank You!',
    196,
    288,
    { align: 'right' }
  );

  return doc;
}

async function shareSingleSaleWhatsApp(saleId) {
  const sale = (typeof activeSales === 'function' ? activeSales() : sales).find(s => String(s.id) === String(saleId)) || sales.find(s => String(s.id) === String(saleId));
  if (!sale) return alert('Sale record not found');

  showPrompt('📄 Generating invoice PDF…', 'success', 2000);

  try {
    const doc = await generateSingleSalePDF(sale);
    const pdfBlob = doc.output('blob');
    const safeName = (shopName || 'Simple_Salon').replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `${safeName}_Invoice_${String(sale.id).slice(-6)}.pdf`;
    const pdfFile = new File([pdfBlob], fileName, { type: 'application/pdf' });

    let itemsList = '';
    if (sale.items && Array.isArray(sale.items) && sale.items.length) {
      itemsList = sale.items.map(i => `• ${i.name} (x${i.qty || 1}) - ₹${((i.price || 0) * (i.qty || 1)).toLocaleString('en-IN')}`).join('\n');
    } else {
      itemsList = `• ${sale.services || 'Service'} - ₹${Number(sale.total).toLocaleString('en-IN')}`;
    }

    const waText =
      `✂️ *${(shopName || 'SIMPLE SALON').toUpperCase()} — INVOICE*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🧾 *Invoice #:* INV-${String(sale.id).slice(-6)}\n` +
      `📅 *Date:* ${formatDateDisplay(sale.date)}\n` +
      `👤 *Team:* ${sale.byName || sale.by || uname || user || 'Team'}\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `*Services:*\n` +
      `${itemsList}\n\n` +
      `💰 *Total Amount:* ₹${Number(sale.total).toLocaleString('en-IN')}\n` +
      `💳 *Payment Mode:* ${sale.pay || 'Cash'}\n` +
      (sale.note ? `📝 *Note:* ${sale.note}\n` : '') +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📄 _Official invoice PDF attached._\n` +
      `_Thank you for visiting ${shopName}!_`;

    if (navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
      try {
        await navigator.share({
          files: [pdfFile],
          title: `${shopName} Invoice - INV-${String(sale.id).slice(-6)}`,
          text: waText
        });
        showPrompt('✓ Invoice shared successfully!', 'success');
        return;
      } catch (shareErr) {
        if (shareErr.name === 'AbortError') return;
        console.warn('Web share failed, falling back to WhatsApp link:', shareErr);
      }
    }

    doc.save(fileName);
    const waUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(waText)}`;
    window.open(waUrl, '_blank');
    showPrompt('✓ Invoice PDF downloaded! Opening WhatsApp…', 'success', 5000);
  } catch (err) {
    alert('Failed to generate invoice: ' + err.message);
  }
}

async function shareSingleSaleAnywhere(saleId) {
  const sale = (typeof activeSales === 'function' ? activeSales() : sales).find(s => String(s.id) === String(saleId)) || sales.find(s => String(s.id) === String(saleId));
  if (!sale) return alert('Sale record not found');

  showPrompt('📄 Preparing invoice PDF…', 'success', 2000);

  try {
    const doc = await generateSingleSalePDF(sale);
    const pdfBlob = doc.output('blob');
    const safeName = (shopName || 'Simple_Salon').replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `${safeName}_Invoice_${String(sale.id).slice(-6)}.pdf`;
    const pdfFile = new File([pdfBlob], fileName, { type: 'application/pdf' });

    const shareText =
      `${(shopName || 'Simple Salon').toUpperCase()} Invoice #INV-${String(sale.id).slice(-6)}\n` +
      `Date: ${formatDateDisplay(sale.date)}\n` +
      `Total: ₹${Number(sale.total).toLocaleString('en-IN')}\n` +
      `Payment: ${sale.pay || 'Cash'}\n` +
      `Team: ${sale.byName || sale.by || uname || user || 'Team'}`;

    if (navigator.share) {
      try {
        const payload = {
          title: `${shopName} Invoice - INV-${String(sale.id).slice(-6)}`,
          text: shareText
        };
        if (navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
          payload.files = [pdfFile];
        }
        await navigator.share(payload);
        showPrompt('✓ Invoice shared successfully!', 'success');
        return;
      } catch (shareErr) {
        if (shareErr.name === 'AbortError') return;
        console.warn('navigator.share rejected/failed:', shareErr);
      }
    }

    doc.save(fileName);
    showPrompt('✓ Invoice PDF downloaded! You can share it to any app or email.', 'success', 5000);
  } catch (err) {
    alert('Failed to generate invoice: ' + err.message);
  }
}

function getCurrentSalesShareInfo() {
  const list = filtered();
  let label = '';
  let dateSlug = '';
  if (salesDateFilter === 'today') {
    label = `Today (${formatDateDisplay(today())})`;
    dateSlug = today();
  } else if (salesDateFilter === 'yesterday') {
    label = `Yesterday (${formatDateDisplay(getYesterday())})`;
    dateSlug = getYesterday();
  } else {
    const d = $('sd')?.value || today();
    label = `Custom (${formatDateDisplay(d)})`;
    dateSlug = d;
  }
  return { list, label, dateSlug };
}

async function shareCurrentSalesWhatsApp() {
  const { list, label, dateSlug } = getCurrentSalesShareInfo();
  const totalRev = list.reduce((a, s) => a + (Number(s.total) || 0), 0);
  const count = list.length;
  const cash = list.filter(s => s.pay === 'Cash').reduce((a, s) => a + (Number(s.total) || 0), 0);
  const upi = list.filter(s => s.pay === 'UPI').reduce((a, s) => a + (Number(s.total) || 0), 0);
  const pending = list.filter(s => s.pay === 'Pending').reduce((a, s) => a + (Number(s.total) || 0), 0);

  showPrompt('📄 Generating Invoice PDF…', 'success', 2000);

  try {
    const doc = await generateSalesPDF({ list, label });
    const pdfBlob = doc.output('blob');
    const safeName = (shopName || 'Simple_Salon').replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `${safeName}_Invoice_${dateSlug}.pdf`;
    const pdfFile = new File([pdfBlob], fileName, { type: 'application/pdf' });

    const waText =
      `✂️ *${(shopName || 'SIMPLE SALON').toUpperCase()} — INVOICE*\n` +
      `📅 *Period:* ${label}\n` +
      `👤 *Team:* ${uname || user || 'Team'} (${role === 'admin' ? 'Owner' : 'Team'})\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `💰 *Total Revenue:* ₹${totalRev.toLocaleString('en-IN')}\n` +
      `🧾 *Total Entries:* ${count} ${count === 1 ? 'sale' : 'sales'}\n\n` +
      `*Payment Breakdown:*\n` +
      `💵 Cash: ₹${cash.toLocaleString('en-IN')}\n` +
      `📱 UPI: ₹${upi.toLocaleString('en-IN')}\n` +
      `⏳ Pending: ₹${pending.toLocaleString('en-IN')}\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📄 _PDF invoice attached._`;

    if (navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
      try {
        await navigator.share({
          files: [pdfFile],
          title: `${shopName} Invoice - ${label}`,
          text: waText
        });
        showPrompt('✓ Invoice shared successfully!', 'success');
        return;
      } catch (shareErr) {
        if (shareErr.name === 'AbortError') return;
        console.warn('Web share failed, falling back:', shareErr);
      }
    }

    doc.save(fileName);
    const waUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(waText)}`;
    window.open(waUrl, '_blank');
    showPrompt('✓ Invoice PDF downloaded! Opening WhatsApp to share summary…', 'success', 5000);
  } catch (err) {
    alert('Failed to share report: ' + err.message);
  }
}

async function shareCurrentSalesAnywhere() {
  const { list, label, dateSlug } = getCurrentSalesShareInfo();
  const totalRev = list.reduce((a, s) => a + (Number(s.total) || 0), 0);
  const count = list.length;
  const cash = list.filter(s => s.pay === 'Cash').reduce((a, s) => a + (Number(s.total) || 0), 0);
  const upi = list.filter(s => s.pay === 'UPI').reduce((a, s) => a + (Number(s.total) || 0), 0);
  const pending = list.filter(s => s.pay === 'Pending').reduce((a, s) => a + (Number(s.total) || 0), 0);

  showPrompt('📄 Preparing Invoice PDF for sharing…', 'success', 2000);

  try {
    const doc = await generateSalesPDF({ list, label });
    const pdfBlob = doc.output('blob');
    const safeName = (shopName || 'Simple_Salon').replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `${safeName}_Invoice_${dateSlug}.pdf`;
    const pdfFile = new File([pdfBlob], fileName, { type: 'application/pdf' });

    const shareText =
      `${(shopName || 'Simple Salon').toUpperCase()} Invoice\n` +
      `Period: ${label}\n` +
      `Total: ₹${totalRev.toLocaleString('en-IN')} (${count} entries)\n` +
      `Cash: ₹${cash.toLocaleString('en-IN')} | UPI: ₹${upi.toLocaleString('en-IN')} | Pending: ₹${pending.toLocaleString('en-IN')}`;

    if (navigator.share) {
      try {
        const sharePayload = {
          title: `${shopName} Invoice - ${label}`,
          text: shareText
        };
        if (navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
          sharePayload.files = [pdfFile];
        }
        await navigator.share(sharePayload);
        showPrompt('✓ Shared successfully!', 'success');
        return;
      } catch (shareErr) {
        if (shareErr.name === 'AbortError') return;
        console.warn('navigator.share rejected/failed:', shareErr);
      }
    }

    doc.save(fileName);
    showPrompt('✓ Invoice PDF downloaded! You can share it to any app or email.', 'success', 5000);
  } catch (err) {
    alert('Failed to generate report: ' + err.message);
  }
}

async function shareReportWhatsApp() {
  const list = getReportSales();
  const { from, to, label } = getSelectedShareRange();
  const totalRev = list.reduce((a, s) => a + (Number(s.total) || 0), 0);
  const count = list.length;
  const cash = list.filter(s => s.pay === 'Cash').reduce((a, s) => a + (Number(s.total) || 0), 0);
  const upi = list.filter(s => s.pay === 'UPI').reduce((a, s) => a + (Number(s.total) || 0), 0);
  const pending = list.filter(s => s.pay === 'Pending').reduce((a, s) => a + (Number(s.total) || 0), 0);

  const btn = $('btnWaShare');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="svc-spinner"></span> Generating PDF…';
  }

  try {
    const doc = await generateSalesPDF({ list, label });
    const pdfBlob = doc.output('blob');
    const safeName = (shopName || 'Simple_Salon').replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `${safeName}_Invoice_${from === to ? from : `${from}_to_${to}`}.pdf`;
    const pdfFile = new File([pdfBlob], fileName, { type: 'application/pdf' });

    const waText =
      `✂️ *${(shopName || 'SIMPLE SALON').toUpperCase()} — INVOICE*\n` +
      `📅 *Period:* ${label}\n` +
      `👤 *Team:* ${uname || user || 'Team'} (${role === 'admin' ? 'Owner' : 'Team'})\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `💰 *Total Revenue:* ₹${totalRev.toLocaleString('en-IN')}\n` +
      `🧾 *Total Entries:* ${count} ${count === 1 ? 'sale' : 'sales'}\n\n` +
      `*Payment Breakdown:*\n` +
      `💵 Cash: ₹${cash.toLocaleString('en-IN')}\n` +
      `📱 UPI: ₹${upi.toLocaleString('en-IN')}\n` +
      `⏳ Pending: ₹${pending.toLocaleString('en-IN')}\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📄 _PDF invoice attached._`;

    // 1. Native mobile share with PDF file attachment
    if (navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
      try {
        await navigator.share({
          files: [pdfFile],
          title: `${shopName} Invoice - ${label}`,
          text: waText
        });
        showPrompt('✓ Invoice shared successfully!', 'success');
        closeM('mShare');
        return;
      } catch (shareErr) {
        if (shareErr.name === 'AbortError') return;
        console.warn('Web Share file failed, using WhatsApp URL fallback:', shareErr);
      }
    }

    // 2. Desktop / fallback: Download PDF & open WhatsApp Web/App
    doc.save(fileName);
    const waUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(waText)}`;
    window.open(waUrl, '_blank');
    showPrompt('✓ PDF downloaded! Opening WhatsApp to share summary…', 'success', 5000);
    closeM('mShare');
  } catch (err) {
    alert('Failed to generate report: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span class="wa-btn-icon">💬</span> Share on WhatsApp';
    }
  }
}

async function downloadReportPDF() {
  const { from, to, label } = getSelectedShareRange();
  const list = getReportSales();
  const btn = $('btnPdfDownload');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Generating PDF…';
  }
  try {
    const doc = await generateSalesPDF({ list, label });
    const safeName = (shopName || 'Simple_Salon').replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `${safeName}_Invoice_${from === to ? from : `${from}_to_${to}`}.pdf`;
    doc.save(fileName);
    showPrompt('✓ PDF report downloaded!', 'success');
  } catch (err) {
    alert('Download failed: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span>📥</span> Download PDF';
    }
  }
}
function closeM(id){
  $(id).classList.remove('show');
}
document.querySelectorAll('.modal').forEach(m=>m.addEventListener('click',e=>{
  if(e.target===m) {
    if (m.id === 'mSale') {
      handleCheckoutBack();
    } else {
      m.classList.remove('show');
    }
  }
}));

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
    const p=teamUsers.filter(u=>u.status==='deactivated'||u.status==='pending').length;
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
    '<div class="syncbar-info">'+
      '<span><i class="sync-dot"></i>Google Sheet: <b>connected</b></span>'+
      (s.lastOk?`<span class="pill">last push ${new Date(s.lastOk).toLocaleTimeString()}</span>`:'')+
      (s.queued?`<span class="pill warn">${s.queued} queued</span>`:'')+
      (s.lastError?`<span class="sb-err" title="${esc(s.lastError)}">${esc(s.lastError)}</span>`:'')+
    '</div>'+
    '<div class="syncbar-actions">'+
      `<button class="btn ghost" onclick="syncRetry()" ${s.queued?'':'disabled style="opacity:.5"'}>Retry${s.queued?' ('+s.queued+')':''}</button>`+
      '<button class="btn ghost" onclick="syncBackfill()">Sync all records</button>'+
    '</div>';
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
  const pending = (list || []).filter(u => u.status === 'deactivated' || u.status === 'pending');
  const paBox = $('pendingApprovalsBox');
  if (paBox) {
    paBox.classList.toggle('hide', pending.length === 0);
    if ($('paCount')) $('paCount').textContent = pending.length;
    if ($('paList')) {
      $('paList').innerHTML = pending.length ? pending.map(u => `
        <div class="pa-item">
          <div class="pa-info">
            <div class="pa-name"><b>${esc(u.name)}</b> <span class="pill warn" style="font-size:10.5px">Deactivated</span></div>
            <div class="pa-subinfo"><span>👤 ${esc(u.user)}</span> · <span>📅 ${u.created ? u.created.slice(0, 10) : 'Just now'}</span></div>
          </div>
          <div class="pa-actions">
            <button type="button" class="btn btn-sm btn-approve" onclick="approveUser('${esc(u.user)}', '${esc(u.name)}')">✓ Approve</button>
            <button type="button" class="btn ghost btn-sm" onclick="removeUser('${esc(u.user)}')">Reject</button>
          </div>
        </div>
      `).join('') : '';
    }
  }

  $('teamList').innerHTML=list.length?list.map(u=>{
    const isAdm = u.role === 'admin';
    const isDeact = u.status === 'deactivated' || u.status === 'pending';
    const isAct = u.status === 'active';
    const statusBadge = isDeact
      ? '<span class="pill warn">Deactivated (Pending)</span>'
      : (isAct ? '<span class="pill okp">Active</span>' : '<span class="pill sb-err">Inactive</span>');
    const roleBadge = `<span class="pill ${isAdm ? 'okp' : ''}">${isAdm ? 'Admin / Owner' : 'Team Member'}</span>`;
    return `<div class="item"><div><b>${esc(u.name)}</b><small>${esc(u.user)} · joined ${u.created?u.created.slice(0,10):'—'}</small></div>
    <div style="display:flex;gap:6px;align-items:center">${roleBadge} ${statusBadge}</div>
    <div class="acts2">
      ${isDeact?`<button class="btn btn-sm btn-approve" onclick="approveUser('${esc(u.user)}', '${esc(u.name)}')">✓ Approve</button>`:''}
      ${u.user!==user && !isAdm?`<button class="btn ghost btn-sm" onclick="removeUser('${esc(u.user)}')">Remove</button>`:''}
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
async function approveUser(u, displayName){
  try{
    await api('/api/admin/users/'+u+'/approve',{method:'POST'});
    showPrompt('✓ ' + (displayName || u) + ' has been approved! Status is now Active.', 3500);
    await loadDash();
  }catch(e){alert(e.message)}
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

  const payColors = {
    'Cash': '#16a34a',
    'UPI': '#4f46e5',
    'Pending': '#f59e0b',
    'Card': '#8a8780'
  };
  const bgColors = d.payments.map(p => payColors[p.mode] || '#c8a46a');
  mkChart('chPay',{
    type:'doughnut',
    data:{labels:d.payments.map(p=>p.mode),datasets:[{
      data:d.payments.map(p=>p.total),backgroundColor:bgColors,borderWidth:0
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
function togglePassword() {
  const inp = $('aPass');
  const ico = $('passIcon');
  if (!inp) return;
  if (inp.type === 'password') {
    inp.type = 'text';
    if (ico) ico.textContent = '🙈';
  } else {
    inp.type = 'password';
    if (ico) ico.textContent = '👁️';
  }
}

let mode='in';
function authMode(m){
  mode=m;
  $('aIn').classList.toggle('on',m==='in');
  $('aUp').classList.toggle('on',m==='up');
  const btn = $('aBtn');
  btn.disabled = false;
  btn.classList.remove('btn-loading');
  btn.textContent=m==='in'?'Log in':'Register Team Account';
  $('aSub').textContent=m==='in'?'Log in to record sales':'Team member registration';
  if($('aUpNotice')) $('aUpNotice').classList.toggle('hide', m==='in');
  if($('aNameBox')) $('aNameBox').classList.toggle('hide', m==='in');
  $('aErr').textContent='';
  $('aErr').className='err';
  const inp = $('aPass');
  if (inp) inp.type = 'password';
  const ico = $('passIcon');
  if (ico) ico.textContent = '👁️';
}
async function submitAuth(){
  const btn = $('aBtn');
  const name = $('aName') ? $('aName').value.trim() : '';
  const n = $('aUser').value.trim(), pw = $('aPass').value;
  const originalText = mode === 'in' ? 'Log in' : 'Register Team Account';
  const e = (t, ok) => {
    btn.disabled = false;
    btn.classList.remove('btn-loading');
    btn.textContent = originalText;
    $('aErr').textContent = t;
    $('aErr').className = ok ? 'err ok' : 'err shake';
  };

  if (mode === 'up') {
    if (name.length < 2) return e('Please enter your full name (min 2 characters).');
  }
  if (n.length < 3 || pw.length < 4) return e('Username / Email: min 3 characters. Password: min 4.');
  if (!/^[a-z0-9_.@+-]+$/i.test(n)) return e('Username / Email: letters, numbers, @ . _ - + only');

  btn.disabled = true;
  btn.classList.add('btn-loading');
  btn.innerHTML = `<span class="btn-spinner"></span><span>${mode === 'in' ? 'Logging in…' : 'Registering…'}</span>`;
  $('aErr').textContent = '';
  $('aErr').className = 'err';

  try {
    const payload = mode === 'up'
      ? { name, username: n, password: pw }
      : { username: n, password: pw };

    const r = await api('/api/auth/' + (mode === 'up' ? 'signup' : 'login'), {
      method: 'POST',
      body: payload
    });

    if (r.pending || r.deactivated) {
      btn.disabled = false;
      btn.classList.remove('btn-loading');
      btn.textContent = originalText;
      authMode('in');
      e('Team account registered with status Deactivated! The owner must log in and approve your account before you can log in.', true);
      $('aUser').value = n;
      $('aPass').value = '';
      if ($('aName')) $('aName').value = '';
      return;
    }

    btn.innerHTML = `<span>✓ Verified</span>`;
    token = r.token;
    localStorage.setItem('token', token);
    saveSessionCache(r);
    document.documentElement.classList.add('has-auth');
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

function start(d, opts = {}){
  user = d.user;
  uname = d.name;
  role = d.role || 'member';
  applyShopName(d.shopName || shopName);
  custom = d.custom || [];
  sales = norm(d.sales);
  allSales = norm(d.sales);
  if (!opts.fromCache) {
    cart = {};
  }
  cat = 'All';

  if (d.services && Array.isArray(d.services) && d.services.length) {
    services = d.services;
    localStorage.setItem('cached_services', JSON.stringify(services));
  }
  fetchServices();
  sheetConfirmedIds = loadCachedConfirmedIds();
  sheetIdsFetched = sheetConfirmedIds.size > 0;
  showOnlyNotUploaded = false;
  $('t3').classList.toggle('hide', role !== 'admin');
  $('tBadge').classList.add('hide');
  $('uRole').textContent = role === 'admin' ? 'Owner' : 'Team';
  $('uRole').className = 'tag' + (role === 'admin' ? '' : ' w');
  $('sm').classList.toggle('hide', role !== 'admin');
  $('sm').value = '';

  const splash = $('appSplash');
  if (splash) splash.classList.add('hide');
  $('auth').classList.add('hide');
  $('app').classList.remove('hide');
  $('uName').textContent = d.name;
  document.documentElement.classList.add('has-auth');

  $('aUser').value = '';
  $('aPass').value = '';
  if ($('aName')) $('aName').value = '';
  $('aErr').textContent = '';
  $('aErr').className = 'err';

  tab(1);
  renderSvc();
  stats();
  updateCart();
  updateNetStatus();
  syncPendingSales();
  if (role === 'admin') {
    refreshTeamUsers().then(users => {
      const pendingCount = (users || []).filter(u => u.status === 'deactivated' || u.status === 'pending').length;
      if (pendingCount > 0) {
        showPrompt(`🔔 You have ${pendingCount} team approval request${pendingCount > 1 ? 's' : ''} in Dashboard!`, 4500);
      }
    });
    loadAllSales();
  }
  setTimeout(fetchSheetIds, 1500);
  saveSessionCache(d);
}

function applyFreshData(d) {
  uname = d.name || uname;
  role = d.role || role;
  if (d.shopName) applyShopName(d.shopName);
  $('uName').textContent = uname;
  $('uRole').textContent = role === 'admin' ? 'Owner' : 'Team';
  $('uRole').className = 'tag' + (role === 'admin' ? '' : ' w');
  $('t3').classList.toggle('hide', role !== 'admin');
  $('sm').classList.toggle('hide', role !== 'admin');

  if (d.services && Array.isArray(d.services) && d.services.length) {
    services = d.services;
    localStorage.setItem('cached_services', JSON.stringify(services));
    renderSvc();
  }
  if (d.sales && Array.isArray(d.sales)) {
    // Preserve local queued sales that haven't synced yet
    const q = getOfflineQueue();
    const serverIds = new Set(d.sales.map(s => String(s.id)));
    const pendingSales = q.filter(s => !serverIds.has(String(s.id)));
    sales = norm([...pendingSales, ...d.sales]);
    allSales = norm([...pendingSales, ...d.sales]);
    renderSales();
    stats();
  }
  updateNetStatus();
  syncPendingSales();
  if (role === 'admin') {
    refreshTeamUsers();
    loadAllSales();
  }
  setTimeout(fetchSheetIds, 1500);
  saveSessionCache(d);
}

async function logout(message){
  isLoggingOut = true;
  const oldToken = token;
  token = '';
  try {
    localStorage.removeItem('token');
    localStorage.removeItem('cached_session');
  } catch {}
  document.documentElement.classList.remove('has-auth');

  user = '';
  uname = '';
  role = 'member';
  cart = {};
  allSales = [];
  teamUsers = [];
  sheetConfirmedIds = new Set();
  sheetIdsFetched = false;
  showOnlyNotUploaded = false;

  const editBtn = $('btnEditShop');
  if (editBtn) editBtn.classList.add('hide');

  $('t3').classList.add('hide');
  $('tBadge').classList.add('hide');
  $('uRole').className = 'tag hide';
  $('sm').classList.add('hide');
  $('sm').value = '';
  updateCart();

  $('app').classList.add('hide');
  hideSplash();
  $('auth').classList.remove('hide');
  authMode('in');

  $('aPass').value = '';
  if (message) {
    $('aErr').textContent = message;
    $('aErr').className = 'err shake';
  } else {
    $('aErr').textContent = '';
    $('aErr').className = 'err';
  }

  isLoggingOut = false;

  if (oldToken) {
    try {
      fetch('/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + oldToken
        }
      }).catch(() => {});
    } catch {}
  }
}

function showSplash(msg) {
  const splash = $('appSplash');
  if (!splash) return;
  $('auth').classList.add('hide');
  $('app').classList.add('hide');
  $('splashSub').textContent = msg || 'Verifying session…';
  const sp = $('splashSpinner');
  if (sp) sp.classList.remove('hide');
  const act = $('splashActions');
  if (act) act.classList.add('hide');
  splash.classList.remove('hide');
}

function hideSplash() {
  const splash = $('appSplash');
  if (splash) splash.classList.add('hide');
}

function showSplashError(msg) {
  const splash = $('appSplash');
  if (!splash) return;
  $('splashSub').textContent = msg;
  const sp = $('splashSpinner');
  if (sp) sp.classList.add('hide');
  const act = $('splashActions');
  if (act) act.classList.remove('hide');
  splash.classList.remove('hide');
}

async function initSession() {
  fetchServices();

  // Listen for bfcache restores or multi-tab logouts
  window.addEventListener('pageshow', () => {
    const currentToken = localStorage.getItem('token');
    if (!currentToken && user) {
      logout();
    }
  });

  if (!token) {
    document.documentElement.classList.remove('has-auth');
    $('auth').classList.remove('hide');
    $('app').classList.add('hide');
    hideSplash();
    authMode('in');
    return;
  }

  // Token exists: check for cached session
  let cached = null;
  try {
    cached = JSON.parse(localStorage.getItem('cached_session') || 'null');
  } catch {}

  if (cached && cached.user) {
    // Instantly show app from cache — 0ms wait, no login screen flicker!
    document.documentElement.classList.add('has-auth');
    start(cached, { fromCache: true });
  } else {
    // Token exists but no cache yet — show minimal splash loader
    document.documentElement.classList.add('has-auth');
    showSplash('Starting up…');
  }

  // Background bootstrap revalidation
  try {
    const d = await api('/api/bootstrap');
    hideSplash();
    if (!user) {
      start(d);
    } else {
      applyFreshData(d);
    }
  } catch (err) {
    hideSplash();
    if (err.isAuthError) {
      // 401 Unauthorized -> token truly expired or revoked
      logout('Your session has expired. Please log in again.');
      return;
    }
    // Network or temporary server issue — DO NOT logout!
    console.warn('Bootstrap background check notice:', err.message);
    if (!user) {
      // No cached session available and network failed
      showSplashError('Unable to connect. Check internet connection.');
    } else {
      // User is already safely active from local cache!
      updateNetStatus();
    }
  }
}

initSession();
