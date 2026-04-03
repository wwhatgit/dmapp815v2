/* DMapp · BIS v2 — app.js
   MapLibre removed. Google Maps external. Recording console Drive tab.
   Plan export/import. Proximity alerts with beep.
*/
'use strict';

/* ══ CONSTANTS ══════════════════════════════════════════════════ */
const APPS_SCRIPT_URL  = 'https://script.google.com/macros/s/AKfycby0fwHY3YI8odvV-QZ1TKwnJbe12hm1b83JqaDHS3dw4OZYeyyGeYwzp8JYjyl8K2VM/exec';
const SHEET_ID         = '1jqtFYsChM8DYC2H4_VPD31QyfeJBA8aQkyEwlNIH4XM';
const PERMANENT_SHEET  = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID;
const OSRM_BASE        = 'https://router.project-osrm.org/route/v1/driving';
const SPEED_KMH        = 50;
const GNSS_GOOD        = 15;   // metres accuracy threshold
const PROX_DIST        = 30;   // metres proximity alert threshold
const APP_VERSION      = '2026.04.03.05';
const PLAN_VERSION     = 'DMAPP v2';
const MAX_GMAPS_WP     = 9;    // Google Maps max intermediate waypoints

const RESULT_HEADERS = ['Zone','Run','LinkID','Service','From','To',
  'PlannedStartLat','PlannedStartLng','ActualStartLat','ActualStartLng','StartFlag',
  'PlannedEndLat','PlannedEndLng','ActualEndLat','ActualEndLng','EndFlag',
  'GPSDist','RouteDist','DateTime','User','Remarks'];

const CL_COLS = ['#2563eb','#16a34a','#d97706','#dc2626','#7c3aed','#0891b2','#be185d','#059669'];

/* ══ APP STATE ══════════════════════════════════════════════════ */
const S = {
  driverName:'DRIVER',
  plan:[], stops:{}, links:{},
  journeySteps:[], currentStepIdx:0,
  clusterResult:null, originalPlanOrder:null,
  records:[], gnssWatchId:null,
  trackingActive:false, gnssDist:0, gnssPoints:[],
  lastPos:null, startCoord:null, endCoord:null,
  plannedStartLat:'', plannedStartLng:'',
  plannedEndLat:'',   plannedEndLng:'',
  startFlag:'', endFlag:'',
  plannerMap:null, plannerMarkers:[], driveStopMarkers:[],
  appsScriptUrl: APPS_SCRIPT_URL,
  // Overrideable constants
  gnssGood: GNSS_GOOD,
  proxDist: PROX_DIST,
  speedKmh: SPEED_KMH,
  // Audio
  audioCtx: null, audioUnlocked: false, muteBeep: false,
  // Proximity tracking
  proxAlertedFrom: false, proxAlertedTo: false,
  proxBeepInterval: null,
  // Planner
  selectedLinkIdx: null,    // highlighted link index in planner map
  optStartMode: 'current',  // 'current' or 'first'
  zoneMapOverrides: {},     // {z0: url, z1: url, dead_0_1: url, ...}
};

/* ══ SETTINGS ════════════════════════════════════════════════════ */
function saveSettings(){
  try{ localStorage.setItem('dms', JSON.stringify({driverName:S.driverName})); }catch(e){}
}
function loadSettings(){
  try{
    const d = JSON.parse(localStorage.getItem('dms')||'{}');
    S.driverName = d.driverName||'DRIVER';
  }catch(e){}
  // Apply admin overrides
  const ov = getAdminOverrides();
  if(ov.appsScriptUrl) S.appsScriptUrl = ov.appsScriptUrl;
  if(ov.gnssGood)      S.gnssGood      = parseInt(ov.gnssGood);
  if(ov.proxDist)      S.proxDist      = parseInt(ov.proxDist);
  if(ov.speedKmh)      S.speedKmh      = parseInt(ov.speedKmh);
}

/* ══ PLAN CACHE ══════════════════════════════════════════════════ */
function savePlanCache(){
  try{ localStorage.setItem('dmp', JSON.stringify({plan:S.plan, stops:S.stops, links:S.links})); }catch(e){}
}
function loadPlanCache(){
  try{
    const d = JSON.parse(localStorage.getItem('dmp')||'{}');
    if(d.plan && d.plan.length){ S.plan=d.plan; S.stops=d.stops||{}; S.links=d.links||{}; return true; }
  }catch(e){}
  return false;
}

/* ══ SESSION ════════════════════════════════════════════════════ */
function saveSession(){
  try{
    localStorage.setItem('dm_session', JSON.stringify({
      plan:S.plan, stops:S.stops, links:S.links,
      journeySteps:S.journeySteps, currentStepIdx:S.currentStepIdx,
      clusterResult:S.clusterResult, records:S.records,
      driverName:S.driverName, zoneMapOverrides:S.zoneMapOverrides||{},
      savedAt:toSGT(new Date())
    }));
  }catch(e){ console.warn('saveSession error:',e); }
}
function checkSavedSession(){
  try{
    const d = JSON.parse(localStorage.getItem('dm_session')||'{}');
    if(d.journeySteps && d.journeySteps.length && d.currentStepIdx < d.journeySteps.length) return d;
  }catch(e){}
  return null;
}
function restoreSession(sess){
  S.plan          = sess.plan          || [];
  S.stops         = sess.stops         || {};
  S.links         = sess.links         || {};
  S.journeySteps  = sess.journeySteps  || [];
  S.currentStepIdx= sess.currentStepIdx|| 0;
  S.clusterResult    = sess.clusterResult    || null;
  S.records          = sess.records          || [];
  S.zoneMapOverrides = sess.zoneMapOverrides || {};
  if(sess.driverName) S.driverName = sess.driverName;
}
function clearSession(){
  localStorage.removeItem('dm_session');
  localStorage.removeItem('dm_recs');
  S.journeySteps=[]; S.currentStepIdx=0; S.records=[];
  S.clusterResult=null; S.plan=[]; S.stops={}; S.links={};
}
function getCurrentStep(){ return S.journeySteps[S.currentStepIdx]||null; }

/* ══ DATETIME ════════════════════════════════════════════════════ */
function toSGT(date){
  const sgt = new Date(date.getTime() + 8*60*60*1000);
  const iso  = sgt.toISOString();
  return iso.slice(0,10) + ' ' + iso.slice(11,19);
}

/* ══ TOAST ═══════════════════════════════════════════════════════ */
let _toastTimer = null;
function toast(msg, type='info'){
  const el = document.getElementById('toast');
  if(!el) return;
  el.textContent = msg;
  el.className = 'toast ' + type;
  el.classList.remove('hidden');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(()=>el.classList.add('hidden'), 3000);
}
function showStatus(id, msg, type='info'){
  const el = document.getElementById(id);
  if(!el) return;
  el.textContent = msg;
  el.className = 'status-msg ' + type;
  el.classList.remove('hidden');
}

/* ══ AUDIO / BEEP ════════════════════════════════════════════════ */
function unlockAudio(){
  if(S.audioUnlocked) return;
  try{
    S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // Play a silent buffer to unlock
    const buf = S.audioCtx.createBuffer(1,1,22050);
    const src = S.audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(S.audioCtx.destination);
    src.start(0);
    S.audioUnlocked = true;
  }catch(e){}
}
function beep(frequency=880, duration=150, volume=0.25){
  if(S.muteBeep) return;
  try{
    if(!S.audioCtx) S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if(S.audioCtx.state === 'suspended') S.audioCtx.resume();
    const osc  = S.audioCtx.createOscillator();
    const gain = S.audioCtx.createGain();
    osc.connect(gain);
    gain.connect(S.audioCtx.destination);
    osc.frequency.value = frequency;
    osc.type = 'sine';
    gain.gain.setValueAtTime(volume, S.audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, S.audioCtx.currentTime + duration/1000);
    osc.start();
    osc.stop(S.audioCtx.currentTime + duration/1000);
  }catch(e){}
}
function beepApproachFrom(){ beep(880,120,0.25); setTimeout(()=>beep(880,120,0.25), 180); }
function beepApproachTo(){   beep(1100,120,0.25); setTimeout(()=>beep(1100,120,0.25), 180); setTimeout(()=>beep(1100,120,0.25), 360); }
function beepStart(){        beep(660,200,0.2); }
function beepStop(){         beep(1320,250,0.2); }
function beepSaved(){        beep(1100,100,0.15); setTimeout(()=>beep(1320,150,0.2), 150); }

/* ══ GNSS ════════════════════════════════════════════════════════ */
function startGNSSWatch(){
  if(S.gnssWatchId != null) return;
  S.gnssWatchId = navigator.geolocation.watchPosition(
    onGNSSUpdate,
    onGNSSError,
    { enableHighAccuracy:true, maximumAge:1000, timeout:15000 }
  );
  console.log('GNSS watch started');
}
function stopGNSSWatch(){
  if(S.gnssWatchId != null){ navigator.geolocation.clearWatch(S.gnssWatchId); S.gnssWatchId=null; }
}
function onGNSSUpdate(pos){
  const lat = pos.coords.latitude;
  const lng = pos.coords.longitude;
  const acc = pos.coords.accuracy;
  S.lastPos = {lat, lng, acc};

  // Update UI
  document.getElementById('gps-lat').textContent = lat.toFixed(6);
  document.getElementById('gps-lng').textContent = lng.toFixed(6);
  document.getElementById('accuracy-pill').textContent = '±'+Math.round(acc)+'m';
  document.getElementById('accuracy-pill').className = 'acc-inline' + (acc<=S.gnssGood?' acc-good':acc<=35?' acc-ok':' acc-poor');
  document.getElementById('gnss-bar-acc').textContent = '±'+Math.round(acc)+'m';

  const isGood = acc <= S.gnssGood;
  updateGNSSPill(isGood ? 'locked' : acc<=35 ? 'poor' : 'waiting');

  // Accumulate distance
  if(S.trackingActive && isGood){
    if(S.gnssPoints.length > 0){
      const prev = S.gnssPoints[S.gnssPoints.length-1];
      const d = optHaversine(prev.lat, prev.lng, lat, lng);
      if(d >= 0.5 && d <= 200){
        S.gnssDist += d;
        const km = (S.gnssDist/1000).toFixed(3);
        document.getElementById('gnss-bar-dist').textContent = km + ' km';
        document.getElementById('gps-dist-display').textContent = km;
      }
    }
    S.gnssPoints.push({lat, lng, acc});
  }

  // Proximity alerts
  checkProximityAlerts(lat, lng, acc);
}
function onGNSSError(err){
  console.warn('GNSS error:', err.code, err.message);
  updateGNSSPill('waiting');
}
function updateGNSSPill(state){
  const pill = document.getElementById('gnss-status-pill');
  const lbl  = document.getElementById('gnss-label');
  if(!pill) return;
  pill.className = 'gnss-pill gnss-' + state;
  lbl.textContent = state==='locked'?'GNSS ✓':state==='poor'?'GNSS ~':'GNSS';
}

/* ══ PROXIMITY ALERTS ════════════════════════════════════════════ */
function checkProximityAlerts(lat, lng, acc){
  const step = getCurrentStep();
  if(!step) return;
  const link  = S.plan[step.planIdx];
  if(!link) return;
  const f = S.stops[link.fromStop]||{};
  const t = S.stops[link.toStop]  ||{};
  const bar = document.getElementById('proximity-alert');
  const txt = document.getElementById('proximity-alert-text');

  // Before START: alert when near FROM stop
  if(!S.trackingActive && f.lat && f.lng){
    const d = optHaversine(lat, lng, f.lat, f.lng);
    if(d <= S.proxDist){
      bar.className = 'proximity-alert prox-start';
      txt.textContent = '📍 Near FROM stop ' + link.fromStop + ' — tap START';
      bar.classList.remove('hidden');
      if(!S.proxAlertedFrom){
        S.proxAlertedFrom = true;
        beepApproachFrom();
        // Repeat beep every 12s while in range
        clearInterval(S.proxBeepInterval);
        S.proxBeepInterval = setInterval(()=>{
          if(!S.trackingActive && S.lastPos){
            const dd = optHaversine(S.lastPos.lat, S.lastPos.lng, f.lat, f.lng);
            if(dd <= S.proxDist) beepApproachFrom();
            else { clearInterval(S.proxBeepInterval); S.proxAlertedFrom=false; }
          } else { clearInterval(S.proxBeepInterval); }
        }, 12000);
      }
      return;
    } else {
      if(S.proxAlertedFrom){ S.proxAlertedFrom=false; clearInterval(S.proxBeepInterval); }
    }
  }

  // During recording: alert when near TO stop
  if(S.trackingActive && t.lat && t.lng){
    const d = optHaversine(lat, lng, t.lat, t.lng);
    if(d <= S.proxDist){
      bar.className = 'proximity-alert prox-stop';
      txt.textContent = '🛑 Near TO stop ' + link.toStop + ' — tap STOP';
      bar.classList.remove('hidden');
      if(!S.proxAlertedTo){
        S.proxAlertedTo = true;
        beepApproachTo();
        clearInterval(S.proxBeepInterval);
        S.proxBeepInterval = setInterval(()=>{
          if(S.trackingActive && S.lastPos){
            const dd = optHaversine(S.lastPos.lat, S.lastPos.lng, t.lat, t.lng);
            if(dd <= S.proxDist) beepApproachTo();
            else { clearInterval(S.proxBeepInterval); S.proxAlertedTo=false; }
          } else { clearInterval(S.proxBeepInterval); }
        }, 12000);
      }
      return;
    } else {
      if(S.proxAlertedTo){ S.proxAlertedTo=false; clearInterval(S.proxBeepInterval); }
    }
  }

  // Hide alert if not near anything
  if(!bar.classList.contains('hidden')) bar.classList.add('hidden');
}
function resetProximityState(){
  S.proxAlertedFrom = false;
  S.proxAlertedTo   = false;
  clearInterval(S.proxBeepInterval);
  const bar = document.getElementById('proximity-alert');
  if(bar) bar.classList.add('hidden');
}

