# Contributing / implementation notes

Engineering detail for anyone working on this extension. For user-facing docs see
[README.md](README.md).

## Run locally

1. `npm install`
2. Open this folder in VS Code.
3. Press <kbd>F5</kbd> to launch the Extension Development Host.
4. Run the command **Open Android Emulator Viewer**.
5. Pick an AVD from the dropdown and press ▶.

## Boot progress

Pressing start replaces the placeholder with a progress panel that steps through real,
observed milestones rather than animating on a timer:

| Phase | Detected by |
| --- | --- |
| Launching emulator | the `emulator` process has been spawned |
| Connecting over adb | `adb devices` lists an `emulator-*` entry |
| Waiting for shell | `adb shell echo ok` answers |
| Booting Android | `sys.boot_completed` is being polled |
| Starting stream | boot completed, resolution detected |

Measured on a cold boot (`-no-snapshot-load`), the phases are genuinely distinct — the gap
between `connected` and `shell` was ~7s, so these are not decorative steps:

```
 1.0s  connected   (adb lists emulator)
 8.2s  shell       (device shell responds)
12.3s  booted
```

A warm snapshot resume reaches `booted` in ~5s and skips visibly through the middle steps.
The elapsed clock appears after 3s so short resumes don't flash a timer. The loader is cleared
by any non-boot state transition, so a failed launch never leaves a spinner running.

## Input

| Gesture | Maps to |
| --- | --- |
| Click | `input tap` |
| Drag | chained `input swipe` segments |
| Scroll wheel | `input swipe` in the opposite direction of the wheel |
| Printable keys | `input text`, batched over 40ms so fast typing is one call |
| Enter, Backspace, Delete, Tab, Esc, arrows, Home/End, PgUp/PgDn | `input keyevent KEYCODE_*` |
| Ctrl/Alt/Shift/Cmd + letter or digit | `input keycombination` |

Notes on why it works this way:

- **All input goes through one persistent `adb shell`.** Spawning a process per event costs
  70–145ms measured, which makes drag and scroll unusable. Reusing a shell over stdin drops
  that to ~50ms, and a chained-swipe drag to ~86ms per segment (vs 286ms standalone).
- **Drag maps to `input swipe`, not synthetic motion events.** A swipe is one native gesture
  with real fling physics; a stream of individual move events is not, and scrolls feel dead.
- **Drag has a movement threshold** (1.2% of the screen) so a slightly shaky click is still a
  tap rather than a 2px swipe.
- **Wheel events are coalesced** over 60ms into one gesture, otherwise a single scroll flick
  queues a dozen competing swipes.
- **`input text` treats `%s` as a space, and a bare `%` is literal.** Do *not* escape `%` as
  `%%` — verified on device, `%%` arrives as two percent characters.
- Escape maps to `KEYCODE_BACK`, which is the Android equivalent rather than a literal Esc.

## Rotation

`wm size` and `input tap` both work in physical, rotation-independent coordinates, but the
video is rotated — so the tracked rotation value is what reconciles the two.

- **`user_rotation` is only honoured while auto-rotate is off**, so `accelerometer_rotation`
  is cleared first.
- **`settings put user_rotation` alone is silently ignored** whenever an app has overridden
  rotation. `wm fixed-to-user-rotation enabled` plus `wm user-rotation lock` makes the user
  rotation override the app's request — verified to rotate the launcher, which no other
  method managed.
- **Rotation is polled rather than assumed** after a fixed delay, and the applied value wins
  over the requested one.
- **`screenrecord --size` must follow the rotation.** It honours the flag literally, so a
  landscape stream requested with portrait dimensions is letterboxed into a portrait frame
  and never appears to rotate.
- A snapshot can resume already rotated, so the real value is read at startup rather than
  assumed to be 0.

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

Icons are Material Symbols, inlined as an SVG sprite — the webview CSP blocks Google's icon
font CDN, so the glyphs ship with the extension.

## Known gaps

- No multi-touch (pinch-zoom, two-finger gestures) — `input` has no API for it. That needs the
  scrcpy server protocol or raw `sendevent` writes.
- Drag latency is bounded by the ~86ms shell round-trip, so a fast flick is approximated by a
  handful of swipe segments rather than tracking the cursor exactly.
- A literal `%s` typed as text will arrive as a space; `input text` offers no way to escape it.
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
