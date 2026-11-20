// ================================================================
//  app.js — Court Automation PWA  |  v5 (UP-Prefix ⚡ + Cache Fix)
//  Changes:
//  - Lightning ⚡ 1-tap buttons now appear for ALL words starting with "UP"
//    (plus auto-detected UPBL CNRs, cleaning dots like UPBL.360... -> UPBL360...)
//  - Manual CNR defaults to editable "UPBL04" + numeric keypad
//  - Comma-separated OCR word chip selection
//  - Stable Firebase (.info/connected, 10s timeout, batch update())
// ================================================================
'use strict';

// ── Firebase state ───────────────────────────────────────────────
let db             = null;
let presenceRef    = null;
let connRef        = null;
let pcOnline       = false;
let fbReady        = false;
let fbConnected    = false;
let isSyncing      = false;
let reconnectTimer = null;

// ── Hardcoded Firebase defaults ──────────────────────────────────
const FB_DEFAULTS = {
  url   : 'https://court-automation-2-default-rtdb.firebaseio.com/',
  apiKey: 'AIzaSyBrgmFp4EXnO7Bb358fZdydk5HpI1UGS3o',
};

let FB_URL    = FB_DEFAULTS.url;
let FB_APIKEY = FB_DEFAULTS.apiKey;
let FB_PREFIX = '/automation';

const FB_WRITE_TIMEOUT_MS = 10000;
const DEFAULT_CNR_PREFIX  = 'UPBL04';

function normalizePrefix(p) {
  let s = String(p || '/automation').trim();
  if (!s.startsWith('/')) s = '/' + s;
  return s.replace(/\/+$/, '') || '/automation';
}

const FB_PATH = () => ({
  presence    : `${FB_PREFIX}/system_status`,
  cnrQueue    : `${FB_PREFIX}/cnr_queue`,
  pendingScans: `${FB_PREFIX}/pending_scans`,
});

// ── Timeout helper for Firebase writes ───────────────────────────
function withTimeout(promise, ms = FB_WRITE_TIMEOUT_MS, label = 'Firebase timeout') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ── App state ─────────────────────────────────────────────────────
let scanCount      = 0;
let qrScanner      = null;
let scannerRunning = false;
let continuousMode = false;
let lastCode       = '';
let lastScanTime   = 0;
const SCAN_DEBOUNCE = 3000;
let   scanLocked    = false;
const SCAN_LOCK_MS  = 1500;

// Offline-first local queue + pairing session
let localPendingQueue = [];
let activeSession     = null;
const LPQ_KEY         = 'pwa_local_pending_queue';
const SESSION_KEY     = 'pwa_active_session';
const RECENT_TAGS_KEY = 'ca_recent_tags';

// ── DOM ───────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ================================================================
//  LOCAL QUEUE HELPERS
// ================================================================
function lqLoad() {
  try { const raw = localStorage.getItem(LPQ_KEY); localPendingQueue = raw ? JSON.parse(raw) : []; }
  catch(_) { localPendingQueue = []; }
  updateQueueCounter();
}
function lqSave() {
  try { localStorage.setItem(LPQ_KEY, JSON.stringify(localPendingQueue)); } catch(_) {}
  updateQueueCounter();
}
function lqAdd(item)  { localPendingQueue.push(item); lqSave(); }
function lqClear()    { localPendingQueue = []; lqSave(); }
function updateQueueCounter() {
  const el = $('localQueueCount'); if (el) el.textContent = localPendingQueue.length;
}
function updateSessionStatus() {
  const el = $('sessionStatusLabel'); if (!el) return;
  if (activeSession) {
    el.textContent = '🟢 Paired: ' + activeSession.slice(-8);
    el.className   = 'lq-sub paired';
  } else {
    el.textContent = '⚪ Not paired — scan PC QR';
    el.className   = 'lq-sub unpaired';
  }
}
function loadSession() {
  activeSession = localStorage.getItem(SESSION_KEY) || null;
  updateSessionStatus();
}

// ── ⚡ Urgent Mode (sticky) ──
const URGENT_KEY = 'ca_urgent_mode';
function isUrgentOn() { try { return localStorage.getItem(URGENT_KEY) === '1'; } catch(_) { return false; } }
function initUrgentToggles() {
  const boxes = ['urgentToggleQr', 'urgentToggleOcr'].map(id => document.getElementById(id)).filter(Boolean);
  const paint = () => boxes.forEach(b => { b.checked = isUrgentOn(); const l = b.closest('.urgent-row'); if (l) l.classList.toggle('on', b.checked); });
  boxes.forEach(b => b.addEventListener('change', () => {
    try { localStorage.setItem(URGENT_KEY, b.checked ? '1' : '0'); } catch(_) {}
    paint();
    toast(b.checked ? '⚡ Urgent Mode ON — scans PC पर auto-search होंगे' : 'Urgent Mode OFF', b.checked ? 'warn' : 'ok', 2000);
  }));
  paint();
}
let urgentSyncTimer = null;
function urgentAutoSend() {
  if (!activeSession) {
    toast('⚠️ Urgent ON है पर PC pair नहीं है — पहले PC का QR scan करें!', 'warn', 3500);
    return;
  }
  clearTimeout(urgentSyncTimer);
  urgentSyncTimer = setTimeout(() => { try { autoSyncLocalQueue(); } catch(_) {} }, 350);
}
function addToLocalQueue(cnr, tag, searchType) {
  const item = {
    cnr          : cnr.trim().toUpperCase(),
    tag          : tag || '',
    searchType   : searchType || 'cnr',
    timestamp    : Date.now(),
    formattedTime: new Date().toLocaleString('en-IN', { timeZone:'Asia/Kolkata', hour12:true }),
    status:'pending', source:'pwa',
  };
  if (isUrgentOn()) item.isUrgent = true;
  if (tag) saveRecentTag(tag);
  lqAdd(item);
  if (item.isUrgent) urgentAutoSend();
  toast('Queued: ' + item.cnr + ' (' + localPendingQueue.length + ' total)', 'ok', 2000);
}

