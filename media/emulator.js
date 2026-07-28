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
const navBackBtn = document.getElementById('navBackBtn');
const navHomeBtn = document.getElementById('navHomeBtn');
const navRecentsBtn = document.getElementById('navRecentsBtn');
const fitHeightBtn = document.getElementById('fitHeightBtn');
const fitWidthBtn = document.getElementById('fitWidthBtn');
const zoomInBtn = document.getElementById('zoomInBtn');
const zoomOutBtn = document.getElementById('zoomOutBtn');
const zoomLabel = document.getElementById('zoomLabel');
const placeholderTitle = document.getElementById('placeholderTitle');
const placeholderHint = document.getElementById('placeholderHint');
const loaderTitle = document.getElementById('loaderTitle');
const loaderFill = document.getElementById('loaderFill');
const loaderSteps = document.getElementById('loaderSteps');
const loaderElapsed = document.getElementById('loaderElapsed');

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

// --- boot progress --------------------------------------------------------
// Phases arrive from the extension as they actually occur. 'shell' and
// 'booting' share a step because a warm snapshot resume skips straight past
// them, and showing a step that never lights up looks broken.
const BOOT_ORDER = ['starting', 'connected', 'shell', 'booting', 'streaming'];
const BOOT_LABELS = {
  starting: 'Starting emulator…',
  connected: 'Connecting over adb…',
  shell: 'Waiting for the device shell…',
  booting: 'Booting Android…',
  booted: 'Boot complete…',
  streaming: 'Starting the video stream…'
};

let bootStartedAt;
let bootTicker;

function stepIndex(phase) {
  // 'booted' is a transient milestone between booting and streaming.
  if (phase === 'booted') return BOOT_ORDER.indexOf('booting');
  return BOOT_ORDER.indexOf(phase);
}

function showLoader(phase) {
  stage.classList.add('stage--booting');
  if (!bootStartedAt) {
    bootStartedAt = performance.now();
    // A cold boot can run 30-45s, so a running clock reassures that the wait is
    // progressing even while one phase is stuck.
    bootTicker = setInterval(() => {
      const seconds = Math.round((performance.now() - bootStartedAt) / 1000);
      loaderElapsed.textContent = seconds >= 3 ? `${seconds}s elapsed` : '';
    }, 500);
  }

  loaderTitle.textContent = BOOT_LABELS[phase] || 'Starting…';

  const active = stepIndex(phase);
  const items = [...loaderSteps.children];
  items.forEach((item, index) => {
    item.classList.toggle('is-done', index < active);
    item.classList.toggle('is-active', index === active);
  });

  // Progress reflects the furthest phase reached, not elapsed time.
  const ratio = (active + 1) / (BOOT_ORDER.length + 1);
  loaderFill.style.width = `${Math.round(ratio * 100)}%`;
}

function hideLoader() {
  stage.classList.remove('stage--booting');
  if (bootTicker) {
    clearInterval(bootTicker);
    bootTicker = undefined;
  }
  bootStartedAt = undefined;
  loaderElapsed.textContent = '';
  loaderFill.style.width = '0%';
  for (const item of loaderSteps.children) {
    item.classList.remove('is-done', 'is-active');
  }
}

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
  // Show the loader on click rather than waiting for the first boot message, so
  // the button press has immediate feedback.
  showLoader('starting');
  startBtn.disabled = true;
  vscode.postMessage({ type: 'start', avdName: avdSelect.value });
});

stopBtn.addEventListener('click', () => {
  hideLoader();
  vscode.postMessage({ type: 'stop' });
});
refreshBtn.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
logsBtn.addEventListener('click', () => vscode.postMessage({ type: 'showLogs' }));
fitHeightBtn.addEventListener('click', () => setViewMode('fitHeight'));
fitWidthBtn.addEventListener('click', () => setViewMode('fitWidth'));
zoomInBtn.addEventListener('click', () => stepZoom(1));
zoomOutBtn.addEventListener('click', () => stepZoom(-1));

const navKey = (keycode) => () => vscode.postMessage({ type: 'key', keycode, meta: [] });
navBackBtn.addEventListener('click', navKey('KEYCODE_BACK'));
navHomeBtn.addEventListener('click', navKey('KEYCODE_HOME'));
navRecentsBtn.addEventListener('click', navKey('KEYCODE_APP_SWITCH'));

// --- pointer input --------------------------------------------------------
// Coordinates are normalized 0..1 so the extension can scale them into full
// device space regardless of the stream or zoom scale.

const DRAG_THRESHOLD = 0.012; // fraction of the screen before a press is a drag
const DRAG_SEGMENT_MS = 90; // matches measured shell round-trip; shorter just queues

let pointer;

function normalize(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    nx: (event.clientX - rect.left) / rect.width,
    ny: (event.clientY - rect.top) / rect.height
  };
}

canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  const at = normalize(event);
  pointer = { ...at, startX: at.nx, startY: at.ny, lastSent: 0, dragging: false };
  canvas.setPointerCapture(event.pointerId);
  event.preventDefault();
});

canvas.addEventListener('pointermove', (event) => {
  if (!pointer) return;
  const at = normalize(event);
  const movedFar =
    Math.hypot(at.nx - pointer.startX, at.ny - pointer.startY) > DRAG_THRESHOLD;

  if (!pointer.dragging && !movedFar) return;
  if (!pointer.dragging) canvas.classList.add('dragging');
  pointer.dragging = true;

  // Emit the drag as a chain of short native swipes. Throttling to the shell's
  // real round-trip keeps the queue from growing faster than it drains.
  const now = performance.now();
  if (now - pointer.lastSent < DRAG_SEGMENT_MS) return;
  pointer.lastSent = now;

  vscode.postMessage({
    type: 'swipe',
    nx1: pointer.nx,
    ny1: pointer.ny,
    nx2: at.nx,
    ny2: at.ny,
    duration: DRAG_SEGMENT_MS
  });
  pointer.nx = at.nx;
  pointer.ny = at.ny;
});

