'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SettingsStore } = require('../src/core/settings/settings-store');
const { DEFAULTS, validateSettings } = require('../src/core/settings/schema');

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

function tempFile(name = 'settings.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Twinlink-settings-'));
  return path.join(dir, name);
}

test('missing settings file yields documented defaults', () => {
  const store = new SettingsStore({ filePath: tempFile(), logger: quietLogger });
  const settings = store.load();

  assert.equal(settings.maxSize, 1080);
  assert.equal(settings.maxFps, 60);
  assert.equal(settings.bitrate, 8000000);
  assert.equal(settings.audio, false);
  assert.equal(settings.autoReconnect, true);
  assert.deepEqual(settings, DEFAULTS);
});

test('updates are validated and coerced to safe values', () => {
  const store = new SettingsStore({ filePath: tempFile(), logger: quietLogger });
  store.load();

  const result = store.update({ maxSize: 1000, maxFps: 75, bitrate: 999999999, theme: 'neon', adbPath: 42 });

  assert.equal(result.settings.maxSize, 1080);
  assert.equal(result.settings.maxFps, 60);
  assert.equal(result.settings.bitrate, 50000000);
  assert.equal(result.settings.theme, 'system');
  assert.equal(result.settings.adbPath, '');
  assert.ok(result.warnings.length >= 3);
});

test('only H.264 is accepted as a video codec', () => {
  const { settings, warnings } = validateSettings({ videoCodec: 'h265' });
  assert.equal(settings.videoCodec, 'h264');
  assert.match(warnings.join(' '), /h264/);
});

test('recording format defaults to WebM VP9', () => {
  assert.equal(DEFAULTS.recordingFormat, 'webm-vp9');
  assert.equal(validateSettings({}).settings.recordingFormat, 'webm-vp9');
});

test('every documented recording format is accepted', () => {
  for (const id of ['webm-vp9', 'webm-vp8', 'webm-av1', 'mp4-h264']) {
    const { settings, warnings } = validateSettings({ recordingFormat: id });
    assert.equal(settings.recordingFormat, id);
    assert.deepEqual(warnings, []);
  }
});

test('an unknown recording format falls back to the default with a warning', () => {
  const { settings, warnings } = validateSettings({ recordingFormat: 'video/quicktime' });
  assert.equal(settings.recordingFormat, 'webm-vp9');
  assert.match(warnings.join(' '), /recordingFormat/);
});

test('recording format persists across store instances', () => {
  const filePath = tempFile();
  const first = new SettingsStore({ filePath, logger: quietLogger });
  first.load();
  first.update({ recordingFormat: 'mp4-h264' });

  const second = new SettingsStore({ filePath, logger: quietLogger });
  assert.equal(second.load().recordingFormat, 'mp4-h264');
});

test('settings persist across store instances', () => {
  const filePath = tempFile();
  const first = new SettingsStore({ filePath, logger: quietLogger });
  first.load();
  first.update({ maxSize: 720, maxFps: 30, showTouches: true, scrollSensitivity: 2.5 });

  const second = new SettingsStore({ filePath, logger: quietLogger });
  const loaded = second.load();

  assert.equal(loaded.maxSize, 720);
  assert.equal(loaded.maxFps, 30);
  assert.equal(loaded.showTouches, true);
  assert.equal(loaded.scrollSensitivity, 2.5);
});

test('a corrupt settings file is preserved and replaced with defaults', () => {
  const filePath = tempFile();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{ this is not json', 'utf8');

  const store = new SettingsStore({ filePath, logger: quietLogger });
  const settings = store.load();

  assert.deepEqual(settings, DEFAULTS);
  const backups = fs.readdirSync(path.dirname(filePath)).filter((name) => name.includes('.corrupt-'));
  assert.equal(backups.length, 1);
});

test('scroll sensitivity is clamped and rounded', () => {
  assert.equal(validateSettings({ scrollSensitivity: 99 }).settings.scrollSensitivity, 4);
  assert.equal(validateSettings({ scrollSensitivity: 0.1 }).settings.scrollSensitivity, 0.25);
  assert.equal(validateSettings({ scrollSensitivity: 1.239 }).settings.scrollSensitivity, 1.24);
});

test('reset restores defaults and emits changed', () => {
  const store = new SettingsStore({ filePath: tempFile(), logger: quietLogger });
  store.load();
  store.update({ maxSize: 720 });

  let emitted = null;
  store.on('changed', (settings) => {
    emitted = settings;
  });

  const reset = store.reset();
  assert.equal(reset.maxSize, 1080);
  assert.equal(emitted.maxSize, 1080);
});
