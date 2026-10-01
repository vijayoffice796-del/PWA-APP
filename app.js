// ================================================================
//  app.js — Court Automation PWA  |  Step 5 (Final / Bug-Fixed)
//  No login screen — opens directly to main UI.
//  Firebase paths: static /automation/... (matches Extension).
//  Step 6 will wire QR/OCR/Manual send to Firebase.
// ================================================================
'use strict';

// ── Firebase state ────────────────────────────────────────────────
let db          = null;
let presenceRef = null;
let pcOnline    = false;
let fbReady     = false;

// ── Hardcoded Firebase defaults (no manual entry needed) ─────────
const FB_DEFAULTS = {
  url   : 'https://court-automation-2-default-rtdb.firebaseio.com/',
  apiKey: 'AIzaSyBrgmFp4EXnO7Bb358fZdydk5HpI1UGS3o',
};

// ── Config (loaded from localStorage, falls back to defaults) ────
let FB_URL     = FB_DEFAULTS.url;
let FB_APIKEY  = FB_DEFAULTS.apiKey;
let FB_PREFIX  = '/automation';

// ── Static Firebase paths (same as Extension's background.js) ────
const FB_PATH = () => ({
  presence    : `${FB_PREFIX}/system_status`,
  cnrQueue    : `${FB_PREFIX}/cnr_queue`,
  pendingScans: `${FB_PREFIX}/pending_scans`,
});

// ── App state ─────────────────────────────────────────────────────
let scanCount       = 0;
let qrScanner       = null;
let scannerRunning  = false;
let continuousMode  = false;
let lastCode        = '';
let lastScanTime    = 0;
const SCAN_DEBOUNCE = 3000;  // ms — same code cooldown
let   scanLocked    = false; // Global lock: blocks ALL scans for LOCK_MS after any success
const SCAN_LOCK_MS  = 1500;  // ms — pause after ANY successful scan (prevents batch duplicates)

// Step 6: selected tag from PWA UI
let selectedTag = '';

// ── DOM ───────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

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
//  FIREBASE INIT
// ================================================================
function initFirebase(url, apiKey, prefix) {
  try {
    // Prevent duplicate app
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
//  PC PRESENCE LISTENER  (reads /automation/system_status)
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
  console.log('[PWA] Presence listener:', FB_PATH().presence);
}

function updatePcStatus(state, ts) {
  pcOnline = state === 'online';
  const dot = $('pcDot'), lbl = $('pcLabel'), time = $('pcTime');
  if (state === 'online') {
    dot.className = 'pc-dot online'; lbl.className = 'pc-lbl online'; lbl.textContent = '🟢 PC Online — Ready';
  } else {
    dot.className = 'pc-dot offline'; lbl.className = 'pc-lbl offline'; lbl.textContent = '🔴 PC Offline — Queue Mode';
  }
  time.textContent = ts ? `${new Date(ts).toLocaleTimeString('en-IN',{hour12:false})}` : '';
  // Settings tab
  $('cfgPcStatus').textContent = state === 'online' ? '🟢 Online' : '🔴 Offline';
}

// ================================================================
//  TAB NAVIGATION
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
//  QR SCANNER  (html5-qrcode)
// ================================================================
$('contScanRow').addEventListener('click', () => {
  const cb = $('continuousScan'); cb.checked = !cb.checked;
  continuousMode = cb.checked;
  $('contScanRow').classList.toggle('on', continuousMode);
  toast(continuousMode ? '🔄 Continuous ON' : '⏹ Continuous OFF', continuousMode ? 'ok' : 'warn', 2000);
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
    // Prefer back camera
    const cam = devices.find(d => /back|rear|environment/i.test(d.label)) || devices[devices.length-1];
    qrScanner = new Html5Qrcode('qr-reader');
    await qrScanner.start(
      { deviceId: { exact: cam.id } },
      { fps:10, qrbox:{width:250,height:250}, aspectRatio:1.0, disableFlip:false },
      onQRSuccess, onQRError
    );
    scannerRunning = true;
    $('scanOverlay').classList.add('on');
    $('stopCamBtn').disabled  = false;
    $('startCamBtn').disabled = true; $('startCamBtn').textContent = '▶️ Start Camera';
    toast('📷 Camera started!', 'ok', 2000);
  } catch (err) {
    $('startCamBtn').disabled = false; $('startCamBtn').textContent = '▶️ Start Camera';
    $('camPlaceholder').style.display = 'flex';
    let msg = err.message || 'Camera error.';
    if (/Permission|NotAllowed/i.test(msg)) msg = '❌ Camera permission denied. Browser Settings में allow करें।';
    else if (/कोई camera/i.test(msg)) msg = '❌ ' + msg;
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

  // Duplicate fix 1: global lock — blocks ALL codes for LOCK_MS after any scan
  if (scanLocked) return;

  // Duplicate fix 2: same-code cooldown
  if (text === lastCode && (now - lastScanTime) < SCAN_DEBOUNCE) return;

  // Acquire lock immediately — prevents other QR codes visible in frame
  scanLocked = true;
  setTimeout(() => { scanLocked = false; }, SCAN_LOCK_MS);

  lastCode = text; lastScanTime = now;
  scanCount++; $('scanCountDisplay').textContent = scanCount;

  displayQRResult(text, result);
  playBeep();

  // Dispatch event → Firebase send (Step 6)
  document.dispatchEvent(new CustomEvent('qr:scanned', {
    detail: { raw:text, format: result?.result?.format?.formatName || 'QR_CODE', timestamp:now }
  }));

  if (!continuousMode) stopCamera();
}

function onQRError(msg) {
  if (/No QR|No barcode/i.test(msg || '')) return;
  console.warn('[PWA] QR frame error:', msg);
}

function displayQRResult(text, result) {
  const box = $('qrResult'), val = $('qrResultValue'), meta = $('qrResultMeta');
  val.textContent  = text;
  const fmt = result?.result?.format?.formatName || 'QR_CODE';
  const isCnr = /^[A-Z]{2}[A-Z\d]{2}\d{10}$/.test(text.trim());
  meta.textContent = `${fmt} · ${new Date().toLocaleTimeString('en-IN')}${isCnr ? ' · ✅ CNR Detected' : ''}`;
  box.className = 'scan-result show ok';
}

function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880; osc.type = 'sine';
    gain.gain.setValueAtTime(.35, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + .15);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + .15);
  } catch(_) {}
}

