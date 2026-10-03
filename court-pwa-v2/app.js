// ================================================================
//  app.js — Court Automation PWA  |  v2 (UI Redesign)
//  Changes:
//  - Manual tab merged into QR tab
//  - 3 case-type radio buttons (Manual/Civil/Criminal)
//  - Dynamic tag datalist via updateTagList()
//  - fileTag input used for both QR scan and manual send
//  Firebase init, sendToPC, offline queue — all unchanged
// ================================================================
'use strict';

// ── Firebase state (UNCHANGED) ───────────────────────────────────
let db          = null;
let presenceRef = null;
let pcOnline    = false;
let fbReady     = false;

// ── Hardcoded Firebase defaults (UNCHANGED) ───────────────────────
const FB_DEFAULTS = {
  url   : 'https://court-automation-2-default-rtdb.firebaseio.com/',
  apiKey: 'AIzaSyBrgmFp4EXnO7Bb358fZdydk5HpI1UGS3o',
};

let FB_URL    = FB_DEFAULTS.url;
let FB_APIKEY = FB_DEFAULTS.apiKey;
let FB_PREFIX = '/automation';

const FB_PATH = () => ({
  presence    : `${FB_PREFIX}/system_status`,
  cnrQueue    : `${FB_PREFIX}/cnr_queue`,
  pendingScans: `${FB_PREFIX}/pending_scans`,
});

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

// ── DOM ───────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ================================================================
//  TAG ARRAYS
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

// ================================================================
//  updateTagList() — rebuilds <datalist> based on radio selection
// ================================================================
function updateTagList() {
  const selected = document.querySelector('input[name="caseType"]:checked')?.value || 'manual';
  const datalist = $('tagOptions');
  if (!datalist) return;

  let tags;
  if (selected === 'civil')    tags = [...commonTags, ...civilTags];
  else if (selected === 'criminal') tags = [...commonTags, ...criminalTags];
  else                          tags = [...commonTags];  // manual (default)

  datalist.innerHTML = tags.map(t => `<option value="${t}"></option>`).join('');

  // Update radio label styles
  document.querySelectorAll('.ct-radio').forEach(el => {
    el.classList.remove('active-manual', 'active-civil', 'active-criminal');
  });
  const labelMap = { manual:'ctManualLabel', civil:'ctCivilLabel', criminal:'ctCriminalLabel' };
  const lbl = $(labelMap[selected]);
  if (lbl) lbl.classList.add(`active-${selected}`);

  // Update active tag label
  const cur = $('fileTag')?.value || '';
  $('activeTagLabel').textContent = cur || '—';
}

// Wire radio buttons
document.querySelectorAll('input[name="caseType"]').forEach(radio => {
  radio.addEventListener('change', () => {
    updateTagList();
    $('fileTag').value = ''; // clear selected tag when case type changes
    $('activeTagLabel').textContent = '—';
  });
});

// Update active tag label when user picks from datalist
$('fileTag').addEventListener('change', () => {
  $('activeTagLabel').textContent = $('fileTag').value || '—';
});
$('fileTag').addEventListener('input', () => {
  $('activeTagLabel').textContent = $('fileTag').value || '—';
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
//  FIREBASE INIT  (UNCHANGED)
// ================================================================
function initFirebase(url, apiKey, prefix) {
  try {
    try { firebase.app(); }
    catch (_) {
      firebase.initializeApp({
        apiKey     : apiKey || 'placeholder-key',
        databaseURL: url,
        projectId  : (url.match(/https:\/\/([^.]+)\./) || [])[1] || 'app',
        appId      : '1:000000000000:web:0000000000000000',
      });
    }
    db = firebase.database();
    FB_PREFIX = prefix || '/automation';
    fbReady   = true;
    console.log('[PWA] Firebase initialized ✅ | prefix:', FB_PREFIX);
    return true;
  } catch (err) {
    console.error('[PWA] Firebase init error:', err.message);
    return false;
  }
}

// ================================================================
//  PC PRESENCE  (UNCHANGED)
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
//  TAB NAVIGATION (3 tabs: qr, ocr, settings)
// ================================================================
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ================================================================
//  QR SCANNER
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
    const devices = await Html5Qrcode.getCameras();
    if (!devices?.length) throw new Error('कोई camera नहीं मिला।');
    const cam = devices.find(d => /back|rear|environment/i.test(d.label)) || devices[devices.length-1];
    qrScanner = new Html5Qrcode('qr-reader');
    await qrScanner.start(
      { deviceId: { exact: cam.id } },
      { fps:10, qrbox:{width:240,height:240}, aspectRatio:1.0, disableFlip:false },
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
  scanCount++; $('scanCountDisplay').textContent = scanCount;

  displayQRResult(text, result);
  playBeep();

  // Read tag from fileTag input
  const tag = $('fileTag').value.trim();
  sendToPC(text, tag);

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
//  MANUAL SEND (reads tag from fileTag — same as QR)
// ================================================================
$('manualSendBtn').addEventListener('click', () => {
  const cnr = $('manualInput').value.trim();
  const tag = $('fileTag').value.trim();
  if (!cnr) { toast('⚠️ CNR खाली है!', 'warn'); return; }
  sendToPC(cnr, tag);
  $('manualInput').value = '';
  $('manualOk').textContent = `✅ "${cnr}" send किया गया`;
  $('manualOk').classList.add('show');
  setTimeout(() => $('manualOk').classList.remove('show'), 3000);
});
$('manualClearBtn').addEventListener('click', () => { $('manualInput').value = ''; });
$('manualInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('manualSendBtn').click();
});

// ================================================================
//  OCR  (UNCHANGED)
// ================================================================
let ocrWorker = null;

$('ocrInput').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  $('ocrPreview').src = URL.createObjectURL(file);
  $('ocrPreview').classList.add('show');
  $('ocrResultCard').style.display = 'none';
  await runOCR(file);
});

