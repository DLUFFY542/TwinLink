# scrcpy v4.0 wire protocol (verified)

Sources inspected at tag **`v4.0`** of `Genymobile/scrcpy`
(commit `9c0c299ea2628d858012f66371eb2fc70988ba07`):

- `server/src/main/java/com/genymobile/scrcpy/device/DesktopConnection.java`
- `server/src/main/java/com/genymobile/scrcpy/device/Streamer.java`
- `server/src/main/java/com/genymobile/scrcpy/control/ControlMessage.java`
- `server/src/main/java/com/genymobile/scrcpy/control/Controller.java`
- `server/src/main/java/com/genymobile/scrcpy/Options.java`
- `app/src/server.c`, `app/src/control_msg.c`, `app/src/demuxer.c`
- Release asset `scrcpy-server-v4.0` and `SHA256SUMS.txt`

All multi-byte integers are **big-endian**. The client and server must run the
**same version string**; the server throws
`The server version (...) does not match the client (...)` otherwise.

## 1. Transport

Twinlink launches the server with `tunnel_forward=true`. The server listens on an
abstract Unix socket named `scrcpy_<scid>` (scid is 8 lowercase hex digits).
Twinlink creates:

```
adb forward tcp:<local> localabstract:scrcpy_<scid>
```

and connects to `127.0.0.1:<local>`. **One forwarded port carries all sockets**,
accepted by the server in this order:

1. video (always, while video is enabled)
2. audio (only when audio is enabled)
3. control (when control is enabled)

The first socket receives the handshake. A message on the control socket is not
required at connection time; the server blocks reading the first type byte, so
any valid control message may be first.

## 2. Handshake (first socket only)

When `send_dummy_byte=true` (default) and `tunnel_forward=true`:

| Bytes | Content |
| --- | --- |
| 1 | `0x00` dummy byte |
| 64 | device name, UTF-8, NUL-padded, truncated to 63 UTF-8 bytes |

The dummy byte exists because the adb tunnel can accept a connection before the
server is listening; reading one byte proves the pipe is live. The name has **no
length prefix**.

**Connection ordering is part of the protocol.** `DesktopConnection.open()`
accepts, in order:

1. video (writes the dummy byte immediately),
2. audio (only when `audio=true`),
3. control (only when `control=true`),

and only **after all expected sockets are accepted** does `sendDeviceMeta()`
write the 64-byte name. A client that waits for the name before opening the
control socket deadlocks: the server is blocked in `accept()` and the client is
blocked in `read()`.

Twinlink therefore connects video, then audio (if enabled), then control, and only
then reads metadata. It also waits for the dummy byte before treating a TCP
connect as live, retrying while the device server starts. This ordering was
confirmed on hardware: the official v4.0 client mirrors the test phone, and the
first Twinlink attempt reproduced the deadlock until the order was corrected.

## 3. Video stream

### 3.1 Codec id

One big-endian `u32` when `send_stream_meta=true` (default):

| Codec | Id |
| --- | --- |
| H.264 | `0x68323634` (`h264`) |
| H.265 | `0x68323635` (`h265`) |
| AV1 | `0x00617631` (`av1`) |

Audio ids: OPUS `0x6f707573`, AAC `0x00616163`, FLAC `0x666c6163`, RAW `0x00726177`.

A codec id of `0` means the stream is explicitly disabled; `1` means a
configuration error and the session must stop. (Sent as four raw bytes.)

### 3.2 Session packet (video only)

12 bytes, after the codec id:

| Offset | Type | Meaning |
| --- | --- | --- |
| 0 | `u32` | `0x80000000`, bit 0 set if the client resized the display |
| 4 | `u32` | video width |
| 8 | `u32` | video height |

`header[0] & 0x80` distinguishes a session packet from a media header.
`header[3] & 0x01` is the client-resized flag. Width/height are read at 4 and 8.

### 3.3 Media packets

Each frame: 12-byte header then payload.

| Offset | Type | Meaning |
| --- | --- | --- |
| 0 | `u64` | PTS in the low 61 bits, plus flags |
| 8 | `u32` | payload size in bytes |

Flags:

