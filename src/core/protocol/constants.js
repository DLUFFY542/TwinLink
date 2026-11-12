'use strict';

/**
 * Wire constants for the scrcpy server protocol, pinned to scrcpy v4.0.
 *
 * Verified against tag v4.0 of Genymobile/scrcpy:
 *   - server/.../device/Streamer.java   (packet flags, header layout)
 *   - server/.../device/DesktopConnection.java (device name field, dummy byte)
 *   - server/.../control/ControlMessage.java   (message type ids)
 *   - app/src/control_msg.c                    (client-side serialization)
 *
 * The client and the server must run the exact same version.
 */

const SCRCPY_VERSION = '4.0';

// Four-character codec ids packed as a big-endian int32.
const VIDEO_CODEC_IDS = Object.freeze({
  0x68323634: 'h264',
  0x68323635: 'h265',
  0x00617631: 'av1',
});

const AUDIO_CODEC_IDS = Object.freeze({
  0x6f707573: 'opus',
  0x00616163: 'aac',
  0x666c6163: 'flac',
  0x00726177: 'raw',
});

// Streamer.java: PACKET_FLAG_SESSION = 1L << 63, CONFIG = 1L << 62, KEY_FRAME = 1L << 61.
const PACKET_FLAG_SESSION = 1n << 63n;
const PACKET_FLAG_CONFIG = 1n << 62n;
const PACKET_FLAG_KEY_FRAME = 1n << 61n;
const PACKET_PTS_MASK = (1n << 61n) - 1n;

const DEVICE_NAME_FIELD_LENGTH = 64;

// ControlMessage.java type ids (identical ordering in app/src/control_msg.h).
const CONTROL_TYPE = Object.freeze({
  INJECT_KEYCODE: 0,
  INJECT_TEXT: 1,
  INJECT_TOUCH_EVENT: 2,
  INJECT_SCROLL_EVENT: 3,
  BACK_OR_SCREEN_ON: 4,
  EXPAND_NOTIFICATION_PANEL: 5,
  EXPAND_SETTINGS_PANEL: 6,
  COLLAPSE_PANELS: 7,
  GET_CLIPBOARD: 8,
  SET_CLIPBOARD: 9,
  SET_DISPLAY_POWER: 10,
  ROTATE_DEVICE: 11,
  UHID_CREATE: 12,
  UHID_INPUT: 13,
  UHID_DESTROY: 14,
  OPEN_HARD_KEYBOARD_SETTINGS: 15,
  START_APP: 16,
  RESET_VIDEO: 17,
  CAMERA_SET_TORCH: 18,
  CAMERA_ZOOM_IN: 19,
  CAMERA_ZOOM_OUT: 20,
  RESIZE_DISPLAY: 21,
});

// android.view.MotionEvent actions used by the touch message.
const MOTION_ACTION = Object.freeze({
  DOWN: 0,
  UP: 1,
  MOVE: 2,
  CANCEL: 3,
});

// android.view.KeyEvent actions.
const KEY_ACTION = Object.freeze({
  DOWN: 0,
  UP: 1,
});

// Scrcpy pointer id sentinels (app/src/control_msg.h).
const POINTER_ID_MOUSE = -1n;
const POINTER_ID_GENERIC_FINGER = -2n;
const POINTER_ID_VIRTUAL_FINGER = -3n;

// Android KeyEvent keycodes used by the UI controls.
const ANDROID_KEYCODE = Object.freeze({
  HOME: 3,
  BACK: 4,
  CALL: 5,
  ENDCALL: 6,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  CAMERA: 27,
  MENU: 82,
  NOTIFICATION: 83,
  SEARCH: 84,
  MEDIA_PLAY_PAUSE: 85,
  MEDIA_STOP: 86,
  MEDIA_NEXT: 87,
  MEDIA_PREVIOUS: 88,
  MEDIA_REWIND: 89,
  MEDIA_FAST_FORWARD: 90,
  MUTE: 91,
  PAGE_UP: 92,
  PAGE_DOWN: 93,
  APP_SWITCH: 187,
  BRIGHTNESS_DOWN: 220,
  BRIGHTNESS_UP: 221,
  MEDIA_AUDIO_TRACK: 222,
  SLEEP: 223,
  WAKEUP: 224,
  ENTER: 66,
  DEL: 67,
  TAB: 61,
  ESCAPE: 111,
  FORWARD_DEL: 112,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_CENTER: 23,
  MOVE_HOME: 122,
  MOVE_END: 123,
  INSERT: 124,
  SPACE: 62,
  SYSRQ: 120,
});

const CONTROL_MSG_MAX_SIZE = 1 << 18; // 256 KiB
const INJECT_TEXT_MAX_LENGTH = 300;

module.exports = {
  SCRCPY_VERSION,
  VIDEO_CODEC_IDS,
  AUDIO_CODEC_IDS,
  PACKET_FLAG_SESSION,
  PACKET_FLAG_CONFIG,
  PACKET_FLAG_KEY_FRAME,
  PACKET_PTS_MASK,
  DEVICE_NAME_FIELD_LENGTH,
  CONTROL_TYPE,
  MOTION_ACTION,
  KEY_ACTION,
  POINTER_ID_MOUSE,
  POINTER_ID_GENERIC_FINGER,
  POINTER_ID_VIRTUAL_FINGER,
  ANDROID_KEYCODE,
  CONTROL_MSG_MAX_SIZE,
  INJECT_TEXT_MAX_LENGTH,
};