async function runOCR(file) {
  $('ocrProg').classList.add('show'); $('ocrBar').style.width = '0%';
  $('ocrProgLabel').textContent = 'Tesseract.js शुरू हो रहा है…';
  try {
    if (!ocrWorker) {
      ocrWorker = await Tesseract.createWorker('eng', 1, {
        logger: m => {
          if (m.status === 'recognizing text') {
            $('ocrBar').style.width = `${Math.round(m.progress*100)}%`;
            $('ocrProgLabel').textContent = `Recognizing… ${Math.round(m.progress*100)}%`;
          } else if (m.status === 'loading tesseract core') {
            $('ocrProgLabel').textContent = 'Core load हो रहा है…';
          } else if (m.status === 'loading language traineddata') {
            $('ocrProgLabel').textContent = 'Language data load हो रहा है…';
          }
        }
      });
    }
    $('ocrProgLabel').textContent = 'Text पहचाना जा रहा है…'; $('ocrBar').style.width = '30%';
    const { data: { text, confidence } } = await ocrWorker.recognize(file);
    $('ocrBar').style.width = '100%';
    $('ocrProgLabel').textContent = `✅ Done! Confidence: ${Math.round(confidence)}%`;
    const trimmed = text.trim() || '(कोई text नहीं मिला)';
    $('ocrResultBox').textContent    = trimmed;
    $('ocrResultCard').style.display = 'block';
    setTimeout(() => $('ocrProg').classList.remove('show'), 1500);
    toast(`✅ OCR complete! Confidence: ${Math.round(confidence)}%`, 'ok', 3000);
    // Auto-detect CNR and send
    const match = text.match(/[A-Z]{2}[A-Z0-9]{2}\d{10}/);
    if (match) {
      const tag = $('fileTag').value.trim();
      toast(`🔍 CNR मिला: ${match[0]} — भेजा जा रहा है…`, 'ok', 2500);
      sendToPC(match[0], tag);
    }
  } catch(err) {
    $('ocrProgLabel').textContent = `❌ Error: ${err.message}`;
    toast('❌ OCR failed.', 'err');
    setTimeout(() => $('ocrProg').classList.remove('show'), 3000);
  }
}

$('ocrCopyBtn').addEventListener('click', () => {
  const t = $('ocrResultBox').textContent; if (!t) return;
  navigator.clipboard.writeText(t).then(() => toast('📋 Copied!', 'ok', 2000));
});
$('ocrClearBtn').addEventListener('click', () => {
  $('ocrPreview').classList.remove('show');
  $('ocrResultCard').style.display = 'none';
  $('ocrResultBox').textContent = ''; $('ocrInput').value = '';
});

// ================================================================
//  SETTINGS — Firebase Config Save  (UNCHANGED)
// ================================================================
$('saveCfgBtn').addEventListener('click', () => {
  const url    = $('cfgUrl').value.trim();
  const apiKey = $('cfgApiKey').value.trim();
  const prefix = $('cfgPath').value.trim() || '/automation';
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
  FB_URL = url; FB_APIKEY = apiKey; FB_PREFIX = prefix;

  if (fbReady) { try { if(presenceRef) presenceRef.off(); } catch(_) {} fbReady = false; }
  const success = initFirebase(url, apiKey, prefix);
  $('saveCfgBtn').textContent = '💾 Save & Connect'; $('saveCfgBtn').disabled = false;

  if (success) {
    ok.textContent = '✅ Firebase connected!'; ok.classList.add('show');
    $('cfgStatusLabel').textContent = '🟢 Connected';
    $('cfgUrlDisplay').textContent  = url;
    startPresenceListener();
    toast('✅ Firebase connected!', 'ok', 3000);
    setTimeout(() => ok.classList.remove('show'), 3000);
  } else {
    err.textContent = '❌ Firebase init failed.'; err.classList.add('show');
    $('cfgStatusLabel').textContent = '🔴 Failed';
  }
});