// ================================================================
//  OCR  (Tesseract.js)
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
    $('ocrBar').style.width = '100%'; $('ocrProgLabel').textContent = `✅ Done! Confidence: ${Math.round(confidence)}%`;
    const trimmed = text.trim() || '(कोई text नहीं मिला)';
    $('ocrResultBox').textContent = trimmed;
    $('ocrResultCard').style.display = 'block';
    setTimeout(() => $('ocrProg').classList.remove('show'), 1500);
    toast(`✅ OCR complete! Confidence: ${Math.round(confidence)}%`, 'ok', 3000);
    document.dispatchEvent(new CustomEvent('ocr:complete', { detail:{ text:trimmed, confidence, timestamp:Date.now() } }));
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
  $('ocrPreview').classList.remove('show'); $('ocrResultCard').style.display = 'none';
  $('ocrResultBox').textContent = ''; $('ocrInput').value = '';
});

// ================================================================
//  MANUAL SEND
// ================================================================
$('manualSendBtn').addEventListener('click', () => {
  const val = $('manualInput').value.trim();
  if (!val) { toast('⚠️ CNR खाली है!', 'warn'); return; }
  document.dispatchEvent(new CustomEvent('manual:send', { detail:{ cnr:val, timestamp:Date.now(), pcOnline } }));
  // Clear input after send
  $('manualInput').value = '';
  $('manualOk').textContent = `✅ "${val}" send किया गया`; $('manualOk').classList.add('show');
  setTimeout(() => $('manualOk').classList.remove('show'), 3000);
});
$('manualClearBtn').addEventListener('click', () => { $('manualInput').value = ''; });
$('manualInput').addEventListener('keydown', e => { if (e.key==='Enter') $('manualSendBtn').click(); });

// ================================================================
//  SETTINGS — Firebase Config Save
// ================================================================
$('saveCfgBtn').addEventListener('click', () => {
  const url    = $('cfgUrl').value.trim();
  const apiKey = $('cfgApiKey').value.trim();
  const prefix = $('cfgPath').value.trim() || '/automation';
  const err    = $('cfgError'), ok = $('cfgOk');
  err.classList.remove('show'); ok.classList.remove('show');

  if (!url)       { err.textContent='❌ Database URL खाली है।'; err.classList.add('show'); return; }
  if (!url.startsWith('https://') || !url.includes('firebaseio.com')) {
    err.textContent='❌ Valid URL: https://xxx.firebaseio.com'; err.classList.add('show'); return;
  }

  $('saveCfgBtn').textContent = '⏳ Connecting…'; $('saveCfgBtn').disabled = true;

  // Persist to localStorage
  localStorage.setItem('ca_fb_url',    url);
  localStorage.setItem('ca_fb_apikey', apiKey);
  localStorage.setItem('ca_fb_prefix', prefix);
  FB_URL = url; FB_APIKEY = apiKey; FB_PREFIX = prefix;

  // Re-init Firebase
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
    err.textContent = '❌ Firebase init failed. URL check करें।'; err.classList.add('show');
    $('cfgStatusLabel').textContent = '🔴 Failed';
  }
});