// ================================================================
//  TAG ARRAYS & QUICK-TAP RECENT TAG CHIPS
// ================================================================
const commonTags = [
  'Summons / Notices (समन / नोटिस)',
  'Appearance (हाजिरी)',
  'Evidence (साक्ष्य / गवाही)',
  'Cross Examination (जिराह / प्रतिपरीक्षा)',
  'Reply / Objection (जवाब / आपत्ति)',
  'Misc. Application (प्रकीर्ण प्रार्थना पत्र)',
  'Interim Argument (अंतरिम बहस)',
  'Final Argument (अंतिम बहस)',
  'Order / Judgment (आदेश / निर्णय)',
  'Report Awaited (रिपोर्ट अप्राप्त / इंतज़ार)',
  'Await Record / LCR (अवर न्यायालय पत्रावली अप्राप्त)',
  'Sent for Mediation (मध्यस्थता हेतु प्रेषित)',
  'High Court Direction (माननीय उच्च न्यायालय का निर्देश)',
  'Action Plan (एक्शन प्लान)',
  'Urgent (अति आवश्यक)',
];

const civilTags = [
  'Written Statement - WS (प्रतिवाद पत्र / जवाबदावा)',
  'Framing of Issues (वाद बिंदु विरचन / तन्कीह)',
  'Injunction / Stay (निषेधाज्ञा / स्टे)',
  'Commission / Amin Report (कमीशन / अमीन रिपोर्ट)',
  'Replication (जवाब-उल-जवाब / प्रत्युत्तर)',
  'Ex-parte Hearing (एकपक्षीय सुनवाई)',
  'Ex-parte Order (एकपक्षीय आदेश)',
  'Execution (इजराय / डिक्री का निष्पादन)',
];

const criminalTags = [
  'BW Issued (जमानती वारंट जारी)',
  'NBW Issued (गैर-जमानती वारंट जारी)',
  'Framing of Charge (आरोप विरचन / चार्ज)',
  'Statement of Accused (अभियुक्त का बयान / 313 CrPC)',
  'Plaintiff Hostile (वादी पक्षद्रोही)',
  'Accused Hostile (अभियुक्त पक्षद्रोही)',
];

function getRecentTags() {
  try {
    const raw = localStorage.getItem(RECENT_TAGS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr) && arr.length) return arr;
  } catch(_) {}
  return [
    'Evidence (साक्ष्य / गवाही)',
    'Summons / Notices (समन / नोटिस)',
    'Final Argument (अंतिम बहस)',
    'Urgent (अति आवश्यक)',
  ];
}

function saveRecentTag(tag) {
  const t = String(tag || '').trim();
  if (!t) return;
  const list = getRecentTags().filter(x => x !== t);
  list.unshift(t);
  try { localStorage.setItem(RECENT_TAGS_KEY, JSON.stringify(list.slice(0, 4))); } catch(_) {}
  renderQuickTagChips();
}

function renderQuickTagChips() {
  const wrap = $('quickTagChips');
  if (!wrap) return;
  const cur = $('fileTag')?.value?.trim() || '';
  const tags = getRecentTags();
  wrap.textContent = '';
  tags.forEach(t => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quick-tag-chip' + (cur === t ? ' active' : '');
    btn.textContent = t.split(' (')[0];
    btn.title = t;
    btn.addEventListener('click', () => {
      $('fileTag').value = t;
      $('activeTagLabel').textContent = t;
      localStorage.setItem('ca_last_tag', t);
      renderQuickTagChips();
    });
    wrap.appendChild(btn);
  });
}

// ================================================================
//  updateTagList() — rebuilds <datalist> based on radio selection
// ================================================================
function updateTagList() {
  const selected = document.querySelector('input[name="caseType"]:checked')?.value || 'manual';
  const datalist = $('tagOptions');
  if (!datalist) return;

  let tags;
  if (selected === 'civil')         tags = [...commonTags, ...civilTags];
  else if (selected === 'criminal') tags = [...commonTags, ...criminalTags];
  else                              tags = [...commonTags];

  datalist.innerHTML = tags.map(t => `<option value="${t}"></option>`).join('');

  document.querySelectorAll('.ct-radio').forEach(el => {
    el.classList.remove('active-manual', 'active-civil', 'active-criminal');
  });
  const labelMap = { manual:'ctManualLabel', civil:'ctCivilLabel', criminal:'ctCriminalLabel' };
  const lbl = $(labelMap[selected]);
  if (lbl) lbl.classList.add(`active-${selected}`);

  const cur = $('fileTag')?.value || '';
  $('activeTagLabel').textContent = cur || '—';
}

document.querySelectorAll('input[name="caseType"]').forEach(radio => {
  radio.addEventListener('change', () => {
    const prevTag = $('fileTag').value;
    localStorage.setItem('ca_case_type', radio.value);
    updateTagList();
    if (prevTag) {
      $('fileTag').value = prevTag;
      $('activeTagLabel').textContent = prevTag;
      localStorage.setItem('ca_last_tag', prevTag);
    }
  });
});

$('fileTag').addEventListener('change', () => {
  const val = $('fileTag').value;
  $('activeTagLabel').textContent = val || '—';
  localStorage.setItem('ca_last_tag', val);
  if (val.trim()) saveRecentTag(val.trim());
  else renderQuickTagChips();
});
$('fileTag').addEventListener('input', () => {
  const val = $('fileTag').value;
  $('activeTagLabel').textContent = val || '—';
  localStorage.setItem('ca_last_tag', val);
  renderQuickTagChips();
});

// ================================================================
//  LOADING / TOAST
// ================================================================
function showLoading(msg = 'Loading…') {
  $('loadingOverlay').classList.add('show');
  $('loadingTxt').textContent = msg;
}
function hideLoading() { $('loadingOverlay').classList.remove('show'); }

let toastTimer;
function toast(msg, type = '', duration = 3000) {
  const el = $('toast');
  el.textContent = msg; el.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, duration);
}

// ================================================================
//  FIREBASE INIT & REAL-TIME CONNECTION MONITOR
// ================================================================
async function initFirebase(url, apiKey, prefix, forceReinit = false) {
  try {
    if (typeof firebase === 'undefined') {
      throw new Error('Firebase SDK load नहीं हुआ। Internet check करें।');
    }
    const cleanUrl = String(url || '').trim();
    if (!cleanUrl) throw new Error('Database URL खाली है।');

    if (forceReinit && firebase.apps.length) {
      try { if (presenceRef) presenceRef.off(); } catch(_) {}
      try { if (connRef) connRef.off(); } catch(_) {}
      presenceRef = null;
      connRef = null;
      await firebase.app().delete();
    }

    if (!firebase.apps.length) {
      firebase.initializeApp({
        apiKey     : apiKey || 'placeholder-key',
        databaseURL: cleanUrl,
        projectId  : (cleanUrl.match(/https:\/\/([^.]+)\./) || [])[1] || 'app',
        appId      : '1:000000000000:web:0000000000000000',
      });
    }

    db = firebase.database();
    db.goOnline();
    FB_URL    = cleanUrl;
    FB_APIKEY = apiKey;
    FB_PREFIX = normalizePrefix(prefix);
    fbReady   = true;
    fbConnected = false;
    console.log('[PWA] Firebase initialized ✅ | prefix:', FB_PREFIX);
    return true;
  } catch (err) {
    fbReady = false;
    fbConnected = false;
    console.error('[PWA] Firebase init error:', err.message);
    return false;
  }
}