- bit 63 — `PACKET_FLAG_SESSION` (never set on media packets)
- bit 62 — `PACKET_FLAG_CONFIG` (SPS/PPS codec configuration)
- bit 61 — `PACKET_FLAG_KEY_FRAME`

The config packet precedes key frames and contains Annex-B SPS/PPS. The payload
itself is Annex-B H.264. Frame payloads may repeat SPS/PPS.

## 4. Control messages

First byte is the message type:

| Id | Message | Size |
| --- | --- | --- |
| 0 | `INJECT_KEYCODE` | 14 |
| 1 | `INJECT_TEXT` | 5 + len |
| 2 | `INJECT_TOUCH_EVENT` | 32 |
| 3 | `INJECT_SCROLL_EVENT` | 21 |
| 4 | `BACK_OR_SCREEN_ON` | 2 |
| 5 | `EXPAND_NOTIFICATION_PANEL` | 1 |
| 6 | `EXPAND_SETTINGS_PANEL` | 1 |
| 7 | `COLLAPSE_PANELS` | 1 |
| 10 | `SET_DISPLAY_POWER` | 2 |
| 11 | `ROTATE_DEVICE` | 1 |
| 16 | `START_APP` | 2 + len |

Layouts (all big-endian):

```
KEYCODE  u8 type=0 | u8 action | i32 keycode | u32 repeat | i32 metaState
TEXT     u8 type=1 | u32 len | len bytes UTF-8          (max 300 bytes)
TOUCH    u8 type=2 | u8 action | i64 pointerId |
         i32 x | i32 y | u16 screenWidth | u16 screenHeight |
         u16 pressure | i32 actionButton | i32 buttons
SCROLL   u8 type=3 | i32 x | i32 y | u16 screenWidth | u16 screenHeight |
         i16 hscroll | i16 vscroll | i32 buttons
BACK     u8 type=4 | u8 action
POWER    u8 type=10 | u8 on
ROTATE   u8 type=11
STARTAPP u8 type=16 | u8 len | len bytes UTF-8          (max 255 bytes)
```

Semantics:

- Touch actions: `0=DOWN`, `1=UP`, `2=MOVE` (also 3=CANCEL, 7=HOVER_MOVE,
  8=SCROLL). The server rewrites secondary pointers itself.
- Pointer ids: mouse `-1`, generic finger `-2`, virtual finger `-3` (as `i64`).
- Pressure is 16-bit fixed point: `round(clamp(f,0,1) * 65536)`, capped at
  `0xffff`. Twinlink uses `0xffff` while pressed and `0` on release.
- Scroll raw units are wheel notches in `[-16, 16]`. The client divides by 16,
  then converts to fixed point `round(v/16 * 32768)`, clamped to `±32767`.
  Twinlink converts CSS pixel deltas to notches using 100 px per notch.
- `INJECT_TEXT` is truncated at a UTF-8 boundary to 300 bytes.

## 5. Server command line

```
CLASSPATH=/data/local/tmp/Twinlink-scrcpy-server.jar app_process / \
  com.genymobile.scrcpy.Server 4.0 <key=value>...
```

Twinlink passes:

```
scid=<hex> log_level=info tunnel_forward=true video=true audio=<bool>
control=true send_device_meta=true send_dummy_byte=true send_stream_meta=true
cleanup=true clipboard_autosync=false power_on=<bool> stay_awake=<bool>
show_touches=<bool> video_codec=h264 [max_size=N] [max_fps=N]
[video_bit_rate=N] [audio_bit_rate=N]
```

Notes:

- Unknown keys are ignored by the server (warning only).
- `audio=false` means the server accepts **no** audio socket; the client must not
  open one. Twinlink opens the audio socket only when audio is enabled.
- `clipboard_autosync=false` means no clipboard traffic is expected.

## 6. Verification performed

- Byte-layout assertions for every control message in
  `tests/protocol-control.test.js`.
- Stream parser fragmentation (7-byte chunks), session packets, disabled stream,
  oversized packet rejection in `tests/protocol-video.test.js`.
- Handshake and metadata parsing in `tests/device-meta.test.js`.
- Real H.264 through the parser and renderer decoder in
  `checks/pipeline.js` (30/30 frames, 720×1280).
- Control socket delivery observed in the same check (`0b`).

Not verified: behaviour against a physical Android device.