// ================================================================
//  STEP 6: FIREBASE DATA SENDING
// ================================================================

// ── Core send function ───────────────────────────────────────────
// Builds payload and routes to Firebase or offline localStorage queue
async function sendToPC(cnr, tag) {
  if (!cnr?.trim()) { toast('⚠️ CNR खाली है।', 'warn'); return; }

  const payload = {
    cnr      : cnr.trim().toUpperCase(),
    tag      : tag || selectedTag || '',
    timestamp: Date.now(),
    status   : 'pending',
    source   : 'pwa',
  };

  if (!fbReady || !db) {
    // Firebase not configured — save to localStorage queue
    saveToOfflineQueue(payload);
    toast(`📥 Offline saved: ${payload.cnr}`, 'warn', 3000);
    console.log('[PWA] Firebase not ready — saved offline:', payload);
    return;
  }

  if (!navigator.onLine) {
    // Device offline — save to localStorage queue
    saveToOfflineQueue(payload);
    toast(`📴 Offline: "${payload.cnr}" queue में सेव हुआ`, 'warn', 3000);
    console.log('[PWA] Device offline — saved to queue:', payload);
    return;
  }

  try {
    // PC online → push to /automation/cnr_queue (Extension picks up immediately)
    // PC offline → push to /automation/pending_scans (Extension processes on reconnect)
    const targetPath = pcOnline ? FB_PATH().cnrQueue : FB_PATH().pendingScans;
    await db.ref(targetPath).push(payload);

    if (pcOnline) {
      toast(`✅ PC को भेजा: ${payload.cnr}`, 'ok', 2500);
      console.log('[PWA] Sent to cnr_queue:', payload.cnr);
    } else {
      toast(`🕐 Queue में डाला: ${payload.cnr} (PC offline)`, 'warn', 3000);
      console.log('[PWA] Sent to pending_scans:', payload.cnr);
    }
  } catch (err) {
    // Firebase write failed — fall back to localStorage
    console.error('[PWA] Firebase push failed:', err.message);
    saveToOfflineQueue(payload);
    toast(`❌ Firebase error — offline save किया: ${payload.cnr}`, 'err', 4000);
  }
}

// ── Offline localStorage queue ───────────────────────────────────
function saveToOfflineQueue(payload) {
  try {
    const raw   = localStorage.getItem('offline_queue');
    const queue = raw ? JSON.parse(raw) : [];
    queue.push(payload);
    localStorage.setItem('offline_queue', JSON.stringify(queue));
    updateOfflineQueueBadge(queue.length);
  } catch(err) {
    console.error('[PWA] saveToOfflineQueue error:', err);
  }
}

// Sync offline localStorage queue to Firebase /pending_scans when back online
async function syncOfflineQueue() {
  if (!fbReady || !db) return;
  try {
    const raw = localStorage.getItem('offline_queue');
    if (!raw) return;
    const queue = JSON.parse(raw);
    if (!queue.length) return;

    console.log(`[PWA] Syncing ${queue.length} offline items to Firebase…`);
    toast(`🔄 ${queue.length} offline items sync हो रहे हैं…`, 'ok', 3000);

    const ref = db.ref(FB_PATH().pendingScans);
    for (const item of queue) {
      await ref.push({ ...item, synced_at: Date.now() });
    }
    localStorage.removeItem('offline_queue');
    updateOfflineQueueBadge(0);
    toast(`✅ ${queue.length} items synced to Firebase!`, 'ok', 3000);
    console.log('[PWA] Offline queue synced successfully.');
  } catch(err) {
    console.error('[PWA] syncOfflineQueue error:', err.message);
    toast('❌ Sync failed — try again.', 'err', 3000);
  }
}

function updateOfflineQueueBadge(count) {
  const el = $('offlineQueueBadge');
  if (!el) return;
  el.textContent   = count > 0 ? `📴 ${count} offline` : '';
  el.style.display = count > 0 ? 'inline-block' : 'none';
}

// Online event → auto-sync offline queue
window.addEventListener('online', () => {
  console.log('[PWA] Device back online — syncing offline queue…');
  toast('🌐 Internet मिला — offline queue sync हो रही है…', 'ok', 2000);
  setTimeout(syncOfflineQueue, 1000); // small delay for connection stability
});

window.addEventListener('offline', () => {
  toast('📴 Internet नहीं है — Offline Mode में काम कर रहे हैं।', 'warn', 4000);
});

// ── Wire qr:scanned event ────────────────────────────────────────
document.addEventListener('qr:scanned', e => {
  const { raw } = e.detail;
  console.log('[PWA] qr:scanned →', raw);
  sendToPC(raw, selectedTag);
});