/* ══ HAVERSINE ═══════════════════════════════════════════════════ */
function optHaversine(lat1,lng1,lat2,lng2){
  const R=6371000, dL=(lat2-lat1)*Math.PI/180, dl=(lng2-lng1)*Math.PI/180;
  const a=Math.sin(dL/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dl/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

/* ══ SCREEN SWITCHING ════════════════════════════════════════════ */
function switchScreen(name){
  document.querySelectorAll('.screen').forEach(s=>s.classList.add('hidden'));
  document.querySelectorAll('.nav-tab').forEach(b=>b.classList.remove('active'));
  const sc = document.getElementById('screen-'+name);
  if(sc) sc.classList.remove('hidden');
  const tab = document.querySelector('.nav-tab[data-screen="'+name+'"]');
  if(tab) tab.classList.add('active');
  if(name==='task')     initTaskTab();
  if(name==='planner')  { if(!S.plannerMap) initPlannerMap(); renderPlannerUI(); initPlannerSubTabs(); }
  if(name==='drive')    renderDriveConsole();
  if(name==='overview') renderOverview();
}

/* ══ COLLAPSIBLE CARDS ═══════════════════════════════════════════ */
function initCollapsible(){
  document.querySelectorAll('.card-toggle').forEach(hdr=>{
    hdr.addEventListener('click',function(e){
      if(e.target.closest('button,.list-actions')) return;
      const tid=this.dataset.target; if(!tid) return;
      const body=document.getElementById(tid);
      const arr=document.getElementById('arrow-'+tid);
      if(!body) return;
      const open=body.classList.contains('open');
      body.classList.toggle('open',!open);
      if(arr) arr.classList.toggle('open',!open);
      if(!open&&tid==='map-body'&&S.plannerMap) setTimeout(()=>S.plannerMap.invalidateSize(),300);
    });
  });
}

/* ══ LOCATION PERMISSION ════════════════════════════════════════ */
function requestLocationPermission(cb){
  const modal = document.getElementById('location-modal');
  const httpsWarn  = document.getElementById('loc-https-warn');
  const deniedWarn = document.getElementById('loc-denied-warn');
  const actions    = document.getElementById('loc-actions');
  const status     = document.getElementById('loc-status');
  if(location.protocol !== 'https:' && location.hostname !== 'localhost'){
    if(httpsWarn) httpsWarn.classList.remove('hidden');
    if(modal) modal.classList.remove('hidden');
    cb(false); return;
  }
  if(!('geolocation' in navigator)){ cb(false); return; }
  document.getElementById('loc-allow-btn').onclick = () => {
    status.textContent = 'Requesting location…';
    status.className = 'status-msg info'; status.classList.remove('hidden');
    navigator.geolocation.getCurrentPosition(
      ()=>{ modal.classList.add('hidden'); cb(true); },
      (err)=>{
        deniedWarn.classList.remove('hidden'); actions.style.display='none';
        status.className='status-msg hidden'; cb(false);
      },
      {enableHighAccuracy:true,timeout:10000}
    );
  };
  document.getElementById('loc-deny-btn').onclick = () => { modal.classList.add('hidden'); cb(false); };
  document.getElementById('loc-close-btn').onclick = () => { modal.classList.add('hidden'); cb(false); };
  modal.classList.remove('hidden');
}

/* ══ JSONP FETCH / SAVE ══════════════════════════════════════════ */
function jsonpFetch(url, params){
  return new Promise((res,rej)=>{
    const cb='__df'+Date.now()+'_'+Math.floor(Math.random()*9999);
    const to=setTimeout(()=>{cleanup();rej(new Error('Timeout'));},20000);
    window[cb]=d=>{cleanup();res(d);};
    function cleanup(){clearTimeout(to);delete window[cb];const el=document.getElementById(cb);if(el)el.remove();}
    const p=Object.assign({callback:cb},params);
    const qs=Object.keys(p).map(k=>encodeURIComponent(k)+'='+encodeURIComponent(String(p[k]||''))).join('&');
    const sc=document.createElement('script');sc.id=cb;
    sc.src=url+(url.indexOf('?')>=0?'&':'?')+qs;
    sc.onerror=()=>{cleanup();rej(new Error('Script load failed'));};
    document.head.appendChild(sc);
  });
}
function jsonpSave(url,rec){
  return new Promise((res,rej)=>{
    const cb='__ds'+Date.now()+'_'+Math.floor(Math.random()*9999);
    const to=setTimeout(()=>{cleanup();res({status:'timeout'});},15000);
    window[cb]=d=>{cleanup();res(d);};
    function cleanup(){clearTimeout(to);delete window[cb];const el=document.getElementById(cb);if(el)el.remove();}
    const p=Object.assign({action:'saveResult',callback:cb},rec);
    const qs=Object.keys(p).map(k=>encodeURIComponent(k)+'='+encodeURIComponent(String(p[k]||''))).join('&');
    const sc=document.createElement('script');sc.id=cb;
    sc.src=url+(url.indexOf('?')>=0?'&':'?')+qs;
    sc.onerror=()=>{cleanup();rej(new Error('Save failed'));};
    document.head.appendChild(sc);
  });
}

/* ══ STOP FLAG MODAL ════════════════════════════════════════════ */
function showFlagModal(stopCode,stopName,plannedLat,plannedLng,callback,cancelCallback){
  const modal=document.getElementById('flag-modal');
  const info=document.getElementById('flag-stop-info');
  const distEl=document.getElementById('flag-distance-info');
  info.textContent='Stop '+stopCode+' — '+stopName;
  if(S.lastPos&&plannedLat){
    const dm=optHaversine(S.lastPos.lat,S.lastPos.lng,plannedLat,plannedLng);
    distEl.textContent='You are '+Math.round(dm)+'m from planned position';
  } else { distEl.textContent=''; }
  modal.classList.remove('hidden');
  document.getElementById('flag-atstop-btn').onclick=()=>{modal.classList.add('hidden');callback('AT_STOP');};
  document.getElementById('flag-relocated-btn').onclick=()=>{modal.classList.add('hidden');callback('RELOCATED');};
  document.getElementById('flag-cancel-btn').onclick=()=>{modal.classList.add('hidden');if(cancelCallback)cancelCallback();};
}

/* ══ SPLASH ══════════════════════════════════════════════════════ */
const SEG_ON={
  '0':['a','b','c','d','e','f'],'1':['b','c'],'2':['a','b','d','e','g'],
  '3':['a','b','c','d','g'],   '4':['b','c','f','g'],'5':['a','c','d','f','g'],
  '6':['a','c','d','e','f','g'],'7':['a','b','c'],
  '8':['a','b','c','d','e','f','g'],'9':['a','b','c','d','f','g']
};
const SEG_POS={
  a:[0,10,80,9],b:[8,88,9,38],c:[54,88,9,38],d:[91,10,80,9],
  e:[54,3,9,38],f:[8,3,9,38],g:[45,10,80,9]
};
function buildDigit(el){
  Object.keys(SEG_POS).forEach(s=>{
    const d=document.createElement('div');
    d.className='seg seg-'+s;d.id=el.id+'-'+s;
    const[t,l,w,h]=SEG_POS[s];
    d.style.cssText='position:absolute;top:'+t+'%;left:'+l+'%;width:'+w+'%;height:'+h+'%;border-radius:2px;background:rgba(255,255,255,0.03);';
    el.appendChild(d);
  });
}
function setDigit(id,ch,intensity=1){
  const on=SEG_ON[ch]||[];
  const r=Math.round(255*intensity),g=Math.round(30*intensity),b=0;
  const col=`rgb(${r},${g},${b})`;
  const glow=intensity>0.5?`0 0 ${8*intensity}px ${col},0 0 ${22*intensity}px rgba(255,30,0,${0.5*intensity})`:'none';
  Object.keys(SEG_POS).forEach(s=>{
    const el=document.getElementById(id+'-'+s);
    if(!el)return;
    if(on.includes(s)){el.style.background=col;el.style.boxShadow=glow;}
    else{el.style.background='rgba(255,255,255,0.03)';el.style.boxShadow='none';}
  });
}

// ── EPIC SPLASH — EA Sports / Marvel style ──
// Phase 1: Deep space — particles + red energy streaks
// Phase 2: 815 hyper-flash — digits scramble at accelerating speed
// Phase 3: Sequential lock — each digit slams into place with flash
// Phase 4: Logo SLAM — DM slides in from left, app from right
// Phase 5: Fade out

function initSplashCanvas(){
  const cv=document.getElementById('splash-canvas');
  if(!cv)return()=>{};
  cv.width=window.innerWidth;cv.height=window.innerHeight;
  const ctx=cv.getContext('2d'),W=cv.width,H=cv.height;

  // Depth stars — 3 layers with parallax
  const layers=[
    Array.from({length:80},()=>({x:Math.random()*W,y:Math.random()*H,r:Math.random()*0.8+0.1,v:0.08,a:Math.random()*0.4+0.1})),
    Array.from({length:40},()=>({x:Math.random()*W,y:Math.random()*H,r:Math.random()*1.2+0.3,v:0.18,a:Math.random()*0.5+0.2})),
    Array.from({length:15},()=>({x:Math.random()*W,y:Math.random()*H,r:Math.random()*1.8+0.5,v:0.35,a:Math.random()*0.6+0.3})),
  ];
  // Energy streaks — converge toward centre
  const cx=W/2,cy=H/2;
  const streaks=Array.from({length:22},()=>{
    const angle=Math.random()*Math.PI*2;
    const dist=Math.random()*Math.max(W,H)*0.7+100;
    return{x:cx+Math.cos(angle)*dist,y:cy+Math.sin(angle)*dist,
      tx:cx,ty:cy,prog:Math.random(),
      len:Math.random()*60+25,speed:Math.random()*0.004+0.002,
      a:Math.random()*0.2+0.05};
  });
  // Shockwave ring (fires once at lock-in)
  let ring={active:false,r:0,maxR:Math.max(W,H)*0.8,a:0.9};

  let running=true,shockFired=false;
  window._splashFireShock=()=>{ring.active=true;ring.r=0;ring.a=0.9;};

  function frame(){
    if(!running)return;
    ctx.fillStyle='rgba(5,7,14,0.22)';
    ctx.fillRect(0,0,W,H);

    // Streaks toward centre
    streaks.forEach(s=>{
      s.prog+=s.speed;if(s.prog>1)s.prog=0;
      const t=s.prog;
      const sx=s.x+(s.tx-s.x)*t,sy=s.y+(s.ty-s.y)*t;
      const ex=s.x+(s.tx-s.x)*(t+s.speed*25);const ey=s.y+(s.ty-s.y)*(t+s.speed*25);
      const g=ctx.createLinearGradient(sx,sy,ex,ey);
      g.addColorStop(0,'transparent');g.addColorStop(1,`rgba(255,35,0,${s.a})`);
      ctx.beginPath();ctx.strokeStyle=g;ctx.lineWidth=1;
      ctx.moveTo(sx,sy);ctx.lineTo(ex,ey);ctx.stroke();
    });

    // Parallax stars
    layers.forEach((layer,li)=>{
      layer.forEach(p=>{
        p.y+=p.v;if(p.y>H){p.y=0;p.x=Math.random()*W;}
        ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
        ctx.fillStyle=`rgba(${li===2?'255,180,100':'255,80,30'},${p.a})`;ctx.fill();
      });
    });

    // Shockwave
    if(ring.active){
      ring.r+=ring.maxR*0.07;ring.a*=0.82;
      ctx.beginPath();ctx.arc(cx,cy,ring.r,0,Math.PI*2);
      ctx.strokeStyle=`rgba(255,55,0,${ring.a})`;
      ctx.lineWidth=ring.r*0.04;ctx.stroke();
      if(ring.a<0.01)ring.active=false;
    }
    requestAnimationFrame(frame);
  }
  ctx.fillStyle='rgb(5,7,14)';ctx.fillRect(0,0,W,H);
  frame();
  return()=>{running=false;};
}

function runSplash(){
  const cells=['sd-0','sd-1','sd-2'];
  cells.forEach(id=>{
    const el=document.getElementById(id);
    if(el){el.style.cssText='position:relative;width:64px;height:108px;';buildDigit(el);}
  });
  const stopCanvas=initSplashCanvas();
  const DIGITS='0123456789';

  // Phase 1: silence — let particles breathe (400ms)
  // Phase 2: hyper-flash — 40 frames accelerating
  const intervals=[80,75,70,65,60,55,50,46,42,38,35,32,29,26,24,22,20,18,16,15,
                   14,13,12,11,10,9,8,8,7,7,6,6,5,5,4,4,4,4,3,3,3];
  let fi=0;
  function doFlash(){
    cells.forEach(id=>setDigit(id,DIGITS[Math.floor(Math.random()*10)]));
    fi++;
    if(fi<intervals.length)setTimeout(doFlash,intervals[fi]||3);
    else lockIn();
  }
  setTimeout(doFlash,400);

  function lockIn(){
    // Fire shockwave at lock-start
    if(window._splashFireShock)window._splashFireShock();

    let s=0;
    function lock0(){
      if(s<10){
        setDigit('sd-0',DIGITS[Math.floor(Math.random()*10)]);
        setDigit('sd-1',DIGITS[Math.floor(Math.random()*10)]);
        setDigit('sd-2',DIGITS[Math.floor(Math.random()*10)]);
        s++;setTimeout(lock0,38);
      } else {
        // SLAM 8 — white flash then settle
        setDigit('sd-0','8',3.0);
        setTimeout(()=>setDigit('sd-0','8',1.4),60);
        setTimeout(()=>setDigit('sd-0','8',1.0),130);
        s=0;
        function lock1(){
          if(s<8){
            setDigit('sd-1',DIGITS[Math.floor(Math.random()*10)]);
            setDigit('sd-2',DIGITS[Math.floor(Math.random()*10)]);
            s++;setTimeout(lock1,44);
          } else {
            setDigit('sd-1','1',3.0);
            setTimeout(()=>setDigit('sd-1','1',1.4),60);
            setTimeout(()=>setDigit('sd-1','1',1.0),130);
            s=0;
            function lock2(){
              if(s<7){
                setDigit('sd-2',DIGITS[Math.floor(Math.random()*10)]);
                s++;setTimeout(lock2,50);
              } else {
                setDigit('sd-2','5',3.0);
                setTimeout(()=>setDigit('sd-2','5',1.4),60);
                setTimeout(()=>setDigit('sd-2','5',1.0),130);
                // Fire second shockwave on 5 lock
                setTimeout(()=>{if(window._splashFireShock)window._splashFireShock();},80);
                // All 3 pulse together
                setTimeout(()=>{
                  ['sd-0','sd-1','sd-2'].forEach(id=>setDigit(id,{'sd-0':'8','sd-1':'1','sd-2':'5'}[id],2.0));
                  setTimeout(()=>['sd-0','sd-1','sd-2'].forEach(id=>setDigit(id,{'sd-0':'8','sd-1':'1','sd-2':'5'}[id],1.0)),120);
                },300);
                // Logo reveal — DM slams from left, app from right
                setTimeout(()=>{
                  const logo=document.getElementById('splash-logo-wrap');
                  if(logo)logo.classList.add('show');
                },520);
                setTimeout(()=>{stopCanvas();endSplash();},1100);
              }
            }
            setTimeout(lock2,180);
          }
        }
        setTimeout(lock1,220);
      }
    }
    lock0();
  }
}

function endSplash(){
  const savedSess = checkSavedSession();
  if(savedSess){ _doEnterApp(null); return; }
  const nameBox = document.getElementById('splash-name-box');
  if(nameBox){
    const saved = localStorage.getItem('dm_driver_name')||'';
    const inp   = document.getElementById('splash-name-input');
    if(inp && saved) inp.value = saved;
    nameBox.classList.remove('hidden');
    if(inp) setTimeout(()=>inp.focus(),100);
  }
  const enterBtn = document.getElementById('splash-enter-btn');
  if(enterBtn) enterBtn.onclick = ()=>{
    const inp  = document.getElementById('splash-name-input');
    const name = (inp?inp.value.trim():'')||'DRIVER';
    localStorage.setItem('dm_driver_name', name);
    _doEnterApp(name);
  };
  const inp2 = document.getElementById('splash-name-input');
  if(inp2) inp2.addEventListener('keydown', e=>{ if(e.key==='Enter') document.getElementById('splash-enter-btn').click(); });
}

function _doEnterApp(nameOverride){
  const splash = document.getElementById('splash');
  if(splash){ splash.style.transition='opacity 0.5s ease'; splash.style.opacity='0';
    setTimeout(()=>{ splash.style.display='none'; document.querySelectorAll('.app-hidden').forEach(el=>el.classList.remove('app-hidden')); initApp(nameOverride); },520);
  }
}

/* ══ INIT APP ════════════════════════════════════════════════════ */
function initApp(nameOverride){
  if(nameOverride) S.driverName = nameOverride;
  loadSettings();
  if(nameOverride) S.driverName = nameOverride;
  bindEvents();
  initCollapsible();
  loadPlanCache();
  const savedSess = checkSavedSession();
  if(savedSess){
    restoreSession(savedSess);
    renderPlannerUI();
    switchScreen('drive');
    const banner  = document.getElementById('resume-banner');
    const remain  = S.journeySteps.length - S.currentStepIdx;
    const done    = S.records.length;
    document.getElementById('resume-banner-text').textContent =
      'Unfinished session — '+remain+' link'+(remain!==1?'s':'')+' remaining'+(done>0?' · '+done+' done':'')+' · Saved: '+savedSess.savedAt;
    if(banner) banner.classList.remove('hidden');
    requestLocationPermission(granted=>{ if(granted) startGNSSWatch(); });
  } else {
    switchScreen('task');
  }
  if('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').catch(()=>{});
  console.log('DMapp v2 ready | driver:', S.driverName);
}

/* ══ BIND EVENTS ════════════════════════════════════════════════ */
function bindEvents(){
  // Nav tabs
  document.querySelectorAll('.nav-tab').forEach(b=>b.addEventListener('click',()=>switchScreen(b.dataset.screen)));

  // Settings
  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('settings-close').addEventListener('click', closeSettings);
  document.getElementById('save-settings-btn').addEventListener('click', saveSettingsFromUI);
  document.getElementById('clear-cache-btn').addEventListener('click', clearAppCache);
  document.getElementById('header-title-click').addEventListener('click', openSettings);

  // Drive buttons
  document.getElementById('start-measure-btn').addEventListener('click', ()=>{ unlockAudio(); startMeasurement(); });
  document.getElementById('stop-measure-btn').addEventListener('click',  ()=>{ unlockAudio(); stopMeasurement(); });
  document.getElementById('next-link-btn').addEventListener('click',     ()=>{ unlockAudio(); nextLink(); });
  document.getElementById('skip-link-btn').addEventListener('click',     skipLink);
  document.getElementById('pause-btn').addEventListener('click',         pauseSession);
  document.getElementById('ladder-btn').addEventListener('click',        openLadder);
  document.getElementById('ladder-close-btn').addEventListener('click',  closeLadder);
  document.getElementById('ladder-backdrop').addEventListener('click',   closeLadder);
  document.getElementById('banner-resume-btn').addEventListener('click', ()=>{
    document.getElementById('resume-banner').classList.add('hidden');
    renderDriveConsole();
    requestLocationPermission(granted=>{ if(granted) startGNSSWatch(); });
  });
  document.getElementById('banner-fresh-btn').addEventListener('click', ()=>{
    if(!confirm('Start fresh? Current session progress will be lost.')) return;
    clearSession(); savePlanCache();
    document.getElementById('resume-banner').classList.add('hidden');
    switchScreen('task');
  });

  // Navigate to FROM stop button
  document.getElementById('nav-to-from-btn').addEventListener('click', navToFromStop);

  // Mute toggle
  document.getElementById('drive-mute-btn').addEventListener('click', ()=>{
    S.muteBeep = !S.muteBeep;
    document.getElementById('drive-mute-btn').textContent = S.muteBeep ? '🔕' : '🔔';
    toast(S.muteBeep ? 'Beep muted' : 'Beep on', 'info');
  });

  // Planner
  document.getElementById('optimise-btn').addEventListener('click', runOptimiser);
  document.getElementById('reset-order-btn').addEventListener('click', resetPlanOrder);
  document.getElementById('start-job-btn').addEventListener('click', startJob);
  document.getElementById('copy-compact-btn').addEventListener('click', copyCompactPlan);
  document.getElementById('download-detailed-btn').addEventListener('click', downloadDetailedPlan);
  document.getElementById('copy-all-gmaps-btn').addEventListener('click', copyAllGmapsLinks);
  document.getElementById('share-plan-wa-btn').addEventListener('click', shareGmapsPlanWhatsApp);
  const slider = document.getElementById('threshold-slider');
  if(slider) slider.addEventListener('input', ()=>{
    const v=parseFloat(slider.value);
    document.getElementById('threshold-display').textContent = v===0?'Auto':v.toFixed(1)+' km';
  });
  document.querySelectorAll('.opt-btn').forEach(b=>b.addEventListener('click',()=>{
    document.querySelectorAll('.opt-btn').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    S.optStartMode=b.dataset.mode; // store for runOptimiser
  }));

  // Task
  document.getElementById('task-load-shared-btn').addEventListener('click', ()=>document.getElementById('plan-paste-modal').classList.remove('hidden'));
  document.getElementById('plan-paste-close').addEventListener('click', ()=>document.getElementById('plan-paste-modal').classList.add('hidden'));
  document.getElementById('plan-paste-confirm-btn').addEventListener('click', loadSharedPlan);

  // Overview
  document.getElementById('export-btn').addEventListener('click', openExportModal);
  document.getElementById('export-cancel-btn').addEventListener('click', ()=>document.getElementById('export-modal').classList.add('hidden'));
  document.getElementById('export-download-btn').addEventListener('click', downloadCSV);
  document.getElementById('export-whatsapp-btn').addEventListener('click', shareWhatsApp);
  document.getElementById('refresh-results-btn').addEventListener('click', loadResultsFromSheet);
}

function openSettings(){
  document.getElementById('driver-name-input').value = S.driverName;
  document.getElementById('settings-modal').classList.remove('hidden');
}
function closeSettings(){ document.getElementById('settings-modal').classList.add('hidden'); }
function saveSettingsFromUI(){
  S.driverName = document.getElementById('driver-name-input').value.trim() || 'DRIVER';
  saveSettings();
  toast('Settings saved', 'success');
  closeSettings();
}
function clearAppCache(){
  if(!confirm('Clear app cache and reload? Your Sheet data is not affected.')) return;
  ['dms','dmp','dm_recs','dm_session','dm_task_rows','dm_driver_name','dmapp_version','dmapp_admin_overrides'].forEach(k=>localStorage.removeItem(k));
  if('serviceWorker' in navigator) navigator.serviceWorker.getRegistrations().then(regs=>regs.forEach(r=>r.unregister()));
  if(window.caches) caches.keys().then(names=>names.forEach(n=>caches.delete(n)));
  setTimeout(()=>window.location.reload(true), 800);
}


/* ══ PLANNER ════════════════════════════════════════════════════ */
function initPlannerMap(){
  if(S.plannerMap) return;
  S.plannerMap = L.map('planner-map',{zoomControl:true,attributionControl:false});
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(S.plannerMap);
  S.plannerMap.setView([1.3521,103.8198],12);
  setTimeout(()=>S.plannerMap.invalidateSize(),300);
}

function renderPlannerUI(){
  const has = S.plan && S.plan.length > 0;
  const badge  = document.getElementById('plan-status-badge');
  const noTask = document.getElementById('planner-no-task');

  // Init sub-tabs on first render
  initPlannerSubTabs();

  if(!has){
    badge.textContent='Not Loaded'; badge.className='badge';
    if(noTask) noTask.style.display='block';
    document.getElementById('plan-summary-block').style.display='none';
    const sb=document.getElementById('planner-subtab-bar');
    if(sb) sb.style.display='none';
    const pv=document.getElementById('planner-plan-view');
    const mv=document.getElementById('planner-map-view');
    if(pv) pv.style.display='none';
    if(mv) mv.style.display='none';
    return;
  }

  if(noTask) noTask.style.display='none';
  badge.textContent=S.plan.length+' Links'; badge.className='badge loaded';
  document.getElementById('plan-summary-block').style.display='block';
  document.getElementById('plan-inline-summary').style.display='flex';

  const ss=new Set(); S.plan.forEach(l=>{ss.add(l.fromStop);ss.add(l.toStop);});
  document.getElementById('stat-links').textContent = S.plan.length;
  document.getElementById('stat-stops').textContent = ss.size;
  document.getElementById('stat-runs').textContent  = S.plan.some(p=>!p.skipRun2)?'2':'1';

  // Show sub-tab bar and plan view
  const sb=document.getElementById('planner-subtab-bar');
  if(sb) sb.style.display='';
  switchPlannerTab(_plannerSubTab||'plan');

  // Start top cards collapsed on first load
  ['load-body','optimise-body'].forEach(id=>{
    const body=document.getElementById(id);
    const arr =document.getElementById('arrow-'+id);
    if(body&&!body._plannerInitialized){
      body.classList.remove('open');
      if(arr) arr.classList.remove('open');
      body._plannerInitialized=true;
    }
  });

  updateDistSummary();
  if(S.plannerMap) updatePlannerMap();
  renderLinksList();
  renderPlanExport();
}
function updateDistSummary(){
  let lKm,dKm,totalKm,timeMin,timeStr;
  if(S.journeySteps&&S.journeySteps.length){
    // Walk every step tracking current position — counts all travel including dead-mileage
    let dM=0,lM=0,cLat=S.lastPos?S.lastPos.lat:null,cLng=S.lastPos?S.lastPos.lng:null;
    S.journeySteps.forEach(step=>{
      const link=S.plan[step.planIdx];if(!link)return;
      const f=S.stops[link.fromStop],t=S.stops[link.toStop];if(!f||!f.lat)return;
      if(cLat!=null) dM+=optHaversine(cLat,cLng,f.lat,f.lng);
      if(t&&t.lat){lM+=optHaversine(f.lat,f.lng,t.lat,t.lng);cLat=t.lat;cLng=t.lng;}
    });
    lKm=lM/1000;dKm=dM/1000;totalKm=lKm+dKm;
  } else {
    lKm=linkDistance(S.plan,S.stops);
    dKm=calcDeadMileForOrder(S.plan,S.stops,S.plan.map((_,i)=>i),S.lastPos?S.lastPos.lat:null,S.lastPos?S.lastPos.lng:null);
    totalKm=(lKm+dKm)*S.totalRuns;
  }
  timeMin=Math.round(totalKm/(S.speedKmh||SPEED_KMH)*60);
  timeStr=timeMin>=60?(Math.floor(timeMin/60)+'h '+(timeMin%60)+'m'):(timeMin+'m');
  document.getElementById('stat-est-dist').textContent=totalKm.toFixed(1);
  document.getElementById('dm-link-dist').textContent=lKm.toFixed(2)+' km';
  document.getElementById('dm-dead-dist').textContent=dKm.toFixed(2)+' km';
  document.getElementById('dm-total-dist').textContent=totalKm.toFixed(2)+' km';
  document.getElementById('dm-est-time').textContent=timeStr;
  document.getElementById('inline-dist').textContent=totalKm.toFixed(1)+' km · '+timeStr;
}
function buildJourneyStepsForCalc(){
  if(!S.plan.length) return [];
  const steps=[];
  const clusters = S.clusterResult ? S.clusterResult.clusters : [S.plan.map((_,i)=>i)];
  clusters.forEach((cluster,ci)=>{
    const maxRuns = cluster.some(pi=>!S.plan[pi].skipRun2)?2:1;
    for(let run=1;run<=maxRuns;run++){
      cluster.forEach(pi=>{ if(run===1||!S.plan[pi].skipRun2) steps.push({planIdx:pi,run,clusterId:ci,clusterSeq:ci}); });
    }
  });
  return steps;
}

function updatePlannerMap(){
  if(!S.plannerMap) return;
  S.plannerMap.invalidateSize();
  S.plannerMarkers.forEach(m=>S.plannerMap.removeLayer(m));
  S.plannerMarkers=[];
  const bounds=[];
  const clusters = S.clusterResult ? S.clusterResult.clusters.filter(c=>c&&c.length>0)
                                    : [S.plan.map((_,i)=>i)];
  // Build stop→zone map for popups
  const stopZoneMap={};
  clusters.forEach((cluster,ci)=>{
    cluster.forEach(pi=>{
      const link=S.plan[pi]; if(!link) return;
      stopZoneMap[link.fromStop]=ci+1;
      stopZoneMap[link.toStop]  =ci+1;
    });
  });
  clusters.forEach((cluster,ci)=>{
    const col = CL_COLS[ci%CL_COLS.length];
    let prev=null;
    cluster.forEach((pi,li)=>{
      const link=S.plan[pi]; if(!link) return;
      const f=S.stops[link.fromStop]||{}, t=S.stops[link.toStop]||{};
      const isSelected = S.selectedLinkIdx === pi;
      const linkCol = isSelected ? '#facc15' : col;
      const linkW   = isSelected ? 5 : 3;
      if(f.lat){
        const zn = stopZoneMap[link.fromStop] ? ' · Zone '+stopZoneMap[link.fromStop] : '';
        const fm=L.circleMarker([f.lat,f.lng],{radius:isSelected?10:7,color:'#fff',fillColor:'#16a34a',fillOpacity:1,weight:2})
          .bindPopup('<b>'+link.fromStop+'</b><br>'+f.name+zn).addTo(S.plannerMap);
        S.plannerMarkers.push(fm); bounds.push([f.lat,f.lng]);
      }
      if(t.lat){
        const zn = stopZoneMap[link.toStop] ? ' · Zone '+stopZoneMap[link.toStop] : '';
        const tm=L.circleMarker([t.lat,t.lng],{radius:isSelected?10:7,color:'#fff',fillColor:'#dc2626',fillOpacity:1,weight:2})
          .bindPopup('<b>'+link.toStop+'</b><br>'+t.name+zn).addTo(S.plannerMap);
        S.plannerMarkers.push(tm); bounds.push([t.lat,t.lng]);
      }
      if(f.lat&&t.lat){
        const lm=L.polyline([[f.lat,f.lng],[t.lat,t.lng]],{color:linkCol,weight:linkW,opacity:0.9}).addTo(S.plannerMap);
        S.plannerMarkers.push(lm);
      }
      if(prev&&f.lat){
        const pl=S.plan[prev]; if(!pl) return;
        const pt=S.stops[pl.toStop]||{};
        if(pt.lat){
          const dm=L.polyline([[pt.lat,pt.lng],[f.lat,f.lng]],{color:'#f97316',weight:2,opacity:0.6,dashArray:'6,4'}).addTo(S.plannerMap);
          S.plannerMarkers.push(dm);
        }
      }
      prev=pi;
    });
  });
  if(bounds.length) S.plannerMap.fitBounds(bounds,{padding:[30,30]});
}

function renderLinksList(){
  const c=document.getElementById('plan-links-list');
  if(!c) return;
  c.innerHTML='';
  if(S.journeySteps&&S.journeySteps.length) renderZoneList(c);
  else renderPlainList(c);
  // Always update Share Plan after any re-render
  renderPlanExport();
}

function renderPlainList(c){
  S.plan.forEach((link,i)=>{
    const f=S.stops[link.fromStop],t=S.stops[link.toStop];
    const ok=!!(f&&f.lat&&t&&t.lat);
    let dead='';
    if(i<S.plan.length-1&&ok){
      const nf=S.stops[S.plan[i+1].fromStop];
      if(nf&&nf.lat){const d=optHaversine(t.lat,t.lng,nf.lat,nf.lng);dead=d<20?'<span class="chain-badge">⛓</span>':'<span class="deadmile-badge">↝'+(d/1000).toFixed(2)+'km</span>';}
    }
    const skip2=S.totalRuns===2?'<span class="skip2-badge'+(link.skipRun2?' skip2-active':'')+'" data-idx="'+i+'">'+(link.skipRun2?'1× run':'2× runs')+'</span>':'';
    const div=document.createElement('div');
    div.className='link-item'+(ok?'':' no-coords');
    div.dataset.idx=i;div.dataset.planidx=i;div.dataset.linkid=link.linkId;
    div.innerHTML='<div class="seq-badge" data-idx="'+i+'">'+(i+1)+'</div>'
      +'<div class="li-id">'+link.linkId+'</div>'
      +'<div class="li-info"><div class="li-stops">'+link.fromStop+' → '+link.toStop+'</div>'
      +'<div class="li-svc">'+(f?f.name:link.fromStop)+' → '+(t?t.name:link.toStop)+(link.service&&link.service!=='—'?' | '+link.service:'')+'</div>'
      +'<div class="li-badges">'+dead+skip2+'</div></div>'
      +'<button class="li-remove" data-idx="'+i+'" title="Remove from plan">✕</button>';
    div.addEventListener('click',e=>{if(!e.target.closest('.skip2-badge,.seq-badge,.li-remove'))onListLinkClick(i);});
    c.appendChild(div);
  });
  c.querySelectorAll('.seq-badge').forEach(b=>{
    b.addEventListener('click',e=>{
      e.stopPropagation();
      const from=parseInt(b.dataset.idx);
      const toStr=prompt('Move "'+S.plan[from].linkId+'" to position (1–'+S.plan.length+'):','');
      if(!toStr)return;const to=parseInt(toStr)-1;
      if(isNaN(to)||to<0||to>=S.plan.length){toast('Invalid position','error');return;}
      const m=S.plan.splice(from,1)[0];S.plan.splice(to,0,m);
      S.plan.forEach((l,i)=>l.sequence=i+1);
      renderLinksList();updatePlannerMap();updateDistSummary();
      toast(m.linkId+' moved to #'+(to+1));
    });
  });
  c.querySelectorAll('.skip2-badge').forEach(b=>{
    b.addEventListener('click',e=>{e.stopPropagation();const i=parseInt(b.dataset.idx);S.plan[i].skipRun2=!S.plan[i].skipRun2;renderLinksList();updateDistSummary();});
  });
  c.querySelectorAll('.li-remove').forEach(b=>{
    b.addEventListener('click',e=>{
      e.stopPropagation();
      const i=parseInt(b.dataset.idx);
      const lid=S.plan[i].linkId;
      if(!confirm('Remove "'+lid+'" from plan?'))return;
      S.plan.splice(i,1);
      S.plan.forEach((l,j)=>l.sequence=j+1);
      S.journeySteps=[];S.clusterResult=null;
      renderLinksList();updatePlannerMap();updateDistSummary();
      toast(lid+' removed','info');
    });
  });
}

function renderZoneList(c){
  if(!c._zc)c._zc={};
  const zoneMap=new Map();
  S.journeySteps.forEach(step=>{
    if(!zoneMap.has(step.clusterId))zoneMap.set(step.clusterId,{clusterId:step.clusterId,clusterSeq:step.clusterSeq,links:[],run2:[]});
    const z=zoneMap.get(step.clusterId);
    if(step.run===1&&!z.links.includes(step.planIdx))z.links.push(step.planIdx);
    if(step.run===2&&!z.run2.includes(step.planIdx))z.run2.push(step.planIdx);
  });
  let gseq=0;
  const zones=[...zoneMap.values()].sort((a,b)=>a.clusterSeq-b.clusterSeq);
  zones.forEach(zone=>{
    const ci=zone.clusterId%CL_COLS.length;
    const isCollapsed=c._zc[zone.clusterId]===true;
    const skipCount=zone.links.filter(pi=>S.plan[pi]&&S.plan[pi].skipRun2).length;
    const hdr=document.createElement('div');
    hdr.className='zone-hdr ch-'+ci;hdr.dataset.zoneid=zone.clusterId;
    hdr.innerHTML='<div class="zone-hdr-left">'
      +'<span class="zone-ca '+(isCollapsed?'':'open')+'">'+(isCollapsed?'▶':'▼')+'</span>'
      +'<span>Zone '+(zone.clusterSeq+1)+'</span>'
      +'<span class="zone-meta">'+zone.links.length+' link'+(zone.links.length!==1?'s':'')+(S.totalRuns===2?' · R1+R2'+(skipCount?' ('+skipCount+' ×1)':''):'')+'</span>'
      +'</div><span class="zone-km" id="zkm-'+zone.clusterId+'">—</span>';
    hdr.addEventListener('click',()=>{c._zc[zone.clusterId]=!c._zc[zone.clusterId];renderLinksList();});
    c.appendChild(hdr);
    if(!isCollapsed){
      zone.links.forEach(planIdx=>{
        gseq++;
        const link=S.plan[planIdx];if(!link)return;
        const f=S.stops[link.fromStop],t=S.stops[link.toStop];
        const ok=!!(f&&f.lat&&t&&t.lat);
        const isSkip=link.skipRun2;
        let dead='';
        if(ok){
          const si=S.journeySteps.findIndex(s=>s.planIdx===planIdx&&s.run===1);
          if(si>=0&&si<S.journeySteps.length-1){
            const nxt=S.journeySteps[si+1],nf=S.stops[S.plan[nxt.planIdx]&&S.plan[nxt.planIdx].fromStop];
            if(nf&&nf.lat){const d=optHaversine(t.lat,t.lng,nf.lat,nf.lng);if(d>20)dead='<span class="deadmile-badge">↝'+(d/1000).toFixed(2)+'km</span>';}
          }
        }
        const runBadges=S.totalRuns===2?('<span class="run-badge-sm r1">R1</span>'+(isSkip?'<span class="run-badge-sm skip-r2">no R2</span>':'<span class="run-badge-sm r2">R2</span>')):'<span class="run-badge-sm r1">R1</span>';
        const skipBtn=S.totalRuns===2?'<span class="skip2-badge'+(isSkip?' skip2-active':'')+'" data-planidx="'+planIdx+'">'+(isSkip?'1× run':'2× runs')+'</span>':'';
        const div=document.createElement('div');
        div.className='link-item cl-'+ci+(ok?'':' no-coords');
        div.dataset.planidx=planIdx;div.dataset.linkid=link.linkId;div.dataset.zoneid=zone.clusterId;
        div.innerHTML='<div class="seq-badge seq-zone" data-planidx="'+planIdx+'" data-zoneid="'+zone.clusterId+'" data-fromzone="'+zone.clusterId+'">'+gseq+'</div>'
          +'<div class="li-id">'+link.linkId+'</div>'
          +'<div class="li-info"><div class="li-stops">'+link.fromStop+' → '+link.toStop+'</div>'
          +'<div class="li-svc">'+(f?f.name:link.fromStop)+' → '+(t?t.name:link.toStop)+(link.service&&link.service!=='—'?' | '+link.service:'')+'</div>'
          +'<div class="li-badges">'+runBadges+dead+skipBtn+'</div></div>';
        div.addEventListener('click',e=>{if(!e.target.closest('.skip2-badge,.seq-zone'))onListLinkClick(planIdx);});
        c.appendChild(div);
      });
    }
    setTimeout(()=>{
      const el=document.getElementById('zkm-'+zone.clusterId);if(!el)return;
      let km=0;zone.links.forEach(pi=>{const l=S.plan[pi],f=S.stops[l&&l.fromStop],t=S.stops[l&&l.toStop];if(f&&t&&f.lat&&t.lat)km+=optHaversine(f.lat,f.lng,t.lat,t.lng)/1000;});
      el.textContent=km.toFixed(2)+' km';
    },0);
  });
  c.querySelectorAll('.skip2-badge[data-planidx]').forEach(b=>{
    b.addEventListener('click',e=>{
      e.stopPropagation();
      const pi=parseInt(b.dataset.planidx);
      S.plan[pi].skipRun2=!S.plan[pi].skipRun2;
      rebuildJourneyFromZones();renderLinksList();updateDistSummary();
    });
  });
  c.querySelectorAll('.seq-zone').forEach(b=>{
    b.addEventListener('click',e=>{
      e.stopPropagation();
      const pi=parseInt(b.dataset.planidx),fromZone=parseInt(b.dataset.fromzone);
      if(!S.clusterResult)return;
      const nZones=S.clusterResult.clusters.length;
      const action=prompt('Link: '+S.plan[pi].linkId+'\n1) Reorder within Zone '+(fromZone+1)+'\n2) Move to different zone\nType 1 or 2:','');
      if(!action)return;
      if(action.trim()==='1'){
        const zoneMembers=S.clusterResult.clusters[fromZone];
        const posInZone=zoneMembers.indexOf(pi)+1;
        const toStr=prompt('Current position: '+posInZone+' of '+zoneMembers.length+'\nMove to position (1–'+zoneMembers.length+'):','');
        if(!toStr)return;const to=parseInt(toStr)-1;
        if(isNaN(to)||to<0||to>=zoneMembers.length){toast('Invalid position','error');return;}
        const cur=zoneMembers.indexOf(pi);
        zoneMembers.splice(cur,1);zoneMembers.splice(to,0,pi);
        rebuildJourneyFromZones();renderLinksList();updateDistSummary();updatePlannerMap();
        toast(S.plan[pi].linkId+' moved to position '+(to+1)+' in Zone '+(fromZone+1),'success');
      } else if(action.trim()==='2'){
        const zoneNames=S.clusterResult.clusters.map((_,i)=>'Zone '+(i+1)).join(', ');
        const ans=prompt('Move to which zone? ('+zoneNames+')\nEnter zone number:','');
        if(!ans)return;const toZone=parseInt(ans)-1;
        if(isNaN(toZone)||toZone<0||toZone>=nZones){toast('Invalid zone','error');return;}
        if(toZone===fromZone){toast('Already in Zone '+(fromZone+1),'info');return;}
        const src=S.clusterResult.clusters[fromZone],dst=S.clusterResult.clusters[toZone];
        const pos=src.indexOf(pi);if(pos>=0){src.splice(pos,1);dst.push(pi);}
        rebuildJourneyFromZones();renderLinksList();updateDistSummary();updatePlannerMap();
        toast(S.plan[pi].linkId+' moved to Zone '+(toZone+1),'success');
      }
    });
  });
}

function rebuildJourneyFromZones(){
  if(!S.clusterResult)return;
  // Remove empty clusters and renumber
  S.clusterResult.clusters = S.clusterResult.clusters.filter(m=>m&&m.length>0);
  S.clusterResult.numClusters = S.clusterResult.clusters.length;
  S.journeySteps=[];
  S.clusterResult.clusters.forEach((members,cId)=>{
    for(let run=1;run<=S.totalRuns;run++){
      members.forEach(pi=>{
        if(pi<0||pi>=S.plan.length)return;
        if(run===2&&S.plan[pi]&&S.plan[pi].skipRun2)return;
        S.journeySteps.push({planIdx:pi,run,clusterId:cId,clusterSeq:cId});
      });
    }
  });
}

function onListLinkClick(planIdx){
  const link=S.plan[planIdx];if(!link)return;
  const f=S.stops[link.fromStop],t=S.stops[link.toStop];
  if(!f||!f.lat)return;
  // Store selected link for highlighting
  S.selectedLinkIdx = planIdx;
  // Switch to map sub-tab
  switchPlannerTab('map');
  // After map is visible, fit bounds and update markers
  setTimeout(()=>{
    if(!S.plannerMap){initPlannerMap();}
    updatePlannerMap();
    const bounds=t&&t.lat?[[f.lat,f.lng],[t.lat,t.lng]]:[[f.lat,f.lng]];
    S.plannerMap.fitBounds(bounds,{padding:[60,60],maxZoom:17});
  },150);
}
function resetPlanOrder(){
  if(S.originalPlanOrder){S.plan=S.originalPlanOrder.map(i=>S.plan[i]||S.plan[0]);S.originalPlanOrder=null;}
  S.clusterResult=null; S.journeySteps=[];
  renderPlannerUI();
}

function runOptimiser(){
  if(!S.plan.length){toast('No plan loaded','error');return;}
  const btn=document.getElementById('optimise-btn');
  btn.disabled=true;btn.textContent='⚡ Optimising…';
  // Save original order as deep copy before first optimise
  if(!S.originalPlanOrder) S.originalPlanOrder=S.plan.map(l=>Object.assign({},l));
  let oLat=null,oLng=null;
  const mode=document.querySelector('.opt-btn.active')?.dataset.mode||'current';
  if(mode==='current'&&S.lastPos){oLat=S.lastPos.lat;oLng=S.lastPos.lng;}
  const slEl=document.getElementById('threshold-slider');
  const customKm=slEl&&parseFloat(slEl.value)>0?parseFloat(slEl.value):null;
  // Use setTimeout so UI updates (button disabled) before heavy computation
  setTimeout(()=>{
    try{
      const r=optimiseRoute(S.plan,S.stops,oLat,oLng,S.totalRuns,S.speedKmh||SPEED_KMH,customKm);
      S.clusterResult=r;
      // Use journey steps directly from optimiser — already correct
      S.journeySteps=r.journeySteps;
      // Remap S.plan to optimised order derived from journeySteps
      const seen=new Set(),po=[];
      r.journeySteps.forEach(s=>{if(!seen.has(s.planIdx)){seen.add(s.planIdx);po.push(s.planIdx);}});
      S.plan.forEach((_,i)=>{if(!seen.has(i))po.push(i);});
      const orig=S.plan.slice();
      S.plan=po.map(i=>orig[i]);
      // Build index map: old plan index → new plan index
      const idxMap={};po.forEach((oi,ni)=>idxMap[oi]=ni);
      // Remap journeySteps planIdx to new positions
      S.journeySteps=S.journeySteps.map(s=>Object.assign({},s,{planIdx:idxMap[s.planIdx]}));
      // CRITICAL: remap cluster member indices to match new S.plan positions
      if(S.clusterResult&&S.clusterResult.clusters){
        S.clusterResult.clusters=S.clusterResult.clusters.map(members=>
          members.map(oldIdx=>idxMap[oldIdx]).filter(ni=>ni!==undefined)
        );
      }
      S.plan.forEach((l,i)=>l.sequence=i+1);
      const badge=document.getElementById('opt-status-badge');
      badge.textContent=r.numClusters+' zones ✓';badge.className='badge opt-status-done';
      showOptResult(r);
      updateDistSummary();renderLinksList();updatePlannerMap();
      toast('Optimised — '+r.numClusters+' zone'+(r.numClusters!==1?'s':'')+' · saved '+r.savings.toFixed(2)+' km','success');
    }catch(e){
      console.error(e);
      toast('Optimiser error: '+e.message,'error');
    }
    btn.disabled=false;btn.textContent='⚡ Auto-Optimise Route';
  },50);
}

function showOptResult(r){
  const el=document.getElementById('opt-result');
  el.classList.remove('hidden');
  const slEl=document.getElementById('threshold-slider');
  const slVal=slEl?parseFloat(slEl.value):0;
  const thStr=slVal>0?(slVal+' km gap'):('auto ('+((r.threshold||0)/1000).toFixed(2)+' km)');
  el.innerHTML='<div class="opt-result-grid">'
    +'<div class="opt-r-item"><div class="opt-r-val" style="color:var(--green)">'+r.linkKm.toFixed(2)+'</div><div class="opt-r-lbl">Link km</div></div>'
    +'<div class="opt-r-item"><div class="opt-r-val" style="color:var(--orange)">'+r.deadKm.toFixed(2)+'</div><div class="opt-r-lbl">Dead-mile</div></div>'
    +'<div class="opt-r-item"><div class="opt-r-val" style="color:var(--blue)">'+r.totalKm.toFixed(2)+'</div><div class="opt-r-lbl">Total km</div></div>'
    +'<div class="opt-r-item"><div class="opt-r-val" style="color:var(--orange)">'+r.timeStr+'</div><div class="opt-r-lbl">Est. time</div></div>'
    +'<div class="opt-r-item"><div class="opt-r-val" style="color:var(--purple)">'+r.savings.toFixed(2)+'</div><div class="opt-r-lbl">Saved km</div></div>'
    +'</div><div class="opt-chain-info">'+r.numClusters+' zone'+(r.numClusters!==1?'s':'')+' · '+thStr+'</div>';
}

function startJob(){
  S.journeySteps = buildJourneyStepsForCalc();
  S.currentStepIdx = 0; S.records = []; S.gnssDist=0; S.gnssPoints=[];
  saveSession();
  switchScreen('drive');
  requestLocationPermission(granted=>{ if(granted) startGNSSWatch(); });
}


/* ══ PLAN EXPORT ════════════════════════════════════════════════ */
function buildCompactPlan(){
  if(!S.plan.length) return '';
  const allClusters = S.clusterResult ? S.clusterResult.clusters : [S.plan.map((_,i)=>i)];
  // Filter empty clusters
  const clusters = allClusters.filter(c=>c&&c.length>0);
  const lines = [PLAN_VERSION];
  lines.push('DRIVER: ' + S.driverName);
  lines.push('DATE: ' + toSGT(new Date()).slice(0,10));
  lines.push('---');
  clusters.forEach((cluster,ci)=>{
    const allX1 = cluster.every(pi=>S.plan[pi]&&S.plan[pi].skipRun2);
    const zoneDefault = allX1 ? 1 : 2;
    const pairs = cluster.map(pi=>{
      const link = S.plan[pi]; if(!link) return null;
      const runs = link.skipRun2 ? 1 : 2;
      return link.linkId + (runs !== zoneDefault ? ':'+runs : '');
    }).filter(Boolean);
    lines.push('Z'+(ci+1)+' x'+zoneDefault+': '+pairs.join('|'));
  });
  if(clusters.length > 1){
    for(let i=0;i<clusters.length-1;i++) lines.push('DEAD: Z'+(i+1)+'>Z'+(i+2));
  }
  lines.push('---');
  // Google Maps overrides
  const ov = S.zoneMapOverrides||{};
  let hasOv = false;
  clusters.forEach((_,ci)=>{
    if(ov['z'+ci]){ lines.push('GMAPS-Z'+(ci+1)+': '+ov['z'+ci]); hasOv=true; }
    if(ci<clusters.length-1&&ov['dead_'+ci+'_'+(ci+1)]){ lines.push('GMAPS-DEAD-'+ci+'-'+(ci+1)+': '+ov['dead_'+ci+'_'+(ci+1)]); hasOv=true; }
  });
  lines.push('---');
  const allLinks = clusters.flat().map(pi=>S.plan[pi]&&S.plan[pi].linkId).filter(Boolean).join('');
  let crc = 0;
  for(let i=0;i<allLinks.length;i++) crc=(crc+allLinks.charCodeAt(i))&0xFFFF;
  lines.push('CK: '+crc.toString(16).toUpperCase().padStart(4,'0'));
  return lines.join('\n');
}

function buildDetailedPlan(){
  if(!S.plan.length) return '';
  const allClusters = S.clusterResult ? S.clusterResult.clusters : [S.plan.map((_,i)=>i)];
  const clusters = allClusters.filter(c=>c&&c.length>0);
  const ov = S.zoneMapOverrides||{};
  const lines = [
    'DMapp BIS — Journey Plan',
    '═'.repeat(50),
    'Driver : ' + S.driverName,
    'Date   : ' + toSGT(new Date()).slice(0,10),
    'Generated: ' + toSGT(new Date()) + ' SGT',
    ''
  ];
  let totalLinkKm=0, totalDeadKm=0;
  clusters.forEach((cluster,ci)=>{
    let zoneKm=0;
    const linkLines=[];
    cluster.forEach((pi,li)=>{
      const link=S.plan[pi]; if(!link) return;
      const f=S.stops[link.fromStop]||{name:link.fromStop,lat:0,lng:0};
      const t=S.stops[link.toStop]  ||{name:link.toStop,  lat:0,lng:0};
      let km='—';
      if(f.lat&&t.lat){ const d=optHaversine(f.lat,f.lng,t.lat,t.lng)/1000; km=d.toFixed(2)+' km'; zoneKm+=d; }
      const runs=link.skipRun2?'×1':'×2';
      linkLines.push('  '+(li+1)+'. '+link.fromStop+' '+padRight(f.name||'',28)+' → '+link.toStop+' '+padRight(t.name||'',28)+'  SVC:'+padRight(link.service||'—',8)+runs+'  ~'+km);
    });
    lines.push('Zone '+(ci+1)+'  ('+cluster.filter(pi=>S.plan[pi]).length+' links, est. '+zoneKm.toFixed(1)+' km)');
    lines.push('─'.repeat(50));
    linkLines.forEach(l=>lines.push(l));
    totalLinkKm+=zoneKm;
    // Google Maps link for this zone
    const gmapsUrl = ov['z'+ci] || buildZoneGoogleMapsUrl(ci, false);
    if(gmapsUrl && Array.isArray(gmapsUrl)){
      gmapsUrl.forEach((url,bi)=>{ lines.push('  🗺 Zone '+(ci+1)+(gmapsUrl.length>1?' Part '+(bi+1):'')+': '+url); });
    } else if(gmapsUrl) {
      lines.push('  🗺 Zone '+(ci+1)+': '+gmapsUrl);
    }
    // Dead-mileage to next zone
    if(ci<clusters.length-1){
      const lastPi=cluster[cluster.length-1];
      const firstPi=clusters[ci+1][0];
      if(S.plan[lastPi]&&S.plan[firstPi]){
        const t2=S.stops[S.plan[lastPi].toStop]  ||{};
        const f2=S.stops[S.plan[firstPi].fromStop]||{};
        let deadKm=0;
        if(t2.lat&&f2.lat){ deadKm=optHaversine(t2.lat,t2.lng,f2.lat,f2.lng)/1000; totalDeadKm+=deadKm; }
        lines.push('  ↝ Dead-mileage to Zone '+(ci+2)+': ~'+deadKm.toFixed(1)+' km');
        const deadUrl=ov['dead_'+ci+'_'+(ci+1)]||buildDeadMileGoogleMapsUrl(ci,ci+1,false);
        if(deadUrl) lines.push('  🗺 Dead-mileage: '+deadUrl);
      }
    }
    lines.push('');
  });
  lines.push('═'.repeat(50));
  lines.push('TOTAL: '+S.plan.length+' links  |  Link dist: ~'+totalLinkKm.toFixed(1)+' km  |  Dead-mile: ~'+totalDeadKm.toFixed(1)+' km');
  const totalMin=Math.round((totalLinkKm+totalDeadKm)/(S.speedKmh||SPEED_KMH)*60);
  const h=Math.floor(totalMin/60),m=totalMin%60;
  lines.push('Est. time: '+(h>0?h+'h ':'')+(m>0?m+'m':'')+'  (at '+(S.speedKmh||SPEED_KMH)+' km/h)');
  lines.push('');
  lines.push('--- Compact plan for sharing ---');
  lines.push(buildCompactPlan());
  return lines.join('\n');
}
function padRight(s,n){ return String(s).substring(0,n).padEnd(n); }

function renderPlanExport(){
  const box = document.getElementById('plan-compact-text');
  if(box){ box.textContent = buildCompactPlan() || '(No plan loaded)'; }

  // Render Google Maps zone links section
  const gmapsContainer = document.getElementById('plan-gmaps-links');
  if(!gmapsContainer||!S.plan.length) return;
  const clusters = S.clusterResult ? S.clusterResult.clusters.filter(c=>c&&c.length>0)
                                    : [S.plan.map((_,i)=>i)];
  const ov = S.zoneMapOverrides||{};
  let html='';

  clusters.forEach((cluster,ci)=>{
    const urls = buildZoneGoogleMapsUrl(ci, false);
    const hasCoords = urls && urls.length>0;
    const isOverride = !!ov['z'+ci];
    const col = CL_COLS[ci%CL_COLS.length];

    html += '<div class="gmaps-zone-row" style="border-left:3px solid '+col+'">';
    html += '<div class="gmaps-zone-label"><span style="color:'+col+'">Zone '+(ci+1)+'</span>';
    html += '<span class="gmaps-zone-count">'+cluster.filter(pi=>S.plan[pi]).length+' links</span>';
    if(isOverride) html += '<span class="gmaps-override-badge">🔗 custom</span>';
    html += '</div>';

    if(hasCoords||isOverride){
      if(urls&&urls.length>1){
        urls.forEach((url,bi)=>{
          html += '<div class="gmaps-btn-row">';
          html += '<a class="btn-gmaps-open" href="'+url+'" target="_blank">🗺 Zone '+(ci+1)+' Part '+(bi+1)+' ↗</a>';
          html += '</div>';
        });
      } else {
        const url = isOverride ? ov['z'+ci] : (urls&&urls[0]);
        html += '<div class="gmaps-btn-row">';
        html += '<a class="btn-gmaps-open" href="'+url+'" target="_blank">🗺 Open Zone '+(ci+1)+' ↗</a>';
        html += '<button class="btn-gmaps-edit" data-ov-key="z'+ci+'">'+(isOverride?'✏ Edit':'✏ Edit')+'</button>';
        if(isOverride) html += '<button class="btn-gmaps-reset" data-ov-key="z'+ci+'">↺</button>';
        html += '</div>';
      }
    } else {
      html += '<div class="gmaps-zone-noc">⚠ Pin stops first</div>';
      html += '<div class="gmaps-btn-row"><button class="btn-gmaps-edit" data-ov-key="z'+ci+'">✏ Enter link manually</button></div>';
    }
    html += '</div>';

    // Dead-mileage to next zone
    if(ci < clusters.length-1){
      const deadUrl = buildDeadMileGoogleMapsUrl(ci, ci+1, false);
      const deadOvKey = 'dead_'+ci+'_'+(ci+1);
      const isDead = !!ov[deadOvKey];
      let deadKmStr='—';
      const lastPi=cluster[cluster.length-1], firstPi=clusters[ci+1][0];
      if(S.plan[lastPi]&&S.plan[firstPi]){
        const t2=S.stops[S.plan[lastPi].toStop]||{}, f2=S.stops[S.plan[firstPi].fromStop]||{};
        if(t2.lat&&f2.lat) deadKmStr=(optHaversine(t2.lat,t2.lng,f2.lat,f2.lng)/1000).toFixed(1)+' km';
      }
      html += '<div class="gmaps-dead-row">';
      html += '<span class="gmaps-dead-label">↓ Dead Z'+(ci+1)+'→Z'+(ci+2)+' ~'+deadKmStr+'</span>';
      if(deadUrl||isDead){
        const url = isDead ? ov[deadOvKey] : deadUrl;
        html += '<a class="btn-gmaps-dead-open" href="'+url+'" target="_blank">🗺↗</a>';
        html += '<button class="btn-gmaps-edit btn-gmaps-dead-edit" data-ov-key="'+deadOvKey+'">✏</button>';
        if(isDead) html += '<button class="btn-gmaps-reset" data-ov-key="'+deadOvKey+'">↺</button>';
      } else {
        html += '<button class="btn-gmaps-edit btn-gmaps-dead-edit" data-ov-key="'+deadOvKey+'">✏</button>';
      }
      html += '</div>';
    }
  });

  gmapsContainer.innerHTML = html;

  // Edit button handler
  gmapsContainer.querySelectorAll('.btn-gmaps-edit').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const key = btn.dataset.ovKey;
      const current = (S.zoneMapOverrides||{})[key]||'';
      const label = key.startsWith('dead')?'dead-mileage':('Zone '+(parseInt(key.slice(1))+1));
      const newUrl = prompt('Paste corrected Google Maps link for '+label+' (leave empty to use auto-generated):', current);
      if(newUrl===null) return; // cancelled
      setZoneMapOverride(key, newUrl||null);
    });
  });

  // Reset button handler
  gmapsContainer.querySelectorAll('.btn-gmaps-reset').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const key = btn.dataset.ovKey;
      if(confirm('Remove custom link and use auto-generated?')) setZoneMapOverride(key, null);
    });
  });
}

