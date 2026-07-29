# Android Emulator Viewer

Run and control an Android emulator in a VS Code tab. No separate emulator window, no
alt-tabbing — the device screen streams live next to your code, and you can click, type,
rotate, and simulate calls, battery, or GPS without leaving the editor.

![Opening the panel](https://raw.githubusercontent.com/dzero1/vs-avd/main/demo/open.gif)

## Features

### Live device screen

Streams at ~30fps as H.264 video — smooth enough to scroll lists and watch animations, not a
sequence of screenshots. The emulator runs headless, so no extra window appears.

![Scrolling at 30fps](https://raw.githubusercontent.com/dzero1/vs-avd/main/demo/scroll-and-fps.gif)

### Start any AVD with real boot progress

Pick a device from the dropdown and press start. Progress shows actual milestones — launching,
connecting over adb, waiting for the shell, booting Android — rather than an indefinite spinner,
with an elapsed clock on slower cold boots.

![Starting an emulator](https://raw.githubusercontent.com/dzero1/vs-avd/main/demo/start.gif)

### Click and type directly

Click to tap, drag to swipe, scroll with the wheel. Click once to focus the screen, then type
with your real keyboard — including Enter, Backspace, arrows, and Ctrl/Alt/Shift shortcuts.

![Typing with the keyboard](https://raw.githubusercontent.com/dzero1/vs-avd/main/demo/keyboard-typing.gif)

### Hardware buttons

Back, Home, and Recent apps.

![Hardware buttons](https://raw.githubusercontent.com/dzero1/vs-avd/main/demo/hardware-buttons.gif)

The toolbar floats over the screen and can be dragged out of the way by its grip.

![Dragging the toolbar](https://raw.githubusercontent.com/dzero1/vs-avd/main/demo/toolbar-drag.gif)

### Rotate

Rotate left or right. Works even on apps that pin their own orientation, and both the video and
your touch coordinates follow the rotation correctly.

![Rotating the device](https://raw.githubusercontent.com/dzero1/vs-avd/main/demo/rotate.gif)

### Screenshots

Grab a full-resolution PNG of the current screen with one click.

![Taking a screenshot](https://raw.githubusercontent.com/dzero1/vs-avd/main/demo/screenshot.gif)

### Fit and zoom

Fit to height, fit to width, or zoom from 25% to 300%. Fit modes re-apply when you resize the
panel.

![Fit and zoom controls](https://raw.githubusercontent.com/dzero1/vs-avd/main/demo/fit-and-zoom.gif)

### Extended controls

A side panel for simulating device conditions, so you can test the paths that are painful to
reach on real hardware:

![Extended controls panel](https://raw.githubusercontent.com/dzero1/vs-avd/main/demo/extended-toolbar.gif)

| | What you can simulate |
| --- | --- |
| **Battery** | Charge level 0–100%, AC / USB / no charger, and health states (good, overheated, dead, overvoltage, failure) |
| **Cellular** | Network type (LTE, GSM, GPRS, EDGE, UMTS, HSDPA, HSCSD, or unthrottled), voice/data status (home, roaming, searching, denied, unregistered), and signal strength |
| **Location** | Send any latitude, longitude, and altitude to the device |
| **Phone** | Place an incoming call from any number, end it, or deliver an SMS |
| **Fingerprint** | Touch the sensor as one of three enrolled fingers |

## Requirements

- **Android Studio or the Android SDK**, with `emulator` and `adb` on your `PATH`.
- **At least one AVD.** Create one in Android Studio's Device Manager. You can check it's
  visible by running `emulator -list-avds`.
- A recent VS Code build. Without WebCodecs support in the webview the panel falls back to
  still frames and tells you so in the status chip.

This extension drives the emulator and `adb` already installed on your machine — it does not
bundle or download either.

## Getting started

1. Install the extension.
2. Open the Command Palette (<kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>).
3. Run **Open Android Emulator Viewer**.
4. Pick an AVD from the dropdown and press ▶.

First boot takes 10–30 seconds depending on the device image. Later starts that resume from a
snapshot are much faster.

## Tips

- Click the screen once before typing — the keyboard goes to the device only while the screen
  has focus, shown by a focus ring.
- Press **Logs** in the toolbar to open the **Android Emulator Viewer** output channel if a
  start fails; adb and emulator output goes there.
- Drag the floating toolbar by its grip if it covers something you need to tap.

## Known limitations

- **No multi-touch** — pinch-to-zoom and two-finger gestures aren't supported.
- **Fast flicks are approximated.** Drag is sent as a series of swipes, so a very fast gesture
  won't track your cursor exactly.
- **A wedged emulator can outlive the panel.** Closing the panel stops the emulator process,
  but an unresponsive one may need `adb emu kill` or Activity Monitor.

## Credits

- Extension icon: <a href="https://www.flaticon.com/free-icons/android" title="android icons">Android icons created by Magnific - Flaticon</a>
- Toolbar glyphs: [Google Material Symbols](https://fonts.google.com/icons), Apache 2.0.

See [NOTICE](NOTICE) for full asset licensing.

## License

MIT — see [LICENSE](LICENSE). Bundled assets are licensed separately, see [NOTICE](NOTICE).

---

Implementation notes, benchmarks, and design rationale live in
[CONTRIBUTING.md](CONTRIBUTING.md).
