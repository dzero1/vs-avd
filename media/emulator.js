const vscode = acquireVsCodeApi();

const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
const stage = document.getElementById('stage');
const screenFrame = document.getElementById('screenFrame');
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
const tools = document.getElementById('tools');
const toolsGrip = document.getElementById('toolsGrip');
const shotBtn = document.getElementById('shotBtn');
const rotateLeftBtn = document.getElementById('rotateLeftBtn');
const rotateRightBtn = document.getElementById('rotateRightBtn');
const extendedBtn = document.getElementById('extendedBtn');
const ext = document.getElementById('ext');
const extCloseBtn = document.getElementById('extCloseBtn');
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
  // On a narrow panel the chip collapses to its dot, so the text has to survive
  // as a tooltip or the status becomes unreadable.
  statusChip.title = text;
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

// Space actually available to the canvas: the stage's own padding plus the
// frame's transparent spacing border, which sits between the stage edge and the
// canvas. Missing the border made a fit overshoot by its two sides (36px) and
// leave the view permanently scrollable.
function stageBox() {
  const style = getComputedStyle(stage);
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);

  const frameStyle = getComputedStyle(screenFrame);
  const borderX = parseFloat(frameStyle.borderLeftWidth) + parseFloat(frameStyle.borderRightWidth);
  const borderY = parseFloat(frameStyle.borderTopWidth) + parseFloat(frameStyle.borderBottomWidth);

  return {
    width: Math.max(40, stage.clientWidth - padX - borderX),
    height: Math.max(40, stage.clientHeight - padY - borderY)
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
// Matches Android's default long_press_timeout, so the cursor cue appears at the
// same moment the device would begin treating the press as a long one.
const LONG_PRESS_MS = 400;

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
  pointer = {
    ...at,
    startX: at.nx,
    startY: at.ny,
    lastSent: 0,
    dragging: false,
    // How long the button stays down decides tap vs long press.
    downAt: performance.now()
  };

  // Nothing is sent until release, so without a cue a held press looks like the
  // view has frozen. The cursor change marks the moment it becomes a long press.
  pointer.holdTimer = setTimeout(() => {
    if (pointer && !pointer.dragging) canvas.classList.add('holding');
  }, LONG_PRESS_MS);
  canvas.setPointerCapture(event.pointerId);
  event.preventDefault();
});

canvas.addEventListener('pointermove', (event) => {
  if (!pointer) return;
  const at = normalize(event);
  const movedFar =
    Math.hypot(at.nx - pointer.startX, at.ny - pointer.startY) > DRAG_THRESHOLD;

  if (!pointer.dragging && !movedFar) return;
  if (!pointer.dragging) {
    canvas.classList.add('dragging');
    // Moving cancels the long press: this is a drag now.
    clearTimeout(pointer.holdTimer);
    canvas.classList.remove('holding');
    pointer.dragging = true;
    // Put the finger down where the press actually began, not where it is now,
    // so the gesture's direction and velocity match what the user did.
    vscode.postMessage({ type: 'gestureStart', nx: pointer.startX, ny: pointer.startY });
  }

  // One continuous gesture: the finger stays down and only moves. Chaining
  // separate swipes instead made each segment a complete touch that lifted at
  // the end, which Android read as a series of small flings — that is what made
  // a swipe-to-close in recents jump around.
  //
  // Moves are still throttled to the shell's round-trip so the queue cannot
  // grow faster than it drains, but a dropped move now costs only positional
  // detail rather than breaking the gesture apart.
  const now = performance.now();
  if (now - pointer.lastSent < DRAG_SEGMENT_MS) return;
  pointer.lastSent = now;

  vscode.postMessage({ type: 'gestureMove', nx: at.nx, ny: at.ny });
  pointer.nx = at.nx;
  pointer.ny = at.ny;
});

