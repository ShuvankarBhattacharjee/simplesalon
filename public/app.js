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

// ---- Sheet-backed Sales & Offline Queue Sync ----
function isInQueue(saleId) {
  return getOfflineQueue().some(x => String(x.id) === String(saleId));
}

function isUploaded(saleId) {
  return !isInQueue(saleId);
}

function getUploadStatus(saleId) {
  return isInQueue(saleId) ? 'not-uploaded' : 'uploaded';
}

// Only unsynced items in local storage offline queue are pending sync
function countTotalPending() {
  return getOfflineQueue().length;
}

// Refresh sales from Google Sheet (Google Sheet is the authoritative source of truth)
async function refreshSalesFromSheet() {
  if (!navigator.onLine || !token) return;
  try {
    if (role === 'admin') {
      const d = await api('/api/admin/sales');
      if (d && Array.isArray(d.sales)) {
        const q = getOfflineQueue();
        const map = new Map();
        for (const s of norm(d.sales)) map.set(String(s.id), s);
        for (const s of q) if (s && s.id) map.set(String(s.id), normSale(s));
        allSales = Array.from(map.values()).sort((a, b) => String(b.date).localeCompare(String(a.date)) || Number(b.id) - Number(a.id));
        sales = allSales;
      }
    } else {
      const d = await api('/api/bootstrap');
      if (d && Array.isArray(d.sales)) {
        const q = getOfflineQueue();
        const map = new Map();
        for (const s of norm(d.sales)) map.set(String(s.id), s);
        for (const s of q) if (s && s.id) map.set(String(s.id), normSale(s));
        sales = Array.from(map.values()).sort((a, b) => String(b.date).localeCompare(String(a.date)) || Number(b.id) - Number(a.id));
      }
    }
    renderSales();
    stats();
    saveSessionCache();
  } catch (e) {
    console.warn('refreshSalesFromSheet notice:', e.message);
  }
}

const fetchSheetIds = refreshSalesFromSheet;

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
      // Data is synced with Google Sheet — remove from local storage!
      saveOfflineQueue([]);
      showBanner(`✓ ${res.synced || q.length} sale${(res.synced || q.length) === 1 ? '' : 's'} synced with Google Sheet`, 'synced');
      await refreshSalesFromSheet();
    }
  } catch (e) {
    console.warn('Auto-sync notice:', e.message);
  } finally {
    isSyncing = false;
    updateNetStatus();
    renderSales();
    stats();
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
  const pending = q.length;
  updateSyncBadges();

  if (isSyncing) {
    el.className = 'net-status banner-syncing';
    el.innerHTML = '<span><i class="spinning" style="display:inline-block;margin-right:6px">↻</i> Syncing with Google Sheet…</span>';
    el.classList.remove('hide');
    return;
  }
  if (!navigator.onLine) {
    el.className = 'net-status banner-offline';
    el.innerHTML = '<span>⚡ Offline — ' + (q.length ? q.length + ' entry(s) in local storage' : 'ready') + '. Auto-syncs on reconnect.</span>';
    el.classList.remove('hide');
    return;
  }
  if (pending > 0) {
    el.className = 'net-status banner-offline';
    el.innerHTML = '<span>⚡ ' + pending + ' sale' + (pending === 1 ? '' : 's') + ' in local storage pending upload</span><button class="sync-btn" onclick="uploadAll()">Upload now</button>';
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
function normDate(d) {
  if (!d) return today();
  const str = String(d).trim();
  const m = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) {
    return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  }
  const m2 = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m2) {
    return `${m2[3]}-${String(m2[2]).padStart(2, '0')}-${String(m2[1]).padStart(2, '0')}`;
  }
  return str.slice(0, 10);
}

function resolveSaleDate(rawDate, saleId) {
  const idNum = Number(saleId);
  if (idNum > 1600000000000 && idNum < 2500000000000) {
    try {
      const idDate = new Date(idNum);
      if (!isNaN(idDate.getTime())) {
        const year = idDate.getFullYear();
        const month = String(idDate.getMonth() + 1).padStart(2, '0');
        const day = String(idDate.getDate()).padStart(2, '0');
        const computedFromId = `${year}-${month}-${day}`;
        if (!rawDate) return computedFromId;
        const normalizedRaw = normDate(rawDate);
        const diffDays = Math.abs((new Date(computedFromId) - new Date(normalizedRaw)) / 86400000);
        // Correct timezone shift from Google Sheets (within 1 day difference)
        if (diffDays <= 1) {
          return computedFromId;
        }
        return normalizedRaw;
      }
    } catch {}
  }
  return normDate(rawDate);
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
  const dateStr = resolveSaleDate(s.date, s.id);
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
    date: dateStr,
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
  const sideShop = $('sidebarShopName');
  if (sideShop) sideShop.textContent = shopName;
  const editBtn = $('btnEditShop');
  if (editBtn) editBtn.classList.toggle('hide', role !== 'admin');
  const sideEditBtn = $('sidebarBtnEditShop');
  if (sideEditBtn) sideEditBtn.classList.toggle('hide', role !== 'admin');
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

// ---- Sidebar & Profile Modal ----
function toggleSidebar() {
  const d = $('sidebarDrawer');
  if (!d) return;
  if (d.classList.contains('open')) {
    closeSidebar();
  } else {
    openSidebar();
  }
}

function openSidebar() {
  const d = $('sidebarDrawer');
  const b = $('sidebarBackdrop');
  updateSidebarInfo();
  if (d) d.classList.add('open');
  if (b) b.classList.remove('hide');
}

function closeSidebar() {
  const d = $('sidebarDrawer');
  const b = $('sidebarBackdrop');
  if (d) d.classList.remove('open');
  if (b) b.classList.add('hide');
}

function updateSidebarInfo() {
  const displayName = uname || user || 'User';
  if ($('sidebarUName')) $('sidebarUName').textContent = displayName;
  if ($('sidebarUHandle')) $('sidebarUHandle').textContent = `@${user || 'user'}`;
  if ($('sidebarShopName')) $('sidebarShopName').textContent = shopName || 'Simple Salon';
  const roleName = role === 'admin' ? 'Owner' : 'Team';
  if ($('sidebarRoleBadge')) $('sidebarRoleBadge').textContent = roleName;
  if ($('sidebarAvatar')) {
    const initial = (displayName.charAt(0) || 'S').toUpperCase();
    $('sidebarAvatar').textContent = initial;
  }
  const editShopBtn = $('sidebarBtnEditShop');
  if (editShopBtn) editShopBtn.classList.toggle('hide', role !== 'admin');

  const pending = typeof countTotalPending === 'function' ? countTotalPending() : 0;
  const badge = $('sidebarSyncBadge');
  if (badge) {
    badge.textContent = pending;
    badge.classList.toggle('hide', pending === 0);
  }
  const desc = $('sidebarSyncDesc');
  if (desc) {
    desc.textContent = pending > 0 ? `${pending} non-synced entry(s)` : 'All sales synced with Sheet';
  }
}

function openProfileModal() {
  const displayName = uname || user || 'User';
  if ($('profName')) $('profName').textContent = displayName;
  if ($('profUser')) $('profUser').textContent = user || '—';
  const designation = role === 'admin' ? 'Owner / Administrator' : 'Team Member';
  if ($('profDesignation')) $('profDesignation').textContent = designation;
  if ($('profRolePill')) $('profRolePill').textContent = role === 'admin' ? 'Owner' : 'Team';
  if ($('profShopName')) $('profShopName').textContent = shopName || 'Simple Salon';
  const changeShopBtn = $('profBtnChangeShop');
  if (changeShopBtn) changeShopBtn.classList.toggle('hide', role !== 'admin');
  $('mProfile').classList.add('show');
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
    if (role !== 'admin') return; // Only admin can edit & delete via holding

    holdTriggered = false;
    holdStartX = e.clientX;
    holdStartY = e.clientY;
    activeHoldEl = card;
    card.classList.add('holding');

    holdTimeout = setTimeout(() => {
      holdTriggered = true;
      if (activeHoldEl) activeHoldEl.classList.remove('holding');
      if (navigator.vibrate) {
        try { navigator.vibrate(50); } catch {}
      }
      openEditSvc(card.dataset.id);
    }, 420);
  });

  grid.addEventListener('pointermove', (e) => {
    if (!holdTimeout) return;
    const dx = Math.abs(e.clientX - holdStartX);
    const dy = Math.abs(e.clientY - holdStartY);
    if (dx > 15 || dy > 15) {
      clearHold();
    }
  });

  grid.addEventListener('pointerup', clearHold);
  grid.addEventListener('pointercancel', clearHold);
  grid.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.svc');
    if (card && !card.classList.contains('add')) {
      e.preventDefault();
      if (role === 'admin' && card.dataset.id) {
        openEditSvc(card.dataset.id);
      }
    }
  });
}