function copyCompactPlan(){
  const txt = buildCompactPlan();
  if(!txt){ toast('No plan to copy','error'); return; }
  navigator.clipboard.writeText(txt).then(()=>toast('Plan copied to clipboard ✓','success')).catch(()=>{
    // Fallback
    const ta=document.createElement('textarea');ta.value=txt;document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();
    toast('Plan copied','success');
  });
}

function downloadDetailedPlan(){
  const txt = buildDetailedPlan();
  if(!txt){ toast('No plan to export','error'); return; }
  const fname='DMapp_Plan_'+S.driverName.replace(/[^a-zA-Z0-9]/g,'_')+'_'+toSGT(new Date()).slice(0,10)+'.txt';
  try{
    const blob = new Blob([txt], {type:'text/plain;charset=utf-8'});
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href=url; a.download=fname;
    document.body.appendChild(a); a.click();
    setTimeout(()=>{ URL.revokeObjectURL(url); document.body.removeChild(a); }, 1000);
    toast('Plan downloaded: '+fname,'success');
  }catch(e){
    // Fallback for browsers that block createObjectURL
    const a=document.createElement('a');
    a.href='data:text/plain;charset=utf-8,'+encodeURIComponent(txt);
    a.download=fname; document.body.appendChild(a); a.click(); document.body.removeChild(a);
    toast('Plan downloaded: '+fname,'success');
  }
}

