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

// ---- mobile auto-sync & offline storage ----
const OFFLINE_KEY = () => 'offline_sales_' + (user || 'guest');
function getOfflineQueue() {
  try { return JSON.parse(localStorage.getItem(OFFLINE_KEY()) || '[]'); } catch { return []; }
}
function saveOfflineQueue(q) {
  try { localStorage.setItem(OFFLINE_KEY(), JSON.stringify(q)); } catch {}
}
function queueOfflineSale(s) {
  const q = getOfflineQueue();
  if (!q.some(x => x.id === s.id)) {
    q.push(s);
    saveOfflineQueue(q);
  }
}
let isSyncing = false;
let syncSuccessTimer = null;

async function syncPendingSales() {
  if (isSyncing || !token) return;
  const q = getOfflineQueue();
  if (!q.length) {
    updateNetStatus();
    return;
  }
  if (!navigator.onLine) {
    updateNetStatus();
    return;
  }
  isSyncing = true;
  updateNetStatus();
  try {
    const res = await api('/api/sales/sync', {
      method: 'POST',
      body: { sales: q }
    });
    if (res && res.ok) {
      saveOfflineQueue([]);
      if (Array.isArray(res.sales)) {
        sales = norm(res.sales);
        if (role === 'admin') loadAllSales();
        renderSales();
        stats();
      }
      showSyncedBanner(res.synced || q.length);
    }
  } catch (e) {
    console.warn('Auto-sync retry failed:', e.message);
  } finally {
    isSyncing = false;
    updateNetStatus();
  }
}

function showSyncedBanner(count) {
  const el = $('netStatus');
  if (!el) return;
  clearTimeout(syncSuccessTimer);
  el.className = 'net-status synced';
  el.innerHTML = `<span>✓ ${count} sale${count === 1 ? '' : 's'} synced automatically with Google Sheet</span>`;
  syncSuccessTimer = setTimeout(() => { updateNetStatus(); }, 4000);
}

function updateNetStatus() {
  const el = $('netStatus');
  if (!el || !user) return;
  const q = getOfflineQueue();
  if (isSyncing) {
    el.className = 'net-status syncing';
    el.innerHTML = '<span>↻ Connecting & syncing with Google Sheet...</span>';
    return;
  }
  if (!navigator.onLine) {
    el.className = 'net-status offline';
    el.innerHTML = `<span>⚡ Offline mode — ${q.length ? q.length + ' entry(s) saved on mobile' : 'Ready'}. Auto-syncs once reconnected.</span>`;
    return;
  }
  if (q.length > 0) {
    el.className = 'net-status offline';
    el.innerHTML = `<span>⚡ ${q.length} sale${q.length === 1 ? '' : 's'} waiting to sync with Google Sheet</span><button class="sync-btn" onclick="syncPendingSales()">Sync now</button>`;
    return;
  }
  el.className = 'net-status hide';
  el.innerHTML = '';
}

