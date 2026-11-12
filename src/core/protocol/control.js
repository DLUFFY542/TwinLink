'use strict';

const {
  CONTROL_TYPE,
  INJECT_TEXT_MAX_LENGTH,
  POINTER_ID_MOUSE,
} = require('./constants');

const INT32_MAX = 0x7fffffff;

function assertFiniteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
}

function clampInt(value, min, max, label) {
  assertFiniteNumber(value, label);
  const rounded = Math.round(value);
  return Math.min(max, Math.max(min, rounded));
}

function fixedPointU16(value) {
  assertFiniteNumber(value, 'pressure');
  const scaled = Math.round(Math.min(1, Math.max(0, value)) * 0x10000);
  return Math.min(0xffff, scaled);
}

function fixedPointI16(value) {
  assertFiniteNumber(value, 'scroll');
  // The client normalizes raw scroll units (range [-16, 16]) to [-1, 1]
  // before converting to 16-bit fixed point.
  const normalized = Math.min(1, Math.max(-1, value / 16));
  return Math.min(0x7fff, Math.max(-0x8000, Math.round(normalized * 0x8000)));
}

function writePosition(buf, offset, position) {
  const { x, y, screenWidth, screenHeight } = position || {};
  buf.writeInt32BE(clampInt(x, -INT32_MAX, INT32_MAX, 'x'), offset);
  buf.writeInt32BE(clampInt(y, -INT32_MAX, INT32_MAX, 'y'), offset + 4);
  buf.writeUInt16BE(clampInt(screenWidth, 0, 0xffff, 'screenWidth'), offset + 8);
  buf.writeUInt16BE(clampInt(screenHeight, 0, 0xffff, 'screenHeight'), offset + 10);
}

function truncateUtf8(text, maxBytes) {
  const bytes = Buffer.from(String(text), 'utf8');
  if (bytes.length <= maxBytes) {
    return bytes;
  }
  let end = maxBytes;
  // Do not split a multi-byte sequence.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return bytes.subarray(0, end);
}

function injectKeycode({ action, keycode, repeat = 0, metaState = 0 }) {
  const buf = Buffer.alloc(14);
  buf.writeUInt8(CONTROL_TYPE.INJECT_KEYCODE, 0);
  buf.writeUInt8(action & 0xff, 1);
  buf.writeInt32BE(clampInt(keycode, 0, INT32_MAX, 'keycode'), 2);
  buf.writeUInt32BE(clampInt(repeat, 0, 0xffffffff, 'repeat'), 6);
  buf.writeInt32BE(clampInt(metaState, 0, INT32_MAX, 'metaState'), 10);
  return buf;
}

function injectText(text) {
  const bytes = truncateUtf8(text, INJECT_TEXT_MAX_LENGTH);
  const buf = Buffer.alloc(5 + bytes.length);
  buf.writeUInt8(CONTROL_TYPE.INJECT_TEXT, 0);
  buf.writeUInt32BE(bytes.length, 1);
  bytes.copy(buf, 5);
  return buf;
}

function injectTouch({
  action,
  pointerId = POINTER_ID_MOUSE,
  position,
  pressure = 1,
  actionButton = 0,
  buttons = 0,
}) {
  const buf = Buffer.alloc(32);
  buf.writeUInt8(CONTROL_TYPE.INJECT_TOUCH_EVENT, 0);
  buf.writeUInt8(action & 0xff, 1);
  buf.writeBigInt64BE(BigInt(pointerId), 2);
  writePosition(buf, 10, position);
  buf.writeUInt16BE(fixedPointU16(pressure), 22);
  buf.writeInt32BE(clampInt(actionButton, -INT32_MAX, INT32_MAX, 'actionButton'), 24);
  buf.writeInt32BE(clampInt(buttons, -INT32_MAX, INT32_MAX, 'buttons'), 28);
  return buf;
}

/**
 * @param {{position: object, hscroll?: number, vscroll?: number, buttons?: number}} input
 *        scroll values are in scrcpy raw units, typically +/-16 per wheel notch.
 */
function injectScroll({ position, hscroll = 0, vscroll = 0, buttons = 0 }) {
  const buf = Buffer.alloc(21);
  buf.writeUInt8(CONTROL_TYPE.INJECT_SCROLL_EVENT, 0);
  writePosition(buf, 1, position);
  buf.writeInt16BE(fixedPointI16(hscroll), 13);
  buf.writeInt16BE(fixedPointI16(vscroll), 15);
  buf.writeInt32BE(clampInt(buttons, -INT32_MAX, INT32_MAX, 'buttons'), 17);
  return buf;
}

function backOrScreenOn(action) {
  return Buffer.from([CONTROL_TYPE.BACK_OR_SCREEN_ON, action & 0xff]);
}

function setDisplayPower(on) {
  return Buffer.from([CONTROL_TYPE.SET_DISPLAY_POWER, on ? 1 : 0]);
}

function rotateDevice() {
  return Buffer.from([CONTROL_TYPE.ROTATE_DEVICE]);
}

function expandNotificationPanel() {
  return Buffer.from([CONTROL_TYPE.EXPAND_NOTIFICATION_PANEL]);
}

function expandSettingsPanel() {
  return Buffer.from([CONTROL_TYPE.EXPAND_SETTINGS_PANEL]);
}

function collapsePanels() {
  return Buffer.from([CONTROL_TYPE.COLLAPSE_PANELS]);
}

function startApp(name) {
  const bytes = truncateUtf8(name, 255);
  const buf = Buffer.alloc(2 + bytes.length);
  buf.writeUInt8(CONTROL_TYPE.START_APP, 0);
  buf.writeUInt8(bytes.length, 1);
  bytes.copy(buf, 2);
  return buf;
}

module.exports = {
  injectKeycode,
  injectText,
  injectTouch,
  injectScroll,
  backOrScreenOn,
  setDisplayPower,
  rotateDevice,
  expandNotificationPanel,
  expandSettingsPanel,
  collapsePanels,
  startApp,
  truncateUtf8,
  fixedPointU16,
  fixedPointI16,
};