/* ══ LOAD SHARED PLAN (paste from WhatsApp) ════════════════════ */
async function loadSharedPlan(){
  const raw = (document.getElementById('plan-paste-input').value||'').trim();
  if(!raw){ showStatus('plan-paste-status','⚠ Nothing to parse','error'); return; }
  const btn = document.getElementById('plan-paste-confirm-btn');
  btn.disabled=true; btn.textContent='Loading…';
  showStatus('plan-paste-status','⏳ Parsing plan…','info');
  try{
    const parsed = parseCompactPlan(raw);
    if(!parsed){ showStatus('plan-paste-status','⚠ Not a valid DMapp plan. Check format.','error'); return; }

    // Fetch reference data
    showStatus('plan-paste-status','⏳ Looking up stop names…','info');
    const data = await jsonpFetch(S.appsScriptUrl, {action:'getReference', sheetId:SHEET_ID});
    const bsMap={}, lnkMap={};
    (data.stops||[]).forEach(s=>{ const c=padStop(String(s.BSCode||'').trim()); if(c) bsMap[c]={name:String(s.BSName||c),lat:parseFloat(s.Planned_Lat)||0,lng:parseFloat(s.Planned_Long)||0}; });
    (data.links||[]).forEach(l=>{ const k=padStop(String(l.FromStopCode||l.FromStop||'').trim())+'-'+padStop(String(l.ToStopCode||l.ToStop||'').trim()); lnkMap[k]=String(l.Service||''); });

    // Build S.plan and S.stops
    S.plan=[]; S.stops={}; S.links={}; S.clusterResult=null; S.journeySteps=[];
    const clusterArray=[];
    parsed.zones.forEach((zone,zi)=>{
      const clusterIdx=[];
      zone.links.forEach(lk=>{
        const from=padStop(lk.from), to=padStop(lk.to);
        const linkId=from+'-'+to;
        const fi=bsMap[from]||{name:'NEW - '+from,lat:0,lng:0};
        const ti=bsMap[to]  ||{name:'NEW - '+to,  lat:0,lng:0};
        if(!S.stops[from]) S.stops[from]={code:from,name:fi.name,lat:fi.lat,lng:fi.lng,isNew:!bsMap[from]};
        if(!S.stops[to])   S.stops[to]  ={code:to,  name:ti.name,lat:ti.lat,lng:ti.lng,isNew:!bsMap[to]};
        const service=lnkMap[linkId]||'';
        const pi=S.plan.length;
        S.plan.push({linkId,fromStop:from,toStop:to,service,skipRun2:lk.runs===1,sequence:pi+1});
        clusterIdx.push(pi);
      });
      clusterArray.push(clusterIdx);
    });

    // Set cluster result if multiple zones
    if(clusterArray.length>1){
      S.clusterResult={clusters:clusterArray,numClusters:clusterArray.length,totalKm:0};
    }

    // If plan has zones, build journey steps and go to Drive
    if(parsed.hasZones){
      S.journeySteps=buildJourneyStepsForCalc();
      S.currentStepIdx=0; S.records=[]; S.gnssDist=0; S.gnssPoints=[];
      savePlanCache(); saveSession();
      document.getElementById('plan-paste-modal').classList.add('hidden');
      document.getElementById('plan-paste-input').value='';
      switchScreen('drive');
      toast('Plan loaded — '+(S.plan.length)+' links','success');
      requestLocationPermission(granted=>{ if(granted) startGNSSWatch(); });
    } else {
      // No zones — go to Planner for optimisation
      savePlanCache();
      document.getElementById('plan-paste-modal').classList.add('hidden');
      document.getElementById('plan-paste-input').value='';
      switchScreen('planner');
      toast('Plan loaded — optimise before starting','info');
    }
  }catch(e){
    showStatus('plan-paste-status','⚠ Error: '+e.message,'error');
  }finally{
    btn.disabled=false; btn.textContent='↳ Load This Plan';
  }
}

