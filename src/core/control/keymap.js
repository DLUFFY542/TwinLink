'use strict';

const { ANDROID_KEYCODE } = require('../protocol/constants');

// Android KeyEvent metaState bits.
const META = Object.freeze({
  SHIFT: 1,
  ALT: 2,
  CTRL: 4096,
  META: 65536,
  CAPS_LOCK: 1048576,
});

const SPECIAL_CODE_TO_KEYCODE = Object.freeze({
  Enter: ANDROID_KEYCODE.ENTER,
  NumpadEnter: ANDROID_KEYCODE.ENTER,
  Backspace: ANDROID_KEYCODE.DEL,
  Tab: ANDROID_KEYCODE.TAB,
  Escape: ANDROID_KEYCODE.ESCAPE,
  Delete: ANDROID_KEYCODE.FORWARD_DEL,
  ArrowUp: ANDROID_KEYCODE.DPAD_UP,
  ArrowDown: ANDROID_KEYCODE.DPAD_DOWN,
  ArrowLeft: ANDROID_KEYCODE.DPAD_LEFT,
  ArrowRight: ANDROID_KEYCODE.DPAD_RIGHT,
  Home: ANDROID_KEYCODE.MOVE_HOME,
  End: ANDROID_KEYCODE.MOVE_END,
  PageUp: ANDROID_KEYCODE.PAGE_UP,
  PageDown: ANDROID_KEYCODE.PAGE_DOWN,
  Insert: ANDROID_KEYCODE.INSERT,
  CapsLock: 115,
  F1: 131,
  F2: 132,
  F3: 133,
  F4: 134,
  F5: 135,
  F6: 136,
  F7: 137,
  F8: 138,
  F9: 139,
  F10: 140,
  F11: 141,
  F12: 142,
});

// android.view.KeyEvent KEYCODE_A..KEYCODE_Z, KEYCODE_0..KEYCODE_9.
function letterKeycode(code) {
  const match = /^Key([A-Z])$/.exec(code);
  if (match) return 29 + (match[1].charCodeAt(0) - 65);
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return 7 + Number.parseInt(digit[1], 10);
  return null;
}

function metaStateFrom(event) {
  let state = 0;
  if (event.shiftKey) state |= META.SHIFT;
  if (event.altKey) state |= META.ALT;
  if (event.ctrlKey) state |= META.CTRL;
  if (event.metaKey) state |= META.META;
  return state;
}

function keycodeFromEvent(event) {
  if (SPECIAL_CODE_TO_KEYCODE[event.code]) {
    return SPECIAL_CODE_TO_KEYCODE[event.code];
  }
  return letterKeycode(event.code);
}

module.exports = { META, SPECIAL_CODE_TO_KEYCODE, keycodeFromEvent, metaStateFrom, letterKeycode };
