import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

type SessionState = 'IDLE' | 'BOOTING_EMULATOR' | 'BOOTED' | 'STARTING_SERVER' | 'STREAMING' | 'STOPPED';

class EmulatorSession {
  private state: SessionState = 'IDLE';
  private emulatorProcess: cp.ChildProcess | undefined;
  private screenshotTimer: NodeJS.Timeout | undefined;
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
    this.stop();
    if (this.screenshotTimer) {
      clearInterval(this.screenshotTimer);
      this.screenshotTimer = undefined;
    }
    this.outputChannel.dispose();
    this.panel = undefined;
  }

  private getWebviewContent(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'emulator.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'emulator.js'));
    const htmlPath = path.join(this.context.extensionPath, 'media', 'emulator.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace('{{styleUri}}', styleUri.toString());
    html = html.replace('{{scriptUri}}', scriptUri.toString());
    html = html.replace('{{cspSource}}', webview.cspSource);
    return html;
  }

  private async handleMessage(message: any): Promise<void> {
    switch (message.type) {
      case 'start':
        await this.start(message.avdName);
        break;
      case 'stop':
        await this.stop();
        break;
      case 'tap':
        await this.tap(message.x, message.y);
        break;
      case 'refresh':
        await this.captureFrame();
        break;
      default:
        break;
    }
  }

  private async start(avdName: string): Promise<void> {
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
      this.setState('STREAMING');
      this.log('Emulator finished booting and streaming has started.');
      this.sendToWebview({ type: 'status', message: 'Emulator is ready. Streaming screenshots.' });
      this.startScreenshotLoop();
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

  private startScreenshotLoop(): void {
    if (this.screenshotTimer) {
      clearInterval(this.screenshotTimer);
    }

    this.log('Starting periodic screenshot capture loop.');
    this.screenshotTimer = setInterval(() => {
      void this.captureFrame();
    }, 800);
  }

  private async captureFrame(): Promise<void> {
    if (this.state !== 'STREAMING') {
      return;
    }

    try {
      const imageBuffer = await this.runAdbBuffer(['exec-out', 'screencap', '-p']);
      const base64 = imageBuffer.toString('base64');
      this.sendToWebview({ type: 'frame', data: base64 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Screenshot capture failed: ${message}`);
      this.sendToWebview({ type: 'status', message: `Screenshot refresh failed: ${message}` });
    }
  }

  private async tap(x: number, y: number): Promise<void> {
    if (this.state !== 'STREAMING') {
      return;
    }

    try {
      this.log(`Sending tap to emulator at (${Math.round(x)}, ${Math.round(y)})`);
      await this.runAdb(['shell', 'input', 'tap', `${Math.round(x)}`, `${Math.round(y)}`]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Tap failed: ${message}`);
      vscode.window.showWarningMessage(`Tap failed: ${message}`);
    }
  }

  private async stop(): Promise<void> {
    if (this.screenshotTimer) {
      clearInterval(this.screenshotTimer);
      this.screenshotTimer = undefined;
    }

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
  const session = new EmulatorSession(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('vs-avd.openEmulatorViewer', async () => {
      const panel = vscode.window.createWebviewPanel(
        'androidEmulatorViewer',
        'Android Emulator Viewer',
        vscode.ViewColumn.Active,
        { enableScripts: true }
      );

      await session.open(panel);
      const avd = await pickAvd();
      if (avd) {
        await session.open(panel);
        await session['start'](avd);
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