function reconnectFirebase() {
  if (!db || !fbReady) return;
  if (!navigator.onLine) return;
  clearTimeout(reconnectTimer);
  try {
    db.goOffline();
    reconnectTimer = setTimeout(() => {
      try { db.goOnline(); } catch(_) {}
    }, 250);
  } catch(_) {}
}

function startConnectionListener() {
  if (!db) return;
  if (connRef) connRef.off();
  connRef = db.ref('.info/connected');
  connRef.on('value', snap => {
    fbConnected = snap.val() === true;
    const statusLbl = $('cfgStatusLabel');
    if (fbConnected) {
      if (statusLbl) statusLbl.textContent = '🟢 Connected (Live)';
      console.log('[PWA] Firebase socket connected ✅');
      setTimeout(() => {
        syncOfflineQueue();
        autoSyncLocalQueue();
      }, 300);
    } else {
      if (statusLbl) {
        statusLbl.textContent = navigator.onLine ? '🟡 Reconnecting…' : '🔴 Offline';
      }
      if (!navigator.onLine) updatePcStatus('offline', null);
      console.warn('[PWA] Firebase socket disconnected');
    }
  });
}

// ================================================================
//  PC PRESENCE
// ================================================================
function startPresenceListener() {
  if (!db) return;
  if (presenceRef) presenceRef.off();
  presenceRef = db.ref(FB_PATH().presence);
  presenceRef.on('value', snap => {
    const val   = snap.val();
    const state = val?.state || 'offline';
    const ts    = val?.last_seen || null;
    updatePcStatus(state, ts);
  }, err => {
    console.warn('[PWA] Presence error:', err.message);
    updatePcStatus('offline', null);
  });
}

function updatePcStatus(state, ts) {
  pcOnline = state === 'online';
  const dot = $('pcDot'), lbl = $('pcLabel'), time = $('pcTime');
  if (state === 'online') {
    dot.className = 'pc-dot online'; lbl.className = 'pc-lbl online';
    lbl.textContent = '🟢 PC Online — Ready';
  } else {
    dot.className = 'pc-dot offline'; lbl.className = 'pc-lbl offline';
    lbl.textContent = '🔴 PC Offline — Queue Mode';
  }
  time.textContent = ts ? new Date(ts).toLocaleTimeString('en-IN', {hour12:false}) : '';
  const cfgPc = $('cfgPcStatus');
  if (cfgPc) cfgPc.textContent = state === 'online' ? '🟢 Online' : '🔴 Offline';
}

// ================================================================
//  TAB NAVIGATION (pre-warm OCR worker when OCR tab is opened)
// ================================================================
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'ocr') {
      ensureOcrWorker().catch(() => {});
    }
  });
});

// ================================================================
//  QR SCANNER (fps=18 + native BarcodeDetector enabled)
// ================================================================
$('contScanRow').addEventListener('click', () => {
  const cb = $('continuousScan'); cb.checked = !cb.checked;
  continuousMode = cb.checked;
  $('contScanRow').classList.toggle('on', continuousMode);
  toast(continuousMode ? '🔄 Continuous ON' : '⏹ Continuous OFF',
        continuousMode ? 'ok' : 'warn', 2000);
});

$('startCamBtn').addEventListener('click', startCamera);
$('stopCamBtn').addEventListener('click',  stopCamera);

async function startCamera() {
  if (scannerRunning) return;
  $('camPlaceholder').style.display = 'none';
  $('startCamBtn').disabled = true; $('startCamBtn').textContent = '⏳ Starting…';
  try {
    if (typeof Html5Qrcode === 'undefined') throw new Error('QR Scanner library लोड हो रही है, कृपया कुछ सेकंड बाद पुनः प्रयास करें।');
    const devices = await Html5Qrcode.getCameras();
    if (!devices?.length) throw new Error('कोई camera नहीं मिला।');
    const cam = devices.find(d => /back|rear|environment/i.test(d.label)) || devices[devices.length-1];
    qrScanner = new Html5Qrcode('qr-reader', {
      experimentalFeatures: { useBarCodeDetectorIfSupported: true },
      verbose: false,
    });
    await qrScanner.start(
      { deviceId: { exact: cam.id } },
      { fps:18, qrbox:{width:240,height:240}, aspectRatio:1.0, disableFlip:false },
      onQRSuccess, onQRError
    );
    scannerRunning = true;
    $('scanOverlay').classList.add('on');
    $('stopCamBtn').disabled = false;
    $('startCamBtn').disabled = true; $('startCamBtn').textContent = '▶️ Start Camera';
    toast('📷 Camera started!', 'ok', 2000);
  } catch (err) {
    $('startCamBtn').disabled = false; $('startCamBtn').textContent = '▶️ Start Camera';
    $('camPlaceholder').style.display = 'flex';
    let msg = err.message || 'Camera error.';
    if (/Permission|NotAllowed/i.test(msg)) msg = '❌ Camera permission denied.';
    toast(msg, 'err', 5000);
    console.error('[PWA] Camera error:', err);
  }
}

async function stopCamera() {
  if (!scannerRunning || !qrScanner) return;
  try { await qrScanner.stop(); qrScanner.clear(); } catch(_) {}
  qrScanner = null; scannerRunning = false;
  $('scanOverlay').classList.remove('on');
  $('camPlaceholder').style.display = 'flex';
  $('startCamBtn').disabled = false; $('stopCamBtn').disabled = true;
  toast('⏹ Camera stopped.', 'warn', 2000);
}

