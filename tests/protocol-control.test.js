'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const control = require('../src/core/protocol/control');
const { CONTROL_TYPE, POINTER_ID_MOUSE } = require('../src/core/protocol/constants');

test('keycode message matches the 14-byte v4.0 layout', () => {
  const buf = control.injectKeycode({ action: 0, keycode: 4, repeat: 0, metastate: 0, metaState: 0 });

  assert.equal(buf.length, 14);
  assert.equal(buf[0], CONTROL_TYPE.INJECT_KEYCODE);
  assert.equal(buf[1], 0);
  assert.equal(buf.readInt32BE(2), 4);
  assert.equal(buf.readUInt32BE(6), 0);
  assert.equal(buf.readInt32BE(10), 0);
});

test('text message is length-prefixed UTF-8', () => {
  const buf = control.injectText('héllo');
  const bytes = Buffer.from('héllo', 'utf8');

  assert.equal(buf[0], CONTROL_TYPE.INJECT_TEXT);
  assert.equal(buf.readUInt32BE(1), bytes.length);
  assert.equal(buf.subarray(5).toString('utf8'), 'héllo');
  assert.equal(buf.length, 5 + bytes.length);
});

test('text is truncated at a UTF-8 boundary to 300 bytes', () => {
  const buf = control.injectText('é'.repeat(300));
  const length = buf.readUInt32BE(1);

  assert.ok(length <= 300);
  assert.equal(length % 2, 0, 'truncation must not split a 2-byte character');
  assert.equal(buf.subarray(5).toString('utf8'), 'é'.repeat(length / 2));
});

test('touch message matches the 32-byte v4.0 layout', () => {
  const buf = control.injectTouch({
    action: 0,
    pointerId: POINTER_ID_MOUSE,
    position: { x: 100, y: 200, screenWidth: 720, screenHeight: 1280 },
    pressure: 1,
    actionButton: 1,
    buttons: 1,
  });

  assert.equal(buf.length, 32);
  assert.equal(buf[0], CONTROL_TYPE.INJECT_TOUCH_EVENT);
  assert.equal(buf[1], 0);
  assert.equal(buf.readBigInt64BE(2), -1n);
  assert.equal(buf.readInt32BE(10), 100);
  assert.equal(buf.readInt32BE(14), 200);
  assert.equal(buf.readUInt16BE(18), 720);
  assert.equal(buf.readUInt16BE(20), 1280);
  assert.equal(buf.readUInt16BE(22), 0xffff);
  assert.equal(buf.readInt32BE(24), 1);
  assert.equal(buf.readInt32BE(28), 1);
});

test('touch coordinates are clamped to the video size', () => {
  const buf = control.injectTouch({
    action: 2,
    position: { x: -50, y: 99999, screenWidth: 1080, screenHeight: 1920 },
    pressure: 0.5,
  });

  assert.equal(buf.readInt32BE(10), -50);
  assert.equal(buf.readInt32BE(14), 99999);
  assert.equal(buf.readUInt16BE(22), 0x8000);
});

test('scroll message normalizes raw units to 16-bit fixed point', () => {
  const buf = control.injectScroll({
    position: { x: 10, y: 20, screenWidth: 720, screenHeight: 1280 },
    hscroll: 0,
    vscroll: 16,
    buttons: 0,
  });

  assert.equal(buf.length, 21);
  assert.equal(buf[0], CONTROL_TYPE.INJECT_SCROLL_EVENT);
  assert.equal(buf.readInt16BE(13), 0); // hscroll
  assert.equal(buf.readInt16BE(15), 32767); // vscroll
  assert.equal(buf.readInt32BE(17), 0);

  const half = control.injectScroll({
    position: { x: 0, y: 0, screenWidth: 100, screenHeight: 100 },
    hscroll: -8,
    vscroll: 8,
  });
  assert.equal(half.readInt16BE(13), -16384);
  assert.equal(half.readInt16BE(15), 16384);
});

test('zero-payload control messages are single bytes', () => {
  assert.deepEqual([...control.rotateDevice()], [CONTROL_TYPE.ROTATE_DEVICE]);
  assert.deepEqual([...control.expandNotificationPanel()], [CONTROL_TYPE.EXPAND_NOTIFICATION_PANEL]);
  assert.deepEqual([...control.expandSettingsPanel()], [CONTROL_TYPE.EXPAND_SETTINGS_PANEL]);
  assert.deepEqual([...control.collapsePanels()], [CONTROL_TYPE.COLLAPSE_PANELS]);
});

test('display power and back messages use two bytes', () => {
  assert.deepEqual([...control.setDisplayPower(true)], [CONTROL_TYPE.SET_DISPLAY_POWER, 1]);
  assert.deepEqual([...control.setDisplayPower(false)], [CONTROL_TYPE.SET_DISPLAY_POWER, 0]);
  assert.deepEqual([...control.backOrScreenOn(1)], [CONTROL_TYPE.BACK_OR_SCREEN_ON, 1]);
});

test('start app uses a single-byte length prefix', () => {
  const buf = control.startApp('com.android.settings');
  assert.equal(buf[0], CONTROL_TYPE.START_APP);
  assert.equal(buf[1], Buffer.byteLength('com.android.settings'));
  assert.equal(buf.subarray(2).toString('utf8'), 'com.android.settings');
});

test('non-finite coordinates are rejected', () => {
  assert.throws(
    () => control.injectTouch({ action: 0, position: { x: Number.NaN, y: 0, screenWidth: 10, screenHeight: 10 } }),
    /finite number/,
  );
});
