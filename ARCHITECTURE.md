# Twinlink — Architecture

## 1. Process model

```
┌────────────────────────────── Main process (Node 24) ──────────────────────────────┐
│  main.js                                                                           │
│   ├─ SettingsStore ───────────────► %APPDATA%/twinlink/settings.json              │
│   ├─ AdbClient (spawn, no shell) ─► adb.exe                                       │
│   ├─ DeviceManager (2 s poll) ────► adb devices -l / getprop / wm                 │
│   ├─ MirrorController                                                             │
│   │    └─ MirrorSession ──────────► 127.0.0.1:<forward port>                      │
│   │         ├─ video socket ──────► VideoStreamParser ──► IPC frames              │
│   │         ├─ audio socket (opt) ► AudioStreamParser ──► IPC audio frames        │
│   │         └─ control socket ◄──── InputInjector ◄──── IPC input                 │
│   └─ ipc.js (validated handlers, save dialogs)                                    │
└────────────────────────────────────────────────────────────────────────────────────┘
                    ▲ contextBridge (preload.js), no Node in renderer
┌───────────────────┴──────────────────── Renderer (Chromium, sandboxed) ────────────┐
│  app.js ─ dashboard.js ─ mirror.js ─ settings.js ─ wireless.js                    │
│                  │                                                                 │
│                  ├─ decoder.js → WebCodecs VideoDecoder → Canvas 2D                │
│                  ├─ audio.js   → WebCodecs AudioDecoder → Web Audio                │
│                  └─ input capture → api.mirror.sendInput(...)                      │
└────────────────────────────────────────────────────────────────────────────────────┘
```

The renderer has **no** Node access. The preload exposes one frozen API object (`window.twinlink`) with explicit functions and subscription helpers only.

## 2. Directory layout

```
src/
  main/        main.js, window.js, ipc.js, paths.js
  preload/     preload.js (contextBridge surface)
  renderer/    index.html, styles/app.css, js/{app,dashboard,mirror,decoder,audio,settings,wireless,qr-render,ui,api}.js
  core/
    adb/       adb-path.js, adb-client.js, device-parser.js, mdns-parser.js, errors.js
    device/    device-manager.js
    mirror/    scrcpy-server.js, session.js, controller.js, net-utils.js
    control/   injector.js, keymap.js
    protocol/  constants.js, video-parser.js, device-meta.js, control.js
    settings/  schema.js, settings-store.js
    wireless/  pairing-qr.js (Android pairing payload + QR matrix)
    audio/     (reserved; audio decode lives in the renderer)
vendor/        scrcpy-server-v4.0.jar + scrcpy-LICENSE.txt
assets/        application icon and packaging resources
checks/        Electron harnesses (pipeline, smoke, recording) and generated reports
tests/         node:test suites + fake adb/server helpers
docs/          protocol notes
```

## 3. Connection lifecycle

```
idle ──start()──► preparing ──push jar + forward + spawn──► connecting
      ──connect video, read meta──► (audio socket, optional)
      ──connect control──► streaming
streaming ──socket close / stall / error──► error (or reconnecting)
reconnecting ──backoff──► preparing (attempt n)
stopped ◄── user stop / app quit
```

Key facts:

- **One forward port** carries all sockets. The scrcpy server accepts them in order: video, audio (if enabled), control.
- **Sockets before metadata:** `DesktopConnection.open()` accepts every socket before `sendDeviceMeta()` runs. The client must connect video, audio, and control first, then read the dummy byte and 64-byte name, or both sides deadlock.
- `tunnel_forward=true` makes the **server** listen; the client connects. This is why the first socket begins with one dummy `0x00` byte. A TCP connect through the adb forward can succeed before the server binds, so the client waits for that dummy byte and retries while the server starts.
- The control socket opens last. Nothing is sent on it at connection time, so the first message may be any valid control message.
- `MirrorSession` owns socket cleanup. `MirrorController` owns retry policy and user intent so a deliberate stop never triggers a reconnect.

## 4. Wire protocol (scrcpy v4.0)

Pinned to the official `v4.0` tag. The full byte-level table is in
[docs/protocol.md](docs/protocol.md). Summary:

1. **Handshake** on the first socket: `0x00` dummy byte, then a 64-byte NUL-padded UTF-8 device name.
2. **Codec id**: big-endian `u32`; H.264 = `0x68323634`.
3. **Session packet**: `u32 flags (0x80000000 | resized)`, `u32 width`, `u32 height`.
4. **Frames**: `u64 ptsAndFlags` (bit 62 = config, bit 61 = key frame), `u32 size`, payload.
5. **Control messages** are 1 type byte + big-endian fields; layouts are covered by unit tests byte-for-byte.

