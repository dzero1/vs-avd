# vs-avd

A starter VS Code extension for launching an Android emulator and viewing it inside a webview panel.

## What it does
- Launches an Android Virtual Device with the emulator CLI.
- Waits for the emulator to finish booting.
- Captures screenshots over adb and displays them in a canvas.
- Lets you tap the canvas to send taps to the emulator.

## Requirements
- Android Studio / Android SDK installed with:
  - `emulator`
  - `adb`
- An AVD already created and visible to `emulator -list-avds`.

## Run locally
1. Install dependencies with `npm install`.
2. Open this folder in VS Code.
3. Press F5 to run the Extension Development Host.
4. Run the command `Open Android Emulator Viewer`.

## Next steps
This starter uses screenshots for the simplest possible viewer. The next milestone is to replace that with a real scrcpy-style video stream using WebCodecs and a custom socket protocol.