window.addEventListener('online', () => {
  updateNetStatus();
  syncPendingSales();
});
window.addEventListener('offline', () => {
  updateNetStatus();
});
setInterval(() => {
  if (navigator.onLine && getOfflineQueue().length > 0) {
    syncPendingSales();
  }
}, 8000);

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
const norm=a=>(a||[]).map(s=>s.items?s:{id:s.id,items:[{name:s.service,cat:s.cat,price:s.price,qty:s.qty}],calc:s.total,total:s.total,pay:s.pay,date:s.date,note:s.note||''});
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
    </div>`).join('')+`<div class="svc add" onclick="openSvc()"><div style="font-size:26px">＋</div><p>Add service</p></div>`;
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

  if (!navigator.onLine) {
    queueOfflineSale(saleObj);
    sales.unshift(saleObj);
    if(role==='admin') allSales.unshift({...saleObj,by:user,byName:uname});
    cart={};closeM('mSale');renderSvc();updateCart();stats();
    updateNetStatus();
    renderSales();
    return;
  }

  try{
    const sale=await api('/api/sales',{method:'POST',body:saleObj});
    sales.unshift(sale);
    if(role==='admin')allSales.unshift({...sale,by:user,byName:uname});
    cart={};closeM('mSale');renderSvc();updateCart();stats();
    syncPendingSales();
  }catch(e){
    if (e.isNetwork || !navigator.onLine) {
      queueOfflineSale(saleObj);
      sales.unshift(saleObj);
      if(role==='admin') allSales.unshift({...saleObj,by:user,byName:uname});
      cart={};closeM('mSale');renderSvc();updateCart();stats();
      updateNetStatus();
      renderSales();
    } else {
      alert(e.message);
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
function activeSales(){
  if(role!=='admin')return sales;
  const v=$('sm').value;
  return v?allSales.filter(s=>s.by===v):allSales;
}
async function loadAllSales(){
  try{allSales=(await api('/api/admin/sales')).sales;renderSales()}catch(e){alert(e.message)}
}
function filtered(){
  const q=$('sq').value.toLowerCase(),d=$('sd').value,p=$('sp').value;
  return activeSales().filter(s=>(!q||(names(s)+s.note).toLowerCase().includes(q))&&(!d||s.date===d)&&(!p||s.pay===p));
}
const names=s=>s.items.map(i=>i.name+(i.qty>1?' ×'+i.qty:'')).join(', ');
function renderSales(){
  const l=filtered();
  const qIds = new Set(getOfflineQueue().map(x => x.id));
  $('list').innerHTML=l.length?l.map(s=>`
    <div class="item"><div><b>${esc(names(s))}</b>
    <small>${s.date} · ${s.pay}${role==='admin'&&s.byName?' · '+esc(s.byName):''}${s.note?' · '+esc(s.note):''}${s.total!==s.calc?' · adjusted from '+inr(s.calc):''}${qIds.has(s.id)?' · <span style="color:#a5731f;font-weight:600">⚡ Queued for sheet</span>':''}</small></div>
    <div class="amt">${inr(s.total)}</div><button class="del" onclick="delSale(${s.id})" title="Delete">✕</button></div>`).join('')
    :'<div class="empty">No sales found</div>';
  $('ft').textContent=inr(l.reduce((a,s)=>a+s.total,0));
}
async function delSale(id){
  if(!confirm('Delete this entry?'))return;
  const s=activeSales().find(x=>x.id===id);
  try{
    if(role==='admin'&&s)await api('/api/admin/sales/'+s.by+'/'+id,{method:'DELETE'});
    else await api('/api/sales/'+id,{method:'DELETE'});
    sales=sales.filter(x=>x.id!==id);
    allSales=allSales.filter(x=>!(x.id===id&&x.by===(s?s.by:user)));
    renderSales();stats()
  }catch(e){alert(e.message)}
}
function clearF(){$('sq').value='';$('sd').value='';$('sp').value='';if(role==='admin')$('sm').value='';renderSales()}
function stats(){
  const t=today(),m=t.slice(0,7);
  $('sToday').textContent=inr(sales.filter(s=>s.date===t).reduce((a,s)=>a+s.total,0));
  $('sMonth').textContent=inr(sales.filter(s=>s.date.startsWith(m)).reduce((a,s)=>a+s.total,0));
  $('sCount').textContent=sales.filter(s=>s.date===t).length;
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
    (s.lastOk?'<span class="pill">last push '+new Date(s.lastOk).toLocaleTimeString()+'</span>':'')+
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
    return `
    <div class="item"><div><b>${esc(u.name)}</b><small>@${esc(u.user)} · joined ${u.created?u.created.slice(0,10):'—'}</small></div>
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
// ---- auth ----
let mode='in';
function authMode(m){
  mode=m;
  $('aIn').classList.toggle('on',m==='in');
  $('aUp').classList.toggle('on',m==='up');
  $('aBtn').textContent=m==='in'?'Log in':'Register Staff Account';
  $('aSub').textContent=m==='in'?'Log in to record sales':'Staff registration';
  if($('aUpNotice')) $('aUpNotice').classList.toggle('hide', m==='in');
  $('aErr').textContent='';
  $('aErr').className='err';
}
async function submitAuth(){
  const n=$('aUser').value.trim(),pw=$('aPass').value;
  const e=(t,ok)=>{$('aErr').textContent=t;$('aErr').className=ok?'err ok':'err'};
  if(n.length<3||pw.length<4)return e('Username: min 3 characters. Password: min 4.');
  if(!/^[a-z0-9_.-]+$/.test(n))return e('Username: letters, numbers, . _ - only');
  try{
    const r=await api('/api/auth/'+(mode==='up'?'signup':'login'),{method:'POST',body:{username:n,password:pw}});
    if(r.pending){
      authMode('in');
      e('Staff account created — the owner must approve it before you can log in.',true);
      $('aUser').value=n;$('aPass').value='';
      return;
    }
    token=r.token;localStorage.setItem('token',token);
    start(r);
  }catch(err){e(err.message)}
}
function start(d){
  user=d.user;uname=d.name;role=d.role||'member';custom=d.custom||[];sales=norm(d.sales);allSales=[];cart={};cat='All';
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
  if(role==='admin')refreshTeamUsers();
}
async function logout(){
  try{await api('/api/auth/logout',{method:'POST'})}catch{}
  token='';localStorage.removeItem('token');user='';role='member';cart={};allSales=[];teamUsers=[];
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
