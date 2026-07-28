# vs-avd

View and control a headless Android emulator inside a VS Code webview panel, streamed as live H.264 video.

## What it does

- Lists your AVDs in a toolbar dropdown and launches the selected one headless (`-no-window`).
- Streams the screen as **H.264 at ~30fps** via `screenrecord`, decoded in the webview with WebCodecs.
- Click anywhere on the screen to send a tap through `adb shell input tap`.
- Fit-to-height / fit-to-width / zoom controls for the viewport.
- Logs go to the **Android Emulator Viewer** output channel.

## Requirements

- Android Studio / Android SDK with `emulator` and `adb` on `PATH`.
- At least one AVD visible to `emulator -list-avds`.
- A VS Code build whose webview supports WebCodecs (`VideoDecoder`). Without it the panel
  falls back to still frames via the refresh button and says so in the status chip.

## Run locally

1. `npm install`
2. Open this folder in VS Code.
3. Press <kbd>F5</kbd> to launch the Extension Development Host.
4. Run the command **Open Android Emulator Viewer**.
5. Pick an AVD from the dropdown and press ▶.

## Toolbar

| Control | Behaviour |
| --- | --- |
| AVD dropdown | Populated from `emulator -list-avds` when the panel opens. Shows "No AVDs found" when empty. |
| Status chip | Colour-coded dot — idle (grey), starting (pulsing amber), streaming (green), error (red). |
| Fit height / Fit width | Scales the screen to the panel, preserving aspect ratio. Re-applies on panel resize. |
| Zoom −/+ | Steps through 25%–300%. Stepping out of a fit mode starts from the resolved fit scale. |
| ▶ / ■ | Start or stop the emulator. Buttons enable/disable to match session state. |
| Refresh | Grabs one full-resolution `screencap` frame. |
| Logs | Reveals the output channel. |

Icons are Material Symbols, inlined as an SVG sprite — the webview CSP blocks Google's icon
font CDN, so the glyphs ship with the extension.

## How the video pipeline works

`adb exec-out screenrecord --output-format=h264` writes an Annex-B elementary stream to a pipe.
The extension base64s each chunk to the webview, which reassembles NAL units and feeds access
units to a `VideoDecoder`.

Details that matter if you touch this code:

- **Chunk boundaries are arbitrary.** Pipe reads do not align to NAL or frame boundaries, so
  the parser buffers bytes and splits on start codes, holding any trailing partial NAL.
- **SPS/PPS are fused onto the following keyframe.** An Annex-B stream has no `avcC`
  description, so the parameter sets must reach the decoder in the same chunk as the IDR.
- **Only an IDR slice (type 5) marks a keyframe.** Parameter sets recur mid-GOP, so treating
  SPS/PPS as the keyframe marker labels an ordinary P-frame `'key'`; the decoder then resolves
  it against a reference it never received and the picture drifts until the next real IDR. This
  showed up as a shredded status bar with diagonal streaks bleeding down the screen — worst on
  the launcher, which is static enough that a natural IDR may not arrive for minutes.
- **Frames before the first IDR are dropped, but their parameter sets are kept**, since the
  IDR that eventually arrives may not repeat them.
- **Keyframe starvation self-heals.** After 30 dropped pre-IDR frames the webview asks the
  extension to restart the capture segment, which is the only way to force a fresh IDR out of
  `screenrecord`.
- **Segments relaunch every 170s.** `screenrecord` hard-caps at 180s. Each relaunch emits fresh
  SPS/PPS, so the extension sends `videoReset` and the webview rebuilds its decoder.
- **The stream is half resolution.** On a 1080×2340 device it encodes 540×1170; the decoder
  scales back up. This roughly quarters the bitrate on the emulator's software encoder.
- **Taps are normalized 0..1**, then scaled into full device space — so a half-resolution
  stream still taps the right pixel.

Measured on a Pixel 5 AVD (1080×2340), versus the screenshot-polling approach this replaced:

| | Screenshots @800ms | H.264 stream |
| --- | --- | --- |
| Framerate | ~1.25 fps | ~30 fps |
| Bandwidth | 613 KB/s | 114 KB/s |
| Per-frame cost | 265 ms `screencap` stall | pipelined |

## Known gaps

- Input is tap-only — no swipe, no keyboard, no rotation.
- The emulator is stopped with `SIGTERM` rather than `adb emu kill`, so a wedged emulator can
  outlive the panel.
- `avc1.42c02a` (Baseline 4.2) is hardcoded as the decoder config; it matches what the
  emulator's encoder produces but is not negotiated from the stream's SPS.

## Next steps

The current pipeline is `screenrecord`-based, which means a keyframe-to-glass latency of a few
hundred milliseconds and a forced reset every 170s. Moving to the real **scrcpy server protocol**
(push `scrcpy-server.jar`, read framed H.264 off an adb-forwarded socket) would remove the
segment limit, cut latency, and bring proper input injection.
[ws-scrcpy](https://github.com/NetrisTV/ws-scrcpy) is a good reference implementation.
