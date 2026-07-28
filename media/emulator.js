const vscode = acquireVsCodeApi();

const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
const stage = document.getElementById('stage');
const statusEl = document.getElementById('status');
const statusChip = document.getElementById('statusChip');
const avdSelect = document.getElementById('avdSelect');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const refreshBtn = document.getElementById('refreshBtn');
const logsBtn = document.getElementById('logsBtn');
const fitHeightBtn = document.getElementById('fitHeightBtn');
const fitWidthBtn = document.getElementById('fitWidthBtn');
const zoomInBtn = document.getElementById('zoomInBtn');
const zoomOutBtn = document.getElementById('zoomOutBtn');
const zoomLabel = document.getElementById('zoomLabel');
const placeholderTitle = document.getElementById('placeholderTitle');
const placeholderHint = document.getElementById('placeholderHint');

// Detailed logs live in the "Android Emulator Viewer" output channel; the
// webview only surfaces the one-line status.
function setStatus(text, kind) {
  statusEl.textContent = text;
  statusChip.className = `status${kind ? ` status--${kind}` : ''}`;
}

// --- H.264 decoding -------------------------------------------------------
// screenrecord writes an Annex-B stream to a pipe, so chunk boundaries are
// arbitrary. Accumulate bytes and cut them into access units on start codes.

let decoder;
let pending = new Uint8Array(0);
let waitingForKeyframe = true;

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function startCodeLength(buf, i) {
  if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) return 3;
  if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1) return 4;
  return 0;
}

function findStartCode(buf, from) {
  for (let i = from; i + 3 < buf.length; i += 1) {
    const len = startCodeLength(buf, i);
    if (len) return { index: i, length: len };
  }
  return undefined;
}

function nalType(buf, offset) {
  return buf[offset] & 0x1f;
}

function ensureDecoder() {
  if (decoder && decoder.state !== 'closed') return decoder;

  decoder = new VideoDecoder({
    output: (frame) => {
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
        applyViewMode();
      }
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      frame.close();
    },
    error: (error) => {
      setStatus(`Decoder error: ${error.message}`, 'error');
      resetDecoder();
    }
  });

  // Annex-B elementary stream: no avcC description, so SPS/PPS must arrive
  // inline ahead of the first keyframe.
  decoder.configure({ codec: 'avc1.42c02a', optimizeForLatency: true });
  return decoder;
}

function resetDecoder() {
  if (decoder && decoder.state !== 'closed') {
    try {
      decoder.close();
    } catch {
      // already tearing down
    }
  }
  decoder = undefined;
  pending = new Uint8Array(0);
  waitingForKeyframe = true;
  accessUnit = [];
  accessUnitHasIdr = false;
  accessUnitHasParams = false;
  droppedBeforeKeyframe = 0;
}

// Group NALs into access units. SPS(7)/PPS(8) are prepended to the keyframe
// that follows them so the decoder gets its parameter sets in one chunk.
//
// `hasIdr` must track the IDR slice (type 5) alone. Parameter sets recur
// mid-GOP, so treating them as a keyframe marker would label an ordinary
// P-frame as 'key' and the decoder would resolve it against a reference frame
// it never received — the whole picture then drifts until the next real IDR.
let accessUnit = [];
let accessUnitHasIdr = false;
let accessUnitHasParams = false;
let droppedBeforeKeyframe = 0;

// Parameter-set NALs, kept so a discarded pre-IDR frame doesn't take the only
// copy of SPS/PPS with it.
function paramNals() {
  return accessUnit.filter((nal) => {
    const type = nal[startCodeLength(nal, 0)] & 0x1f;
    return type === 7 || type === 8;
  });
}