function parseCompactPlan(raw){
  const lines=raw.split('\n').map(l=>l.trim()).filter(Boolean);
  if(!lines[0].startsWith('DMAPP')) return null;
  const zones=[];
  let hasZones=false;
  lines.forEach(line=>{
    if(line.startsWith('Z')&&line.includes(':')){
      hasZones=true;
      // e.g. "Z1 x2: 26419-26429|26311-26321:1"
      const zMatch=line.match(/^Z(\d+)\s+x(\d+):\s*(.+)$/);
      if(!zMatch) return;
      const zoneDefault=parseInt(zMatch[2])||2;
      const pairs=zMatch[3].split('|').map(p=>p.trim()).filter(Boolean);
      const links=pairs.map(p=>{
        const parts=p.split(':');
        const linkId=parts[0].trim();
        const runs=parts[1]?parseInt(parts[1]):zoneDefault;
        const [from,to]=linkId.split('-');
        return {from:from||'',to:to||'',runs};
      }).filter(lk=>lk.from&&lk.to);
      if(links.length) zones.push({links});
    }
  });
  // If no zones found, parse flat list from task format
  if(!zones.length){
    const flatLinks=[];
    lines.forEach(line=>{
      if(/^\d{5}-\d{5}/.test(line)||line.includes(';')){
        line.split(/[;|\s]+/).forEach(tok=>{
          const m=tok.match(/^(\d{4,6})-(\d{4,6})(?::(\d))?$/);
          if(m) flatLinks.push({from:m[1],to:m[2],runs:m[3]?parseInt(m[3]):2});
        });
      }
    });
    if(flatLinks.length) zones.push({links:flatLinks});
  }
  return zones.length?{zones,hasZones}:null;
}


/* ══ DRIVE CONSOLE ══════════════════════════════════════════════ */
function renderDriveConsole(){
  const step = getCurrentStep();
  if(!step){
    document.getElementById('drive-link-id').textContent='No plan';
    document.getElementById('drive-from-code').textContent='—';
    document.getElementById('drive-to-code').textContent='—';
    document.getElementById('drive-from-name').textContent='Load a plan in Task tab first';
    document.getElementById('drive-to-name').textContent='';
    return;
  }
  const link = S.plan[step.planIdx];
  const f    = S.stops[link.fromStop]||{code:link.fromStop,name:'—'};
  const t    = S.stops[link.toStop]  ||{code:link.toStop,  name:'—'};

  document.getElementById('drive-link-id').textContent   = link.linkId;
  document.getElementById('drive-run-badge').textContent  = 'RUN '+step.run;
  document.getElementById('drive-from-code').textContent  = link.fromStop;
  document.getElementById('drive-from-name').textContent  = f.name||'—';
  document.getElementById('drive-to-code').textContent    = link.toStop;
  document.getElementById('drive-to-name').textContent    = t.name||'—';
  document.getElementById('drive-service').textContent    = 'SVC '+(link.service||'—');

  const zb = document.getElementById('drive-zone-badge');
  if(S.clusterResult && S.clusterResult.numClusters > 1){
    zb.textContent='Z'+(step.clusterSeq+1);
    zb.className='zone-badge';
    zb.style.color=CL_COLS[step.clusterId%CL_COLS.length];
    zb.style.borderColor=CL_COLS[step.clusterId%CL_COLS.length];
  } else { zb.className='zone-badge hidden'; }

  const done=S.records.length, total=S.journeySteps.length;
  document.getElementById('drive-progress-label').textContent=done+'/'+total;
  document.getElementById('drive-progress-fill').style.width=(total>0?done/total*100:0)+'%';

  // Update nav button label — hide if already at FROM stop
  const navBtn = document.getElementById('nav-to-from-btn');
  const navLabel = document.getElementById('nav-to-from-label');
  if(f.lat && S.lastPos){
    const distToFrom = optHaversine(S.lastPos.lat, S.lastPos.lng, f.lat, f.lng);
    if(distToFrom <= S.proxDist){
      if(navBtn) navBtn.style.display='none';
      document.getElementById('drive-nav-section').innerHTML='<div class="already-at-stop">✓ Already at FROM stop '+link.fromStop+' — tap START</div>';
    } else {
      if(navBtn){ navBtn.style.display=''; }
      if(navLabel) navLabel.textContent='Navigate to '+link.fromStop+' '+f.name;
    }
  } else {
    if(navLabel) navLabel.textContent='Navigate to '+link.fromStop+' '+f.name;
  }

  // Reset button states
  document.getElementById('start-measure-btn').disabled=false;
  document.getElementById('stop-measure-btn').disabled=true;
  document.getElementById('next-link-btn').disabled=true;
  document.getElementById('remarks-input').value='';

  // Reset GNSS display
  S.gnssDist=0; S.gnssPoints=[];
  document.getElementById('gnss-bar-dist').textContent='0.000 km';

  // Reset proximity state for new link
  resetProximityState();

  // Render zone nav
  renderZoneNav();
  renderLadderContent();
}

/* ══ GOOGLE MAPS NAVIGATION ════════════════════════════════════ */
function openGoogleMaps(lat, lng){
  // Open Google Maps from current position to given lat/lng
  const origin = S.lastPos ? S.lastPos.lat+','+S.lastPos.lng : '';
  const dest   = lat+','+lng;
  // Try native app first, fall back to web
  const webUrl = 'https://www.google.com/maps/dir/?api=1'
    + (origin?'&origin='+encodeURIComponent(origin):'')
    + '&destination='+encodeURIComponent(dest)
    + '&travelmode=driving';
  window.open(webUrl, '_blank');
}

function openGoogleMapsMulti(stops){
  // stops = [{lat,lng,name}] array — origin is current location
  if(!stops.length) return;
  const origin  = S.lastPos ? S.lastPos.lat+','+S.lastPos.lng : '';
  const dest    = stops[stops.length-1].lat+','+stops[stops.length-1].lng;
  const wps     = stops.slice(0,-1).map(s=>s.lat+','+s.lng);
  const webUrl  = 'https://www.google.com/maps/dir/?api=1'
    + (origin?'&origin='+encodeURIComponent(origin):'')
    + '&destination='+encodeURIComponent(dest)
    + (wps.length?'&waypoints='+encodeURIComponent(wps.join('|')):'')
    + '&travelmode=driving';
  window.open(webUrl, '_blank');
}

function navToFromStop(){
  const step = getCurrentStep();
  if(!step) return;
  const link = S.plan[step.planIdx];
  const f    = S.stops[link.fromStop]||{};
  if(!f.lat){ toast('No coordinates for stop '+link.fromStop,'error'); return; }
  openGoogleMaps(f.lat, f.lng);
}

function buildZoneStops(clusterIdx){
  // Returns array of unique stop lat/lngs for a zone (for Google Maps URL)
  const cluster = S.clusterResult ? S.clusterResult.clusters[clusterIdx] : S.plan.map((_,i)=>i);
  const stops=[];
  cluster.forEach(pi=>{
    const link=S.plan[pi];
    const f=S.stops[link.fromStop]||{}, t=S.stops[link.toStop]||{};
    if(f.lat&&(!stops.length||stops[stops.length-1].lat!==f.lat)){
      stops.push({lat:f.lat,lng:f.lng,name:link.fromStop});
    }
    if(t.lat) stops.push({lat:t.lat,lng:t.lng,name:link.toStop});
  });
  return stops;
}

