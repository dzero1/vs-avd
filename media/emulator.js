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
  const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
  vscode.postMessage({ type: 'tap', x, y });
});

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'status') {
    statusEl.textContent = message.message;
  }
  if (message.type === 'state') {
    statusEl.textContent = `State: ${message.state}`;
  }
  if (message.type === 'log' && message.message) {
    appendLog(message.message);
  }
  if (message.type === 'frame' && message.data) {
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    img.src = `data:image/png;base64,${message.data}`;
  }
});

appendLog('Extension ready. Click Start to launch the emulator.');