function flushAccessUnit() {
  if (accessUnit.length === 0) return;

  const isKey = accessUnitHasIdr;
  const carried = paramNals();

  // Never hand the decoder a delta frame before a real IDR has arrived; without
  // a valid reference it renders as noise that propagates through every
  // subsequent P-frame. The frame is dropped but its parameter sets are kept,
  // since the next IDR may not repeat them.
  if (waitingForKeyframe && !isKey) {
    accessUnit = carried;
    accessUnitHasParams = carried.length > 0;
    accessUnitHasIdr = false;
    droppedBeforeKeyframe += 1;
    // A static screen (the launcher especially) can go a long time without a
    // natural IDR, so ask for a fresh segment rather than sit on a blank canvas.
    if (droppedBeforeKeyframe === 1) {
      setStatus('Waiting for keyframe…', 'busy');
    } else if (droppedBeforeKeyframe === 30) {
      vscode.postMessage({ type: 'requestKeyframe' });
    }
    return;
  }

  if (droppedBeforeKeyframe > 0) {
    droppedBeforeKeyframe = 0;
    setStatus('Streaming', 'live');
  }

  let total = 0;
  for (const nal of accessUnit) total += nal.length;
  const data = new Uint8Array(total);
  let offset = 0;
  for (const nal of accessUnit) {
    data.set(nal, offset);
    offset += nal.length;
  }

  accessUnit = [];
  accessUnitHasIdr = false;
  accessUnitHasParams = false;
  waitingForKeyframe = false;

  try {
    ensureDecoder().decode(
      new EncodedVideoChunk({
        type: isKey ? 'key' : 'delta',
        // screenrecord gives no container timestamps; monotonic is enough for
        // a live view with optimizeForLatency.
        timestamp: performance.now() * 1000,
        data
      })
    );
  } catch (error) {
    setStatus(`Decode failed: ${error.message}`, 'error');
    resetDecoder();
  }
}

function onVideoBytes(bytes) {
  pending = concat(pending, bytes);

  let cursor = findStartCode(pending, 0);
  if (!cursor) return;

  while (true) {
    const payloadStart = cursor.index + cursor.length;
    const next = findStartCode(pending, payloadStart);
    if (!next) break;

    const nal = pending.subarray(cursor.index, next.index);
    const type = nalType(pending, payloadStart);

    // 1=non-IDR, 5=IDR both begin a new picture; parameter sets attach to the
    // upcoming one instead of standing alone.
    if (type === 1 || type === 5) {
      accessUnit.push(nal);
      if (type === 5) accessUnitHasIdr = true;
      flushAccessUnit();
    } else {
      if (type === 7 || type === 8) accessUnitHasParams = true;
      accessUnit.push(nal);
    }

    cursor = next;
  }

  // Keep the trailing partial NAL for the next chunk.
  pending = pending.slice(cursor.index);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// --- view sizing ----------------------------------------------------------
// 'fitHeight' | 'fitWidth' | number (explicit scale factor)

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3];
let viewMode = 'fitHeight';

function stageBox() {
  const style = getComputedStyle(stage);
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  return {
    width: Math.max(40, stage.clientWidth - padX),
    height: Math.max(40, stage.clientHeight - padY)
  };
}

function currentScale() {
  const box = stageBox();
  if (viewMode === 'fitHeight') return box.height / canvas.height;
  if (viewMode === 'fitWidth') return box.width / canvas.width;
  return viewMode;
}

function applyViewMode() {
  const scale = currentScale();
  canvas.style.width = `${Math.round(canvas.width * scale)}px`;
  canvas.style.height = `${Math.round(canvas.height * scale)}px`;

  if (viewMode === 'fitHeight') zoomLabel.textContent = 'Fit H';
  else if (viewMode === 'fitWidth') zoomLabel.textContent = 'Fit W';
  else zoomLabel.textContent = `${Math.round(scale * 100)}%`;

  fitHeightBtn.classList.toggle('iconbtn--on', viewMode === 'fitHeight');
  fitWidthBtn.classList.toggle('iconbtn--on', viewMode === 'fitWidth');
}

function setViewMode(mode) {
  viewMode = mode;
  applyViewMode();
}

function stepZoom(direction) {
  // Stepping out of a fit mode starts from whatever that fit resolved to, so
  // the first click doesn't jump the size unexpectedly.
  const from = currentScale();
  const next =
    direction > 0
      ? ZOOM_STEPS.find((s) => s > from + 0.001)
      : [...ZOOM_STEPS].reverse().find((s) => s < from - 0.001);
  if (next) setViewMode(next);
}