function renderZoneNav(){
  const container = document.getElementById('zone-nav-list');
  if(!container) return;
  const clusters = S.clusterResult ? S.clusterResult.clusters : null;
  if(!clusters || clusters.length <= 1){
    // Single zone or no clusters — just show one full-route button
    const allStops=[];
    S.plan.forEach(link=>{
      const f=S.stops[link.fromStop]||{},t=S.stops[link.toStop]||{};
      if(f.lat&&(!allStops.length||allStops[allStops.length-1].lat!==f.lat)) allStops.push({lat:f.lat,lng:f.lng,name:link.fromStop});
      if(t.lat) allStops.push({lat:t.lat,lng:t.lng,name:link.toStop});
    });
    // Split into batches of MAX_GMAPS_WP+1 stops
    const batches=chunkStops(allStops);
    container.innerHTML=batches.map((batch,i)=>`
      <div class="zone-nav-row">
        <div class="znr-label">All Links${batches.length>1?' Part '+(i+1):''}
          <span class="znr-count">${batch.length} stops</span>
        </div>
        <button class="btn-gmaps-zone" data-batch="${i}">Open in Google Maps ↗</button>
      </div>`).join('');
    container.querySelectorAll('.btn-gmaps-zone').forEach(btn=>{
      btn.addEventListener('click',()=>{
        const b=parseInt(btn.dataset.batch);
        openGoogleMapsMulti(batches[b]);
      });
    });
    return;
  }

  let html='';
  clusters.forEach((cluster,ci)=>{
    const stops=buildZoneStops(ci);
    const batches=chunkStops(stops);
    const col=CL_COLS[ci%CL_COLS.length];
    html+=`<div class="zone-nav-row" style="border-left:3px solid ${col}">
      <div class="znr-label" style="color:${col}">Zone ${ci+1}
        <span class="znr-count">${cluster.length} links · ${stops.length} stops</span>
      </div>
      <div class="znr-btns">
        ${batches.map((batch,bi)=>`<button class="btn-gmaps-zone" data-ci="${ci}" data-bi="${bi}">
          ${batches.length>1?'Part '+(bi+1)+' ':''} Google Maps ↗
        </button>`).join('')}
      </div>
    </div>`;
    // Dead-mileage button to next zone
    if(ci < clusters.length-1){
      const lastPi=cluster[cluster.length-1];
      const firstPi=clusters[ci+1][0];
      const t2=S.stops[S.plan[lastPi].toStop]  ||{};
      const f2=S.stops[S.plan[firstPi].fromStop]||{};
      const hasCoords=t2.lat&&f2.lat;
      let deadKm='—';
      if(hasCoords) deadKm=(optHaversine(t2.lat,t2.lng,f2.lat,f2.lng)/1000).toFixed(1)+' km';
      html+=`<div class="zone-nav-dead" data-from-ci="${ci}">
        <span class="dead-label">↓ Dead-mileage Z${ci+1}→Z${ci+2} ~${deadKm}</span>
        <button class="btn-gmaps-dead ${hasCoords?'':'disabled'}" data-from-ci="${ci}" ${hasCoords?'':'disabled'}>
          Google Maps ↗
        </button>
      </div>`;
    }
  });
  container.innerHTML=html;

  // Bind zone buttons
  container.querySelectorAll('.btn-gmaps-zone').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const ci=parseInt(btn.dataset.ci||0), bi=parseInt(btn.dataset.bi||0);
      const stops=buildZoneStops(ci);
      const batches=chunkStops(stops);
      if(batches[bi]) openGoogleMapsMulti(batches[bi]);
    });
  });

  // Bind dead-mileage buttons
  container.querySelectorAll('.btn-gmaps-dead:not(.disabled)').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const ci=parseInt(btn.dataset.fromCi);
      const cluster=clusters[ci];
      const nextCluster=clusters[ci+1];
      const t2=S.stops[S.plan[cluster[cluster.length-1]].toStop]||{};
      const f2=S.stops[S.plan[nextCluster[0]].fromStop]||{};
      if(t2.lat&&f2.lat){
        // From last stop of this zone to first stop of next
        const origin=t2.lat+','+t2.lng;
        const dest  =f2.lat+','+f2.lng;
        const url='https://www.google.com/maps/dir/?api=1&origin='+encodeURIComponent(origin)+'&destination='+encodeURIComponent(dest)+'&travelmode=driving';
        window.open(url,'_blank');
      }
    });
  });
}

function chunkStops(stops){
  // Split stop array into batches of MAX_GMAPS_WP+1 (origin + 9 WP + destination = 11 max)
  if(stops.length <= MAX_GMAPS_WP+1) return [stops];
  const batches=[];
  for(let i=0;i<stops.length;i+=MAX_GMAPS_WP+1){
    batches.push(stops.slice(i, i+MAX_GMAPS_WP+1));
  }
  return batches;
}

/* ══ ROUTE LADDER ═══════════════════════════════════════════════ */
function openLadder(){
  renderLadderContent();
  document.getElementById('ladder-drawer').classList.remove('hidden');
  document.getElementById('ladder-backdrop').classList.remove('hidden');
}
function closeLadder(){
  document.getElementById('ladder-drawer').classList.add('hidden');
  document.getElementById('ladder-backdrop').classList.add('hidden');
}
function renderLadderContent(){
  const body = document.getElementById('ladder-body');
  if(!body||!S.journeySteps.length){ if(body)body.innerHTML='<div class="empty-state">No plan loaded</div>'; return; }
  const doneIds=new Set(S.records.map(r=>r.LinkID+'_R'+r.Run));
  let html='', lastZone=-1;
  S.journeySteps.forEach((step,i)=>{
    const link=S.plan[step.planIdx];
    if(!link) return;
    const zoneId=step.clusterSeq||0;
    if(zoneId!==lastZone&&S.clusterResult&&S.clusterResult.numClusters>1){
      lastZone=zoneId;
      html+=`<div class="ladder-zone-hdr" style="border-left:3px solid ${CL_COLS[zoneId%CL_COLS.length]}">Zone ${zoneId+1}</div>`;
    }
    const uid=link.linkId+'_R'+step.run;
    const isCurrent=(i===S.currentStepIdx);
    const isDone=doneIds.has(uid);
    const isSkipped=link._skipped;
    let cls='ladder-step';
    if(isCurrent) cls+=' current';
    else if(isDone) cls+=' done';
    else if(isSkipped) cls+=' skipped';
    const icon=isCurrent?'▶':isDone?'✓':isSkipped?'⏭':'○';
    html+=`<div class="${cls}">
      <span class="ls-icon">${icon}</span>
      <div class="ls-info">
        <div class="ls-link">${link.linkId} <span class="ls-run">Run ${step.run}</span></div>
        <div class="ls-svc">${link.service||'—'}</div>
      </div>
    </div>`;
  });
  body.innerHTML=html;
  // Scroll current into view
  const cur=body.querySelector('.current');
  if(cur) cur.scrollIntoView({block:'center',behavior:'smooth'});
}


/* ══ MEASUREMENT: START / STOP / NEXT / SKIP / PAUSE ══════════ */
function startMeasurement(){
  const step=getCurrentStep(); if(!step){toast('No step — tap Next','error');return;}
  const link=S.plan[step.planIdx];
  const f=S.stops[link.fromStop]||{};
  beepStart();
  showFlagModal(link.fromStop, f.name||link.fromStop, f.lat, f.lng, flag=>{
    S.startFlag=flag;
    S.startCoord={lat:S.lastPos?S.lastPos.lat:'',lng:S.lastPos?S.lastPos.lng:''};
    S.plannedStartLat=f.lat||''; S.plannedStartLng=f.lng||'';
    S.trackingActive=true; S.gnssDist=0; S.gnssPoints=[];
    if(S.lastPos) S.gnssPoints.push({lat:S.lastPos.lat,lng:S.lastPos.lng,acc:S.lastPos.acc||0});
    document.getElementById('start-measure-btn').disabled=true;
    document.getElementById('stop-measure-btn').disabled=false;
    document.getElementById('gnss-bar-dist').textContent='0.000 km';
    resetProximityState();
    toast('Recording started','success');
  }, ()=>{ /* cancelled */ });
}

async function stopMeasurement(){
  if(!S.trackingActive){toast('Not recording','error');return;}
  const step=getCurrentStep(); if(!step) return;
  const link=S.plan[step.planIdx];
  const t=S.stops[link.toStop]||{};
  const cancelStop=()=>{
    S.trackingActive=true;
    document.getElementById('stop-measure-btn').disabled=false;
    toast('Cancelled — still recording','info');
  };
  showFlagModal(link.toStop, t.name||link.toStop, t.lat, t.lng, async flag=>{
    S.endFlag=flag;
    S.trackingActive=false;
    S.endCoord={lat:S.lastPos?S.lastPos.lat:'',lng:S.lastPos?S.lastPos.lng:''};
    S.plannedEndLat=t.lat||''; S.plannedEndLng=t.lng||'';
    const gnssKm=(S.gnssDist/1000);
    document.getElementById('stop-measure-btn').disabled=true;
    document.getElementById('next-link-btn').disabled=false;
    document.getElementById('gnss-bar-dist').textContent=gnssKm.toFixed(3)+' km';
    beepStop();
    resetProximityState();

    // Get route distance (OSRM between planned stops)
    let routeDist='';
    if(S.plannedStartLat&&S.plannedEndLat){
      try{
        const url=OSRM_BASE+'/'+S.plannedStartLng+','+S.plannedStartLat+';'+S.plannedEndLng+','+S.plannedEndLat+'?overview=false';
        const resp=await fetch(url);
        if(resp.ok){const d=await resp.json();routeDist=d.routes&&d.routes[0]?(d.routes[0].distance/1000).toFixed(4):'';}
      }catch(e){}
    }

    // Build record
    const rec={
      Zone:       S.clusterResult?String(step.clusterSeq+1):'1',
      Run:        String(step.run),
      LinkID:     link.linkId,
      Service:    link.service||'',
      From:       link.fromStop,
      To:         link.toStop,
      PlannedStartLat: String(S.plannedStartLat||''),
      PlannedStartLng: String(S.plannedStartLng||''),
      ActualStartLat:  String(S.startCoord?S.startCoord.lat:''),
      ActualStartLng:  String(S.startCoord?S.startCoord.lng:''),
      StartFlag:  S.startFlag||'AT_STOP',
      PlannedEndLat:   String(S.plannedEndLat||''),
      PlannedEndLng:   String(S.plannedEndLng||''),
      ActualEndLat:    String(S.endCoord?S.endCoord.lat:''),
      ActualEndLng:    String(S.endCoord?S.endCoord.lng:''),
      EndFlag:    S.endFlag||'AT_STOP',
      GPSDist:    gnssKm.toFixed(4),
      RouteDist:  routeDist,
      DateTime:   toSGT(new Date()),
      User:       S.driverName,
      Remarks:    buildRemarksWithNewStops(link, document.getElementById('remarks-input').value||'')
    };

    S.records.push(rec);
    try{localStorage.setItem('dm_recs',JSON.stringify(S.records));}catch(e){}
    saveSession();

    const saved=await jsonpSave(S.appsScriptUrl, Object.assign({sheetUrl:PERMANENT_SHEET},rec)).then(r=>!r.error).catch(()=>false);
    if(saved){ beepSaved(); toast('✓ Saved to Sheet','success'); }
    else      { toast('✓ Saved locally (no sheet connection)','info'); }

    // Write new stops if any
    if(saved) await writeNewStopsIfAny(link);
  }, cancelStop);
}

function nextLink(){
  S.currentStepIdx++;
  S.gnssDist=0; S.gnssPoints=[];
  S.startCoord=null; S.endCoord=null;
  S.startFlag=''; S.endFlag='';
  saveSession();
  if(S.currentStepIdx >= S.journeySteps.length){
    toast('🎉 All links completed!','success');
    renderDriveConsole();
    setTimeout(()=>switchScreen('overview'),1500);
    return;
  }
  renderDriveConsole();
  renderLadderContent();
}

function skipLink(){
  const step=getCurrentStep(); if(!step) return;
  const link=S.plan[step.planIdx];
  if(!confirm('Skip link '+link.linkId+'?')) return;
  link._skipped=true;
  S.currentStepIdx++;
  saveSession();
  if(S.currentStepIdx>=S.journeySteps.length){ toast('All links done','success'); switchScreen('overview'); return; }
  renderDriveConsole();
  renderLadderContent();
  toast('Skipped '+link.linkId,'info');
}

function pauseSession(){
  saveSession();
  toast('Session saved — you can close the app','success');
}

/* ══ NEW STOP HELPERS ═══════════════════════════════════════════ */
function buildRemarksWithNewStops(link, driverRemark){
  const from=S.stops[link.fromStop]||{}, to=S.stops[link.toStop]||{};
  const parts=[];
  if(from.isNew) parts.push('NEW STOP FROM: '+link.fromStop);
  if(to.isNew)   parts.push('NEW STOP TO: '+link.toStop);
  if(!parts.length) return driverRemark;
  const prefix='['+parts.join(', ')+']';
  return driverRemark ? prefix+' '+driverRemark : prefix;
}
async function writeNewStopsIfAny(link){
  const from=S.stops[link.fromStop]||{}, to=S.stops[link.toStop]||{};
  const newStops=[from,to].filter(s=>s.isNew&&s.lat);
  for(const stop of newStops){
    try{
      await jsonpFetch(S.appsScriptUrl,{action:'addNewStop',sheetUrl:PERMANENT_SHEET,BSCode:stop.code,BSName:stop.name,Planned_Lat:stop.lat,Planned_Long:stop.lng,Source:'DRIVER'});
    }catch(e){}
  }
  if(newStops.length){
    try{
      await jsonpFetch(S.appsScriptUrl,{action:'addNewLink',sheetUrl:PERMANENT_SHEET,Link:link.linkId,FromStopCode:link.fromStop,ToStopCode:link.toStop,Service:link.service||'',Source:'DRIVER'});
    }catch(e){}
  }
  newStops.forEach(s=>{ if(S.stops[s.code]) S.stops[s.code].isNew=false; });
}

/* ══ OVERVIEW ════════════════════════════════════════════════════ */
function renderOverview(){
  const done=S.records.length;
  const total=S.journeySteps.length;
  const pending=Math.max(0,total-done);
  let totalDist=0;
  S.records.forEach(r=>{ totalDist+=parseFloat(r.GPSDist)||0; });
  document.getElementById('ov-completed').textContent=done;
  document.getElementById('ov-pending').textContent=pending;
  document.getElementById('ov-total-dist').textContent=totalDist.toFixed(2);
  document.getElementById('ov-total-records').textContent=done;
  renderResultsTable(S.records);
}

function renderResultsTable(recs){
  const wrap=document.getElementById('results-table-wrap');
  if(!wrap) return;
  if(!recs||!recs.length){wrap.innerHTML='<div class="empty-state">No records yet.</div>';return;}
  const showCols=['Zone','Run','LinkID','Service','From','To','StartFlag','EndFlag','GPSDist','RouteDist','DateTime'];
  let html='<div style="overflow-x:auto"><table class="results-table"><thead><tr>'+showCols.map(c=>'<th>'+c+'</th>').join('')+'</tr></thead><tbody>';
  recs.forEach(r=>{
    html+='<tr>'+showCols.map(c=>'<td>'+escHtml(String(r[c]||''))+'</td>').join('')+'</tr>';
  });
  wrap.innerHTML=html+'</tbody></table></div>';
}

function openExportModal(){
  document.getElementById('export-modal-info').textContent=S.records.length+' records';
  document.getElementById('export-modal').classList.remove('hidden');
}

