'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { InputInjector } = require('../src/core/control/injector');
const { CONTROL_TYPE } = require('../src/core/protocol/constants');

function createInjector(size = { width: 1000, height: 2000 }) {
  const sent = [];
  const injector = new InputInjector({
    getVideoSize: () => size,
    send: (buffer) => {
      sent.push(buffer);
      return true;
    },
    logger: { debug() {}, warn() {} },
  });
  return { injector, sent };
}

test('touch input is validated and serialized with the stream size', () => {
  const { injector, sent } = createInjector();
  const result = injector.handle({ type: 'touch', action: 0, x: 500, y: 1000 });

  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].length, 32);
  assert.equal(sent[0][0], CONTROL_TYPE.INJECT_TOUCH_EVENT);
  assert.equal(sent[0].readInt32BE(10), 500);
  assert.equal(sent[0].readInt32BE(14), 1000);
  assert.equal(sent[0].readUInt16BE(18), 1000);
  assert.equal(sent[0].readUInt16BE(20), 2000);
});

test('input is refused before the first video frame', () => {
  const { injector, sent } = createInjector({ width: 0, height: 0 });
  const result = injector.handle({ type: 'touch', action: 0, x: 1, y: 1 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'video stream not ready');
  assert.equal(sent.length, 0);
});

test('scroll converts pixels into scrcpy raw units', () => {
  const { injector, sent } = createInjector();
  const result = injector.handle({ type: 'scroll', x: 10, y: 20, deltaX: 0, deltaY: 100, sensitivity: 1 });

  assert.equal(result.ok, true);
  assert.equal(sent[0].length, 21);
  assert.equal(sent[0].readInt16BE(15), 32767); // 16 raw units == full scale
});

test('printable keys are injected as text, shortcuts as key codes', () => {
  const { injector, sent } = createInjector();

  injector.handle({ type: 'keyboard', phase: 'down', key: 'a', code: 'KeyA' });
  assert.equal(sent[0][0], CONTROL_TYPE.INJECT_TEXT);
  assert.equal(sent[0].subarray(5).toString('utf8'), 'a');

  injector.handle({ type: 'keyboard', phase: 'down', key: 'a', code: 'KeyA', ctrlKey: true });
  assert.equal(sent[1][0], CONTROL_TYPE.INJECT_KEYCODE);
  assert.equal(sent[1].readInt32BE(2), 29); // KEYCODE_A
  assert.equal(sent[1].readInt32BE(10), 4096); // META_CTRL_ON
});

test('navigation and volume actions send key down and up', () => {
  const { injector, sent } = createInjector();

  const result = injector.handle({ type: 'action', name: 'back' });
  assert.equal(result.ok, true);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].readInt32BE(2), 4);
  assert.equal(sent[0][1], 0);
  assert.equal(sent[1][1], 1);

  injector.handle({ type: 'action', name: 'volumeUp' });
  assert.equal(sent[2].readInt32BE(2), 24);
});

test('rotate and panel actions produce single control messages', () => {
  const { injector, sent } = createInjector();

  injector.handle({ type: 'action', name: 'rotate' });
  injector.handle({ type: 'action', name: 'notifications' });
  injector.handle({ type: 'action', name: 'quickSettings' });
  injector.handle({ type: 'action', name: 'collapsePanels' });

  assert.deepEqual(
    sent.map((buf) => buf[0]),
    [
      CONTROL_TYPE.ROTATE_DEVICE,
      CONTROL_TYPE.EXPAND_NOTIFICATION_PANEL,
      CONTROL_TYPE.EXPAND_SETTINGS_PANEL,
      CONTROL_TYPE.COLLAPSE_PANELS,
    ],
  );
});

test('unknown and malformed input is rejected without throwing', () => {
  const { injector, sent } = createInjector();

  assert.equal(injector.handle({ type: 'touch', action: 9, x: 1, y: 1 }).ok, false);
  assert.equal(injector.handle({ type: 'touch', action: 0, x: 'x', y: 1 }).ok, false);
  assert.equal(injector.handle({ type: 'keyboard', phase: 'sideways', key: 'a' }).ok, false);
  assert.equal(injector.handle({ type: 'action', name: 'launchMissiles' }).ok, false);
  assert.equal(injector.handle(null).ok, false);
  assert.equal(sent.length, 0);
});