function onQRSuccess(text, result) {
  const now = Date.now();
  if (scanLocked) return;
  if (text === lastCode && (now - lastScanTime) < SCAN_DEBOUNCE) return;
  scanLocked = true;
  setTimeout(() => { scanLocked = false; }, SCAN_LOCK_MS);
  lastCode = text; lastScanTime = now;
  playBeep();
  if (text.startsWith('court_session_')) {
    activeSession = text;
    localStorage.setItem(SESSION_KEY, text);
    updateSessionStatus();
    displayQRResult('Paired: ' + text, result);
    toast('PC se pair ho gaya: ' + text.slice(-8), 'ok', 4000);
    if (!continuousMode) stopCamera();
    if (localPendingQueue.length) autoSyncLocalQueue();
    return;
  }
  scanCount++; $('scanCountDisplay').textContent = scanCount;
  displayQRResult(text, result);
  const tag        = $('fileTag').value.trim();
  const searchType = document.querySelector('input[name="searchType"]:checked')?.value || 'cnr';
  addToLocalQueue(text, tag, searchType);
  if (!continuousMode) stopCamera();
}

function onQRError(msg) {
  if (/No QR|No barcode/i.test(msg || '')) return;
  console.warn('[PWA] QR frame error:', msg);
}

function displayQRResult(text, result) {
  const box = $('qrResult'), val = $('qrResultValue'), meta = $('qrResultMeta');
  val.textContent = text;
  const fmt   = result?.result?.format?.formatName || 'QR_CODE';
  const isCnr = /^[A-Z]{2}[A-Z\d]{2}\d{10}$/.test(text.trim());
  meta.textContent = `${fmt} · ${new Date().toLocaleTimeString('en-IN')}${isCnr ? ' · ✅ CNR' : ''}`;
  box.className = 'scan-result show ok';
}

function playBeep() {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880; osc.type = 'sine';
    gain.gain.setValueAtTime(.35, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + .15);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + .15);
  } catch(_) {}
}

// ================================================================
//  MANUAL SEND (default UPBL04 for CNR + numeric pad)
// ================================================================
function setManualDefaultForType(searchType) {
  const inp = $('manualInput');
  if (!inp) return;
  if (searchType === 'case_number') {
    if (inp.value.trim().toUpperCase() === DEFAULT_CNR_PREFIX) {
      inp.value = '';
      localStorage.removeItem('ca_manual_cnr');
    }
  } else {
    if (!inp.value.trim()) {
      inp.value = DEFAULT_CNR_PREFIX;
    }
  }
}

$('manualSendBtn').addEventListener('click', async () => {
  const raw        = $('manualInput').value.trim();
  const tag        = $('fileTag').value.trim();
  const searchType = document.querySelector('input[name="searchType"]:checked')?.value || 'cnr';

  if (!raw || (searchType === 'cnr' && raw.toUpperCase() === DEFAULT_CNR_PREFIX)) {
    toast('⚠️ पूरा CNR / Case Number लिखें!', 'warn');
    return;
  }

  const items = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (!items.length) { toast('⚠️ Valid input नहीं मिला।', 'warn'); return; }

  if (searchType === 'case_number') {
    const caseNumPattern = /^\d+\/\d{4}$/;
    const invalid = items.filter(i => !caseNumPattern.test(i));
    if (invalid.length) {
      toast(`❌ Invalid format: "${invalid[0]}" — use Number/Year (e.g. 123/2026)`, 'err', 4000);
      return;
    }
  }

  items.forEach(item => addToLocalQueue(item, tag, searchType));
  const sent = items.length;

  localStorage.removeItem('ca_manual_cnr');
  $('manualInput').value = searchType === 'cnr' ? DEFAULT_CNR_PREFIX : '';

  const label = searchType === 'case_number' ? 'Case Number' : 'CNR';
  $('manualOk').textContent = `✅ ${sent} ${label}(s) queued`;
  $('manualOk').classList.add('show');
  setTimeout(() => $('manualOk').classList.remove('show'), 3000);
});
$('manualClearBtn').addEventListener('click', () => {
  $('manualInput').value = '';
  localStorage.removeItem('ca_manual_cnr');
  $('manualInput').focus();
});

$('clearLocalQueueBtn').addEventListener('click', () => {
  if (!localPendingQueue.length) { toast('Queue empty.', 'warn'); return; }
  if (!confirm(localPendingQueue.length + ' items clear karein?')) return;
  lqClear();
  toast('Queue cleared.', 'warn', 2500);
});

// ================================================================
//  ATOMIC BATCH SYNC TO PC (1 single round-trip + 10s timeout)
// ================================================================
async function pushLocalQueueBatch(isAuto = false) {
  if (isSyncing) return { ok: false, reason: 'busy' };
  if (!activeSession) {
    if (!isAuto) {
      toast('❌ Pehle PC ka Pairing QR scan karein!', 'err', 4000);
      document.querySelector('.tab-btn[data-tab="qr"]')?.click();
    }
    return { ok: false, reason: 'no_session' };
  }
  if (!localPendingQueue.length) {
    if (!isAuto) toast('⚠️ Queue mein koi item nahi hai.', 'warn', 3000);
    return { ok: false, reason: 'empty' };
  }
  if (!fbReady || !db) {
    if (!isAuto) toast('❌ Firebase ready nahi hai. Settings check karein.', 'err', 4000);
    return { ok: false, reason: 'not_ready' };
  }
  if (!navigator.onLine) {
    if (!isAuto) toast('📴 Internet nahi hai.', 'warn', 3000);
    return { ok: false, reason: 'offline' };
  }

  isSyncing = true;
  const toSend = [...localPendingQueue];
  const sessionRef = db.ref('/queues/' + activeSession);
  const now = Date.now();
  const updates = {};

  for (const item of toSend) {
    const key = sessionRef.push().key;
    updates[key] = {
      ...item,
      formattedTime: item.formattedTime || new Date().toLocaleString('en-IN', {
        timeZone:'Asia/Kolkata', hour12:true,
      }),
      synced_at: now,
      ...(isAuto ? { auto_synced: true } : {}),
    };
  }

  try {
    db.goOnline();
    await withTimeout(sessionRef.update(updates), FB_WRITE_TIMEOUT_MS, 'Sync timeout (10s) — Firebase से जवाब नहीं मिला');
    localPendingQueue = localPendingQueue.slice(toSend.length);
    lqSave();
    toast((isAuto ? '✅ Auto-sync: ' : '✅ ') + toSend.length + ' items PC को भेजे गए!', 'ok', 3500);
    console.log('[PWA] Batch synced', toSend.length, 'items to /queues/' + activeSession);
    return { ok: true, count: toSend.length };
  } catch (err) {
    console.error('[PWA] Batch sync error:', err.message);
    reconnectFirebase();
    toast('❌ Sync failed: ' + err.message, 'err', 4500);
    return { ok: false, error: err };
  } finally {
    isSyncing = false;
  }
}