window.addEventListener('resize', () => {
  if (viewMode === 'fitHeight' || viewMode === 'fitWidth') applyViewMode();
});

// --- AVD list -------------------------------------------------------------

let avdNames = [];

function renderAvdList(names) {
  avdNames = names;
  avdSelect.replaceChildren();

  if (names.length === 0) {
    const option = document.createElement('option');
    option.textContent = 'No AVDs found';
    avdSelect.appendChild(option);
    avdSelect.disabled = true;
    startBtn.disabled = true;
    placeholderTitle.textContent = 'No AVDs found';
    placeholderHint.textContent = 'Create one in Android Studio, then reopen this view.';
    setStatus('No AVDs available', 'error');
    return;
  }

  for (const name of names) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    avdSelect.appendChild(option);
  }
  avdSelect.disabled = false;
  startBtn.disabled = false;
  placeholderTitle.textContent = 'No emulator running';
  placeholderHint.textContent = `Press start to launch ${names[0]}.`;
}

avdSelect.addEventListener('change', () => {
  placeholderHint.textContent = `Press start to launch ${avdSelect.value}.`;
});

// --- controls -------------------------------------------------------------

startBtn.addEventListener('click', () => {
  if (!avdSelect.value || avdNames.length === 0) return;
  vscode.postMessage({ type: 'start', avdName: avdSelect.value });
});

stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
refreshBtn.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
logsBtn.addEventListener('click', () => vscode.postMessage({ type: 'showLogs' }));
fitHeightBtn.addEventListener('click', () => setViewMode('fitHeight'));
fitWidthBtn.addEventListener('click', () => setViewMode('fitWidth'));
zoomInBtn.addEventListener('click', () => stepZoom(1));
zoomOutBtn.addEventListener('click', () => stepZoom(-1));

canvas.addEventListener('click', (event) => {
  const rect = canvas.getBoundingClientRect();
  // Normalized so the extension can scale into full device resolution even
  // though the video is streamed at half size.
  vscode.postMessage({
    type: 'tap',
    nx: (event.clientX - rect.left) / rect.width,
    ny: (event.clientY - rect.top) / rect.height
  });
});

// --- extension messages ---------------------------------------------------

const LIVE_STATES = new Set(['STREAMING']);
const BUSY_STATES = new Set(['BOOTING_EMULATOR', 'BOOTED', 'STARTING_SERVER']);

function applyState(state) {
  const live = LIVE_STATES.has(state);
  stage.classList.toggle('stage--live', live);

  startBtn.disabled = live || BUSY_STATES.has(state) || avdNames.length === 0;
  stopBtn.disabled = !live && !BUSY_STATES.has(state);
  refreshBtn.disabled = !live;

  if (live) setStatus('Streaming', 'live');
  else if (BUSY_STATES.has(state)) setStatus('Starting…', 'busy');
  else if (state === 'STOPPED') setStatus('Stopped');
  else setStatus('Idle');

  if (!live) resetDecoder();
}

window.addEventListener('message', (event) => {
  const message = event.data;

  switch (message.type) {
    case 'avdList':
      renderAvdList(message.avds || []);
      break;
    case 'status':
      setStatus(message.message, message.kind);
      break;
    case 'state':
      applyState(message.state);
      break;
    case 'videoReset':
      resetDecoder();
      break;
    case 'video':
      if (message.data) onVideoBytes(base64ToBytes(message.data));
      break;
    case 'frame':
      if (message.data) {
        const img = new Image();
        img.onload = () => {
          if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
          }
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0);
          applyViewMode();
        };
        img.src = `data:image/png;base64,${message.data}`;
      }
      break;
    default:
      break;
  }
});

if (typeof VideoDecoder === 'undefined') {
  setStatus('WebCodecs unavailable — use Refresh', 'error');
}

applyViewMode();
vscode.postMessage({ type: 'ready' });