// ── Wire ocr:complete event ──────────────────────────────────────
// OCR sends full text — user can extract CNR manually from result
// or we auto-detect a CNR pattern in the text
document.addEventListener('ocr:complete', e => {
  const { text } = e.detail;
  // Try to auto-detect CNR pattern: 2 letters + 2 alphanumeric + 10 digits
  const match = text.match(/[A-Z]{2}[A-Z0-9]{2}\d{10}/);
  if (match) {
    const cnr = match[0];
    console.log('[PWA] OCR CNR detected:', cnr);
    toast(`🔍 CNR मिला: ${cnr} — भेजा जा रहा है…`, 'ok', 2500);
    sendToPC(cnr, selectedTag);
  } else {
    console.log('[PWA] OCR: no CNR pattern found in text');
    // Text is shown in OCR result box — user can manually copy/use
  }
});

// ── Wire manual:send event ───────────────────────────────────────
document.addEventListener('manual:send', e => {
  const { cnr } = e.detail;
  console.log('[PWA] manual:send →', cnr);
  sendToPC(cnr, selectedTag);
});

// ================================================================
//  STEP 6: TAG SELECTOR WIRING
// ================================================================
function wireTagStrip(stripId) {
  const strip = document.getElementById(stripId);
  if (!strip) return;
  strip.querySelectorAll('.tag-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      strip.querySelectorAll('.tag-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      selectedTag = chip.dataset.tag || '';
      updateActiveTagLabel();
    });
  });
}

function updateActiveTagLabel() {
  const el = $('activeTagLabel');
  if (el) el.textContent = selectedTag || 'None';
  const countEl = $('offlineQueueCount');
  if (countEl) {
    try {
      const raw = localStorage.getItem('offline_queue');
      const q   = raw ? JSON.parse(raw) : [];
      countEl.textContent = `${q.length} items`;
    } catch(_) { countEl.textContent = '0 items'; }
  }
}

// Custom tag set button
document.getElementById('setCustomTagBtn')?.addEventListener('click', () => {
  const input = $('customTagInput');
  const val   = input?.value.trim();
  if (!val) return;
  selectedTag = val;
  // Deactivate all chips
  document.querySelectorAll('.tag-chip').forEach(c => c.classList.remove('active'));
  updateActiveTagLabel();
  toast(`🏷️ Tag set: "${val}"`, 'ok', 2000);
});

// Sync Now button in Settings
document.getElementById('syncNowBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('syncNowBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Syncing…'; }
  await syncOfflineQueue();
  updateActiveTagLabel();
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
//  BOOT — no login, straight to app
// ================================================================
async function boot() {
  showLoading('Loading…');

  // Load saved config — fall back to hardcoded defaults
  FB_URL    = localStorage.getItem('ca_fb_url')    || FB_DEFAULTS.url;
  FB_APIKEY = localStorage.getItem('ca_fb_apikey') || FB_DEFAULTS.apiKey;
  FB_PREFIX = localStorage.getItem('ca_fb_prefix') || '/automation';
  // Save defaults to localStorage so settings UI shows them
  if (!localStorage.getItem('ca_fb_url'))    localStorage.setItem('ca_fb_url',    FB_URL);
  if (!localStorage.getItem('ca_fb_apikey')) localStorage.setItem('ca_fb_apikey', FB_APIKEY);

  // Pre-fill settings inputs
  if (FB_URL)    $('cfgUrl').value    = FB_URL;
  if (FB_APIKEY) $('cfgApiKey').value = FB_APIKEY;
  $('cfgPath').value = FB_PREFIX;

  if (FB_URL) {
    $('loadingTxt').textContent = 'Firebase connect हो रहा है…';
    const ok = initFirebase(FB_URL, FB_APIKEY, FB_PREFIX);
    if (ok) {
      $('cfgStatusLabel').textContent = '🟢 Connected';
      $('cfgUrlDisplay').textContent  = FB_URL;
      startPresenceListener();
    } else {
      $('cfgStatusLabel').textContent = '🔴 Config error';
      toast('⚠️ Firebase init failed. Settings tab में URL check करें।', 'warn', 5000);
    }
  } else {
    $('cfgStatusLabel').textContent = '⚠️ Not configured';
    updatePcStatus('offline', null);
    toast('⚙️ Settings tab में Firebase URL configure करें।', 'warn', 5000);
  }

  // Step 6: check offline queue on boot and update badge
  try {
    const raw = localStorage.getItem('offline_queue');
    if (raw) {
      const q = JSON.parse(raw);
      if (q.length) {
        updateOfflineQueueBadge(q.length);
        toast(`📴 ${q.length} offline items pending — WiFi मिलने पर auto-sync होंगे।`, 'warn', 5000);
      }
    }
  } catch(_) {}

  // Wire tag strips (must be after DOM is ready)
  wireTagStrip('tagStrip');
  wireTagStrip('manualTagStrip');
  updateActiveTagLabel();

  hideLoading();
}

boot();