$('syncToPCBtn').addEventListener('click', async () => {
  const btn = $('syncToPCBtn');
  btn.disabled = true; btn.textContent = '⏳ Syncing...';
  try {
    await pushLocalQueueBatch(false);
  } finally {
    btn.disabled = false; btn.textContent = '📤 Sync to PC';
  }
});

// Update placeholder + default prefix when searchType changes
document.querySelectorAll('input[name="searchType"]').forEach(r => {
  r.addEventListener('change', () => {
    const isCN = r.value === 'case_number';
    $('manualInput').placeholder = isCN
      ? 'Case Number: 123/2026, 45/2025…'
      : 'CNR Number: UPBL04..., UPBL04… (comma se multiple)';
    setManualDefaultForType(r.value);
  });
});
$('manualInput').addEventListener('input', () => {
  const val = $('manualInput').value;
  if (val && val.trim().toUpperCase() !== DEFAULT_CNR_PREFIX) {
    localStorage.setItem('ca_manual_cnr', val);
  } else {
    localStorage.removeItem('ca_manual_cnr');
  }
});
$('manualInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('manualSendBtn').click();
});

// ================================================================
//  OCR + CROPPER.JS WORKFLOW (Pre-warmed Worker + ⚡ UP Words + Comma Chips)
// ================================================================
let ocrWorker     = null;
let ocrWorkerInit = null;
let cropperInst   = null;

async function ensureOcrWorker(onProgress) {
  if (ocrWorker) return ocrWorker;
  if (typeof Tesseract === 'undefined') {
    throw new Error('Tesseract OCR अभी लोड हो रहा है, कृपया कुछ सेकंड बाद पुनः प्रयास करें।');
  }
  if (!ocrWorkerInit) {
    ocrWorkerInit = (async () => {
      const worker = await Tesseract.createWorker('eng', 1, {
        logger: m => {
          if (typeof onProgress === 'function') onProgress(m);
        },
      });
      try {
        await worker.setParameters({
          tessedit_char_whitelist: OCR_WHITELIST,
          preserve_interword_spaces: '1',
        });
      } catch (_) {}
      ocrWorker = worker;
      return worker;
    })().catch(err => {
      ocrWorkerInit = null;
      throw err;
    });
  }
  return ocrWorkerInit;
}

function openCropModal(src) {
  if (typeof Cropper === 'undefined') {
    toast('Cropper library लोड हो रही है, कृपया कुछ सेकंड बाद प्रयास करें।', 'warn', 3000);
    return;
  }
  const img = $('cropperImg');
  img.src = src;
  $('cropModalOverlay').classList.add('show');

  if (cropperInst) { cropperInst.destroy(); cropperInst = null; }

  img.onload = () => {
    cropperInst = new Cropper(img, {
      viewMode   : 1,
      dragMode   : 'none',
      autoCropArea: 0.8,
      cropBoxMovable  : true,
      cropBoxResizable: true,
      toggleDragModeOnDblclick: false,
      movable    : false,
      zoomable   : true,
      zoomOnTouch: true,
      scalable   : false,
      rotatable  : true,
      responsive : true,
      background : false,
      guides     : true,
    });
  };
}

function closeCropModal() {
  if (cropperInst) { cropperInst.destroy(); cropperInst = null; }
  const img = $('cropperImg');
  if (img) img.src = '';
  $('cropModalOverlay').classList.remove('show');
}

function onImageSelected(file) {
  if (!file) return;
  $('ocrResultCard').style.display = 'none';
  $('ocrPreview').classList.remove('show');
  $('ocrPreview').src = '';
  const reader = new FileReader();
  reader.onload = e => openCropModal(e.target.result);
  reader.readAsDataURL(file);
}

$('ocrInput').addEventListener('change', e => {
  onImageSelected(e.target.files[0]);
  e.target.value = '';
});

$('ocrCamInput').addEventListener('change', e => {
  onImageSelected(e.target.files[0]);
  e.target.value = '';
});

$('cropRotateBtn').addEventListener('click', () => { if (cropperInst) cropperInst.rotate(90); });

$('cropCancelBtn').addEventListener('click', () => {
  closeCropModal();
  toast('Crop cancelled.', 'warn', 1500);
});

$('cropScanBtn').addEventListener('click', () => {
  if (!cropperInst) return;
  $('cropScanBtn').disabled    = true;
  $('cropScanBtn').textContent = '⏳ Processing…';
  try {
    const raw      = cropperInst.getCroppedCanvas({
      maxWidth : 1000,
      maxHeight: 4000,
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high',
    });
    const canvas   = ocrPreprocess(raw);
    const dataUrl  = canvas.toDataURL('image/png');

    $('ocrPreview').src = dataUrl;
    $('ocrPreview').classList.add('show');

    closeCropModal();
    runOCR(dataUrl);
  } catch(err) {
    toast('Crop error: ' + err.message, 'err', 3000);
  } finally {
    $('cropScanBtn').disabled    = false;
    $('cropScanBtn').textContent = '✂️ Crop & Scan';
  }
});

