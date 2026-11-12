# Third-Party Notices

Twinlink is an independent application. It is not affiliated with, endorsed by, or
an official product of Google, Android, Genymobile, or scrcpy. All trademarks
belong to their respective owners.

## Distributed with Twinlink

### scrcpy-server v4.0

- Project: scrcpy — https://github.com/Genymobile/scrcpy
- Copyright: Romain Vimont and scrcpy contributors
- License: **Apache License 2.0**
- Component: `vendor/scrcpy-server-v4.0.jar` (unmodified official release asset)
- License text: `vendor/scrcpy-LICENSE.txt`
- SHA-256: `84924bd564a1eb6089c872c7521f968058977f91f5ff02514a8c74aff3210f3a`
- Use: the device-side server that captures, encodes, and transmits the screen
  and injects input. Twinlink's client implements the same v4.0 wire protocol.

### Electron

- Project: Electron — https://www.electronjs.org
- Copyright: OpenJS Foundation and Electron contributors
- License: **MIT**
- Use: desktop application runtime (Chromium + Node.js), bundled by electron-builder.

### Chromium

- Project: The Chromium Project — https://www.chromium.org
- License: **BSD 3-Clause** and additional third-party licenses
- Use: rendering engine inside Electron, including WebCodecs, Canvas, and Web Audio.

### Node.js

- Project: Node.js — https://nodejs.org
- License: **MIT**
- Use: main-process runtime inside Electron; build and test tooling.

## Build-time and development tools (not redistributed)

| Component | License | Purpose |
| --- | --- | --- |
| electron-builder 26.18.0 | MIT | Builds the NSIS installer |
| node:test | MIT (Node.js) | Automated tests |
| ffmpeg 9.0.2 (Gyan build, GPL) | GPL | Generates the local H.264 test stream; **not** shipped |
| scrcpy v4.0 Windows release | Apache-2.0 | Manual cross-check against the test phone; downloaded locally for verification, **not** shipped |
| Android SDK Platform Tools (`adb`) | Android SDK License | User-installed host tool; **not** redistributed |

The generated test stream (`checks/.artifacts/test.h264`, derived from FFmpeg's
`testsrc`) is git-ignored and is not part of any installer.

## User-supplied software

Twinlink expects Android Platform Tools (`adb`) to be installed by the user or
located via Settings. Twinlink does not redistribute `adb`; users are bound by the
Android SDK terms when they install it.

## Licenses of Twinlink itself

Twinlink source code is provided under the MIT License (see `package.json`).
The bundled scrcpy server remains under Apache-2.0 and is governed by its own
license text, which is included in `vendor/scrcpy-LICENSE.txt`.

## Compliance notes

- The scrcpy jar is included unmodified; its notices and license are preserved.
- No GPL binary (including ffmpeg) is included in the installer.
- No Google/Android proprietary binaries are included.
- Report licensing concerns before distributing a modified build.