function handleServiceHold(id) {
  if (role !== 'admin') {
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
    <div class="svc ${cart[s.id]?'sel':''}" data-id="${s.id}" onclick="onSvcClick(event, '${s.id}')" title="${role==='admin'?'Tap to add · Hold to edit or delete':'Tap to add'}">
      ${cart[s.id]?`<span class="badge">${cart[s.id]}</span>`:''}
      ${role==='admin'?`<span class="x" onclick="event.stopPropagation();delSvc('${s.id}')" title="Delete service">✕</span><span class="x" style="right:28px" onclick="event.stopPropagation();openEditSvc('${s.id}')" title="Edit service">✏️</span>`:''}
      <div class="ic">${s.ic||'⭐'}</div><h3>${esc(s.name)}</h3><p>${esc(s.cat)}</p><div class="pr">${inr(s.price)}</div>
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
  const now = new Date();
  $('cDate').value=today();
  if ($('cTime')) {
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    $('cTime').value = `${hh}:${mm}`;
  }
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
  const now = new Date();
  let time = '';
  if ($('cTime') && $('cTime').value) {
    const parts = $('cTime').value.split(':');
    if (parts.length >= 2) {
      const d = new Date();
      d.setHours(Number(parts[0]), Number(parts[1]), 0);
      time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
    }
  }
  if (!time) {
    time = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  }
  const timestamp = now.toISOString();
  const saleObj = {
    id: Date.now(),
    items,
    calc: calcTotal(),
    total,
    pay: $('cPay').value,
    date: $('cDate').value||today(),
    time,
    timestamp,
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
    const normalizedSale = normSale({ ...saleObj, by: user, byName: uname });
    sales = [normalizedSale, ...sales.filter(s => String(s.id) !== String(normalizedSale.id))];
    if (role === 'admin') {
      allSales = [normalizedSale, ...allSales.filter(s => String(s.id) !== String(normalizedSale.id))];
    }
    stats(); updateNetStatus(); renderSales();
    saveSessionCache();
    showPrompt('💾 Saved to local storage — will upload automatically when online', 'offline');
    return;
  }

  try{
    const sale = await api('/api/sales', { method: 'POST', body: saleObj });
    // Synced with Google Sheet -> do not keep in local storage offline queue!
    removeFromOfflineQueue(sale.id);
    const normalizedSale = normSale({ ...saleObj, ...sale, by: user, byName: uname });

    sales = [normalizedSale, ...sales.filter(s => String(s.id) !== String(normalizedSale.id))];
    if (role === 'admin') {
      allSales = [normalizedSale, ...allSales.filter(s => String(s.id) !== String(normalizedSale.id))];
    }
    stats();
    renderSales();
    saveSessionCache();
    updateNetStatus();
    showPrompt('✓ Data saved & uploaded to Google Sheet!', 'success');
  }catch(e){
    // If request failed or network dropped, store in local storage offline queue
    queueOfflineSale(saleObj);
    const normalizedSale = normSale({ ...saleObj, by: user, byName: uname });
    sales = [normalizedSale, ...sales.filter(s => String(s.id) !== String(normalizedSale.id))];
    if (role === 'admin') {
      allSales = [normalizedSale, ...allSales.filter(s => String(s.id) !== String(normalizedSale.id))];
    }
    stats(); updateNetStatus(); renderSales();
    saveSessionCache();
    showPrompt('💾 Saved to local storage — will upload automatically when online', 'offline');
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
  const s = all().find(x => String(x.id) === String(id));
  const name = s ? s.name : 'this service';
  if(!confirm(`Remove "${name}" from all devices and delete from Google Sheet?`)) return;
  try{
    await api('/api/services/' + encodeURIComponent(id), { method: 'DELETE' });
    services = services.filter(s => String(s.id) !== String(id));
    localStorage.setItem('cached_services', JSON.stringify(services));
    renderSvc();
    showPrompt(`✓ "${name}" deleted and synced with Google Sheet!`, 'success');
  }catch(e){ alert(e.message); }
}

async function deleteFromEditModal() {
  const id = $('eId').value;
  const s = all().find(x => String(x.id) === String(id));
  const name = s ? s.name : ($('eName').value || 'this service');
  if (!id) return;
  if (!confirm(`Are you sure you want to delete "${name}"?\n\nThis will remove the service from all devices and delete it from Google Sheet.`)) {
    return;
  }
  const btn = $('btnDeleteEditSvc');
  if (btn) {
    btn.setAttribute('disabled', '');
    btn.innerHTML = '<span class="svc-spinner"></span> Deleting…';
  }
  try {
    await api('/api/services/' + encodeURIComponent(id), { method: 'DELETE' });
    services = services.filter(x => String(x.id) !== String(id));
    localStorage.setItem('cached_services', JSON.stringify(services));
    closeM('mEditSvc');
    renderSvc();
    showPrompt(`✓ "${name}" deleted and synced with Google Sheet!`, 'success');
  } catch (err) {
    alert('Failed to delete service: ' + err.message);
  } finally {
    if (btn) {
      btn.removeAttribute('disabled');
      btn.innerHTML = '<span>🗑️</span> Delete';
    }
  }
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
  const btn = $('btnSaveEditSvc'), cancelBtn = $('btnCancelEditSvc'), delBtn = $('btnDeleteEditSvc');
  if (btn) {
    btn.removeAttribute('disabled');
    btn.classList.remove('svc-btn-loading');
    btn.innerHTML = '<span class="svc-btn-text">Save changes</span>';
  }
  if (cancelBtn) cancelBtn.removeAttribute('disabled');
  if (delBtn) {
    delBtn.removeAttribute('disabled');
    delBtn.innerHTML = '<span>🗑️</span> Delete';
  }
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
    if (d && Array.isArray(d.sales)) {
      const q = getOfflineQueue();
      const map = new Map();
      // Google Sheet is authoritative for confirmed sales
      for (const s of norm(d.sales)) map.set(String(s.id), s);
      // Only keep unsynced entries from local storage offline queue
      for (const s of q) if (s && s.id) map.set(String(s.id), normSale(s));
      allSales = Array.from(map.values()).sort((a, b) => String(b.date).localeCompare(String(a.date)) || Number(b.id) - Number(a.id));
      sales = allSales;
      renderSales();
      stats();
      saveSessionCache();
    }
  }catch(e){
    console.warn('loadAllSales error:', e.message);
  }
}
function getSalesDateRange() {
  if (salesDateFilter === 'today') return { from: today(), to: today() };
  if (salesDateFilter === 'yesterday') return { from: getYesterday(), to: getYesterday() };
  if (salesDateFilter === 'all') return { from: '', to: '' };

  const from = $('sdFrom') ? $('sdFrom').value : ($('sd') ? $('sd').value : '');
  const to = $('sdTo') ? $('sdTo').value : ($('sd') ? $('sd').value : '');
  return { from, to };
}

function onSalesDateRangeChange() {
  const range = getSalesDateRange();
  if (range.from || range.to) {
    salesDateFilter = 'range';
    if ($('btnSalesToday')) $('btnSalesToday').classList.remove('on');
    if ($('btnSalesYesterday')) $('btnSalesYesterday').classList.remove('on');
    if ($('btnSalesAll')) $('btnSalesAll').classList.remove('on');
  }
  renderSales();
}

function setSalesDateFilter(mode) {
  salesDateFilter = mode;
  const btnToday = $('btnSalesToday');
  const btnYesterday = $('btnSalesYesterday');
  const btnAll = $('btnSalesAll');

  if (btnToday) btnToday.classList.toggle('on', mode === 'today');
  if (btnYesterday) btnYesterday.classList.toggle('on', mode === 'yesterday');
  if (btnAll) btnAll.classList.toggle('on', mode === 'all');

  if (mode === 'today' || mode === 'yesterday' || mode === 'all') {
    if ($('sdFrom')) $('sdFrom').value = '';
    if ($('sdTo')) $('sdTo').value = '';
    if ($('sd')) $('sd').value = '';
  }
  renderSales();
}

function filtered(){
  const q = $('sq') ? $('sq').value.toLowerCase() : '';
  const range = getSalesDateRange();
  const p = $('sp') ? $('sp').value : '';
  let list = activeSales().filter(s => {
    const sDate = resolveSaleDate(s.date, s.id);
    if (q && !(names(s) + s.note).toLowerCase().includes(q)) return false;
    if (range.from && sDate < range.from) return false;
    if (range.to && sDate > range.to) return false;
    if (p && s.pay !== p) return false;
    return true;
  });
  if (showOnlyNotUploaded) {
    // Only show sales currently in local storage waiting to sync
    list = list.filter(s => isInQueue(s.id));
  }
  return list;
}
const names = s => (s && s.items && Array.isArray(s.items) && s.items.length)
  ? s.items.map(i => (i.name || 'Service') + (i.qty > 1 ? ' ×' + i.qty : '')).join(', ')
  : (s?.services || 'Service');

function getSaleTime(s) {
  if (s && s.time && String(s.time).trim()) return String(s.time).trim();
  if (s && s.timestamp) {
    try {
      const d = new Date(s.timestamp);
      if (!isNaN(d.getTime())) {
        return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
      }
    } catch {}
  }
  if (s && s.id && Number(s.id) > 1600000000000) {
    try {
      const d = new Date(Number(s.id));
      if (!isNaN(d.getTime())) {
        return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
      }
    } catch {}
  }
  return '';
}

function getUploadStatus(saleId) {
  return isInQueue(saleId) ? 'not-uploaded' : 'uploaded';
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
    const isUnsynced = isInQueue(s.id);
    let statusBtn = '';
    if (isUnsynced) {
      statusBtn = `<button class="upload-tag not-uploaded" title="Stored in local storage — click to upload to Google Sheet" onclick="uploadSingle('${s.id}')">⚡ Upload to Sheet</button>`;
    } else {
      statusBtn = `<span class="upload-tag uploaded" title="Data fetched & confirmed from Google Sheet">✓ In Sheet</span>`;
    }
    const timeVal = getSaleTime(s);
    const timeTag = timeVal ? ` · <span class="sale-dt-tag">⏰ ${esc(timeVal)}</span>` : '';
    return `<div class="item" id="sale-${s.id}"><div><b>${esc(names(s))}</b>
      <small><span class="sale-dt-date">📅 ${s.date}</span>${timeTag} · <span class="${s.pay==='Pending'?'pill warn':''}">${s.pay}</span>${role==='admin'&&s.byName?' · '+esc(s.byName):''}${s.note?' · '+esc(s.note):''}${s.total!==s.calc?' · adjusted from '+inr(s.calc):''}</small>
      <div class="sale-tags">
        ${statusBtn}
        <button type="button" class="sale-invoice-btn wa" onclick="shareSingleSaleWhatsApp('${s.id}')" title="Share this sale Invoice on WhatsApp">
          <span class="wa-ico">💬</span> Invoice
        </button>
        <button type="button" class="sale-invoice-btn share" onclick="shareSingleSaleAnywhere('${s.id}')" title="Share or Download this sale Invoice PDF">
          <span>📤</span> PDF
        </button>
      </div></div>
      <div class="amt">${inr(s.total)}</div>
      <button class="del" onclick="delSale('${s.id}')" title="Delete">✕</button></div>`;
  }).join('') : '<div class="empty">No sales found</div>';
  $('ft').textContent = inr(l.reduce((a, s) => a + s.total, 0));
}