function ocrEnhancePixels(d) {
  const n = d.length / 4, hist = new Uint32Array(256);
  for (let i = 0, p = 0; i < n; i++, p += 4) { const g = (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000 | 0; d[p] = d[p + 1] = d[p + 2] = g; hist[g]++; }
  let lo = 0, hi = 255, acc = 0; const cut = n * 0.02;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= cut) { lo = v; break; } }
  acc = 0; for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= cut) { hi = v; break; } }
  if (hi - lo < 16) { lo = Math.max(0, lo - 8); hi = Math.min(255, hi + 8); }
  const lut = new Uint8ClampedArray(256), span = Math.max(1, hi - lo);
  for (let v = 0; v < 256; v++) { let t = Math.min(1, Math.max(0, (v - lo) / span)); t = t * t * (3 - 2 * t); t = t * t * (3 - 2 * t); lut[v] = Math.round(t * 255); }
  for (let p = 0; p < d.length; p += 4) { const g = lut[d[p]]; d[p] = d[p + 1] = d[p + 2] = g; d[p + 3] = 255; }
  return d;
}
function ocrPreprocess(src) {
  let c = src;
  if (c.width > 1000) { const s = document.createElement('canvas'); s.width = 1000; s.height = Math.max(1, Math.round(c.height * 1000 / c.width)); const x = s.getContext('2d'); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high'; x.drawImage(c, 0, 0, s.width, s.height); c = s; }
  const ctx = c.getContext('2d', { willReadFrequently: true }), img = ctx.getImageData(0, 0, c.width, c.height);
  ocrEnhancePixels(img.data); ctx.putImageData(img, 0, 0);
  return c;
}
const OCR_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/-.';

let camStream = null;
function stopCam() { if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; } const v = $('camVideo'); if (v) v.srcObject = null; $('camModalOverlay').classList.remove('show'); }
async function openCam() {
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    const v = $('camVideo'); v.srcObject = camStream; $('camModalOverlay').classList.add('show'); try { await v.play(); } catch (_) {}
    return true;
  } catch (err) { stopCam(); return false; }
}
function openCamera() {
  if (camLiveFailed || !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) { $('ocrCamInput').click(); return Promise.resolve(false); }
  return openCam().then(ok => { if (!ok) { camLiveFailed = true; toast('Live camera नहीं खुला — phone का camera app खुलेगा', 'warn', 2500); $('ocrCamInput').click(); } return ok; });
}
let camLiveFailed = false;
$('ocrCamInput').addEventListener('click', e => {
  if (camLiveFailed || !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) return;
  e.preventDefault();
  openCam().then(ok => { if (!ok) { camLiveFailed = true; toast('Live camera नहीं खुला — अब phone का camera app खुलेगा (दोबारा 📷 दबाएँ)', 'warn', 3000); } });
});
$('camShutterBtn').addEventListener('click', () => {
  const v = $('camVideo'); if (!v.videoWidth) return;
  const k = Math.min(1, 2048 / Math.max(v.videoWidth, v.videoHeight)), c = document.createElement('canvas');
  c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k); c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.92); stopCam();
  $('ocrResultCard').style.display = 'none'; $('ocrPreview').classList.remove('show'); $('ocrPreview').src = '';
  openCropModal(url);
});
$('camCloseBtn').addEventListener('click', stopCam);
document.addEventListener('visibilitychange', () => { if (document.hidden && camStream) stopCam(); });

// Collect all UP-starting words (e.g. UPBL360000172011, UP32AB1234) + regex CNRs
function extractUpQuickItems(text) {
  const upSet = new Set();
  const rawWords = String(text || '').toUpperCase().split(/\s+/);
  for (const w of rawWords) {
    // Strip dots/hyphens inside tokens like UPBL.360000012010 -> UPBL360000012010
    const clean = w.replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, '').replace(/[.\-]/g, '');
    if (/^UP[A-Z0-9]{2,}/.test(clean)) {
      upSet.add(clean);
    }
  }
  const compact = String(text || '').replace(/[\s\-.\n\r]/g, '').toUpperCase();
  const strictMatches = compact.match(/UP[A-Z]{2}[A-Z0-9]{2}\d{10}/g) || [];
  strictMatches.forEach(m => upSet.add(m));
  return upSet;
}

function renderQuickCnrButtons(upItems) {
  const box = $('ocr-quick-cnr-box');
  if (!box) return;
  box.textContent = '';
  if (!upItems || !upItems.size) {
    box.style.display = 'none';
    return;
  }
  box.style.display = 'flex';
  upItems.forEach(val => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ocr-lightning-btn';
    btn.textContent = '⚡ ' + val;
    btn.title = '1-Tap Direct Send to Queue';
    btn.addEventListener('click', () => {
      const ocrTag = $('fileTag')?.value?.trim() || '';
      addToLocalQueue(val, ocrTag, 'cnr');
      btn.style.background = '#bbf7d0';
      btn.style.borderColor = '#16a34a';
      btn.style.color = '#14532d';
      if ($('continuousCamera') && $('continuousCamera').checked) {
        clearOcrUi();
        setTimeout(openCamera, 250);
      }
    });
    box.appendChild(btn);
  });
}

function renderOcrChips(text) {
  const box = $('ocr-highlight-box'); if (!box) return;
  box.textContent = '';
  const seen = new Set(), words = String(text || '').split(/\s+/).filter(w => /[A-Z0-9\u0900-\u097F]/i.test(w));
  words.forEach(w => {
    if (seen.has(w)) return; seen.add(w);
    const s = document.createElement('span'); s.className = 'cnr-highlight'; s.dataset.cnr = w; s.textContent = w; box.appendChild(s);
  });
  if (!seen.size) { const em = document.createElement('em'); em.style.color = '#94a3b8'; em.textContent = 'कोई word नहीं मिला — दोबारा scan करें'; box.appendChild(em); }
}

function clearOcrUi() {
  $('ocrPreview').classList.remove('show');
  $('ocrPreview').src = '';
  $('ocrResultCard').style.display = 'none';
  $('ocrResultBox').value = '';
  const hlBox = $('ocr-highlight-box');
  if (hlBox) hlBox.innerHTML = '';
  const qBox = $('ocr-quick-cnr-box');
  if (qBox) { qBox.innerHTML = ''; qBox.style.display = 'none'; }
  $('ocrInput').value = ''; $('ocrCamInput').value = '';
  closeCropModal();
}

async function runOCR(source) {
  $('ocrProg').classList.add('show'); $('ocrBar').style.width = '0%';
  $('ocrProgLabel').textContent = 'Tesseract.js शुरू हो रहा है…';
  try {
    const worker = await ensureOcrWorker(m => {
      if (m.status === 'recognizing text') {
        $('ocrBar').style.width = Math.round(m.progress * 100) + '%';
        $('ocrProgLabel').textContent = 'Recognizing… ' + Math.round(m.progress * 100) + '%';
      } else if (m.status === 'loading tesseract core') {
        $('ocrProgLabel').textContent = 'Core load हो रहा है…';
      } else if (m.status === 'loading language traineddata') {
        $('ocrProgLabel').textContent = 'Language data load हो रहा है…';
      }
    });
    $('ocrProgLabel').textContent = 'Text पहचाना जा रहा है…';
    $('ocrBar').style.width = '30%';

    const { data: { text: rawText, confidence } } = await worker.recognize(source);
    const text = String(rawText || '').toUpperCase();

    $('ocrBar').style.width = '100%';
    $('ocrProgLabel').textContent = 'Done! Confidence: ' + Math.round(confidence) + '%';
    $('ocrResultBox').value          = '';
    $('ocrResultCard').style.display = 'block';
    setTimeout(() => $('ocrProg').classList.remove('show'), 1500);
    toast('OCR complete! Confidence: ' + Math.round(confidence) + '%', 'ok', 3000);

    const upItems = extractUpQuickItems(text);
    renderQuickCnrButtons(upItems);
    renderOcrChips(text);

    if (upItems.size > 0) {
      console.log('[PWA] OCR UP items auto-detected:', [...upItems]);
      toast(upItems.size + ' UP नंबर मिले — ⚡ पर 1-tap करें या नीचे से चुनें।', 'ok', 3500);
    } else {
      console.log('[PWA] OCR: no UP pattern found');
      toast('OCR हो गया — words पर tap करें (comma से जुड़ेंगे) या Send करें।', 'warn', 3000);
    }
  } catch(err) {
    $('ocrProgLabel').textContent = 'Error: ' + err.message;
    toast('OCR failed: ' + err.message, 'err');
    setTimeout(() => $('ocrProg').classList.remove('show'), 3000);
  }
}