function endPointer(event) {
  if (!pointer) return;
  const at = normalize(event);

  if (pointer.dragging) {
    // Flush whatever is left so the gesture ends where the mouse actually is.
    if (at.nx !== pointer.nx || at.ny !== pointer.ny) {
      vscode.postMessage({
        type: 'swipe',
        nx1: pointer.nx,
        ny1: pointer.ny,
        nx2: at.nx,
        ny2: at.ny,
        duration: DRAG_SEGMENT_MS
      });
    }
  } else {
    vscode.postMessage({ type: 'tap', nx: at.nx, ny: at.ny });
  }

  pointer = undefined;
  canvas.classList.remove('dragging');
  if (canvas.hasPointerCapture?.(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
}

canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', () => {
  pointer = undefined;
  canvas.classList.remove('dragging');
});

// Wheel scroll. Deltas are accumulated and flushed on a timer so a burst of
// wheel events becomes one gesture rather than a queue of competing swipes.
let wheelAccum = { dx: 0, dy: 0, nx: 0.5, ny: 0.5 };
let wheelTimer;

canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const at = normalize(event);
    // deltaMode 1 is lines, 2 is pages; normalize everything to rough pixels.
    const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
    wheelAccum.dx += event.deltaX * factor;
    wheelAccum.dy += event.deltaY * factor;
    wheelAccum.nx = at.nx;
    wheelAccum.ny = at.ny;

    if (wheelTimer) return;
    wheelTimer = setTimeout(() => {
      wheelTimer = undefined;
      const { dx, dy, nx, ny } = wheelAccum;
      wheelAccum = { dx: 0, dy: 0, nx, ny };
      if (dx === 0 && dy === 0) return;
      // Scale up: a wheel notch should move more than its pixel delta suggests.
      vscode.postMessage({ type: 'scroll', nx, ny, dx: dx * 2.5, dy: dy * 2.5 });
    }, 60);
  },
  { passive: false }
);

// --- keyboard input -------------------------------------------------------

// Keys that must go through `input keyevent` rather than `input text`.
const KEYCODES = {
  Enter: 'KEYCODE_ENTER',
  Backspace: 'KEYCODE_DEL',
  Delete: 'KEYCODE_FORWARD_DEL',
  Tab: 'KEYCODE_TAB',
  Escape: 'KEYCODE_BACK',
  ArrowUp: 'KEYCODE_DPAD_UP',
  ArrowDown: 'KEYCODE_DPAD_DOWN',
  ArrowLeft: 'KEYCODE_DPAD_LEFT',
  ArrowRight: 'KEYCODE_DPAD_RIGHT',
  Home: 'KEYCODE_MOVE_HOME',
  End: 'KEYCODE_MOVE_END',
  PageUp: 'KEYCODE_PAGE_UP',
  PageDown: 'KEYCODE_PAGE_DOWN'
};

function metaOf(event) {
  const meta = [];
  if (event.ctrlKey) meta.push('CTRL_LEFT');
  if (event.altKey) meta.push('ALT_LEFT');
  if (event.shiftKey) meta.push('SHIFT_LEFT');
  if (event.metaKey) meta.push('META_LEFT');
  return meta;
}

// Buffer printable characters so fast typing becomes one `input text` call
// instead of one shell command per keystroke.
let textBuffer = '';
let textTimer;

function flushText() {
  textTimer = undefined;
  if (!textBuffer) return;
  vscode.postMessage({ type: 'text', text: textBuffer });
  textBuffer = '';
}

function queueText(char) {
  textBuffer += char;
  if (!textTimer) textTimer = setTimeout(flushText, 40);
}

stage.addEventListener('keydown', (event) => {
  if (!stage.classList.contains('stage--live')) return;

  const mapped = KEYCODES[event.key];
  const meta = metaOf(event);

  if (mapped) {
    flushText();
    vscode.postMessage({ type: 'key', keycode: mapped, meta });
    event.preventDefault();
    return;
  }

  // A printable key with a modifier held is a shortcut, not text.
  if (event.key.length === 1 && (event.ctrlKey || event.altKey || event.metaKey)) {
    flushText();
    const upper = event.key.toUpperCase();
    if (/^[A-Z0-9]$/.test(upper)) {
      vscode.postMessage({ type: 'key', keycode: `KEYCODE_${upper}`, meta });
      event.preventDefault();
    }
    return;
  }

  if (event.key.length === 1) {
    queueText(event.key);
    event.preventDefault();
  }
});

// The stage needs focus to receive keys; clicking the screen gives it focus.
canvas.addEventListener('pointerdown', () => stage.focus());

// --- extension messages ---------------------------------------------------

const LIVE_STATES = new Set(['STREAMING']);
const BUSY_STATES = new Set(['BOOTING_EMULATOR', 'BOOTED', 'STARTING_SERVER']);

function applyState(state) {
  const live = LIVE_STATES.has(state);
  stage.classList.toggle('stage--live', live);

  // Streaming means the first frame is on its way; anything that is not a boot
  // state (STOPPED after a failure, IDLE) must also clear the loader.
  if (!BUSY_STATES.has(state)) hideLoader();

  startBtn.disabled = live || BUSY_STATES.has(state) || avdNames.length === 0;
  stopBtn.disabled = !live && !BUSY_STATES.has(state);
  refreshBtn.disabled = !live;
  for (const button of [navBackBtn, navHomeBtn, navRecentsBtn]) {
    button.disabled = !live;
  }
  if (live) stage.focus();

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
    case 'boot':
      showLoader(message.phase);
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
