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

// Offline-first local queue + pairing session
let localPendingQueue = [];
let activeSession     = null;
const LPQ_KEY     = 'pwa_local_pending_queue';
const SESSION_KEY = 'pwa_active_session';

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
function addToLocalQueue(cnr, tag, searchType) {
  const item = {
    cnr          : cnr.trim().toUpperCase(),
    tag          : tag || '',
    searchType   : searchType || 'cnr',
    timestamp    : Date.now(),
    formattedTime: new Date().toLocaleString('en-IN', { timeZone:'Asia/Kolkata', hour12:true }),
    status:'pending', source:'pwa',
  };
  lqAdd(item);
  toast('Queued: ' + item.cnr + ' (' + localPendingQueue.length + ' total)', 'ok', 2000);
}

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

// Wire radio buttons — save selection, PRESERVE existing tag
document.querySelectorAll('input[name="caseType"]').forEach(radio => {
  radio.addEventListener('change', () => {
    const prevTag = $('fileTag').value; // save before rebuild
    localStorage.setItem('ca_case_type', radio.value);
    updateTagList();
    // Always restore the previous tag — don't clear on type change
    if (prevTag) {
      $('fileTag').value = prevTag;
      $('activeTagLabel').textContent = prevTag;
      localStorage.setItem('ca_last_tag', prevTag);
    }
  });
});

