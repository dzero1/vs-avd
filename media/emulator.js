const vscode = acquireVsCodeApi();
const canvas = document.getElementById('screen');
const statusEl = document.getElementById('status');
const avdInput = document.getElementById('avdName');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const refreshBtn = document.getElementById('refreshBtn');
const logOutput = document.getElementById('logOutput');
const ctx = canvas.getContext('2d');

function appendLog(message) {
  const line = document.createElement('div');
  line.textContent = message;
  logOutput.appendChild(line);
  logOutput.scrollTop = logOutput.scrollHeight;
}

// --- H.264 decoding -------------------------------------------------------
// screenrecord writes an Annex-B stream to a pipe, so chunk boundaries are
// arbitrary. Accumulate bytes and cut them into access units on start codes.

let decoder;
let pending = new Uint8Array(0);
let waitingForKeyframe = true;
let decodeErrors = 0;

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
      }
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      frame.close();
    },
    error: (error) => {
      decodeErrors += 1;
      appendLog(`Decoder error: ${error.message}`);
      // Rebuild on the next keyframe rather than staying wedged.
      resetDecoder();
    }
  });

  // Annex-B elementary stream: no avcC description, so SPS/PPS must arrive
  // inline ahead of the first keyframe.
  decoder.configure({
    codec: 'avc1.42c02a',
    optimizeForLatency: true
  });

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
}

// Group NALs into access units. SPS(7)/PPS(8) are prepended to the keyframe
// that follows them so the decoder gets its parameter sets in one chunk.
let accessUnit = [];
let accessUnitIsKey = false;

function flushAccessUnit() {
  if (accessUnit.length === 0) return;

  let total = 0;
  for (const nal of accessUnit) total += nal.length;
  const data = new Uint8Array(total);
  let offset = 0;
  for (const nal of accessUnit) {
    data.set(nal, offset);
    offset += nal.length;
  }

  accessUnit = [];
  const isKey = accessUnitIsKey;
  accessUnitIsKey = false;

  if (waitingForKeyframe && !isKey) return;
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
    appendLog(`Decode failed: ${error.message}`);
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
      if (type === 5) accessUnitIsKey = true;
      flushAccessUnit();
    } else {
      if (type === 7 || type === 8) accessUnitIsKey = true;
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

// --- input ----------------------------------------------------------------

startBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'start', avdName: avdInput.value.trim() });
});

stopBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'stop' });
});

refreshBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'refresh' });
});

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

window.addEventListener('message', (event) => {
  const message = event.data;

  if (message.type === 'status') {
    statusEl.textContent = message.message;
  }
  if (message.type === 'state') {
    statusEl.textContent = `State: ${message.state}`;
    if (message.state === 'STOPPED' || message.state === 'IDLE') resetDecoder();
  }
  if (message.type === 'log' && message.message) {
    appendLog(message.message);
  }
  if (message.type === 'videoReset') {
    resetDecoder();
  }
  if (message.type === 'video' && message.data) {
    onVideoBytes(base64ToBytes(message.data));
  }
  if (message.type === 'frame' && message.data) {
    const img = new Image();
    img.onload = () => {
      if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
    };
    img.src = `data:image/png;base64,${message.data}`;
  }
});

if (typeof VideoDecoder === 'undefined') {
  appendLog('WebCodecs is unavailable in this webview; falling back to Refresh screenshots.');
} else {
  appendLog('Extension ready. Click Start to launch the emulator.');
}

vscode.postMessage({ type: 'ready' });