$('ocrCopyBtn').addEventListener('click', () => {
  const t = $('ocrResultBox').value; if (!t) return;
  navigator.clipboard.writeText(t).then(() => toast('📋 Copied!', 'ok', 2000));
});

// Tap-to-Add with comma: tapping a word chip appends ", word" to the sandbox
$('ocr-highlight-box').addEventListener('click', function(e) {
  const span = e.target.closest('.cnr-highlight');
  if (!span) return;
  const word = span.dataset.cnr || span.textContent || '';
  if (!word) return;
  const box = $('ocrResultBox');
  const cur = box.value.trimEnd();
  if (!cur) {
    box.value = word;
  } else if (cur.endsWith(',')) {
    box.value = cur + ' ' + word;
  } else {
    box.value = cur + ', ' + word;
  }
  box.scrollTop = box.scrollHeight;
  span.classList.add('tapped');
  setTimeout(function() { span.classList.remove('tapped'); }, 1200);
});

// Send to Queue from OCR text (supports comma-separated & newline-separated items)
$('ocrSendQueueBtn').addEventListener('click', () => {
  const text    = $('ocrResultBox').value.trim();
  const ocrTag  = $('fileTag')?.value?.trim() || '';
  if (!text) { toast('⚠️ Text box खाली है।', 'warn'); return; }

  const items = text.split(/[\r\n,]+/).map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!items.length) { toast('⚠️ Text box खाली है।', 'warn'); return; }
  items.forEach(it => addToLocalQueue(it, ocrTag, 'cnr'));
  toast('✅ ' + items.length + ' item queue में add हुए!', 'ok', 3000);
  if ($('continuousCamera') && $('continuousCamera').checked) {
    clearOcrUi();
    setTimeout(openCamera, 250);
    return;
  }
  $('ocrResultBox').style.borderColor = 'var(--green)';
  setTimeout(() => { $('ocrResultBox').style.borderColor = ''; }, 2000);
});
$('ocrClearBtn').addEventListener('click', clearOcrUi);

// ================================================================
//  SETTINGS — Firebase Config Save (supports live URL switching)
// ================================================================
$('saveCfgBtn').addEventListener('click', async () => {
  const url    = $('cfgUrl').value.trim();
  const apiKey = $('cfgApiKey').value.trim();
  const prefix = normalizePrefix($('cfgPath').value);
  const err    = $('cfgError'), ok = $('cfgOk');
  err.classList.remove('show'); ok.classList.remove('show');

  if (!url) { err.textContent='❌ Database URL खाली है।'; err.classList.add('show'); return; }
  if (!url.startsWith('https://') || !url.includes('firebaseio.com')) {
    err.textContent='❌ Valid URL: https://xxx.firebaseio.com'; err.classList.add('show'); return;
  }

  $('saveCfgBtn').textContent = '⏳ Connecting…'; $('saveCfgBtn').disabled = true;
  localStorage.setItem('ca_fb_url',    url);
  localStorage.setItem('ca_fb_apikey', apiKey);
  localStorage.setItem('ca_fb_prefix', prefix);

  const success = await initFirebase(url, apiKey, prefix, true);
  $('saveCfgBtn').textContent = '💾 Save & Connect'; $('saveCfgBtn').disabled = false;

  if (success) {
    ok.textContent = '✅ Firebase configured — connecting…'; ok.classList.add('show');
    $('cfgStatusLabel').textContent = '🟡 Connecting…';
    $('cfgUrlDisplay').textContent  = url;
    startConnectionListener();
    startPresenceListener();
    toast('✅ Firebase reconnected!', 'ok', 3000);
    setTimeout(() => ok.classList.remove('show'), 3000);
  } else {
    err.textContent = '❌ Firebase init failed.'; err.classList.add('show');
    $('cfgStatusLabel').textContent = '🔴 Failed';
  }
});

$('reconnectFbBtn')?.addEventListener('click', () => {
  if (!fbReady || !db) {
    toast('❌ Firebase initialized नहीं है। Settings से Save & Connect करें।', 'err', 3000);
    return;
  }
  reconnectFirebase();
  toast('🔄 Firebase reconnect किया जा रहा है…', 'ok', 2000);
});

// ================================================================
//  sendToPC (with timeout & offline fallback)
// ================================================================
async function sendToPC(cnr, tag, searchType = 'cnr') {
  if (!cnr?.trim()) { toast('⚠️ Input खाली है।', 'warn'); return; }

  const payload = {
    cnr          : cnr.trim().toUpperCase(),
    tag          : tag || '',
    searchType   : searchType || 'cnr',
    timestamp    : Date.now(),
    formattedTime: new Date().toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour12  : true,
    }),
    status       : 'pending',
    source       : 'pwa',
  };
  if (isUrgentOn()) payload.isUrgent = true;

  if (!fbReady || !db) {
    saveToOfflineQueue(payload);
    toast(`📥 Offline saved: ${payload.cnr}`, 'warn', 3000);
    return;
  }
  if (!navigator.onLine) {
    saveToOfflineQueue(payload);
    toast(`📴 Offline: "${payload.cnr}" queue में सेव हुआ`, 'warn', 3000);
    return;
  }
  try {
    const targetPath = pcOnline ? FB_PATH().cnrQueue : FB_PATH().pendingScans;
    await withTimeout(db.ref(targetPath).push(payload), FB_WRITE_TIMEOUT_MS, 'Firebase write timeout');
    if (pcOnline) {
      toast(`✅ PC को भेजा: ${payload.cnr}`, 'ok', 2500);
    } else {
      toast(`🕐 Queue में डाला: ${payload.cnr} (PC offline)`, 'warn', 3000);
    }
  } catch (err) {
    saveToOfflineQueue(payload);
    reconnectFirebase();
    toast(`❌ Firebase error — offline save: ${payload.cnr}`, 'err', 4000);
    console.error('[PWA] Firebase push failed:', err.message);
  }
}