// Update active tag label + save to localStorage on every change
$('fileTag').addEventListener('change', () => {
  const val = $('fileTag').value;
  $('activeTagLabel').textContent = val || '—';
  localStorage.setItem('ca_last_tag', val);
});
$('fileTag').addEventListener('input', () => {
  const val = $('fileTag').value;
  $('activeTagLabel').textContent = val || '—';
  localStorage.setItem('ca_last_tag', val);
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
  playBeep();
  // Intercept pairing QR — do NOT add to queue
  if (text.startsWith('court_session_')) {
    activeSession = text;
    localStorage.setItem(SESSION_KEY, text);
    updateSessionStatus();
    displayQRResult('Paired: ' + text, result);
    toast('PC se pair ho gaya: ' + text.slice(-8), 'ok', 4000);
    if (!continuousMode) stopCamera();
    return; // Do NOT add to queue
  }
  // Normal scan → local queue
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
//  MANUAL SEND (reads tag from fileTag — same as QR)
// ================================================================
$('manualSendBtn').addEventListener('click', async () => {
  const raw        = $('manualInput').value.trim();
  const tag        = $('fileTag').value.trim();
  const searchType = document.querySelector('input[name="searchType"]:checked')?.value || 'cnr';

  if (!raw) { toast('⚠️ Input खाली है!', 'warn'); return; }

  // Split by comma, trim each, remove empty
  const items = raw.split(',').map(s => s.trim()).filter(Boolean);

  if (!items.length) { toast('⚠️ Valid input नहीं मिला।', 'warn'); return; }

  // Validate Case Number format: Number/Year strictly
  if (searchType === 'case_number') {
    const caseNumPattern = /^\d+\/\d{4}$/;
    const invalid = items.filter(i => !caseNumPattern.test(i));
    if (invalid.length) {
      toast(`❌ Invalid format: "${invalid[0]}" — use Number/Year (e.g. 123/2026)`, 'err', 4000);
      return;
    }
  }

  // Req 3: add to local queue
  items.forEach(item => addToLocalQueue(item, tag, searchType));
  const sent = items.length;

  $('manualInput').value = '';
  localStorage.removeItem('ca_manual_cnr');
  const label = searchType === 'case_number' ? 'Case Number' : 'CNR';
  $('manualOk').textContent = `✅ ${sent} ${label}(s) queued`;
  $('manualOk').classList.add('show');
  setTimeout(() => $('manualOk').classList.remove('show'), 3000);
});
$('manualClearBtn').addEventListener('click', () => {
  $('manualInput').value = '';
  localStorage.removeItem('ca_manual_cnr');
});

// Req 4: Clear local queue
$('clearLocalQueueBtn').addEventListener('click', () => {
  if (!localPendingQueue.length) { toast('Queue empty.', 'warn'); return; }
  if (!confirm(localPendingQueue.length + ' items clear karein?')) return;
  lqClear();
  toast('Queue cleared.', 'warn', 2500);
});

// Sync to PC — pushes localPendingQueue to Firebase session path
$('syncToPCBtn').addEventListener('click', async () => {
  // Guard checks
  if (!activeSession) {
    toast('❌ Pehle PC ka Pairing QR scan karein!', 'err', 4000);
    // Switch to QR tab so user can scan
    document.querySelector('.tab-btn[data-tab="qr"]')?.click();
    return;
  }
  if (!localPendingQueue.length) {
    toast('⚠️ Queue mein koi item nahi hai.', 'warn', 3000); return;
  }
  if (!fbReady || !db) {
    toast('❌ Firebase ready nahi hai. Settings check karein.', 'err', 4000); return;
  }
  if (!navigator.onLine) {
    toast('📴 Internet nahi hai.', 'warn', 3000); return;
  }

  const btn = $('syncToPCBtn');
  btn.disabled = true; btn.textContent = '⏳ Syncing...';

  let sent = 0;
  try {
    const sessionRef = db.ref('/queues/' + activeSession);
    // Send each item with IST timestamp added
    for (const item of localPendingQueue) {
      const enriched = {
        ...item,
        formattedTime: item.formattedTime || new Date().toLocaleString('en-IN',{
          timeZone:'Asia/Kolkata', hour12:true,
        }),
        synced_at: Date.now(),
      };
      await sessionRef.push(enriched);
      sent++;
    }
    lqClear();
    toast('✅ ' + sent + ' items PC ko bheje gaye!', 'ok', 3500);
    console.log('[PWA] Synced', sent, 'items to /queues/' + activeSession);
  } catch(err) {
    // Items already pushed partially — don't clear queue
    toast('❌ Sync failed (' + sent + '/' + localPendingQueue.length + '): ' + err.message, 'err', 5000);
    console.error('[PWA] Sync error:', err.message);
  } finally {
    btn.disabled = false; btn.textContent = '📤 Sync to PC';
  }
});

// Update placeholder when searchType changes
document.querySelectorAll('input[name="searchType"]').forEach(r => {
  r.addEventListener('change', () => {
    const isCN = r.value === 'case_number';
    $('manualInput').placeholder = isCN
      ? 'Case Number: 123/2026, 45/2025…'
      : 'CNR Number: UPBL01..., UPBL02… (comma se multiple)';
  });
});
$('manualInput').addEventListener('input', () => {
  // Persist as user types — survives app reload
  const val = $('manualInput').value;
  if (val) localStorage.setItem('ca_manual_cnr', val);
  else     localStorage.removeItem('ca_manual_cnr');
});
$('manualInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('manualSendBtn').click();
});

// ================================================================
//  OCR + CROPPER.JS WORKFLOW
//  Flow: image selected/captured → Crop Modal → Crop & Scan
//        → runOCR(dataUrl) → regex → addToLocalQueue()
// ================================================================
let ocrWorker  = null;
let cropperInst = null; // active Cropper.js instance

// ── Helper: open crop modal with a File or dataURL ────────────────
function openCropModal(src) {
  const img = $('cropperImg');
  img.src = src;
  $('cropModalOverlay').classList.add('show');

  // Destroy any previous cropper instance
  if (cropperInst) { cropperInst.destroy(); cropperInst = null; }

  // Wait for img to load before initialising Cropper
  img.onload = () => {
    cropperInst = new Cropper(img, {
      viewMode   : 1,       // restrict crop box inside canvas
      dragMode   : 'move',  // drag the image, not the box
      autoCropArea: 0.85,   // default crop = 85% of image
      movable    : true,
      zoomable   : true,
      scalable   : false,
      responsive : true,
      background : false,
      guides     : true,
    });
  };
}

function closeCropModal() {
  if (cropperInst) { cropperInst.destroy(); cropperInst = null; }
  $('cropModalOverlay').classList.remove('show');
}

// ── Wire both file inputs → open crop modal ───────────────────────
function onImageSelected(file) {
  if (!file) return;
  $('ocrResultCard').style.display = 'none';
  $('ocrPreview').classList.remove('show');
  const reader = new FileReader();
  reader.onload = e => openCropModal(e.target.result);
  reader.readAsDataURL(file);
}

$('ocrInput').addEventListener('change', e => {
  onImageSelected(e.target.files[0]);
  e.target.value = ''; // reset so same file can be reselected
});

$('ocrCamInput').addEventListener('change', e => {
  onImageSelected(e.target.files[0]);
  e.target.value = '';
});

// ── Cancel: close modal, reset inputs ────────────────────────────
$('cropCancelBtn').addEventListener('click', () => {
  closeCropModal();
  toast('Crop cancelled.', 'warn', 1500);
});

// ── Crop & Scan: extract cropped canvas → pass to Tesseract ───────
$('cropScanBtn').addEventListener('click', () => {
  if (!cropperInst) return;
  $('cropScanBtn').disabled    = true;
  $('cropScanBtn').textContent = '⏳ Processing…';
  try {
    // getCroppedCanvas returns a <canvas> — convert to dataURL
    const canvas   = cropperInst.getCroppedCanvas({
      maxWidth : 2048,
      maxHeight: 2048,
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high',
    });
    const dataUrl  = canvas.toDataURL('image/jpeg', 0.92);

    // Show the cropped image as preview
    $('ocrPreview').src = dataUrl;
    $('ocrPreview').classList.add('show');

    closeCropModal();

    // Pass cropped dataUrl directly into existing Tesseract OCR function
    runOCR(dataUrl);
  } catch(err) {
    toast('Crop error: ' + err.message, 'err', 3000);
  } finally {
    $('cropScanBtn').disabled    = false;
    $('cropScanBtn').textContent = '✂️ Crop & Scan';
  }
});

// ── runOCR: accepts File OR dataURL string ────────────────────────
// All OCR extraction + addToLocalQueue logic UNCHANGED below
async function runOCR(source) {
  $('ocrProg').classList.add('show'); $('ocrBar').style.width = '0%';
  $('ocrProgLabel').textContent = 'Tesseract.js शुरू हो रहा है…';
  try {
    if (!ocrWorker) {
      ocrWorker = await Tesseract.createWorker('eng', 1, {
        logger: m => {
          if (m.status === 'recognizing text') {
            $('ocrBar').style.width = Math.round(m.progress * 100) + '%';
            $('ocrProgLabel').textContent = 'Recognizing… ' + Math.round(m.progress * 100) + '%';
          } else if (m.status === 'loading tesseract core') {
            $('ocrProgLabel').textContent = 'Core load हो रहा है…';
          } else if (m.status === 'loading language traineddata') {
            $('ocrProgLabel').textContent = 'Language data load हो रहा है…';
          }
        },
      });
    }
    $('ocrProgLabel').textContent = 'Text पहचाना जा रहा है…';
    $('ocrBar').style.width = '30%';

    // Tesseract accepts File, Blob, dataURL, or URL
    const { data: { text, confidence } } = await ocrWorker.recognize(source);

    $('ocrBar').style.width = '100%';
    $('ocrProgLabel').textContent = 'Done! Confidence: ' + Math.round(confidence) + '%';
    const trimmed = text.trim() || '(कोई text नहीं मिला)';
    $('ocrResultBox').value          = trimmed; // textarea — editable
    $('ocrResultCard').style.display = 'block';
    setTimeout(() => $('ocrProg').classList.remove('show'), 1500);
    toast('OCR complete! Confidence: ' + Math.round(confidence) + '%', 'ok', 3000);

    // ── Multi-CNR extraction (UNCHANGED logic) ────────────────────
    const cleaned = text.replace(/[\s\-]/g, '').toUpperCase();
    const foundCNRs = new Set();

    // Logic 1: strict 16-digit UPBL CNRs
    const strictMatches = cleaned.match(/UPBL[A-Z0-9]{2}\d{10}/g) || [];
    strictMatches.forEach(m => foundCNRs.add(m));

    // Logic 2: fallback 12-char → prepend UPBL
    let remainder = cleaned;
    foundCNRs.forEach(c => { remainder = remainder.replace(c, ''); });
    const fallbackMatches = remainder.match(/[A-Z0-9]{2}\d{10}/g) || [];
    fallbackMatches.forEach(m => foundCNRs.add('UPBL' + m));

        // Smart Highlight: find UP* words AND 10+ digit numbers
    const HIGHLIGHT_RE = /\b(UP[a-zA-Z0-9]+|\d{10,})\b/gi;
    const highlighted  = trimmed.replace(HIGHLIGHT_RE, function(match) {
      const safe = match.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return '<span class="cnr-highlight" data-cnr="' + safe + '">' + safe + '</span>';
    });
    const hlBox = $('ocr-highlight-box');
    if (hlBox) {
      hlBox.innerHTML = highlighted ||
        '<em style="color:#94a3b8">No highlighted terms found</em>';
    }

    if (foundCNRs.size > 0) {
      console.log('[PWA] OCR CNRs auto-detected:', [...foundCNRs]);
      toast(foundCNRs.size + ' CNR मिले — tap करें या "Send to Queue" दबाएं।', 'ok', 3500);
    } else {
      console.log('[PWA] OCR: no CNR pattern found');
      toast('OCR हो गया — highlighted terms tap करें या edit करके Send करें।', 'warn', 3000);
    }  } catch(err) {
    $('ocrProgLabel').textContent = 'Error: ' + err.message;
    toast('OCR failed: ' + err.message, 'err');
    setTimeout(() => $('ocrProg').classList.remove('show'), 3000);
  }
}

$('ocrCopyBtn').addEventListener('click', () => {
  const t = $('ocrResultBox').value; if (!t) return;
  navigator.clipboard.writeText(t).then(() => toast('📋 Copied!', 'ok', 2000));
});

// Tap-to-Extract: click highlighted span → APPENDS to textarea (multi-select)
$('ocr-highlight-box').addEventListener('click', function(e) {
  const span = e.target.closest('.cnr-highlight');
  if (!span) return;

  const extracted = (span.dataset.cnr || span.textContent || '').trim();
  if (!extracted) return;

  const box      = $('ocrResultBox');
  const existing = (box.value || '').trim();

  // Duplicate check — don't add if already present
  const parts = existing ? existing.split(',').map(function(s){ return s.trim(); }) : [];
  if (parts.includes(extracted)) {
    span.style.background = '#fca5a5';
    setTimeout(function() { span.style.background = ''; }, 800);
    toast('Already added: ' + extracted, 'warn', 1500);
    return;
  }

  // Append with ", " separator or insert fresh
  box.value = existing ? existing + ', ' + extracted : extracted;
  box.focus();

  // Visual feedback — flash green
  span.classList.add('tapped');
  setTimeout(function() { span.classList.remove('tapped'); }, 1200);

  toast('Added: ' + extracted + ' (' + (parts.length + 1) + ' total)', 'ok', 2000);
});

// New Feature 2: Send to Queue from OCR text
$('ocrSendQueueBtn').addEventListener('click', () => {
  const text    = $('ocrResultBox').value.trim();
  const ocrTag  = $('fileTag')?.value?.trim() || '';
  if (!text) { toast('⚠️ Text box खाली है।', 'warn'); return; }

  // Run same CNR extraction on the (possibly edited) text
  const cleaned = text.replace(/[\s\-]/g, '').toUpperCase();
  const found   = new Set();

  // Logic 1: strict UPBL CNRs
  (cleaned.match(/UPBL[A-Z0-9]{2}\d{10}/g) || []).forEach(m => found.add(m));

  // Logic 2: fallback 12-char → prepend UPBL
  let rem = cleaned;
  found.forEach(c => { rem = rem.replace(c, ''); });
  (rem.match(/[A-Z0-9]{2}\d{10}/g) || []).forEach(m => found.add('UPBL' + m));

  if (!found.size) {
    toast('❌ Text में कोई CNR pattern नहीं मिला।', 'err', 3000);
    return;
  }

  for (const cnr of found) { addToLocalQueue(cnr, ocrTag, 'cnr'); }
  toast('✅ ' + found.size + ' CNR queue में add हुए!', 'ok', 3000);
  $('ocrResultBox').style.borderColor = 'var(--green)';
  setTimeout(() => { $('ocrResultBox').style.borderColor = ''; }, 2000);
});
$('ocrClearBtn').addEventListener('click', () => {
  $('ocrPreview').classList.remove('show');
  $('ocrResultCard').style.display = 'none';
  $('ocrResultBox').value = '';
  const hlBox = $('ocr-highlight-box');
  if (hlBox) hlBox.innerHTML = '';
  $('ocrInput').value = ''; $('ocrCamInput').value = '';
  closeCropModal();
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
async function sendToPC(cnr, tag, searchType = 'cnr') {
  if (!cnr?.trim()) { toast('⚠️ Input खाली है।', 'warn'); return; }

  const payload = {
    cnr          : cnr.trim().toUpperCase(),
    tag          : tag || '',
    searchType   : searchType || 'cnr',   // 'cnr' or 'case_number'
    timestamp    : Date.now(),
    formattedTime: new Date().toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour12  : true,
    }),
    status       : 'pending',
    source       : 'pwa',
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
  toast('🌐 Internet मिला — sync शुरू हो रही है…', 'ok', 2000);
  setTimeout(() => { syncOfflineQueue(); autoSyncLocalQueue(); }, 1200);
});
window.addEventListener('offline', () => {
  toast('📴 Internet नहीं है — Offline Mode।', 'warn', 4000);
});

// Fix 5: Auto-sync localPendingQueue when internet restored
async function autoSyncLocalQueue() {
  if (!activeSession)                { console.log('[PWA] autoSync: no session'); return; }
  if (!fbReady || !db)               { console.log('[PWA] autoSync: Firebase not ready'); return; }
  if (!localPendingQueue.length)     { console.log('[PWA] autoSync: queue empty'); return; }
  if (!navigator.onLine)             { console.log('[PWA] autoSync: offline'); return; }
  console.log('[PWA] autoSync:', localPendingQueue.length, 'items...');
  const sessionRef = db.ref('/queues/' + activeSession);
  const toSend = [...localPendingQueue];
  let sent = 0;
  try {
    for (const item of toSend) {
      await sessionRef.push({
        ...item,
        formattedTime: item.formattedTime || new Date().toLocaleString('en-IN',{
          timeZone:'Asia/Kolkata', hour12:false }),
        synced_at: Date.now(), auto_synced: true,
      });
      sent++;
    }
    lqClear();
    toast('✅ Auto-sync: ' + sent + ' items PC को भेजे गए!', 'ok', 3500);
  } catch(err) {
    console.error('[PWA] autoSync error:', err.message);
    toast('⚠️ Auto-sync failed (' + sent + '/' + toSend.length + ')', 'warn', 4000);
  }
}

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

  // Restore last selected case type and tag from localStorage
  const savedCaseType = localStorage.getItem('ca_case_type') || 'manual';
  const savedTag      = localStorage.getItem('ca_last_tag')  || '';

  // Set the correct radio button
  const radio = document.querySelector(`input[name="caseType"][value="${savedCaseType}"]`);
  if (radio) radio.checked = true;

  // Build datalist for saved case type, then restore tag
  updateTagList();
  if (savedTag) {
    $('fileTag').value = savedTag;
    $('activeTagLabel').textContent = savedTag;
  }

  // Fix 1: restore manual CNR input if user had typed it
  const savedManualCNR = localStorage.getItem('ca_manual_cnr') || '';
  if (savedManualCNR && $('manualInput')) {
    $('manualInput').value = savedManualCNR;
  }

  lqLoad();
  loadSession();

  hideLoading();
}

boot();
