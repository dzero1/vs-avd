import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

type SessionState = 'IDLE' | 'BOOTING_EMULATOR' | 'BOOTED' | 'STARTING_SERVER' | 'STREAMING' | 'STOPPED';

// Ordered boot milestones surfaced to the webview's progress loader.
type BootPhase = 'starting' | 'connected' | 'shell' | 'booting' | 'booted' | 'streaming';

const BOOT_TIMEOUT_MS = 180_000;

// screenrecord caps every session at 180s, so the stream is relaunched in a
// loop. Each relaunch emits a fresh SPS/PPS + keyframe, which the decoder needs.
const STREAM_SEGMENT_SECONDS = 170;
const STREAM_BITRATE = 8_000_000;

class EmulatorSession {
  private state: SessionState = 'IDLE';
  private emulatorProcess: cp.ChildProcess | undefined;
  private streamProcess: cp.ChildProcess | undefined;
  private streamGeneration = 0;
  private screenSize: { width: number; height: number } | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private avdName = '';
  private readonly outputChannel: vscode.OutputChannel;

  // One long-lived `adb shell` fed over stdin. Spawning a process per event
  // costs 70-145ms, which makes drag and scroll unusable; reusing a shell drops
  // that to ~50ms and lets a whole gesture go out in one write.
  private inputShell: cp.ChildProcess | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel('Android Emulator Viewer');
  }

  public async open(panel: vscode.WebviewPanel): Promise<void> {
    this.panel = panel;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };

    panel.webview.html = this.getWebviewContent(panel.webview);
    panel.webview.onDidReceiveMessage((message) => this.handleMessage(message));
    panel.onDidDispose(() => this.dispose());
    this.setState('IDLE');
  }

  public dispose(): void {
    void this.stop();
    this.outputChannel.dispose();
    this.panel = undefined;
  }

  private getWebviewContent(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'emulator.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'emulator.js'));
    const htmlPath = path.join(this.context.extensionPath, 'media', 'emulator.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replaceAll('{{styleUri}}', styleUri.toString());
    html = html.replaceAll('{{scriptUri}}', scriptUri.toString());
    html = html.replaceAll('{{cspSource}}', webview.cspSource);
    return html;
  }

  private async handleMessage(message: any): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.sendAvdList();
        this.setState(this.state);
        break;
      case 'start':
        await this.start(message.avdName);
        break;
      case 'stop':
        await this.stop();
        break;
      case 'tap':
        this.tap(message.nx, message.ny);
        break;
      case 'swipe':
        this.swipe(message.nx1, message.ny1, message.nx2, message.ny2, message.duration);
        break;
      case 'scroll':
        this.scroll(message.nx, message.ny, message.dx, message.dy);
        break;
      case 'key':
        this.keyEvent(message.keycode, message.meta);
        break;
      case 'text':
        this.inputText(message.text);
        break;
      case 'refresh':
        await this.captureFrame();
        break;
      case 'showLogs':
        this.outputChannel.show(true);
        break;
      case 'requestKeyframe':
        // screenrecord only emits an IDR when a segment starts, so the only way
        // to force one is to restart the capture.
        this.restartVideoStream();
        break;
      default:
        break;
    }
  }

  public async start(avdName: string): Promise<void> {
    if (!avdName) {
      this.log('No AVD name provided.');
      vscode.window.showErrorMessage('Please provide an AVD name.');
      return;
    }

    this.avdName = avdName;
    if (this.panel) {
      this.panel.title = avdName;
    }
    this.setState('BOOTING_EMULATOR');
    this.log(`Starting emulator for AVD: ${avdName}`);
    this.sendToWebview({ type: 'status', message: `Launching ${avdName}…`, kind: 'busy' });

    try {
      this.emulatorProcess = cp.spawn('emulator', [
        '-avd',
        avdName,
        '-no-window',
        '-no-audio',
        '-no-boot-anim',
        '-gpu',
        'swiftshader_indirect'
      ], {
        stdio: 'ignore'
      });

      this.emulatorProcess.once('spawn', () => {
        this.log(`Emulator process spawned for ${avdName}`);
      });

      this.emulatorProcess.on('exit', (code, signal) => {
        this.log(`Emulator process exited with code ${code ?? 'n/a'} and signal ${signal ?? 'n/a'}`);
        if (this.state !== 'STOPPED') {
          this.setState('STOPPED');
        }
      });

      this.emulatorProcess.on('error', (error) => {
        this.log(`Emulator launch failed: ${error.message}`);
        vscode.window.showErrorMessage(`Unable to start emulator: ${error.message}`);
        this.setState('STOPPED');
      });

      await this.waitForBoot();
      this.screenSize = await this.detectScreenSize();
      this.reportBootProgress('streaming');
      this.setState('STREAMING');
      this.log('Emulator finished booting and streaming has started.');
      this.sendToWebview({ type: 'status', message: `Streaming ${this.avdName}`, kind: 'live' });
      this.startVideoStream();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Start failed: ${message}`);
      vscode.window.showErrorMessage(message);
      this.setState('STOPPED');
    }
  }

  // Boot goes through observable phases, so the webview gets real milestones
  // rather than an indeterminate spinner. A warm snapshot resume reaches
  // 'booted' in ~5s; a cold boot takes 30-45s, which is what the loader is for.
  private reportBootProgress(phase: BootPhase, detail?: string): void {
    this.sendToWebview({ type: 'boot', phase, detail });
  }

  private async waitForBoot(): Promise<void> {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    let sawDevice = false;
    let sawShell = false;

    this.reportBootProgress('starting');

    for (let attempt = 0; Date.now() < deadline; attempt += 1) {
      if (!sawDevice) {
        const devices = await this.runAdb(['devices']).catch(() => undefined);
        if (devices?.stdout.includes('emulator-')) {
          sawDevice = true;
          this.log('adb lists the emulator.');
          this.reportBootProgress('connected');
        }
      }

      if (sawDevice && !sawShell) {
        const echo = await this.runAdb(['shell', 'echo', 'ok']).catch(() => undefined);
        if (echo?.stdout.trim() === 'ok') {
          sawShell = true;
          this.log('Device shell is responding.');
          this.reportBootProgress('shell');
        }
      }

      if (sawShell) {
        const result = await this.runAdb(['shell', 'getprop', 'sys.boot_completed']).catch(() => undefined);
        const value = result?.stdout.trim();
        this.log(`Boot completion check: ${value || '<empty>'}`);
        if (value === '1') {
          this.log('Boot completed successfully.');
          this.reportBootProgress('booted');
          return;
        }
      }

      // Report elapsed time so a long cold boot still looks like it is moving.
      const elapsed = Math.round((BOOT_TIMEOUT_MS - (deadline - Date.now())) / 1000);
      this.reportBootProgress(sawShell ? 'booting' : sawDevice ? 'shell' : 'starting', `${elapsed}s`);
      await this.delay(1500);
    }

    throw new Error('Timed out waiting for the Android emulator to finish booting.');
  }

  // The webview owns AVD selection, so the list is pushed to it on ready
  // instead of going through a modal QuickPick.
  private async sendAvdList(): Promise<void> {
    try {
      const result = await runCommand('emulator', ['-list-avds']);
      const avds = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      this.log(avds.length ? `Found AVDs: ${avds.join(', ')}` : 'No AVDs found.');
      this.sendToWebview({ type: 'avdList', avds });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Unable to list AVDs: ${message}`);
      this.sendToWebview({ type: 'avdList', avds: [] });
      this.sendToWebview({
        type: 'status',
        message: 'emulator CLI not found on PATH',
        kind: 'error'
      });
    }
  }

  private async detectScreenSize(): Promise<{ width: number; height: number } | undefined> {
    try {
      const result = await this.runAdb(['shell', 'wm', 'size']);
      const match = /(\d+)x(\d+)/.exec(result.stdout);
      if (match) {
        const size = { width: Number(match[1]), height: Number(match[2]) };
        this.log(`Detected device resolution ${size.width}x${size.height}`);
        return size;
      }
    } catch (error) {
      this.log(`Unable to detect screen size: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  }

  // Stream half-resolution video: the decoder scales it back up for display and
  // it roughly quarters the bitrate, which matters most on the emulator's
  // software encoder. Tap coordinates stay in full device space.
  private streamSize(): string | undefined {
    if (!this.screenSize) {
      return undefined;
    }
    const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
    return `${even(this.screenSize.width / 2)}x${even(this.screenSize.height / 2)}`;
  }

  private startVideoStream(): void {
    const generation = (this.streamGeneration += 1);

    const spawnSegment = () => {
      if (this.state !== 'STREAMING' || generation !== this.streamGeneration) {
        return;
      }

      const size = this.streamSize();
      const args = [
        'exec-out',
        'screenrecord',
        '--output-format=h264',
        `--time-limit=${STREAM_SEGMENT_SECONDS}`,
        `--bit-rate=${STREAM_BITRATE}`,
        ...(size ? [`--size=${size}`] : []),
        '-'
      ];

      this.log(`Starting video segment: adb ${args.join(' ')}`);
      const child = cp.spawn('adb', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.streamProcess = child;

      child.stdout.on('data', (chunk: Buffer) => {
        this.sendToWebview({ type: 'video', data: chunk.toString('base64') });
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) {
          this.log(`screenrecord: ${text}`);
        }
      });

      child.on('error', (error) => {
        this.log(`Video stream failed: ${error.message}`);
        this.sendToWebview({ type: 'status', message: `Video stream failed: ${error.message}`, kind: 'error' });
      });

      child.on('close', (code) => {
        if (generation !== this.streamGeneration || this.state !== 'STREAMING') {
          return;
        }
        this.log(`Video segment ended (code ${code ?? 'n/a'}); starting the next one.`);
        // A new segment restarts the H.264 stream, so the webview must reset its
        // decoder before the fresh SPS/PPS arrives.
        this.sendToWebview({ type: 'videoReset' });
        spawnSegment();
      });
    };

    spawnSegment();
  }

  private stopVideoStream(): void {
    this.streamGeneration += 1;
    if (this.streamProcess && !this.streamProcess.killed) {
      this.streamProcess.kill();
    }
    this.streamProcess = undefined;
  }

  // Forces a fresh SPS/PPS + IDR by starting a new capture segment. Used when
  // the webview reports it is stuck without a decodable keyframe.
  private restartVideoStream(): void {
    if (this.state !== 'STREAMING') {
      return;
    }
    this.log('Restarting video stream to obtain a keyframe.');
    this.stopVideoStream();
    this.sendToWebview({ type: 'videoReset' });
    this.startVideoStream();
  }

  private async captureFrame(): Promise<void> {
    try {
      const imageBuffer = await this.runAdbBuffer(['exec-out', 'screencap', '-p']);
      this.sendToWebview({ type: 'frame', data: imageBuffer.toString('base64') });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Screenshot capture failed: ${message}`);
      this.sendToWebview({ type: 'status', message: `Screenshot refresh failed: ${message}`, kind: 'error' });
    }
  }

  // --- input ---------------------------------------------------------------

  private ensureInputShell(): cp.ChildProcess | undefined {
    if (this.inputShell && !this.inputShell.killed && this.inputShell.stdin?.writable) {
      return this.inputShell;
    }

    const shell = cp.spawn('adb', ['shell'], { stdio: ['pipe', 'ignore', 'pipe'] });
    shell.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        this.log(`input shell: ${text}`);
      }
    });
    shell.on('error', (error: Error) => this.log(`Input shell failed: ${error.message}`));
    shell.on('close', () => {
      if (this.inputShell === shell) {
        this.inputShell = undefined;
      }
    });

    this.inputShell = shell;
    this.log('Opened persistent adb shell for input.');
    return shell;
  }

  private stopInputShell(): void {
    if (this.inputShell && !this.inputShell.killed) {
      this.inputShell.stdin?.write('exit\n');
      this.inputShell.kill();
    }
    this.inputShell = undefined;
  }

  // Commands go out over the shared shell; a failed write falls back to a
  // one-shot `adb shell` so a dead shell never silently swallows input.
  private sendInput(commands: string[]): void {
    if (this.state !== 'STREAMING' || commands.length === 0) {
      return;
    }

    const shell = this.ensureInputShell();
    const payload = `${commands.join('\n')}\n`;

    if (!shell?.stdin?.writable || !shell.stdin.write(payload)) {
      this.log('Input shell unavailable; falling back to one-shot adb.');
      for (const command of commands) {
        void this.runAdb(['shell', command]).catch((error) =>
          this.log(`Input fallback failed: ${error instanceof Error ? error.message : String(error)}`)
        );
      }
    }
  }

  // Normalized 0..1 -> full device pixels, so a half-resolution video stream
  // still hits the right spot.
  private toDevice(nx: number, ny: number): { x: number; y: number } {
    const size = this.screenSize ?? { width: 1080, height: 2340 };
    return {
      x: Math.round(Math.min(Math.max(nx, 0), 1) * size.width),
      y: Math.round(Math.min(Math.max(ny, 0), 1) * size.height)
    };
  }

  private tap(nx: number, ny: number): void {
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
      return;
    }
    const { x, y } = this.toDevice(nx, ny);
    this.log(`tap (${x}, ${y})`);
    this.sendInput([`input tap ${x} ${y}`]);
  }

  // `input swipe` is one native gesture with real fling physics, so a drag maps
  // to it directly rather than to a stream of synthetic motion events.
  private swipe(nx1: number, ny1: number, nx2: number, ny2: number, durationMs: number): void {
    if (![nx1, ny1, nx2, ny2].every(Number.isFinite)) {
      return;
    }
    const from = this.toDevice(nx1, ny1);
    const to = this.toDevice(nx2, ny2);
    const duration = Math.round(Math.min(Math.max(durationMs || 0, 20), 2000));
    this.log(`swipe (${from.x}, ${from.y}) -> (${to.x}, ${to.y}) in ${duration}ms`);
    this.sendInput([`input swipe ${from.x} ${from.y} ${to.x} ${to.y} ${duration}`]);
  }

  private scroll(nx: number, ny: number, dx: number, dy: number): void {
    if (![nx, ny, dx, dy].every(Number.isFinite)) {
      return;
    }
    const { x, y } = this.toDevice(nx, ny);
    const size = this.screenSize ?? { width: 1080, height: 2340 };
    // A wheel notch moves the content, so the finger travels the opposite way.
    const travelX = Math.round(Math.min(Math.max(-dx, -size.width), size.width));
    const travelY = Math.round(Math.min(Math.max(-dy, -size.height), size.height));
    const endX = Math.min(Math.max(x + travelX, 0), size.width);
    const endY = Math.min(Math.max(y + travelY, 0), size.height);
    this.log(`scroll at (${x}, ${y}) by (${travelX}, ${travelY})`);
    this.sendInput([`input swipe ${x} ${y} ${endX} ${endY} 80`]);
  }

  private keyEvent(keycode: string, meta: string[] | undefined): void {
    // Keycodes and meta names come from the webview, so restrict them to the
    // KEYCODE_* / bare-name alphabet before they reach a shell.
    const safe = (value: string) => /^[A-Z0-9_]{1,32}$/.test(value);
    if (!keycode || !safe(keycode)) {
      return;
    }

    const modifiers = (meta ?? []).filter(safe);
    if (modifiers.length > 0) {
      // `keycombination` wants bare keycode names, not KEYCODE_ prefixed ones.
      const bare = (value: string) => value.replace(/^KEYCODE_/, '');
      this.log(`keycombination ${modifiers.join('+')} + ${keycode}`);
      this.sendInput([`input keycombination ${modifiers.map(bare).join(' ')} ${bare(keycode)}`]);
      return;
    }

    this.log(`keyevent ${keycode}`);
    this.sendInput([`input keyevent ${keycode}`]);
  }

  private inputText(text: string): void {
    if (typeof text !== 'string' || text.length === 0 || text.length > 500) {
      return;
    }
    // `input text` treats %s as a space; a bare % is literal and must NOT be
    // doubled (verified on device — '%%' arrives as two percent characters).
    // Single-quote for the shell, escaping only embedded quotes.
    const escaped = text.replace(/ /g, '%s').replace(/'/g, `'\\''`);
    this.log(`text (${text.length} chars)`);
    this.sendInput([`input text '${escaped}'`]);
  }

  private async stop(): Promise<void> {
    this.stopVideoStream();
    this.stopInputShell();

    if (this.emulatorProcess && !this.emulatorProcess.killed) {
      this.log('Stopping emulator process.');
      this.emulatorProcess.kill();
    }
    this.emulatorProcess = undefined;
    this.screenSize = undefined;
    this.setState('STOPPED');
    this.log('Session stopped.');
    this.sendToWebview({ type: 'status', message: 'Stopped' });
  }

  private setState(nextState: SessionState): void {
    this.state = nextState;
    this.log(`State changed to ${nextState}`);
    this.sendToWebview({ type: 'state', state: nextState });
  }

  private sendToWebview(message: any): void {
    this.panel?.webview.postMessage(message);
  }

  private log(message: string): void {
    const timestamp = new Date().toLocaleTimeString();
    this.outputChannel.appendLine(`[${timestamp}] ${message}`);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private runAdb(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      this.log(`Running adb ${args.join(' ')}`);
      const child = cp.spawn('adb', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => reject(error));
      child.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(stderr.trim() || `adb exited with code ${code}`));
        }
      });
    });
  }

  private runAdbBuffer(args: string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.log(`Running adb ${args.join(' ')}`);
      const child = cp.spawn('adb', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => reject(error));
      child.on('close', (code) => {
        if (code === 0) {
          resolve(Buffer.concat(chunks));
        } else {
          reject(new Error(stderr.trim() || `adb exited with code ${code}`));
        }
      });
    });
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('vs-avd.openEmulatorViewer', async () => {
      const panel = vscode.window.createWebviewPanel(
        'androidEmulatorViewer',
        'Android Emulator Viewer',
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
        }
      );

      // The webview requests the AVD list itself once its script is ready, and
      // drives start/stop from its own toolbar.
      const session = new EmulatorSession(context);
      await session.open(panel);
    })
  );
}

export function deactivate(): void {
  // no-op
}

function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
      }
    });
  });
}