// ================================================================
//  OFFLINE QUEUE (Atomic batch + timeout)
// ================================================================
function saveToOfflineQueue(payload) {
  try {
    const raw   = localStorage.getItem('offline_queue');
    const queue = raw ? JSON.parse(raw) : [];
    queue.push(payload);
    localStorage.setItem('offline_queue', JSON.stringify(queue));
    updateOfflineQueueBadge(queue.length);
  } catch(err) { console.error('[PWA] saveToOfflineQueue error:', err); }
}

async function syncOfflineQueue() {
  if (!fbReady || !db || !navigator.onLine) return;
  try {
    const raw = localStorage.getItem('offline_queue');
    if (!raw) return;
    const queue = JSON.parse(raw);
    if (!queue.length) return;
    toast(`🔄 ${queue.length} offline items sync हो रहे हैं…`, 'ok', 3000);
    const ref = db.ref(FB_PATH().pendingScans);
    const updates = {};
    const now = Date.now();
    for (const item of queue) {
      const key = ref.push().key;
      updates[key] = { ...item, synced_at: now };
    }
    await withTimeout(ref.update(updates), FB_WRITE_TIMEOUT_MS, 'Offline queue sync timeout');
    localStorage.removeItem('offline_queue');
    updateOfflineQueueBadge(0);
    toast(`✅ ${queue.length} items synced!`, 'ok', 3000);
  } catch(err) {
    reconnectFirebase();
    toast('❌ Sync failed — try again.', 'err', 3000);
    console.error('[PWA] syncOfflineQueue error:', err.message);
  }
}

function updateOfflineQueueBadge(count) {
  const el = $('offlineQueueBadge');
  if (!el) return;
  el.textContent   = count > 0 ? `📴 ${count} offline` : '';
  el.style.display = count > 0 ? 'inline-block' : 'none';
  const countEl = $('offlineQueueCount');
  if (countEl) countEl.textContent = `${count} items`;
}

window.addEventListener('online', () => {
  toast('🌐 Internet मिला — sync शुरू हो रही है…', 'ok', 2000);
  reconnectFirebase();
  setTimeout(() => { syncOfflineQueue(); autoSyncLocalQueue(); }, 1000);
});
window.addEventListener('offline', () => {
  fbConnected = false;
  updatePcStatus('offline', null);
  const statusLbl = $('cfgStatusLabel');
  if (statusLbl) statusLbl.textContent = '🔴 Offline';
  toast('📴 Internet नहीं है — Offline Mode।', 'warn', 4000);
});

async function autoSyncLocalQueue() {
  return pushLocalQueueBatch(true);
}

document.getElementById('syncNowBtn')?.addEventListener('click', async () => {
  const btn = $('syncNowBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Syncing…'; }
  await syncOfflineQueue();
  if (btn) { btn.disabled = false; btn.textContent = '🔄 Sync Offline Firebase Queue'; }
});

// ================================================================
//  VISIBILITY — pause camera in background, reconnect Firebase on resume
// ================================================================
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (scannerRunning) {
      stopCamera(); toast('📷 Camera paused.', 'warn', 2000);
    }
  } else {
    if (fbReady && db && navigator.onLine) {
      if (!fbConnected) reconnectFirebase();
      setTimeout(() => { autoSyncLocalQueue(); }, 600);
    }
  }
});

// ================================================================
//  BOOT
// ================================================================
async function boot() {
  try {
    FB_URL    = localStorage.getItem('ca_fb_url')    || FB_DEFAULTS.url;
    FB_APIKEY = localStorage.getItem('ca_fb_apikey') || FB_DEFAULTS.apiKey;
    FB_PREFIX = normalizePrefix(localStorage.getItem('ca_fb_prefix') || '/automation');
    if (!localStorage.getItem('ca_fb_url'))    localStorage.setItem('ca_fb_url',    FB_URL);
    if (!localStorage.getItem('ca_fb_apikey')) localStorage.setItem('ca_fb_apikey', FB_APIKEY);

    $('cfgUrl').value    = FB_URL;
    $('cfgApiKey').value = FB_APIKEY;
    $('cfgPath').value   = FB_PREFIX;

    try {
      const raw = localStorage.getItem('offline_queue');
      if (raw) {
        const q = JSON.parse(raw);
        if (q.length) updateOfflineQueueBadge(q.length);
      }
    } catch(_) {}

    const savedCaseType = localStorage.getItem('ca_case_type') || 'manual';
    const savedTag      = localStorage.getItem('ca_last_tag')  || '';

    const radio = document.querySelector(`input[name="caseType"][value="${savedCaseType}"]`);
    if (radio) radio.checked = true;

    updateTagList();
    if (savedTag) {
      $('fileTag').value = savedTag;
      $('activeTagLabel').textContent = savedTag;
    }
    renderQuickTagChips();

    const savedManualCNR = localStorage.getItem('ca_manual_cnr') || '';
    const activeSearchType = document.querySelector('input[name="searchType"]:checked')?.value || 'cnr';
    if ($('manualInput')) {
      if (savedManualCNR) {
        $('manualInput').value = savedManualCNR;
      } else if (activeSearchType === 'cnr') {
        $('manualInput').value = DEFAULT_CNR_PREFIX;
      } else {
        $('manualInput').value = '';
      }
    }

    lqLoad();
    loadSession();

    if (FB_URL) {
      $('cfgStatusLabel').textContent = '🟡 Connecting…';
      $('cfgUrlDisplay').textContent  = FB_URL;
      const ok = await initFirebase(FB_URL, FB_APIKEY, FB_PREFIX);
      if (ok) {
        startConnectionListener();
        startPresenceListener();
      } else {
        $('cfgStatusLabel').textContent = '🔴 Config error';
        updatePcStatus('offline', null);
        toast('⚠️ Firebase init failed. Settings में URL check करें।', 'warn', 5000);
      }
    } else {
      updatePcStatus('offline', null);
    }
  } finally {
    hideLoading();
  }
}

boot();

// ⚡ Urgent Mode toggles
initUrgentToggles();

// v10: sticky "Continuous Scan Loop" toggle (localStorage)
(function initContinuousToggle() {
  const cb = $('continuousCamera'); if (!cb) return;
  try { cb.checked = localStorage.getItem('continuousCameraState') === 'true'; } catch (_) { cb.checked = false; }
  cb.addEventListener('change', () => { try { localStorage.setItem('continuousCameraState', String(cb.checked)); } catch (_) {} });
})();