// ================================================================
//  sendToPC  (UNCHANGED — core Firebase logic)
// ================================================================
async function sendToPC(cnr, tag) {
  if (!cnr?.trim()) { toast('⚠️ CNR खाली है।', 'warn'); return; }

  const payload = {
    cnr      : cnr.trim().toUpperCase(),
    tag      : tag || '',
    timestamp: Date.now(),
    status   : 'pending',
    source   : 'pwa',
  };

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
    await db.ref(targetPath).push(payload);
    if (pcOnline) {
      toast(`✅ PC को भेजा: ${payload.cnr}`, 'ok', 2500);
    } else {
      toast(`🕐 Queue में डाला: ${payload.cnr} (PC offline)`, 'warn', 3000);
    }
  } catch (err) {
    saveToOfflineQueue(payload);
    toast(`❌ Firebase error — offline save: ${payload.cnr}`, 'err', 4000);
    console.error('[PWA] Firebase push failed:', err.message);
  }
}

// ================================================================
//  OFFLINE QUEUE  (UNCHANGED)
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
  if (!fbReady || !db) return;
  try {
    const raw = localStorage.getItem('offline_queue');
    if (!raw) return;
    const queue = JSON.parse(raw);
    if (!queue.length) return;
    toast(`🔄 ${queue.length} offline items sync हो रहे हैं…`, 'ok', 3000);
    const ref = db.ref(FB_PATH().pendingScans);
    for (const item of queue) {
      await ref.push({ ...item, synced_at: Date.now() });
    }
    localStorage.removeItem('offline_queue');
    updateOfflineQueueBadge(0);
    toast(`✅ ${queue.length} items synced!`, 'ok', 3000);
  } catch(err) {
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
  toast('🌐 Internet मिला — offline queue sync हो रही है…', 'ok', 2000);
  setTimeout(syncOfflineQueue, 1000);
});
window.addEventListener('offline', () => {
  toast('📴 Internet नहीं है — Offline Mode।', 'warn', 4000);
});

document.getElementById('syncNowBtn')?.addEventListener('click', async () => {
  const btn = $('syncNowBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Syncing…'; }
  await syncOfflineQueue();
  if (btn) { btn.disabled = false; btn.textContent = '🔄 Sync Offline Queue Now'; }
});

// ================================================================
//  VISIBILITY — stop camera in background
// ================================================================
document.addEventListener('visibilitychange', () => {
  if (document.hidden && scannerRunning) {
    stopCamera(); toast('📷 Camera paused.', 'warn', 2000);
  }
});

// ================================================================
//  BOOT
// ================================================================
async function boot() {
  showLoading('Loading…');

  FB_URL    = localStorage.getItem('ca_fb_url')    || FB_DEFAULTS.url;
  FB_APIKEY = localStorage.getItem('ca_fb_apikey') || FB_DEFAULTS.apiKey;
  FB_PREFIX = localStorage.getItem('ca_fb_prefix') || '/automation';
  if (!localStorage.getItem('ca_fb_url'))    localStorage.setItem('ca_fb_url',    FB_URL);
  if (!localStorage.getItem('ca_fb_apikey')) localStorage.setItem('ca_fb_apikey', FB_APIKEY);

  $('cfgUrl').value    = FB_URL;
  $('cfgApiKey').value = FB_APIKEY;
  $('cfgPath').value   = FB_PREFIX;

  if (FB_URL) {
    $('loadingTxt').textContent = 'Firebase connect हो रहा है…';
    const ok = initFirebase(FB_URL, FB_APIKEY, FB_PREFIX);
    if (ok) {
      $('cfgStatusLabel').textContent = '🟢 Connected';
      $('cfgUrlDisplay').textContent  = FB_URL;
      startPresenceListener();
    } else {
      $('cfgStatusLabel').textContent = '🔴 Config error';
      toast('⚠️ Firebase init failed. Settings में URL check करें।', 'warn', 5000);
    }
  } else {
    updatePcStatus('offline', null);
  }

  // Check offline queue
  try {
    const raw = localStorage.getItem('offline_queue');
    if (raw) {
      const q = JSON.parse(raw);
      if (q.length) updateOfflineQueueBadge(q.length);
    }
  } catch(_) {}

  // Init tag datalist on load
  updateTagList();

  hideLoading();
}

boot();