function endPointer(event) {
  if (!pointer) return;
  // Only the left button's release ends the gesture. pointerdown ignores the
  // other buttons, but pointerup did not, so clicking the middle (or right)
  // button while dragging released the pointer here and sent a phantom tap.
  if (event.button !== 0) return;
  clearTimeout(pointer.holdTimer);
  const at = normalize(event);

  if (pointer.dragging) {
    // Only the end point is sent: the extension interpolates the last stretch
    // into a burst of moves so the release carries enough velocity to fling.
    // Sending a separate final move here would consume that travel and leave the
    // burst with nothing to describe.
    vscode.postMessage({ type: 'gestureEnd', nx: at.nx, ny: at.ny });
  } else {
    // The device turns a held press into a long press itself, so just report
    // how long the button was actually down.
    vscode.postMessage({
      type: 'tap',
      nx: at.nx,
      ny: at.ny,
      holdMs: Math.round(performance.now() - pointer.downAt)
    });
  }

  pointer = undefined;
  canvas.classList.remove('dragging', 'holding');
  if (canvas.hasPointerCapture?.(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
}

canvas.addEventListener('pointerup', endPointer);

// A middle click otherwise triggers the browser's autoscroll and fires auxclick;
// neither means anything to the device, and both read as a stray interaction.
canvas.addEventListener('auxclick', (event) => event.preventDefault());
canvas.addEventListener('contextmenu', (event) => event.preventDefault());
canvas.addEventListener('pointercancel', () => {
  if (pointer) {
    clearTimeout(pointer.holdTimer);
    // Lift the finger, otherwise the device keeps tracking a touch that the
    // browser has already abandoned and later input goes nowhere.
    if (pointer.dragging) {
      vscode.postMessage({ type: 'gestureEnd', nx: pointer.nx, ny: pointer.ny });
    }
  }
  pointer = undefined;
  canvas.classList.remove('dragging', 'holding');
});

// Wheel scroll. Deltas are accumulated and flushed on a timer so a burst of
// wheel events becomes one gesture rather than a queue of competing swipes.
let wheelAccum = { dx: 0, dy: 0, nx: 0.5, ny: 0.5 };
let wheelTimer;

canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    // A wheel turn mid-drag would inject a separate swipe into the gesture that
    // is already in flight, so scrolling is ignored while a press is held. This
    // also covers a middle-button press that emits wheel events of its own.
    if (pointer) {
      vscode.postMessage({ type: 'logWheel', detail: 'ignored: press held' });
      return;
    }
    const at = normalize(event);
    // deltaMode 1 is lines, 2 is pages; normalize everything to rough pixels.
    const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
    wheelAccum.dx += event.deltaX * factor;
    wheelAccum.dy += event.deltaY * factor;
    wheelAccum.nx = at.nx;
    wheelAccum.ny = at.ny;

    vscode.postMessage({
      type: 'logWheel',
      detail:
        `event dy=${event.deltaY} dx=${event.deltaX} mode=${event.deltaMode} ` +
        `-> accum dy=${wheelAccum.dy.toFixed(1)} dx=${wheelAccum.dx.toFixed(1)}`
    });

    if (wheelTimer) return;
    wheelTimer = setTimeout(() => {
      wheelTimer = undefined;
      const { dx, dy, nx, ny } = wheelAccum;
      wheelAccum = { dx: 0, dy: 0, nx, ny };
      if (dx === 0 && dy === 0) return;
      // A scroll must never reach the device as a tap. Anything below this is
      // scaled up on the extension side to clear the platform's tap slop.
      if (Math.hypot(dx, dy) < 1) {
        vscode.postMessage({ type: 'logWheel', detail: `flush dropped: |delta|<1 (${dx}, ${dy})` });
        return;
      }
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

// --- floating tool panel --------------------------------------------------

// Confirms a fire-and-forget action (screenshot, rotate) visually, since those
// leave no lasting state on the button.
function flash(button) {
  button.classList.add('is-flash');
  setTimeout(() => button.classList.remove('is-flash'), 220);
}

shotBtn.addEventListener('click', () => {
  flash(shotBtn);
  vscode.postMessage({ type: 'screenshot' });
});

// Rotation is debounced: each rotate restarts the video segment, and stacking
// them mid-restart leaves the stream and the reported size out of sync.
let rotateLock = false;

function rotate(direction, button) {
  if (rotateLock) return;
  rotateLock = true;
  flash(button);
  vscode.postMessage({ type: 'rotate', direction });
  setTimeout(() => {
    rotateLock = false;
  }, 900);
}

rotateLeftBtn.addEventListener('click', () => rotate('left', rotateLeftBtn));
rotateRightBtn.addEventListener('click', () => rotate('right', rotateRightBtn));

// Drag the panel by its grip. Positions are clamped to the window so it can
// never be dropped somewhere unreachable.
let toolsDrag;

toolsGrip.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  const rect = tools.getBoundingClientRect();
  toolsDrag = {
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
    width: rect.width,
    height: rect.height
  };
  tools.classList.add('is-dragging');
  toolsGrip.setPointerCapture(event.pointerId);
  event.preventDefault();
});

toolsGrip.addEventListener('pointermove', (event) => {
  if (!toolsDrag) return;
  const maxLeft = Math.max(0, window.innerWidth - toolsDrag.width);
  const maxTop = Math.max(0, window.innerHeight - toolsDrag.height);
  const left = Math.min(Math.max(event.clientX - toolsDrag.offsetX, 0), maxLeft);
  const top = Math.min(Math.max(event.clientY - toolsDrag.offsetY, 0), maxTop);
  tools.style.left = `${Math.round(left)}px`;
  tools.style.top = `${Math.round(top)}px`;
});

function endToolsDrag(event) {
  if (!toolsDrag) return;
  toolsDrag = undefined;
  tools.classList.remove('is-dragging');
  if (toolsGrip.hasPointerCapture?.(event.pointerId)) {
    toolsGrip.releasePointerCapture(event.pointerId);
  }
}

toolsGrip.addEventListener('pointerup', endToolsDrag);
toolsGrip.addEventListener('pointercancel', endToolsDrag);

// The panel floats over the screen, so clicks on it must not reach the canvas
// underneath and register as taps on the device.
for (const element of [tools, ext]) {
  element.addEventListener('pointerdown', (event) => event.stopPropagation());
  element.addEventListener('wheel', (event) => event.stopPropagation());
}

// --- extended controls ----------------------------------------------------

function setExtOpen(open) {
  ext.classList.toggle('is-open', open);
  ext.setAttribute('aria-hidden', String(!open));
  extendedBtn.classList.toggle('toolbtn--on', open);
  extendedBtn.setAttribute('aria-expanded', String(open));
}

extendedBtn.addEventListener('click', () => setExtOpen(!ext.classList.contains('is-open')));
extCloseBtn.addEventListener('click', () => setExtOpen(false));

// Escape closes the drawer. Captured on the window because the stage's own
// keydown handler forwards Escape to the device as KEYCODE_BACK.
window.addEventListener(
  'keydown',
  (event) => {
    if (event.key === 'Escape' && ext.classList.contains('is-open')) {
      setExtOpen(false);
      event.stopPropagation();
      event.preventDefault();
    }
  },
  true
);

// Console commands go out through the extension, which validates every argument
// before it reaches a process.
function emu(args, label, freeText) {
  vscode.postMessage({ type: 'emu', args, label, freeText });
}

// -- battery
const battLevel = document.getElementById('battLevel');
const battLevelOut = document.getElementById('battLevelOut');
const battStatus = document.getElementById('battStatus');
const battHealth = document.getElementById('battHealth');

// The slider fires continuously while dragging, so the label updates live but
// the console call waits for the release ('change').
battLevel.addEventListener('input', () => {
  battLevelOut.textContent = `${battLevel.value}%`;
});
battLevel.addEventListener('change', () => {
  emu(['power', 'capacity', battLevel.value], `Battery ${battLevel.value}%`);
});

battStatus.addEventListener('change', () => {
  // `power ac on|off` drives the charger icon; `power status` sets what the
  // battery service reports, and the two have to agree.
  const value = battStatus.value;
  emu(['power', 'ac', value === 'none' ? 'off' : 'on'], 'Charger');
  emu(['power', 'status', value === 'none' ? 'not-charging' : 'charging'], 'Charger');
});

battHealth.addEventListener('change', () => {
  emu(['power', 'health', battHealth.value], 'Battery health');
});

// -- cellular
const netType = document.getElementById('netType');
const netStatus = document.getElementById('netStatus');
const netSignal = document.getElementById('netSignal');
const netSignalOut = document.getElementById('netSignalOut');

const SIGNAL_LABELS = ['None', 'Poor', 'Moderate', 'Good', 'Great'];

netType.addEventListener('change', () => {
  emu(['network', 'speed', netType.value], 'Network type');
});

netStatus.addEventListener('change', () => {
  // The console needs an explicit register: a bare `gsm <state>` is rejected as
  // a bad sub-command. Voice and data are set together so the status the panel
  // reports matches both.
  emu(['gsm', 'voice', netStatus.value], 'Voice status');
  emu(['gsm', 'data', netStatus.value], 'Data status');
});

netSignal.addEventListener('input', () => {
  netSignalOut.textContent = SIGNAL_LABELS[Number(netSignal.value)];
});
netSignal.addEventListener('change', () => {
  // gsm signal-profile takes 0-4, matching the slider directly.
  emu(['gsm', 'signal-profile', netSignal.value], 'Signal strength');
});

// -- location
const locLat = document.getElementById('locLat');
const locLng = document.getElementById('locLng');
const locAlt = document.getElementById('locAlt');
const locSendBtn = document.getElementById('locSendBtn');

// Console arguments are restricted to a strict alphabet upstream, so
// coordinates are validated here to give a useful message instead of a
// silent drop.
function numberField(input, min, max) {
  const value = Number(input.value.trim());
  const ok = Number.isFinite(value) && value >= min && value <= max;
  input.setCustomValidity(ok ? '' : `Enter a number between ${min} and ${max}`);
  return ok ? value : undefined;
}

locSendBtn.addEventListener('click', () => {
  const lat = numberField(locLat, -90, 90);
  const lng = numberField(locLng, -180, 180);
  const alt = numberField(locAlt, -500, 10000);
  if (lat === undefined || lng === undefined || alt === undefined) {
    setStatus('Enter a valid latitude, longitude and altitude', 'error');
    return;
  }
  // `geo fix` takes longitude first.
  emu(['geo', 'fix', String(lng), String(lat), String(alt)], 'Location');
});

// -- phone
const phoneNumber = document.getElementById('phoneNumber');
const smsBody = document.getElementById('smsBody');
const callBtn = document.getElementById('callBtn');
const callEndBtn = document.getElementById('callEndBtn');
const smsBtn = document.getElementById('smsBtn');

function phoneField() {
  const value = phoneNumber.value.trim();
  const ok = /^[+\d][\d]{1,19}$/.test(value);
  phoneNumber.setCustomValidity(ok ? '' : 'Enter a phone number (digits, optional leading +)');
  if (!ok) setStatus('Enter a valid phone number', 'error');
  return ok ? value : undefined;
}

callBtn.addEventListener('click', () => {
  const number = phoneField();
  if (number) emu(['gsm', 'call', number], 'Incoming call');
});

callEndBtn.addEventListener('click', () => {
  const number = phoneField();
  if (number) emu(['gsm', 'cancel', number], 'End call');
});

smsBtn.addEventListener('click', () => {
  const number = phoneField();
  if (!number) return;
  const body = smsBody.value.trim();
  if (!body) {
    setStatus('Enter a message to send', 'error');
    return;
  }
  // The body goes as free text; the extension appends it as a single trailing
  // argument so spaces and punctuation survive intact.
  emu(['sms', 'send', number], 'SMS', body);
});

// -- fingerprint
const fingerId = document.getElementById('fingerId');
const fingerTouchBtn = document.getElementById('fingerTouchBtn');

fingerTouchBtn.addEventListener('click', () => {
  emu(['finger', 'touch', fingerId.value], 'Fingerprint');
  // The sensor expects a release, otherwise the finger reads as still held.
  setTimeout(() => emu(['finger', 'remove'], 'Fingerprint'), 350);
});

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

  // Every tool acts on a running device, so the whole panel and drawer go
  // inert together; the drawer also closes so it isn't left over a dead screen.
  for (const button of [shotBtn, rotateLeftBtn, rotateRightBtn, extendedBtn]) {
    button.disabled = !live;
  }
  // The close button is excluded: disabling it would trap an open drawer.
  for (const control of ext.querySelectorAll('.ext__body input, .ext__body select, .ext__body button')) {
    control.disabled = !live;
  }
  if (!live) setExtOpen(false);

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
    case 'rotation':
      // A landscape stream is wider than it is tall, so a height-fit view would
      // leave it tiny; switch the fit axis to match the new aspect.
      if (viewMode === 'fitHeight' || viewMode === 'fitWidth') {
        setViewMode(message.rotation === 1 || message.rotation === 3 ? 'fitWidth' : 'fitHeight');
      }
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