async function refreshSheetStatus() {
  showBanner('↻ Refreshing latest sales from Google Sheet…', 'syncing');
  await refreshSalesFromSheet();
}

async function uploadSingle(saleId) {
  await syncPendingSales();
  renderSales();
  updateNetStatus();
}

// Upload unsynced local storage entries or refresh from Google Sheet
async function uploadAll() {
  if (isSyncing) return;
  if (!navigator.onLine) {
    showBanner('⚡ Device is offline — connect to internet to sync', 'error');
    return;
  }

  const q = getOfflineQueue();
  if (q.length > 0) {
    await syncPendingSales();
  } else {
    isSyncing = true;
    updateSyncBadges();
    showBanner('↻ Fetching latest data from Google Sheet…', 'syncing');
    try {
      await refreshSalesFromSheet();
      showBanner('All data is in sync with Google Sheet ✓', 'synced');
    } catch (e) {
      showBanner('Sync error: ' + e.message, 'error');
    } finally {
      isSyncing = false;
      updateNetStatus();
      renderSales();
      stats();
    }
  }
}

async function delSale(id){
  if(!confirm('Delete this entry?'))return;
  const s = activeSales().find(x => String(x.id) === String(id));
  removeFromOfflineQueue(id);
  sales = sales.filter(x => String(x.id) !== String(id));
  allSales = allSales.filter(x => String(x.id) !== String(id));
  renderSales();
  stats();
  saveSessionCache();
  try{
    if (role === 'admin' && s && s.by) {
      await api('/api/admin/sales/' + s.by + '/' + id, { method: 'DELETE' });
    } else {
      await api('/api/sales/' + id, { method: 'DELETE' });
    }
  }catch(e){
    console.warn('delSale notice:', e.message);
  }
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
function getAllAvailableSales() {
  const map = new Map();
  // 1. Confirmed sales from Google Sheet
  const base = (role === 'admin' && allSales && allSales.length) ? allSales : sales;
  for (const s of (base || [])) {
    if (s && s.id != null) {
      const n = normSale(s);
      if (n) map.set(String(n.id), n);
    }
  }
  // 2. Unsynced offline queue sales
  for (const s of getOfflineQueue()) {
    if (s && s.id != null) {
      const n = normSale(s);
      if (n) map.set(String(n.id), n);
    }
  }
  return Array.from(map.values());
}

function stats(){
  const t = today();
  const m = t.slice(0, 7);
  const src = role === 'admin' ? getAllAvailableSales() : (sales && sales.length ? sales : getAllAvailableSales());
  const todayList = src.filter(s => resolveSaleDate(s.date, s.id) === t);
  const monthList = src.filter(s => {
    const dStr = resolveSaleDate(s.date, s.id);
    return dStr && dStr.startsWith(m);
  });
  const todayTotal = todayList.reduce((a, s) => a + (Number(s.total) || 0), 0);
  const monthTotal = monthList.reduce((a, s) => a + (Number(s.total) || 0), 0);

  if ($('sToday')) $('sToday').textContent = inr(todayTotal);
  if ($('sMonth')) $('sMonth').textContent = inr(monthTotal);
  if ($('sCount')) $('sCount').textContent = todayList.length;
}

let exportSource = 'sales';

function getExportList() {
  if (exportSource === 'dash') {
    const from = $('fFrom')?.value || '';
    const to = $('fTo')?.value || '';
    const u = $('fUser')?.value || '';
    const p = $('fPay')?.value || '';
    const src = (role === 'admin' && allSales && allSales.length) ? allSales : sales;
    return src.filter(s => {
      if (from && s.date < from) return false;
      if (to && s.date > to) return false;
      if (u && s.by !== u) return false;
      if (p && s.pay !== p) return false;
      return true;
    });
  }
  return filtered();
}

function openExportModal(source = 'sales') {
  exportSource = source;
  const list = getExportList();
  const countEl = $('exportScopeCount');
  if (countEl) countEl.textContent = list.length;
  $('mExport').classList.add('show');
}

function executeExport(type) {
  const list = getExportList();
  if (!list.length) {
    alert('No sales to export in the current view.');
    return;
  }
  const adminView = role === 'admin';
  const safeName = (shopName || 'Simple_Salon').replace(/[^a-zA-Z0-9_-]/g, '_');

  if (type === 'csv') {
    const headers = adminView
      ? ['Date', 'Time', 'Team Member', 'Services', 'Payment Mode', 'Calculated (INR)', 'Total Amount (INR)', 'Notes', 'Sync Status']
      : ['Date', 'Time', 'Services', 'Payment Mode', 'Calculated (INR)', 'Total Amount (INR)', 'Notes', 'Sync Status'];

    const rows = list.map(s => {
      const status = getUploadStatus(s.id) === 'uploaded' ? 'Uploaded to Sheet' : 'Pending Upload';
      return adminView
        ? [s.date, s.time || '', s.byName || s.by || '', names(s), s.pay, Number(s.calc) || 0, Number(s.total) || 0, s.note || '', status]
        : [s.date, s.time || '', names(s), s.pay, Number(s.calc) || 0, Number(s.total) || 0, s.note || '', status];
    });

    const csvContent = '\uFEFF' + [headers, ...rows]
      .map(row => row.map(cell => '"' + String(cell ?? '').replace(/"/g, '""') + '"').join(','))
      .join('\r\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${safeName}_Sales_${today()}.csv`;
    a.click();
    closeM('mExport');
    showPrompt('✓ Sales exported as CSV successfully!', 'success');
  } else {
    // Excel XML Spreadsheet format
    const headers = adminView
      ? ['Date', 'Time', 'Team Member', 'Services', 'Payment Mode', 'Calculated (INR)', 'Total Amount (INR)', 'Notes', 'Sync Status']
      : ['Date', 'Time', 'Services', 'Payment Mode', 'Calculated (INR)', 'Total Amount (INR)', 'Notes', 'Sync Status'];

    let xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <Styles>
  <Style ss:ID="Header">
   <Font ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#1C1C1A" ss:Pattern="Solid"/>
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
  </Style>
  <Style ss:ID="Currency">
   <NumberFormat ss:Format="₹#,##0"/>
   <Alignment ss:Horizontal="Right"/>
  </Style>
  <Style ss:ID="Normal">
   <Alignment ss:Vertical="Center"/>
  </Style>
 </Styles>
 <Worksheet ss:Name="Sales Records">
  <Table>
   <Row ss:StyleID="Header">
    ${headers.map(h => `<Cell><Data ss:Type="String">${esc(h)}</Data></Cell>`).join('')}
   </Row>`;

    list.forEach(s => {
      const status = getUploadStatus(s.id) === 'uploaded' ? 'Uploaded' : 'Pending';
      if (adminView) {
        xml += `
   <Row ss:StyleID="Normal">
    <Cell><Data ss:Type="String">${esc(s.date)}</Data></Cell>
    <Cell><Data ss:Type="String">${esc(s.time || '')}</Data></Cell>
    <Cell><Data ss:Type="String">${esc(s.byName || s.by || '')}</Data></Cell>
    <Cell><Data ss:Type="String">${esc(names(s))}</Data></Cell>
    <Cell><Data ss:Type="String">${esc(s.pay)}</Data></Cell>
    <Cell ss:StyleID="Currency"><Data ss:Type="Number">${Number(s.calc) || 0}</Data></Cell>
    <Cell ss:StyleID="Currency"><Data ss:Type="Number">${Number(s.total) || 0}</Data></Cell>
    <Cell><Data ss:Type="String">${esc(s.note || '')}</Data></Cell>
    <Cell><Data ss:Type="String">${esc(status)}</Data></Cell>
   </Row>`;
      } else {
        xml += `
   <Row ss:StyleID="Normal">
    <Cell><Data ss:Type="String">${esc(s.date)}</Data></Cell>
    <Cell><Data ss:Type="String">${esc(s.time || '')}</Data></Cell>
    <Cell><Data ss:Type="String">${esc(names(s))}</Data></Cell>
    <Cell><Data ss:Type="String">${esc(s.pay)}</Data></Cell>
    <Cell ss:StyleID="Currency"><Data ss:Type="Number">${Number(s.calc) || 0}</Data></Cell>
    <Cell ss:StyleID="Currency"><Data ss:Type="Number">${Number(s.total) || 0}</Data></Cell>
    <Cell><Data ss:Type="String">${esc(s.note || '')}</Data></Cell>
    <Cell><Data ss:Type="String">${esc(status)}</Data></Cell>
   </Row>`;
      }
    });

    xml += `
  </Table>
 </Worksheet>
</Workbook>`;

    const blob = new Blob([xml], { type: 'application/vnd.ms-excel;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${safeName}_Sales_${today()}.xls`;
    a.click();
    closeM('mExport');
    showPrompt('✓ Sales exported as Excel spreadsheet successfully!', 'success');
  }
}
function exportCSV(){
  executeExport('csv');
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

let shareSource = 'sales';

function openShareModal(source = 'sales') {
  shareSource = source;
  const t = today();
  if (source === 'dash' && $('fFrom') && $('fFrom').value) {
    if ($('shareFrom')) $('shareFrom').value = $('fFrom').value;
    if ($('shareTo')) $('shareTo').value = $('fTo').value || $('fFrom').value;
    selectPeriod('custom');
  } else {
    if ($('shareFrom')) $('shareFrom').value = t;
    if ($('shareTo')) $('shareTo').value = t;
    selectPeriod('today');
  }
  $('mShare').classList.add('show');
}

function getReportSales() {
  const { from, to } = getSelectedShareRange();
  const src = (role === 'admin' && allSales && allSales.length) ? allSales : sales;
  const memberFilter = (shareSource === 'dash' && $('fUser')?.value)
    ? $('fUser').value
    : (($('sm') && $('sm').value) ? $('sm').value : '');
  const payFilter = (shareSource === 'dash' && $('fPay')?.value) ? $('fPay').value : '';
  let list = (role === 'admin' && memberFilter) ? src.filter(s => s.by === memberFilter) : src;
  if (payFilter) list = list.filter(s => s.pay === payFilter);
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
  const invTime = getSaleTime(sale) || new Date(Number(sale.id)).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
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
      `📅 *Date & Time:* ${formatDateDisplay(sale.date)}${getSaleTime(sale) ? ' at ' + getSaleTime(sale) : ''}\n` +
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
      `Date & Time: ${formatDateDisplay(sale.date)}${getSaleTime(sale) ? ' at ' + getSaleTime(sale) : ''}\n` +
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

document.addEventListener('click', e => {
  const pop = $('dashRangePopover');
  if (pop && !pop.classList.contains('hide')) {
    const wrap = $('dashRangeWrap');
    if (wrap && !wrap.contains(e.target)) {
      closeDashRangePicker();
    }
  }
});

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

let dashCalYear = new Date().getFullYear();
let dashCalMonth = new Date().getMonth();
let dashCalStart = null;
let dashCalEnd = null;
let dashPreset = 'thisMonth';
let dashInitialized = false;

function formatDateYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function setDashPreset(preset, triggerLoad = true) {
  dashPreset = preset;
  const t = today();
  const d = new Date();
  let from = '', to = '', label = 'This Month';

  if (preset === 'today') {
    from = t;
    to = t;
    label = 'Today';
  } else if (preset === 'yesterday') {
    const y = getYesterday();
    from = y;
    to = y;
    label = 'Yesterday';
  } else if (preset === '7days') {
    const d7 = new Date();
    d7.setDate(d7.getDate() - 6);
    from = formatDateYMD(d7);
    to = t;
    label = 'Last 7 Days';
  } else if (preset === 'thisMonth') {
    const mStart = new Date(d.getFullYear(), d.getMonth(), 1);
    from = formatDateYMD(mStart);
    to = t;
    label = 'This Month';
  } else if (preset === 'lastMonth') {
    const lmStart = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    const lmEnd = new Date(d.getFullYear(), d.getMonth(), 0);
    from = formatDateYMD(lmStart);
    to = formatDateYMD(lmEnd);
    label = 'Last Month';
  } else if (preset === 'all') {
    from = '';
    to = '';
    label = 'All Time';
  }

  dashCalStart = from;
  dashCalEnd = to;

  if ($('fFrom')) $('fFrom').value = from;
  if ($('fTo')) $('fTo').value = to;
  if ($('drInputFrom')) $('drInputFrom').value = from;
  if ($('drInputTo')) $('drInputTo').value = to;
  if ($('dashRangeLabel')) $('dashRangeLabel').textContent = label;

  if ($('dashBtnToday')) $('dashBtnToday').classList.toggle('on', preset === 'today');
  if ($('dashBtnYest')) $('dashBtnYest').classList.toggle('on', preset === 'yesterday');
  if ($('dashBtnThisMonth')) $('dashBtnThisMonth').classList.toggle('on', preset === 'thisMonth');
  if ($('dashBtnAll')) $('dashBtnAll').classList.toggle('on', preset === 'all');

  document.querySelectorAll('.dr-preset-btn').forEach(b => {
    b.classList.toggle('on', b.getAttribute('onclick')?.includes(`'${preset}'`));
  });

  closeDashRangePicker();
  if (triggerLoad) loadDash();
}

function toggleDashRangePicker() {
  const pop = $('dashRangePopover');
  if (!pop) return;
  const isHidden = pop.classList.contains('hide');
  if (isHidden) {
    if (dashCalStart) {
      const parts = dashCalStart.split('-');
      if (parts.length === 3) {
        dashCalYear = Number(parts[0]);
        dashCalMonth = Number(parts[1]) - 1;
      }
    }
    if ($('drInputFrom')) $('drInputFrom').value = dashCalStart || '';
    if ($('drInputTo')) $('drInputTo').value = dashCalEnd || '';
    renderDashCalendar();
    pop.classList.remove('hide');
  } else {
    pop.classList.add('hide');
  }
}

function closeDashRangePicker() {
  const pop = $('dashRangePopover');
  if (pop) pop.classList.add('hide');
}

function navDashCal(delta) {
  dashCalMonth += delta;
  if (dashCalMonth < 0) {
    dashCalMonth = 11;
    dashCalYear--;
  } else if (dashCalMonth > 11) {
    dashCalMonth = 0;
    dashCalYear++;
  }
  renderDashCalendar();
}

function renderDashCalendar() {
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  if ($('drCalMonthLabel')) $('drCalMonthLabel').textContent = `${monthNames[dashCalMonth]} ${dashCalYear}`;
  if ($('drInputFrom')) $('drInputFrom').value = dashCalStart || '';
  if ($('drInputTo')) $('drInputTo').value = dashCalEnd || '';

  const firstDay = new Date(dashCalYear, dashCalMonth, 1).getDay();
  const daysInMonth = new Date(dashCalYear, dashCalMonth + 1, 0).getDate();
  const grid = $('drCalGrid');
  if (!grid) return;

  let html = '';
  for (let i = 0; i < firstDay; i++) {
    html += '<div class="dr-day empty"></div>';
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dayStr = `${dashCalYear}-${String(dashCalMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    let cls = 'dr-day';
    if (dashCalStart && dashCalEnd) {
      if (dayStr === dashCalStart && dayStr === dashCalEnd) {
        cls += ' range-start range-end';
      } else if (dayStr === dashCalStart) {
        cls += ' range-start';
      } else if (dayStr === dashCalEnd) {
        cls += ' range-end';
      } else if (dayStr > dashCalStart && dayStr < dashCalEnd) {
        cls += ' in-range';
      }
    } else if (dashCalStart && dayStr === dashCalStart) {
      cls += ' range-start range-end';
    }
    html += `<div class="${cls}" onclick="onDashDayClick('${dayStr}')">${day}</div>`;
  }
  grid.innerHTML = html;

  const hint = $('drCalHint');
  if (hint) {
    if (!dashCalStart) hint.textContent = 'Click start date, then upto date';
    else if (!dashCalEnd) hint.textContent = 'Click end date to finish range';
    else hint.textContent = `${formatDateDisplay(dashCalStart)} → ${formatDateDisplay(dashCalEnd)}`;
  }
}

function onDashDayClick(dateStr) {
  if (!dashCalStart || (dashCalStart && dashCalEnd)) {
    dashCalStart = dateStr;
    dashCalEnd = null;
  } else {
    if (dateStr < dashCalStart) {
      dashCalEnd = dashCalStart;
      dashCalStart = dateStr;
    } else {
      dashCalEnd = dateStr;
    }
  }
  if ($('drInputFrom')) $('drInputFrom').value = dashCalStart || '';
  if ($('drInputTo')) $('drInputTo').value = dashCalEnd || '';
  document.querySelectorAll('.dr-preset-btn').forEach(b => b.classList.remove('on'));
  renderDashCalendar();
}

function onDashRangeInputChange() {
  const from = $('drInputFrom')?.value;
  const to = $('drInputTo')?.value;
  if (from) dashCalStart = from;
  if (to) dashCalEnd = to;
  if (dashCalStart && dashCalEnd && dashCalStart > dashCalEnd) {
    const tmp = dashCalStart;
    dashCalStart = dashCalEnd;
    dashCalEnd = tmp;
    if ($('drInputFrom')) $('drInputFrom').value = dashCalStart;
    if ($('drInputTo')) $('drInputTo').value = dashCalEnd;
  }
  if (dashCalStart) {
    const parts = dashCalStart.split('-');
    if (parts.length === 3) {
      dashCalYear = Number(parts[0]);
      dashCalMonth = Number(parts[1]) - 1;
    }
  }
  document.querySelectorAll('.dr-preset-btn').forEach(b => b.classList.remove('on'));
  renderDashCalendar();
}

function applyDashRangePicker() {
  const fromVal = $('drInputFrom')?.value;
  const toVal = $('drInputTo')?.value;
  if (fromVal) dashCalStart = fromVal;
  if (toVal) dashCalEnd = toVal;
  if (dashCalStart && !dashCalEnd) dashCalEnd = dashCalStart;
  if (!dashCalStart) {
    dashCalStart = today();
    dashCalEnd = today();
  }
  if ($('fFrom')) $('fFrom').value = dashCalStart;
  if ($('fTo')) $('fTo').value = dashCalEnd;
  const label = dashCalStart === dashCalEnd
    ? formatDateDisplay(dashCalStart)
    : `${formatDateDisplay(dashCalStart)} – ${formatDateDisplay(dashCalEnd)}`;
  if ($('dashRangeLabel')) $('dashRangeLabel').textContent = label;
  closeDashRangePicker();
  loadDash();
}

async function loadDash(){
  if(role!=='admin')return;
  if (!dashInitialized) {
    dashInitialized = true;
    setDashPreset('thisMonth', false);
  }
  const p=new URLSearchParams();
  if($('fFrom') && $('fFrom').value) p.set('from',$('fFrom').value);
  if($('fTo') && $('fTo').value) p.set('to',$('fTo').value);
  if($('fUser') && $('fUser').value) p.set('user',$('fUser').value);
  if($('fPay') && $('fPay').value) p.set('pay',$('fPay').value);
  try{
    const [d,,st]=await Promise.all([
      api('/api/admin/summary?'+p),
      refreshTeamUsers(),
      api('/api/sync/status')
    ]);
    renderDash(d);
    renderTeam(teamUsers);
    renderSync(st);
    checkOwnerNotifications();
    checkSheetConn();
  }catch(e){
    console.warn('loadDash error:', e.message);
  }
}
function clearDashF(){
  setDashPreset('thisMonth', false);
  if ($('fUser')) $('fUser').value='';
  if ($('fPay')) $('fPay').value='';
  loadDash();
}

function renderSync(s){
  const el=$('syncBar');
  if (!el) return;
  if(!s || !s.configured){
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
    showPrompt('Pushed '+r.pushed+' sale'+(r.pushed===1?'':'s')+' to the sheet.', 'success');
    renderSync(r);
    checkSheetConn();
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
    checkOwnerNotifications();
    alert('Team accounts synced from Google Sheet!');
  }catch(e){alert(e.message)}
}
async function approveUser(u, displayName){
  try{
    await api('/api/admin/users/'+u+'/approve',{method:'POST'});
    showPrompt('✓ ' + (displayName || u) + ' has been approved! Status is now Active.', 3500);
    await refreshTeamUsers();
    await checkOwnerNotifications();
    await loadDash();
  }catch(e){alert(e.message)}
}
async function removeUser(u){
  if(!confirm('Remove this team member? Their sales and services will be deleted.'))return;
  try{
    await api('/api/admin/users/'+u,{method:'DELETE'});
    allSales=allSales.filter(s=>s.by!==u);
    await refreshTeamUsers();
    await checkOwnerNotifications();
    await loadDash();renderSales();
  }catch(e){alert(e.message)}
}

function renderDash(d){
  if (!d) return;
  const totals = d.totals || { revenue: 0, count: 0, avg: 0, activeMembers: 0 };
  const trend = Array.isArray(d.trend) ? d.trend : [];
  const members = Array.isArray(d.members) ? d.members : [];
  const payments = Array.isArray(d.payments) ? d.payments : [];
  const services = Array.isArray(d.services) ? d.services : [];
  const memberOptions = Array.isArray(d.memberOptions) ? d.memberOptions : [];

  if ($('dRev')) $('dRev').textContent = inr(totals.revenue || 0);
  if ($('dCount')) $('dCount').textContent = totals.count || 0;
  if ($('dAvg')) $('dAvg').textContent = inr(totals.avg || 0);
  if ($('dAct')) $('dAct').textContent = totals.activeMembers || 0;

  if ($('fUser')) {
    const sel = $('fUser').value;
    $('fUser').innerHTML = '<option value="">All members</option>' +
      memberOptions.map(m => `<option value="${esc(m.user)}">${esc(m.name)}</option>`).join('');
    $('fUser').value = sel;
  }

  try {
    mkChart('chTrend', {
      type: 'line',
      data: {
        labels: trend.map(t => t.date),
        datasets: [{
          label: 'Revenue',
          data: trend.map(t => Number(t.total) || 0),
          borderColor: '#c8a46a',
          backgroundColor: 'rgba(200,164,106,.15)',
          fill: true,
          tension: .3,
          pointRadius: 2
        }]
      },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: tooltipCfg },
        scales: { y: { beginAtZero: true, ticks: { callback: fmtAxis } }, x: { ticks: { maxTicksLimit: 10, autoSkip: true } } }
      }
    });
  } catch (err) { console.warn('chTrend error:', err); }

  try {
    const mem = members.filter(m => (Number(m.total) || 0) > 0);
    mkChart('chMembers', {
      type: 'bar',
      data: {
        labels: mem.map(m => m.name),
        datasets: [{
          label: 'Revenue',
          data: mem.map(m => Number(m.total) || 0),
          backgroundColor: '#c8a46a',
          borderRadius: 6
        }]
      },
      options: {
        indexAxis: 'y',
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: tooltipCfg },
        scales: { x: { beginAtZero: true, ticks: { callback: fmtAxis } }, y: { grid: { display: false } } }
      }
    });
  } catch (err) { console.warn('chMembers error:', err); }

  try {
    const payColors = {
      'Cash': '#16a34a',
      'UPI': '#4f46e5',
      'Pending': '#f59e0b',
      'Card': '#8a8780'
    };
    const bgColors = payments.map(p => payColors[p.mode] || '#c8a46a');
    mkChart('chPay', {
      type: 'doughnut',
      data: {
        labels: payments.map(p => p.mode),
        datasets: [{
          data: payments.map(p => Number(p.total) || 0),
          backgroundColor: bgColors,
          borderWidth: 0
        }]
      },
      options: {
        maintainAspectRatio: false,
        cutout: '65%',
        plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: c => c.label + ': ' + inr(c.parsed) } } }
      }
    });
  } catch (err) { console.warn('chPay error:', err); }

  try {
    mkChart('chSvc', {
      type: 'bar',
      data: {
        labels: services.map(s => s.name),
        datasets: [{
          label: 'Revenue',
          data: services.map(s => Math.round(Number(s.total) || 0)),
          backgroundColor: '#1c1c1a',
          borderRadius: 6
        }]
      },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: tooltipCfg },
        scales: { y: { beginAtZero: true, ticks: { callback: fmtAxis } }, x: { grid: { display: false } } }
      }
    });
  } catch (err) { console.warn('chSvc error:', err); }

  if ($('mList')) {
    $('mList').innerHTML = members.length ? members.map(m => `
      <div class="mrow"><div><b>${esc(m.name)}</b><small>${m.count} ${m.count === 1 ? 'entry' : 'entries'}</small></div>
      <div class="amt">${inr(m.total || 0)}</div>
      <div><div class="prog"><i style="width:${Math.min(m.share || 0, 100)}%"></i></div><span class="prog-lbl">${m.share || 0}% of revenue</span></div>
      <div style="font-size:12px;color:var(--mute)">${m.count ? inr(Math.round((m.total || 0) / m.count)) + ' avg' : '—'}</div></div>`).join('')
      : '<div class="empty">No team members yet</div>';
  }
}

// ---- Google Sheet Connection Indicator ----
let consecutiveConnErrors = 0;
async function checkSheetConn(interactive = false) {
  const dot = $('sheetStatusDot');
  const pill = $('sheetStatusIndicator');
  const txt = $('sheetStatusText');

  // Only show checking state if user explicitly clicked indicator
  if (interactive) {
    if (dot) dot.className = 'sheet-status-dot syncing';
    if (txt) txt.textContent = 'Checking…';
    if (pill) pill.setAttribute('title', 'Checking Google Sheet connection…');
  }

  if (!navigator.onLine) {
    if (dot) dot.className = 'sheet-status-dot offline';
    if (txt) txt.textContent = 'Device Offline';
    if (pill) pill.setAttribute('title', '⚡ Device is offline (No internet connection)');
    if (interactive) showPrompt('⚡ Device is offline — connect to internet', 'offline');
    return null;
  }

  try {
    const st = await api('/api/sync/status');
    consecutiveConnErrors = 0;
    if (st && st.configured) {
      if (dot) dot.className = 'sheet-status-dot online';
      if (txt) txt.textContent = 'Sheet Connected';
      if (pill) pill.setAttribute('title', '🟢 Google Sheet Connected (Click to re-check)');
      if (interactive) showPrompt('🟢 Google Sheet is active & connected!', 'success');
    } else {
      if (dot) dot.className = 'sheet-status-dot offline';
      if (txt) txt.textContent = 'Not Configured';
      if (pill) pill.setAttribute('title', '⚠️ Google Sheet Not Configured in config.json');
      if (interactive) showPrompt('⚠️ Google Sheet URL not configured', 'warn');
    }
    return st;
  } catch (e) {
    consecutiveConnErrors++;
    // Only turn red if multiple consecutive background checks fail or user requested check
    if (consecutiveConnErrors >= 2 || interactive) {
      if (dot) dot.className = 'sheet-status-dot offline';
      if (txt) txt.textContent = 'Connection Issue';
      if (pill) pill.setAttribute('title', '⚠️ Connection Issue: ' + e.message);
      if (interactive) showPrompt('⚠️ Unable to verify Sheet connection: ' + e.message, 'warn');
    }
    return null;
  }
}

// ---- Owner Notifications for Pending Team Approvals ----
async function checkOwnerNotifications() {
  if (role !== 'admin') return;
  try {
    const data = await api('/api/admin/notifications');
    const banner = $('pendingOwnerBanner');
    if (data && data.count > 0) {
      if (banner) {
        banner.classList.remove('hide');
        const names = data.pendingUsers.map(u => u.name).join(', ');
        if ($('pobTitle')) $('pobTitle').textContent = `${data.count} team member${data.count > 1 ? 's' : ''} awaiting approval`;
        if ($('pobDesc')) $('pobDesc').textContent = `Approve ${names} to grant access`;
      }
    } else {
      if (banner) banner.classList.add('hide');
    }
  } catch {}
}

function openPendingApprovals() {
  tab(3);
  const paBox = $('pendingApprovalsBox');
  if (paBox) {
    paBox.scrollIntoView({ behavior: 'smooth' });
    paBox.style.animation = 'highlightPulse 1.5s ease';
  }
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
  updateSidebarInfo();
  syncPendingSales();
  checkSheetConn();
  if (role === 'admin') {
    checkOwnerNotifications();
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
    // Google Sheet (via server) is the confirmed source of truth
    // Only combine with unsynced offline queue items currently in local storage
    const q = getOfflineQueue();
    const map = new Map();
    for (const s of norm(d.sales)) map.set(String(s.id), s);
    for (const s of q) if (s && s.id) map.set(String(s.id), normSale(s));
    const merged = Array.from(map.values()).sort((a, b) => String(b.date).localeCompare(String(a.date)) || Number(b.id) - Number(a.id));
    sales = merged;
    allSales = merged;
    renderSales();
    stats();
  }
  updateNetStatus();
  updateSidebarInfo();
  syncPendingSales();
  if (role === 'admin') {
    refreshTeamUsers();
    loadAllSales();
  }
  setTimeout(refreshSalesFromSheet, 1500);
  saveSessionCache(d);
}

async function logout(message){
  isLoggingOut = true;
  closeSidebar();
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

// Periodic Google Sheet connection status & owner notifications poller
setInterval(() => {
  if (token && user) {
    checkSheetConn();
    if (role === 'admin') {
      checkOwnerNotifications();
    }
  }
}, 25000);

