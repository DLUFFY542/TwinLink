# Twinlink

Twinlink is a Windows desktop app that mirrors and controls an Android phone over USB or Wi-Fi. It is built with Electron and talks to the phone through Android's own `adb` debugging bridge. It does **not** bypass Android authorization, DRM, or any security control.

> **Project status:** the application is implemented, its automated checks pass, and every feature below was exercised on a physical phone (vivo iQOO, Android 16) — USB mirroring, touch and keyboard control, audio forwarding, and wireless debugging by pairing code and by QR code. See [Verified vs. untested](#verified-vs-untested).

_Screenshots will be added after a completed real-device run._

---

## Verified vs. untested

| Area | Status | Evidence |
| --- | --- | --- |
| Protocol framing (scrcpy v4.0) | **Verified** | 71/71 automated tests; byte-layout tests against the published v4.0 source |
| H.264 decode → Canvas | **Verified** | `npm run check:pipeline`: 30/30 real ffmpeg H.264 frames decoded, canvas 720×1280, 622 distinct colours sampled |
| Input injection → control socket | **Verified (wire only)** | Pipeline check: a rotate message produced exactly `0b` on the device socket |
| App shell, CSP, preload bridge | **Verified** | `npm run check`: real app launched, 3 tabs, bridge present, 0 console errors |
| Device discovery / auth states | **Verified (fixtures + one live device)** | Parser/manager tests; the app discovered a vivo phone running Android 16 as authorized |
| **USB mirroring of a real phone** | **Verified (real phone)** | Confirmed on a vivo iQOO (Android 16) on 2026-11-13: the phone screen streams over the USB data cable |
| **Touch/keyboard control of a real phone** | **Verified (real phone)** | Same device and session on 2026-11-13: taps, drags, keyboard input, and the device buttons all reached the phone |
| **Audio forwarding** | **Verified (real phone)** | The OPUS audio path was confirmed on the same device on 2026-11-13; the app still falls back to video-only if the device refuses the audio socket |
| **Wireless debugging** | **Verified (real phone)** | Manual pairing code, QR pairing, and the wireless connection were confirmed on a vivo iQOO (Android 16) on 2026-11-12 |
| Recording formats (WebM VP9/VP8/AV1, MP4 H.264) | **Verified (encoder harness)** | `npm run check:recording`: all four formats recorded a real canvas and produced valid WebM (EBML) or MP4 (`ftyp`) bytes; unsupported formats are disabled in Settings |
| Wireless pairing QR code | **Verified (real phone)** | `npm run check` decodes the generated code with an independent decoder, and the code was scanned on a real phone: Twinlink paired and connected with no typed address or code |
| Windows installer | **Built** | NSIS setup and single-file portable `.exe`; the portable build opened a responsive "Twinlink" window on the build machine (unsigned) |

Twinlink never claims a feature works just because code exists. Every *Verified* row above was confirmed on a physical phone; anything still marked *Blocked* or *unvalidated* needs one.

---

## Requirements

- Windows 10/11 (x64)
- Android 5.0+ (API 21+) with **USB debugging** enabled
- A USB **data** cable
- Android Platform Tools (`adb`) installed, or pointed to in Settings
- For wireless debugging: Android 11+ and both devices on the same network

Twinlink bundles the official **scrcpy-server v4.0** binary and pushes it to the phone at connect time. The client speaks exactly the v4.0 protocol, so the bundled server must not be swapped for a different version.

## Download and install (Windows)

Twinlink runs on the Windows PC. There is **no Android app to install** on the
phone — the phone only needs USB debugging enabled.

1. Open the [Releases page](https://github.com/DLUFFY542/TwinLink/releases).
2. Download **one** of:
   - `Twinlink-Portable-0.1.2.exe` — single file, no installation; run it from
     anywhere.
   - `Twinlink-Setup-0.1.2.exe` — installer with Start-menu and desktop
     shortcuts.
3. Run the file. The builds are unsigned, so Windows SmartScreen may warn:
   choose **More info → Run anyway**.
4. On the phone, enable **Developer options → USB debugging**, connect it with a
   USB **data** cable, and accept the **Allow USB debugging?** prompt.
5. In Twinlink, open **Devices**, select the phone, and press **Connect**.

Twinlink uses `adb`. If it is not already installed, install
[Android Platform Tools](https://developer.android.com/tools/releases/platform-tools)
or point Twinlink at an existing `adb.exe` in **Settings → Connection**.

## Quick start (from source)

```powershell
npm install
npm start
```

1. Connect the phone with a USB data cable.
2. Enable *Developer options → USB debugging*.
3. Accept the **Allow USB debugging?** prompt on the phone (tick *Always allow* for automatic reconnects).
4. The phone appears on the **Devices** tab. Press **Connect**.
5. The phone screen appears in the **Mirror** tab. Left click = tap, right click = Back, middle click = Home, wheel = scroll, keyboard = text/keys.

If `adb` is not on `PATH`, Twinlink searches `TWINLINK_ADB`, bundled platform-tools, the Android SDK, and WinGet installs. You can also pick `adb.exe` manually in **Settings → Connection**.

## Wireless debugging (Android 11+)

Phone and PC must be on the same network. Open **Devices → Wireless**:

- **QR code** — press *Show QR code*, then on the phone open *Developer options →
  Wireless debugging → Pair device with QR code* and scan the code on screen.
  Twinlink waits for the phone to appear over mDNS, pairs it automatically, and
  connects. No address or code to type.
- **Pairing code** — type the `IP:port` and the 6-digit code shown by *Pair
  device with pairing code*.
- **Discovered** — the endpoints `adb` advertises on the network.

Pairing relies on mDNS. Guest and public Wi-Fi often block it; a phone hotspot
works.

## Build

```powershell
npm run pack   # unpacked app in build/win-unpacked
npm run dist   # NSIS installer + single-file portable .exe in build/
```

`Twinlink-Setup-0.1.2.exe` installs the app; `Twinlink-Portable-0.1.2.exe` is a
single executable that runs without installing. The portable build
(111,463,867 bytes) was launched and opened a responsive **Twinlink** window; the
setup build (122,389,023 bytes) opened its installer. Both are unsigned, so
Windows SmartScreen will warn on first launch. Build output is intentionally
git-ignored.

## Testing

```powershell
npm test               # 71 unit/integration tests (node:test)
npm run check          # launches the real app, asserts clean shell
npm run check:pipeline # real H.264 -> WebCodecs -> Canvas proof
npm run check:recording # real MediaRecorder output for every offered format
npm run check:device   # real USB phone: discovery -> stream -> rotate -> cleanup
```

`check:device` needs an attached, authorized phone and is the only proof of real
USB mirroring. It writes `checks/.artifacts/device-report.json` plus PNG captures
of the app window. It fails loudly when no device is present.

The pipeline check needs `checks/.artifacts/test.h264`, generated with ffmpeg:

```powershell
ffmpeg -y -loglevel error -f lavfi -i "testsrc=size=720x1280:rate=30" -t 1 `
  -pix_fmt yuv420p -c:v libx264 -profile:v baseline -level 3.1 `
  -x264-params "aud=1:repeat-headers=1:keyint=15:min-keyint=15:scenecut=0" `
  -f h264 checks/.artifacts/test.h264
```

Reports are written to `checks/.artifacts/`. They are generated artifacts and are not committed.

## How it works (short version)

1. `adb devices -l` is polled to discover USB and network devices and their authorization state.
2. On **Connect**, Twinlink pushes `scrcpy-server-v4.0.jar` to `/data/local/tmp/`, creates `adb forward tcp:<port> localabstract:scrcpy_<scid>`, and starts the server with `app_process`.
3. The client opens the video socket, the audio socket (when enabled), and the control socket *before* reading anything, because the v4.0 server accepts all of them before it sends metadata. It reads one dummy byte, a 64-byte device name, an H.264 codec id, a 12-byte session packet with width/height, then 12-byte-framed H.264 packets.
4. The main process parses frames and streams them to the renderer over IPC. The renderer decodes with WebCodecs `VideoDecoder` and paints to a canvas.
5. Renderer input is mapped to scrcpy control messages and written to the control socket in the main process.

Full detail: [ARCHITECTURE.md](ARCHITECTURE.md) and [docs/protocol.md](docs/protocol.md).

## Security posture

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- Strict CSP, no `connect-src`, no remote content, no `<webview>`
- All IPC handlers validate types, ranges, serials, device paths, and host:port strings
- `adb` is always spawned with an argument array; no shell strings and no concatenation of untrusted input
- The device server jar is checksum-verified against the published v4.0 SHA-256
- Permission requests, downloads, popups, and navigation are blocked

## Legal

Twinlink is an independent project. It is **not** affiliated with, endorsed by, or an official product of Google, Android, Genymobile, or scrcpy. It uses the official scrcpy server under the Apache License 2.0; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Only mirror devices you own or are authorized to access.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — components and data flow
- [docs/protocol.md](docs/protocol.md) — verified scrcpy v4.0 wire protocol
- [checks/README.md](checks/README.md) — what the automated checks prove
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) — bundled scrcpy server attribution