function buildCSV(){
  const rows=[RESULT_HEADERS.join(',')];
  S.records.forEach(r=>{ rows.push(RESULT_HEADERS.map(h=>'"'+(String(r[h]||'').replace(/"/g,'""'))+'"').join(',')); });
  return rows.join('\n');
}

function downloadCSV(){
  const csv=buildCSV();
  const ts=toSGT(new Date()).replace(' ','_').replace(/:/g,'-');
  const dname=(S.driverName||'DRIVER').replace(/[^a-zA-Z0-9_]/g,'_').toUpperCase();
  const fname='DM1_'+dname+'_'+ts+'.csv';
  const a=document.createElement('a');
  a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download=fname; a.click();
  document.getElementById('export-modal').classList.add('hidden');
  toast('Downloaded: '+fname,'success');
}

function shareWhatsApp(){
  const csv=buildCSV();
  const ts=toSGT(new Date()).replace(' ','_').replace(/:/g,'-');
  const dname=(S.driverName||'DRIVER').replace(/[^a-zA-Z0-9_]/g,'_').toUpperCase();
  const fname='DM1_'+dname+'_'+ts+'.csv';
  const a=document.createElement('a');a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);a.download=fname;a.click();
  setTimeout(()=>{
    const wa='https://wa.me/?text='+encodeURIComponent('DMapp Results: '+S.records.length+' records\nDriver: '+S.driverName+'\n\n(Attach the downloaded CSV file)');
    window.open(wa,'_blank');
  },800);
  document.getElementById('export-modal').classList.add('hidden');
}

async function loadResultsFromSheet(){
  try{
    const data=await jsonpFetch(S.appsScriptUrl,{action:'getResults',sheetUrl:PERMANENT_SHEET,user:S.driverName});
    if(data.results) renderResultsTable(data.results);
  }catch(e){ toast('Could not load from sheet','error'); }
}


/* ══ TASK TAB (reused from v1) ══════════════════════════════════ */
let _taskRows=[], _taskRunsOverride=2, _taskTabInited=false;

function initTaskTab(){
  if(_taskTabInited) return;
  _taskTabInited=true;
  document.getElementById('task-parse-btn').addEventListener('click', taskParse);
  document.getElementById('task-clear-btn').addEventListener('click', taskClearAll);
  document.getElementById('task-add-btn').addEventListener('click', taskAddManual);
  document.getElementById('task-load-plan-btn').addEventListener('click', taskLoadPlan);
  const fromInp=document.getElementById('task-manual-from');
  const toInp  =document.getElementById('task-manual-to');
  if(fromInp) fromInp.addEventListener('keydown',e=>{ if(e.key==='Enter')toInp&&toInp.focus(); });
  if(toInp)   toInp.addEventListener('keydown',  e=>{ if(e.key==='Enter')taskAddManual(); });
  [fromInp,toInp].forEach(inp=>{
    if(!inp) return;
    inp.addEventListener('input',()=>{ const v=inp.value.replace(/\D/g,'').slice(0,5); if(inp.value!==v)inp.value=v; });
  });
  document.querySelectorAll('#task-footer .run-btn-sm').forEach(b=>{
    b.addEventListener('click',()=>{
      document.querySelectorAll('#task-footer .run-btn-sm').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      _taskRunsOverride=parseInt(b.dataset.runs)||2;
      _taskRows.forEach(r=>r.runs=_taskRunsOverride);
      renderTaskTable(); saveTaskRows();
    });
  });
  initPinModalEvents();
  try{
    const saved=localStorage.getItem('dm_task_rows');
    if(saved){ _taskRows=JSON.parse(saved);
      if(_taskRows.length&&_taskRows[0].runs) _taskRunsOverride=_taskRows[0].runs;
      document.querySelectorAll('#task-footer .run-btn-sm').forEach(b=>b.classList.toggle('active',parseInt(b.dataset.runs)===_taskRunsOverride));
      renderTaskTable(); updateTaskLoadBtn();
    }
  }catch(e){}
}
function taskParse(){
  const raw=(document.getElementById('task-paste-input').value||'').trim();
  if(!raw){showStatus('task-parse-status','⚠ Nothing to parse','error');return;}
  const tokens=raw.split(/[;\n,\s]+/).map(t=>t.trim()).filter(Boolean);
  let added=0,skipped=0;
  tokens.forEach(tok=>{
    const parts=tok.split('-');
    if(parts.length<2){skipped++;return;}
    const from=parts[0].trim().toUpperCase(), to=parts[parts.length-1].trim().toUpperCase();
    if(!from||!to){skipped++;return;}
    if(_taskRows.some(r=>r.from===from&&r.to===to)){skipped++;return;}
    _taskRows.push({from,to,fromName:'…',toName:'…',service:'',status:'loading',runs:_taskRunsOverride,isNewFrom:false,isNewTo:false,pinnedFrom:null,pinnedTo:null});
    added++;
  });
  document.getElementById('task-paste-input').value='';
  renderTaskTable(); updateTaskLoadBtn();
  if(added>0){showStatus('task-parse-status','✓ '+added+' link'+(added!==1?'s':'')+' added'+(skipped?' ('+skipped+' skipped)':''),'success');taskLookupAll();}
  else showStatus('task-parse-status','⚠ No new links parsed','error');
  saveTaskRows();
}
function taskAddManual(){
  const fromEl=document.getElementById('task-manual-from'),toEl=document.getElementById('task-manual-to');
  const from=(fromEl.value||'').trim().toUpperCase(),to=(toEl.value||'').trim().toUpperCase();
  if(!from||!to){toast('Enter both FROM and TO codes','error');return;}
  if(_taskRows.some(r=>r.from===from&&r.to===to)){toast('Link already in list','error');return;}
  _taskRows.push({from,to,fromName:'…',toName:'…',service:'',status:'loading',runs:_taskRunsOverride,isNewFrom:false,isNewTo:false,pinnedFrom:null,pinnedTo:null});
  fromEl.value='';toEl.value='';fromEl.focus();
  renderTaskTable(); updateTaskLoadBtn(); saveTaskRows(); taskLookupAll();
}
function taskClearAll(){
  _taskRows=[];renderTaskTable();updateTaskLoadBtn();saveTaskRows();
  document.getElementById('task-paste-input').value='';
  const st=document.getElementById('task-parse-status');
  if(st){st.textContent='';st.className='status-msg hidden';}
}
function taskDeleteRow(i){_taskRows.splice(i,1);renderTaskTable();updateTaskLoadBtn();saveTaskRows();}
function taskSetRowRuns(i,runs){if(!_taskRows[i])return;_taskRows[i].runs=runs;renderTaskTable();saveTaskRows();}
function saveTaskRows(){try{localStorage.setItem('dm_task_rows',JSON.stringify(_taskRows));}catch(e){}}
function escHtml(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function padStop(code){if(!code)return code;return code.length<5?code.padStart(5,'0'):code;}

function renderTaskTable(){
  const tbody=document.getElementById('task-tbody');
  const badge=document.getElementById('task-count-badge');
  if(!tbody)return;
  if(badge)badge.textContent=_taskRows.length?_taskRows.length+' link'+(_taskRows.length!==1?'s':''):'';
  if(!_taskRows.length){tbody.innerHTML='<tr class="task-empty-row"><td colspan="8">No links yet</td></tr>';return;}
  const rows=[];
  for(let i=0;i<_taskRows.length;i++){
    const r=_taskRows[i];
    let fCls='',fContent='',tCls='',tContent='';
    if(r.status==='loading'){fCls='task-warn';fContent='…';tCls='task-warn';tContent='…';}
    else{
      if(r.isNewFrom&&r.pinnedFrom){fCls='task-new-pinned';fContent='NEW - '+r.from+' 📍 <button class="pin-btn" data-pin-idx="'+i+'" data-pin-which="from">✏</button>';}
      else if(r.isNewFrom||r.status==='err-from'){fCls='task-warn';fContent='NEW - '+r.from+' <button class="pin-btn" data-pin-idx="'+i+'" data-pin-which="from">📍 Pin</button>';}
      else{fContent=escHtml(r.fromName||'—');}
      if(r.isNewTo&&r.pinnedTo){tCls='task-new-pinned';tContent='NEW - '+r.to+' 📍 <button class="pin-btn" data-pin-idx="'+i+'" data-pin-which="to">✏</button>';}
      else if(r.isNewTo||r.status==='err-to'){tCls='task-warn';tContent='NEW - '+r.to+' <button class="pin-btn" data-pin-idx="'+i+'" data-pin-which="to">📍 Pin</button>';}
      else{tContent=escHtml(r.toName||'—');}
    }
    const runs=r.runs||2;
    rows.push('<tr>'
      +'<td class="tc-num">'+(i+1)+'</td>'
      +'<td class="tc-code">'+r.from+'</td>'
      +'<td class="tc-name '+fCls+'">'+fContent+'</td>'
      +'<td class="tc-code">'+r.to+'</td>'
      +'<td class="tc-name '+tCls+'">'+tContent+'</td>'
      +'<td class="tc-svc">'+escHtml(r.service||'—')+'</td>'
      +'<td class="tc-runs"><div class="row-runs">'
        +'<button class="row-run-btn'+(runs===1?' active':'')+'" data-runs-idx="'+i+'" data-runs-val="1">×1</button>'
        +'<button class="row-run-btn'+(runs===2?' active':'')+'" data-runs-idx="'+i+'" data-runs-val="2">×2</button>'
      +'</div></td>'
      +'<td class="tc-del"><button class="task-del-btn" data-del-idx="'+i+'">✕</button></td>'
      +'</tr>');
  }
  tbody.innerHTML=rows.join('');
}
function updateTaskLoadBtn(){
  const btn=document.getElementById('task-load-plan-btn');
  if(!btn)return;
  const total=_taskRows.filter(r=>r.from&&r.to).length;
  const unpinned=_taskRows.filter(r=>(r.isNewFrom&&!r.pinnedFrom)||(r.isNewTo&&!r.pinnedTo)).length;
  const newPinned=_taskRows.filter(r=>(r.isNewFrom&&r.pinnedFrom)||(r.isNewTo&&r.pinnedTo)).length;
  btn.disabled=total===0||unpinned>0;
  if(total===0) btn.textContent='▶ Load Plan → Planner';
  else if(unpinned>0) btn.textContent='⚠ Pin '+unpinned+' new stop'+(unpinned!==1?'s':'')+' before loading';
  else if(newPinned>0) btn.textContent='▶ Load '+total+' Link'+(total!==1?'s':'')+' ('+newPinned+' new) → Planner';
  else btn.textContent='▶ Load '+total+' Link'+(total!==1?'s':'')+' → Planner';
}
async function taskLookupAll(){
  const pending=_taskRows.filter(r=>r.status==='loading');
  if(!pending.length)return;
  showStatus('task-parse-status','⏳ Looking up stop names…','info');
  try{
    const data=await jsonpFetch(S.appsScriptUrl,{action:'getReference',sheetId:SHEET_ID});
    const bsMap={},lnkMap={};
    let cachedNewStops={};
    try{cachedNewStops=JSON.parse(localStorage.getItem('dm_new_stops')||'{}');}catch(e){}
    (data.stops||[]).forEach(s=>{ const c=padStop(String(s.BSCode||s['BS Code']||'').trim()); const n=String(s.BSName||s['BS Name']||'').trim(); if(c)bsMap[c]=n; });
    (data.links||[]).forEach(l=>{ const k=padStop(String(l.FromStopCode||l.FromStop||'').trim())+'-'+padStop(String(l.ToStopCode||l.ToStop||'').trim()); lnkMap[k]=String(l.Service||'').trim(); });
    // Always update S.stops with full lat/lng from reference data
    (data.stops||[]).forEach(s=>{
      const c=padStop(String(s.BSCode||'').trim()); if(!c)return;
      S.stops[c]=S.stops[c]||{};
      S.stops[c].code=c;
      S.stops[c].name=String(s.BSName||c).trim();
      S.stops[c].lat=parseFloat(s.Planned_Lat||0)||0;
      S.stops[c].lng=parseFloat(s.Planned_Long||0)||0;
    });
    S.links={};
    (data.links||[]).forEach(l=>{ const k=padStop(String(l.FromStopCode||l.FromStop||'').trim())+'-'+padStop(String(l.ToStopCode||l.ToStop||'').trim()); if(k)S.links[k]={service:String(l.Service||'').trim()}; });
    savePlanCache();
    _taskRows.forEach(r=>{
      if(r.status!=='loading')return;
      const fc=padStop(r.from),tc=padStop(r.to);
      r.from=fc;r.to=tc;
      const fn=bsMap[fc]||(cachedNewStops[fc]&&cachedNewStops[fc].name);
      const tn=bsMap[tc]||(cachedNewStops[tc]&&cachedNewStops[tc].name);
      const fcNew=!bsMap[fc],tcNew=!bsMap[tc];
      r.fromName=fn||('NEW - '+fc);r.toName=tn||('NEW - '+tc);
      r.isNewFrom=fcNew;r.isNewTo=tcNew;
      if(fcNew&&cachedNewStops[fc])r.pinnedFrom=cachedNewStops[fc];
      if(tcNew&&cachedNewStops[tc])r.pinnedTo=cachedNewStops[tc];
      r.service=lnkMap[fc+'-'+tc]||'';
      r.status=(!fcNew&&!tcNew)?(r.service?'ok':'no-svc'):'has-new';
    });
    const newStops=_taskRows.filter(r=>r.status==='has-new').length;
    const ok=_taskRows.filter(r=>r.status==='ok'||r.status==='no-svc').length;
    let msg='✓ '+ok+' resolved';
    if(newStops)msg+=' · 📍 '+newStops+' new stop'+(newStops!==1?'s':'')+' — tap Pin';
    showStatus('task-parse-status',msg,newStops?'error':'success');
  }catch(e){
    _taskRows.forEach(r=>{ if(r.status==='loading'){r.fromName='?';r.toName='?';r.status='no-svc';} });
    showStatus('task-parse-status','⚠ Could not look up names (offline?) — codes kept','error');
  }
  renderTaskTable();updateTaskLoadBtn();saveTaskRows();
}
function taskLoadPlan(){
  const valid=_taskRows.filter(r=>r.from&&r.to);
  if(!valid.length){toast('Add at least one link first','error');return;}
  // Keep S.stops intact so lat/lng from taskLookupAll is preserved
  S.plan=[]; S.links={}; S.clusterResult=null; S.journeySteps=[];
  valid.forEach((r,i)=>{
    const p=r.pinnedFrom, q=r.pinnedTo;
    // Preserve existing coords; only override if we have a pinned location
    const existF=S.stops[r.from]||{};
    const existT=S.stops[r.to]  ||{};
    S.stops[r.from]={code:r.from, name:r.fromName||existF.name||('NEW - '+r.from),
      lat:p?p.lat:(existF.lat||0), lng:p?p.lng:(existF.lng||0), isNew:r.isNewFrom||false};
    S.stops[r.to]  ={code:r.to,   name:r.toName  ||existT.name||('NEW - '+r.to),
      lat:q?q.lat:(existT.lat||0), lng:q?q.lng:(existT.lng||0), isNew:r.isNewTo  ||false};
    S.plan.push({linkId:r.from+'-'+r.to,service:r.service||'—',sequence:i+1,fromStop:r.from,toStop:r.to,skipRun2:(r.runs||2)===1});
  });
  S.totalRuns=valid.some(r=>(r.runs||2)===2)?2:1;
  savePlanCache(); renderPlannerUI(); switchScreen('planner');
  toast('Plan loaded: '+valid.length+' links','success');
}

/* ══ PIN MODAL ═══════════════════════════════════════════════════ */
let _pinMap=null,_pinMarker=null,_pinRowIdx=-1,_pinWhich='',_pinCoord=null;
function openPinModal(rowIdx,which){
  _pinRowIdx=rowIdx;_pinWhich=which;_pinCoord=null;
  const r=_taskRows[rowIdx];
  const code=which==='from'?r.from:r.to;
  document.getElementById('pin-modal-title').textContent='📍 Pin New Stop: '+code;
  document.getElementById('pin-confirm-btn').disabled=true;
  document.getElementById('pin-coord-display').textContent='Tap map to place pin';
  document.getElementById('pin-lat-input').value='';
  document.getElementById('pin-lng-input').value='';
  document.getElementById('pin-modal').classList.remove('hidden');
  setTimeout(()=>{
    if(!_pinMap){
      _pinMap=L.map('pin-map',{zoomControl:true,attributionControl:false});
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(_pinMap);
      _pinMap.on('click',e=>placePinAt(e.latlng.lat,e.latlng.lng));
    }
    const existing=which==='from'?r.pinnedFrom:r.pinnedTo;
    if(existing){_pinMap.setView([existing.lat,existing.lng],17);placePinAt(existing.lat,existing.lng);}
    else if(S.lastPos){
      _pinMap.setView([S.lastPos.lat,S.lastPos.lng],16);
      if(!_pinMap._gpsDot){
        const icon=L.divIcon({className:'',html:'<div style="width:12px;height:12px;background:#2563eb;border:2px solid #fff;border-radius:50%;box-shadow:0 0 6px rgba(37,99,235,0.6)"></div>',iconSize:[12,12],iconAnchor:[6,6]});
        _pinMap._gpsDot=L.marker([S.lastPos.lat,S.lastPos.lng],{icon,interactive:false}).addTo(_pinMap);
      }else _pinMap._gpsDot.setLatLng([S.lastPos.lat,S.lastPos.lng]);
    }else _pinMap.setView([1.3521,103.8198],13);
    _pinMap.invalidateSize();
  },100);
}
function placePinAt(lat,lng){
  lat=parseFloat(lat.toFixed(6));lng=parseFloat(lng.toFixed(6));
  _pinCoord={lat,lng};
  if(!_pinMarker){
    const icon=L.divIcon({className:'',html:'<div style="width:22px;height:22px;background:#ef4444;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.4);"></div>',iconSize:[22,22],iconAnchor:[11,11]});
    _pinMarker=L.marker([lat,lng],{icon,draggable:true}).addTo(_pinMap);
    _pinMarker.on('dragend',e=>{const p=e.target.getLatLng();placePinAt(p.lat,p.lng);});
  }else _pinMarker.setLatLng([lat,lng]);
  document.getElementById('pin-coord-display').textContent=lat.toFixed(6)+', '+lng.toFixed(6);
  document.getElementById('pin-lat-input').value=lat;
  document.getElementById('pin-lng-input').value=lng;
  document.getElementById('pin-confirm-btn').disabled=false;
}
function closePinModal(){document.getElementById('pin-modal').classList.add('hidden');_pinRowIdx=-1;_pinWhich='';_pinCoord=null;}
function confirmPin(){
  if(!_pinCoord||_pinRowIdx<0)return;
  const r=_taskRows[_pinRowIdx];
  const code=_pinWhich==='from'?r.from:r.to;
  const pinData={lat:_pinCoord.lat,lng:_pinCoord.lng,code,name:'NEW - '+code};
  if(_pinWhich==='from'){r.pinnedFrom=pinData;r.fromName='NEW - '+code;r.isNewFrom=true;}
  else{r.pinnedTo=pinData;r.toName='NEW - '+code;r.isNewTo=true;}
  r.status=(r.isNewFrom||r.isNewTo)?'has-new':(r.service?'ok':'no-svc');
  try{const cache=JSON.parse(localStorage.getItem('dm_new_stops')||'{}');cache[code]=pinData;localStorage.setItem('dm_new_stops',JSON.stringify(cache));}catch(e){}
  S.stops[code]={code,name:'NEW - '+code,lat:_pinCoord.lat,lng:_pinCoord.lng,isNew:true};
  saveTaskRows();renderTaskTable();updateTaskLoadBtn();closePinModal();
  toast('📍 '+code+' pinned','success');
}
function initPinModalEvents(){
  document.getElementById('pin-modal-cancel').addEventListener('click',closePinModal);
  document.getElementById('pin-confirm-btn').addEventListener('click',confirmPin);
  document.getElementById('pin-goto-btn').addEventListener('click',()=>{
    const lat=parseFloat(document.getElementById('pin-lat-input').value);
    const lng=parseFloat(document.getElementById('pin-lng-input').value);
    if(isNaN(lat)||isNaN(lng)||lat<-90||lat>90||lng<-180||lng>180){toast('Enter valid coordinates','error');return;}
    if(_pinMap)_pinMap.setView([lat,lng],17);
    placePinAt(lat,lng);
  });
  ['pin-lat-input','pin-lng-input'].forEach(id=>document.getElementById(id).addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('pin-goto-btn').click();}));
  // Task table delegation
  const tbody=document.getElementById('task-tbody');
  if(tbody){
    tbody.addEventListener('click',function(e){
      const btn=e.target.closest('button');if(!btn)return;
      if(btn.hasAttribute('data-pin-idx')){e.stopPropagation();openPinModal(parseInt(btn.dataset.pinIdx),btn.dataset.pinWhich);return;}
      if(btn.hasAttribute('data-runs-idx')){e.stopPropagation();taskSetRowRuns(parseInt(btn.dataset.runsIdx),parseInt(btn.dataset.runsVal));return;}
      if(btn.hasAttribute('data-del-idx')){e.stopPropagation();taskDeleteRow(parseInt(btn.dataset.delIdx));return;}
    });
  }
}

/* ══ ADMIN ═══════════════════════════════════════════════════════ */
const ADMIN_STORE_KEY='dmapp_admin_overrides';
function getAdminOverrides(){try{return JSON.parse(localStorage.getItem(ADMIN_STORE_KEY)||'{}');}catch(e){return {};}}
function applyAdminOverrides(){
  const ov=getAdminOverrides();
  if(ov.appsScriptUrl) S.appsScriptUrl=ov.appsScriptUrl;
  if(ov.gnssGood)      S.gnssGood=parseInt(ov.gnssGood);
  if(ov.proxDist)      S.proxDist=parseInt(ov.proxDist);
  if(ov.speedKmh)      S.speedKmh=parseInt(ov.speedKmh);
}
function checkAdminRoute(){
  const path=window.location.pathname;
  const params=new URLSearchParams(window.location.search);
  const isAdmin=path.endsWith('/admin')||path.endsWith('/admin.html')||params.get('admin')==='1';
  if(!isAdmin)return false;
  const splash=document.getElementById('splash');
  if(splash)splash.style.display='none';
  document.querySelectorAll('.app-hidden').forEach(el=>el.classList.remove('app-hidden'));
  initAdminPage();
  return true;
}
function initAdminPage(){
  const overlay=document.getElementById('admin-overlay');
  if(!overlay)return;
  overlay.classList.remove('hidden');
  const pwInput=document.getElementById('admin-pw-input');
  const pwBtn=document.getElementById('admin-pw-btn');
  const pwErr=document.getElementById('admin-pw-err');
  function tryUnlock(){
    if((pwInput.value||'').trim()==='815'){
      document.getElementById('admin-pw-screen').style.display='none';
      document.getElementById('admin-panel').classList.remove('hidden');
      populateAdminPanel();
    }else{pwErr.classList.remove('hidden');pwInput.value='';setTimeout(()=>pwErr.classList.add('hidden'),2000);}
  }
  pwBtn.addEventListener('click',tryUnlock);
  pwInput.addEventListener('keydown',e=>{if(e.key==='Enter')tryUnlock();});
  setTimeout(()=>pwInput&&pwInput.focus(),200);
  document.getElementById('admin-close-btn').addEventListener('click',()=>{
    overlay.classList.add('hidden');
    const path=window.location.pathname;
    if(path.endsWith('/admin'))window.location.href='/';
    else{const url=new URL(window.location.href);url.searchParams.delete('admin');window.history.replaceState({},'',url.pathname);}
  });
  document.getElementById('admin-save-btn').addEventListener('click',saveAdminOverrides);
  document.getElementById('admin-reset-btn').addEventListener('click',resetAdminOverrides);
}
function populateAdminPanel(){
  const ov=getAdminOverrides();
  document.getElementById('admin-as-url').value  =ov.appsScriptUrl||APPS_SCRIPT_URL;
  document.getElementById('admin-sheet-id').value=ov.sheetId||SHEET_ID;
  document.getElementById('admin-osrm-url').value=ov.osrmBase||OSRM_BASE;
  document.getElementById('admin-gnss-good').value=ov.gnssGood||GNSS_GOOD;
  document.getElementById('admin-prox-dist').value=ov.proxDist||PROX_DIST;
  document.getElementById('admin-speed').value    =ov.speedKmh||SPEED_KMH;
  document.getElementById('admin-app-ver').value  =APP_VERSION;
  const sid=ov.sheetId||SHEET_ID;
  const surl='https://docs.google.com/spreadsheets/d/'+sid;
  document.getElementById('admin-sheet-url').value=surl;
  document.getElementById('admin-sheet-link').href=surl+'/edit';
  document.getElementById('admin-sheet-id').addEventListener('input',function(){
    const u='https://docs.google.com/spreadsheets/d/'+this.value.trim();
    document.getElementById('admin-sheet-url').value=u;
    document.getElementById('admin-sheet-link').href=u+'/edit';
  });
  buildDebugInfo();
}
function buildDebugInfo(){
  const el=document.getElementById('admin-debug-info');if(!el)return;
  const ov=getAdminOverrides();
  const sess=localStorage.getItem('dm_session');
  const si=sess?((()=>{try{const s=JSON.parse(sess);return 'Step '+(s.currentStepIdx||0)+'/'+(s.journeySteps||[]).length+' · '+(s.records||[]).length+' records · '+s.savedAt;}catch(e){return 'Parse error';}})()):'None';
  const rows=[
    ['Version',APP_VERSION],['Driver',S.driverName],['Overrides',Object.keys(ov).join(', ')||'None'],
    ['Apps Script',APPS_SCRIPT_URL.slice(0,50)+'…'],['Sheet ID',SHEET_ID],
    ['OSRM',OSRM_BASE],['GNSS threshold',S.gnssGood+'m'],['Prox alert',S.proxDist+'m'],['Speed',S.speedKmh+' km/h'],
    ['Session',si],['Plan links',(S.plan||[]).length],['Records',(S.records||[]).length],
  ];
  el.innerHTML=rows.map(([k,v])=>'<div class="admin-debug-row"><span class="adr-key">'+k+'</span><span class="adr-val">'+v+'</span></div>').join('');
}
function saveAdminOverrides(){
  const ov={
    appsScriptUrl:document.getElementById('admin-as-url').value.trim(),
    sheetId:document.getElementById('admin-sheet-id').value.trim(),
    osrmBase:document.getElementById('admin-osrm-url').value.trim(),
    gnssGood:document.getElementById('admin-gnss-good').value.trim(),
    proxDist:document.getElementById('admin-prox-dist').value.trim(),
    speedKmh:document.getElementById('admin-speed').value.trim(),
  };
  const clean={};
  if(ov.appsScriptUrl!==APPS_SCRIPT_URL)clean.appsScriptUrl=ov.appsScriptUrl;
  if(ov.sheetId!==SHEET_ID)clean.sheetId=ov.sheetId;
  if(ov.osrmBase!==OSRM_BASE)clean.osrmBase=ov.osrmBase;
  if(parseInt(ov.gnssGood)!==GNSS_GOOD)clean.gnssGood=ov.gnssGood;
  if(parseInt(ov.proxDist)!==PROX_DIST)clean.proxDist=ov.proxDist;
  if(parseInt(ov.speedKmh)!==SPEED_KMH)clean.speedKmh=ov.speedKmh;
  localStorage.setItem(ADMIN_STORE_KEY,JSON.stringify(clean));
  applyAdminOverrides();
  const msg=document.getElementById('admin-save-msg');
  msg.textContent='✓ '+(Object.keys(clean).length?Object.keys(clean).length+' override(s) saved':'No changes');
  msg.classList.remove('hidden');setTimeout(()=>msg.classList.add('hidden'),3000);
  buildDebugInfo();
}
function resetAdminOverrides(){
  if(!confirm('Reset all admin overrides to defaults?'))return;
  localStorage.removeItem(ADMIN_STORE_KEY);
  S.appsScriptUrl=APPS_SCRIPT_URL;S.gnssGood=GNSS_GOOD;S.proxDist=PROX_DIST;S.speedKmh=SPEED_KMH;
  populateAdminPanel();
  const msg=document.getElementById('admin-save-msg');
  msg.textContent='↺ Defaults restored';msg.classList.remove('hidden');setTimeout(()=>msg.classList.add('hidden'),3000);
}

/* ══ BOOTSTRAP ═══════════════════════════════════════════════════ */
const APP_VERSION_STR = APP_VERSION;
document.addEventListener('DOMContentLoaded', ()=>{
  applyAdminOverrides();
  if(checkAdminRoute()) return;
  fetch('version.json?t='+Date.now(),{cache:'no-store'})
    .then(r=>r.json())
    .then(v=>{
      const stored=localStorage.getItem('dmapp_version');
      if(stored&&stored!==v.version){
        localStorage.setItem('dmapp_version',v.version);
        if(window.caches) caches.keys().then(keys=>Promise.all(keys.map(k=>caches.delete(k)))).then(()=>window.location.reload(true));
        else window.location.reload(true);
        return;
      }
      localStorage.setItem('dmapp_version',v.version);
      runSplash();
    })
    .catch(()=>runSplash());
});


/* ══════════════════════════════════════════════════════════════
   GOOGLE MAPS URL GENERATION
   ══════════════════════════════════════════════════════════════ */

function getZoneStopCoords(clusterIdx){
  // Returns [{lat,lng,code}] in order for a zone
  const clusters = S.clusterResult ? S.clusterResult.clusters : [S.plan.map((_,i)=>i)];
  const cluster  = clusters[clusterIdx]||[];
  const stops=[];
  cluster.forEach(pi=>{
    const link=S.plan[pi]; if(!link) return;
    const f=S.stops[link.fromStop]||{}, t=S.stops[link.toStop]||{};
    // Avoid duplicating chained stops
    const lastCode = stops.length ? stops[stops.length-1].code : null;
    if(f.lat && f.code!==lastCode) stops.push({lat:f.lat,lng:f.lng,code:link.fromStop});
    if(t.lat) stops.push({lat:t.lat,lng:t.lng,code:link.toStop});
  });
  return stops;
}

function buildGoogleMapsUrlFromStops(stops, originOverride){
  // originOverride: {lat,lng} — if null, uses first stop as origin
  if(!stops.length) return null;
  const origin = originOverride
    ? (originOverride.lat+','+originOverride.lng)
    : (stops[0].lat+','+stops[0].lng);
  const dest   = stops[stops.length-1].lat+','+stops[stops.length-1].lng;
  const middle = stops.slice(originOverride?0:1, -1);
  const wps    = middle.map(s=>s.lat+','+s.lng);
  let url = 'https://www.google.com/maps/dir/?api=1'
    + '&origin='      + encodeURIComponent(origin)
    + '&destination=' + encodeURIComponent(dest)
    + (wps.length ? '&waypoints='+encodeURIComponent(wps.join('|')) : '')
    + '&travelmode=driving';
  return url;
}

function buildZoneGoogleMapsUrl(clusterIdx, useCurrentGPS){
  // Check override first
  const ov = S.zoneMapOverrides||{};
  if(ov['z'+clusterIdx]) return [ov['z'+clusterIdx]];

  const stops = getZoneStopCoords(clusterIdx);
  if(!stops.length) return null;

  // Check if all coords are 0
  const hasCoords = stops.some(s=>s.lat&&s.lng);
  if(!hasCoords) return null;

  const origin = useCurrentGPS && S.lastPos
    ? {lat:S.lastPos.lat, lng:S.lastPos.lng}
    : null; // use first stop

  // Split into batches of MAX_GMAPS_WP+1
  const batches = [];
  // If using GPS origin, include all stops as waypoints/dest
  const stopsForBatch = origin ? stops : stops;
  for(let i=0; i<stopsForBatch.length; i+=MAX_GMAPS_WP+1){
    batches.push(stopsForBatch.slice(i, i+MAX_GMAPS_WP+1));
  }
  return batches.map((batch,bi)=>buildGoogleMapsUrlFromStops(batch, bi===0?origin:null));
}

function buildDeadMileGoogleMapsUrl(fromClusterIdx, toClusterIdx, useCurrentGPS){
  const ov = S.zoneMapOverrides||{};
  const key = 'dead_'+fromClusterIdx+'_'+toClusterIdx;
  if(ov[key]) return ov[key];

  const clusters = S.clusterResult ? S.clusterResult.clusters : [S.plan.map((_,i)=>i)];
  const fromCluster = clusters[fromClusterIdx]||[];
  const toCluster   = clusters[toClusterIdx]  ||[];
  if(!fromCluster.length||!toCluster.length) return null;

  const lastPi  = fromCluster[fromCluster.length-1];
  const firstPi = toCluster[0];
  if(!S.plan[lastPi]||!S.plan[firstPi]) return null;

  const t = S.stops[S.plan[lastPi].toStop]  ||{};
  const f = S.stops[S.plan[firstPi].fromStop]||{};

  if(!t.lat||!f.lat) return null;

  const origin = useCurrentGPS && S.lastPos
    ? (S.lastPos.lat+','+S.lastPos.lng)
    : (t.lat+','+t.lng);

  return 'https://www.google.com/maps/dir/?api=1'
    + '&origin='      + encodeURIComponent(origin)
    + '&destination=' + encodeURIComponent(f.lat+','+f.lng)
    + '&travelmode=driving';
}

function setZoneMapOverride(key, url){
  if(!S.zoneMapOverrides) S.zoneMapOverrides={};
  if(url) S.zoneMapOverrides[key]=url.trim();
  else delete S.zoneMapOverrides[key];
  saveSession();
  renderPlanExport();
  renderZoneNav(); // update Drive tab
}

/* ══════════════════════════════════════════════════════════════
   PLANNER SUB-TABS
   ══════════════════════════════════════════════════════════════ */

let _plannerSubTab = 'plan'; // 'plan' or 'map'

function switchPlannerTab(tab){
  _plannerSubTab = tab;
  const planView = document.getElementById('planner-plan-view');
  const mapView  = document.getElementById('planner-map-view');
  const planBtn  = document.getElementById('psub-plan-btn');
  const mapBtn   = document.getElementById('psub-map-btn');
  if(!planView||!mapView) return;
  if(tab==='plan'){
    planView.style.display='';
    mapView.style.display='none';
    if(planBtn){ planBtn.classList.add('active'); }
    if(mapBtn)  { mapBtn.classList.remove('active'); }
  } else {
    planView.style.display='none';
    mapView.style.display='';
    if(planBtn){ planBtn.classList.remove('active'); }
    if(mapBtn)  { mapBtn.classList.add('active'); }
    // Leaflet needs resize after display:none→block
    setTimeout(()=>{ if(S.plannerMap) S.plannerMap.invalidateSize(); },100);
  }
}

function initPlannerSubTabs(){
  const planBtn = document.getElementById('psub-plan-btn');
  const mapBtn  = document.getElementById('psub-map-btn');
  if(planBtn) planBtn.addEventListener('click',()=>switchPlannerTab('plan'));
  if(mapBtn)  mapBtn.addEventListener('click', ()=>switchPlannerTab('map'));
}


/* ══ COPY/SHARE ALL GMAPS LINKS ═════════════════════════════════ */
function buildAllGmapsText(){
  const clusters = S.clusterResult ? S.clusterResult.clusters.filter(c=>c&&c.length>0)
                                    : [S.plan.map((_,i)=>i)];
  const ov = S.zoneMapOverrides||{};
  const lines = ['DMapp BIS — Google Maps Navigation Links',
    'Driver: '+S.driverName+'  |  Date: '+toSGT(new Date()).slice(0,10), ''];
  clusters.forEach((cluster,ci)=>{
    const urls = buildZoneGoogleMapsUrl(ci, false);
    const ovUrl = ov['z'+ci];
    lines.push('Zone '+(ci+1)+' ('+cluster.filter(pi=>S.plan[pi]).length+' links):');
    if(ovUrl){
      lines.push('  '+ovUrl+' [custom]');
    } else if(urls&&urls.length){
      urls.forEach((url,bi)=>lines.push('  '+(urls.length>1?'Part '+(bi+1)+': ':'')+url));
    } else {
      lines.push('  (no coordinates — pin stops first)');
    }
    if(ci<clusters.length-1){
      const deadKey='dead_'+ci+'_'+(ci+1);
      const deadUrl=ov[deadKey]||buildDeadMileGoogleMapsUrl(ci,ci+1,false);
      lines.push('Dead-mileage Zone '+(ci+1)+'→Zone '+(ci+2)+':');
      lines.push('  '+(deadUrl||'(no coordinates)'));
    }
    lines.push('');
  });
  return lines.join('\n');
}

function copyAllGmapsLinks(){
  const txt = buildAllGmapsText();
  navigator.clipboard.writeText(txt)
    .then(()=>toast('All Google Maps links copied ✓','success'))
    .catch(()=>{
      const ta=document.createElement('textarea');ta.value=txt;
      document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();
      toast('Links copied','success');
    });
}

function shareGmapsPlanWhatsApp(){
  const txt = buildCompactPlan()+'\n\n'+buildAllGmapsText();
  const fname='DMapp_Plan_'+S.driverName.replace(/[^a-zA-Z0-9]/g,'_')+'_'+toSGT(new Date()).slice(0,10)+'.txt';
  const blob=new Blob([txt],{type:'text/plain;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=fname;
  document.body.appendChild(a);a.click();
  setTimeout(()=>{URL.revokeObjectURL(url);document.body.removeChild(a);},1000);
  setTimeout(()=>{
    const wa='https://wa.me/?text='+encodeURIComponent('DMapp Plan — see attached .txt file\n\nDriver: '+S.driverName+'\nDate: '+toSGT(new Date()).slice(0,10));
    window.open(wa,'_blank');
  },800);
  toast('File downloaded — attach it in WhatsApp','info');
}

/* ══ PARSE COMPACT PLAN — restore GMAPS overrides ══════════════ */