Server launch (tunnel forward):

```
adb -s <serial> shell CLASSPATH=/data/local/tmp/Twinlink-scrcpy-server.jar \
  app_process / com.genymobile.scrcpy.Server 4.0 \
  scid=<8 hex> log_level=info tunnel_forward=true video=true audio=<bool> \
  control=true send_device_meta=true send_dummy_byte=true send_stream_meta=true \
  cleanup=true clipboard_autosync=false max_size=<px> max_fps=<fps> video_bit_rate=<bps> \
  video_codec=h264
```

The server rejects any client whose version string differs, which is why the jar is pinned and checksum-verified.

## 5. Video pipeline

1. `VideoStreamParser` incrementally parses arbitrary TCP fragmentation into `codec`, `session`, and `frame` events. It rejects implausible packet sizes instead of allocating memory.
2. Frames cross IPC as `Uint8Array`. Minimized windows skip frame forwarding to save CPU.
3. `decoder.js` reads the SPS profile/constraints/level to build the `avc1.PPCCLL` codec string, keeps the latest config packet, and prepends SPS/PPS to key frames.
4. `VideoDecoder` is configured without a `description`, because scrcpy sends Annex-B. Output frames are drawn to a 2D canvas and closed immediately.
5. Decode queue is bounded: if more than 24 delta frames are pending, new delta frames are dropped to avoid latency growth.
6. A session packet (rotation/resize) closes and rebuilds the decoder so stale SPS state cannot persist.

## 6. Input path

```
DOM event → mapPoint (canvas rect → video pixels) → IPC → InputInjector
   → protocol serializers → MirrorSession.sendControl → control socket
```

- The renderer never supplies screen dimensions; the injector reads them from the active stream.
- Coordinates are clamped; non-finite values are rejected.
- Printable keys without modifiers become text messages; shortcuts become keycodes with Android meta state.
- Every control message has a fixed-size unit test that asserts offsets, widths, and endianness.

## 7. Security model

| Control | Implementation |
| --- | --- |
| Context isolation | `contextIsolation: true` |
| Node in renderer | `nodeIntegration: false`, `nodeIntegrationInWorker/SubFrames: false` |
| Sandbox | `sandbox: true` |
| Remote content | `will-navigate` blocked; `setWindowOpenHandler` denies popups (allowlisted HTTPS links open externally) |
| Webviews | `will-attach-webview` prevented |
| CSP | `default-src 'none'`, self-only scripts/styles, no `connect-src` |
| Permissions | every permission request/check denied; downloads blocked |
| Commands | `spawn(adb, argsArray)` only; no shell |
| Input validation | serial regex, port range, remote-socket regex, `/data/local/tmp/...` path regex, host:port regex |
| Files | save dialogs plus PNG/WebM/MP4 magic-byte and size checks |
| Device data | inserted with `textContent`, never HTML |
| Server binary | SHA-256 must equal `84924bd5…3210f3a` |

## 8. Failure semantics

| Failure | Behaviour |
| --- | --- |
| adb missing | `ADB_NOT_FOUND`; UI banner + picker; polling continues |
| adb command timeout | process killed, `TIMEOUT` error, UI message |
| Forward failure | session start fails; partial forward removed |
| Device server exits | session error → controller retry (if enabled) |
| Metadata timeout (12 s) | session fails with explicit message |
| Video parse error | session fails; parser never over-allocates |
| Decoder error | decoder reset; up to 3 errors reported; recovers on next key frame |
| Audio failure | audio disabled; video unaffected |
| Settings corruption | quarantined, defaults restored |
| App quit | forward removed, sockets destroyed, adb children killed |

## 9. Key decisions and trade-offs

| Decision | Why |
| --- | --- |
| Bundle the official server jar | No device-side install, exact version match, checksummed supply chain |
| Single forward port | Matches scrcpy's own tunnel-forward design; works with USB and TCP devices |
| Parse in the main process | Keeps the renderer sandboxed and avoids duplicating validation |
| WebCodecs instead of WASM/JS decoder | Hardware decode, low latency, no third-party decoder |
| Canvas 2D instead of WebGL | Simple, reliable, sufficient for one phone-sized surface |
| Renderer-side screenshot/recording | No extra device round-trip; the canvas is the source of truth |
| No renderer framework | Small surface, no build step, easier CSP auditing |
| Audio opt-in | Keeps video safe if the device refuses the audio socket; the path itself is hardware-verified |

## 10. Known limitations

- Only H.264 is accepted; H.265/AV1 are rejected to avoid silently painting nothing.
- No clipboard sync (explicitly disabled server-side).
- No camera/virtual-display modes.
- Latency was only checked qualitatively on a device, not measured with a tool.
