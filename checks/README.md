# Checks

Three Electron harnesses prove things that unit tests cannot.

## `npm run check` — application smoke test

Launches the **real** app (`electron .`) with `TWINLINK_SMOKE=1`. A dev-only hook
(`checks/smoke-hook.js`, loaded by `src/main/main.js` only when that variable is
set and the app is unpackaged) waits for the window, inspects the DOM, records
console errors/preload failures, writes a report, and quits.

Asserts:

- the preload bridge exists and exposes the expected namespaces,
- 3 tabs and 3 views rendered, dashboard active,
- the mirror canvas and placeholder exist,
- the recording-format selector offers all four formats,
- the Wireless → QR tab draws a pairing code that an **independent** QR
  decoder (jsQR) reads back as the exact Android payload
  `WIFI:T:ADB;S:<service>;P:<code>;;`,
- no console errors, no preload/load failures.

Output: `checks/.artifacts/smoke-report.json` (git-ignored).

Last run:

```json
{"ok":true,"activeView":"view-dashboard","bridge":true,"deviceCards":1,
 "qr":{"visible":true,"canvasWidth":296,"canvasHeight":296,"code":"419558",
       "payload":"WIFI:T:ADB;S:adbqr-99499c08;P:419558;;","decodedMatches":true},
 "consoleErrors":0,"failures":[]}
```

## `npm run check:pipeline` — video pipeline proof

Feeds a **real H.264 stream** through the exact production path:

```
fake scrcpy server (v4.0 framing)
  → VideoStreamParser (src/core/protocol)
  → MirrorSession
  → IPC
  → StreamDecoder (src/renderer/js/decoder.js, WebCodecs)
  → Canvas 2D
```

The fake server sends the real handshake (dummy byte + 64-byte name), codec id,
session packet, a config packet, and 30 access units parsed from
`checks/.artifacts/test.h264`. The renderer samples the rendered canvas and
reports decoded frame count, canvas size, distinct colours, and decoder errors.
The check also injects a rotate message through the production `InputInjector`
and verifies the server received exactly `0b`.

Pass criteria:

- ≥25 decoded frames,
- canvas = 720×1280,
- ≥8 distinct sampled colours,
- control bytes = `0b`.

Output: `checks/.artifacts/pipeline-report.json` (git-ignored).

Last run:

```json
{"ok":true,"decodedFrames":30,"canvas":{"width":720,"height":1280},
 "distinctColors":622,"controlHex":"0b","error":null}
```

## `npm run check:recording` — recording format proof

Records a **real animated canvas** with `MediaRecorder` in every format the
Settings UI offers, then validates the produced files:

| Format | Expected container |
| --- | --- |
| `webm-vp9` | WebM (EBML magic `1A 45 DF A3`) |
| `webm-vp8` | WebM |
| `webm-av1` | WebM |
| `mp4-h264` | MP4 (`ftyp` at bytes 4–8) |

Each recording runs for 1.5 s at 320×240; the files are written to
`checks/.artifacts/recording-<format>.<ext>` and the report records byte length,
chunk count, and magic result. The check fails if the default WebM VP9 encoder is
unavailable or if any supported format produces invalid bytes.

This does not exercise the native **Save** dialog, which cannot be automated; the
save path itself validates the same magic bytes in `src/main/ipc.js`.

Output: `checks/.artifacts/recording-report.json` (git-ignored).

Last run:

```json
{"ok":true,"formats":[
  {"id":"webm-vp9","supported":true,"bytes":44640,"magicOk":true,"error":null},
  {"id":"webm-vp8","supported":true,"bytes":73326,"magicOk":true,"error":null},
  {"id":"webm-av1","supported":true,"bytes":41790,"magicOk":true,"error":null},
  {"id":"mp4-h264","supported":true,"bytes":105078,"magicOk":true,"error":null}],
 "error":null}
```

## Generating the test stream

```powershell
New-Item -ItemType Directory -Force checks/.artifacts | Out-Null
ffmpeg -y -loglevel error -f lavfi -i "testsrc=size=720x1280:rate=30" -t 1 `
  -pix_fmt yuv420p -c:v libx264 -profile:v baseline -level 3.1 `
  -x264-params "aud=1:repeat-headers=1:keyint=15:min-keyint=15:scenecut=0" `
  -f h264 checks/.artifacts/test.h264
```

Without this file `check:pipeline` fails with a clear message; it is never
silently skipped.

## `npm run check:device` — real USB phone proof

Launches the real app against an attached, authorized phone and drives the exact
production path:

```
renderer Connect -> preload -> IPC -> MirrorController -> adb push/forward
  -> scrcpy-server v4.0 -> VideoStreamParser -> IPC -> WebCodecs -> canvas
```

It requires streaming state, ≥25 decoded frames, a non-uniform canvas, a PNG
export of the canvas, a rotate injected through the input pipeline whose result
is the device's video dimensions swapping, and a clean stop with no adb forward
left behind. It writes `checks/.artifacts/device-report.json`,
`device-mirror-portrait.png`, `device-mirror-landscape.png`, and
`device-canvas.png`.

It fails loudly if no device is attached. Do not mark device features verified
unless this check (or the manual report) passes.

Last run: the phone was detected and the server launched, but the check failed on
the socket-ordering deadlock that has since been fixed. The phone then
disconnected, so the re-run did not complete; the report records the failure, not
a pass.

## What these checks do not prove

- That a physical phone can be mirrored or controlled on this machine: the
  device check has not completed a pass (the phone disconnected mid-run).
- That the native Save dialog appears or writes to disk (it is an OS dialog; the
  encoder and container bytes are verified instead).
- Audio or wireless behaviour.
- Installer behaviour on a clean machine.

Those require testing on real hardware and are not covered by the automated
checks in this repository.
