import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

type SessionState = 'IDLE' | 'BOOTING_EMULATOR' | 'BOOTED' | 'STARTING_SERVER' | 'STREAMING' | 'STOPPED';

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
        this.setState(this.state);
        break;
      case 'start':
        await this.start(message.avdName);
        break;
      case 'stop':
        await this.stop();
        break;
      case 'tap':
        await this.tap(message.nx, message.ny);
        break;
      case 'refresh':
        await this.captureFrame();
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
    this.setState('BOOTING_EMULATOR');
    this.log(`Starting emulator for AVD: ${avdName}`);
    this.outputChannel.show(true);
    this.sendToWebview({ type: 'status', message: `Launching ${avdName}...` });

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
      this.setState('STREAMING');
      this.log('Emulator finished booting and streaming has started.');
      this.sendToWebview({ type: 'status', message: 'Emulator is ready. Streaming H.264.' });
      this.startVideoStream();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Start failed: ${message}`);
      vscode.window.showErrorMessage(message);
      this.setState('STOPPED');
    }
  }

  private async waitForBoot(): Promise<void> {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      try {
        this.log(`Waiting for device (${attempt + 1}/90)...`);
        await this.runAdb(['wait-for-device']);
      } catch (error) {
        this.log(`adb wait-for-device attempt failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      try {
        const result = await this.runAdb(['shell', 'getprop', 'sys.boot_completed']);
        this.log(`Boot completion check: ${result.stdout.trim() || '<empty>'}`);
        if (result.stdout.trim() === '1') {
          this.log('Boot completed successfully.');
          return;
        }
      } catch (error) {
        this.log(`Boot property check failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      await this.delay(2000);
    }

    throw new Error('Timed out waiting for the Android emulator to finish booting.');
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
        this.sendToWebview({ type: 'status', message: `Video stream failed: ${error.message}` });
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

  private async captureFrame(): Promise<void> {
    try {
      const imageBuffer = await this.runAdbBuffer(['exec-out', 'screencap', '-p']);
      this.sendToWebview({ type: 'frame', data: imageBuffer.toString('base64') });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Screenshot capture failed: ${message}`);
      this.sendToWebview({ type: 'status', message: `Screenshot refresh failed: ${message}` });
    }
  }

  // Takes normalized 0..1 coordinates and scales them into full device space,
  // so a half-resolution video stream still taps the right pixel.
  private async tap(nx: number, ny: number): Promise<void> {
    if (this.state !== 'STREAMING' || !Number.isFinite(nx) || !Number.isFinite(ny)) {
      return;
    }

    const size = this.screenSize ?? { width: 1080, height: 2340 };
    const x = Math.round(Math.min(Math.max(nx, 0), 1) * size.width);
    const y = Math.round(Math.min(Math.max(ny, 0), 1) * size.height);

    try {
      this.log(`Sending tap to emulator at (${x}, ${y})`);
      await this.runAdb(['shell', 'input', 'tap', `${x}`, `${y}`]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Tap failed: ${message}`);
      vscode.window.showWarningMessage(`Tap failed: ${message}`);
    }
  }

  private async stop(): Promise<void> {
    this.stopVideoStream();

    if (this.emulatorProcess && !this.emulatorProcess.killed) {
      this.log('Stopping emulator process.');
      this.emulatorProcess.kill();
    }
    this.emulatorProcess = undefined;
    this.setState('STOPPED');
    this.log('Session stopped.');
    this.sendToWebview({ type: 'status', message: 'Emulator stopped.' });
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
    const entry = `[${timestamp}] ${message}`;
    this.outputChannel.appendLine(entry);
    this.sendToWebview({ type: 'log', message: entry });
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

      const session = new EmulatorSession(context);
      await session.open(panel);

      // The panel is live and interactive at this point; the picker is only a
      // convenience. Cancelling it leaves the viewer usable via its AVD field.
      const avd = await pickAvd();
      if (avd) {
        await session.start(avd);
      }
    })
  );
}

export function deactivate(): void {
  // no-op
}

async function pickAvd(): Promise<string | undefined> {
  try {
    const result = await runCommand('emulator', ['-list-avds']);
    const avds = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (avds.length === 0) {
      vscode.window.showWarningMessage('No Android virtual devices were found. Create one in Android Studio or install the emulator first.');
      return undefined;
    }

    return await vscode.window.showQuickPick(avds, {
      placeHolder: 'Choose an Android Virtual Device'
    });
  } catch {
    vscode.window.showWarningMessage('The emulator CLI is not available on PATH. Install Android Studio or the Android SDK platform tools first.');
    return undefined;
  }
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
