'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { AdbClient } = require('../src/core/adb/adb-client');
const { AdbError } = require('../src/core/adb/errors');

const FAKE_ADB = path.join(__dirname, 'helpers', 'fake-adb.js');

function createClient(extraEnv = {}) {
  return new AdbClient({
    adbPath: process.execPath,
    prefixArgs: [FAKE_ADB],
    env: { ...process.env, ...extraEnv },
    timeoutMs: 8000,
  });
}

test('adb version and device listing are executed without a shell', async () => {
  const adb = createClient({
    FAKE_DEVICES:
      'List of devices attached\nR58M12345\tdevice product:beyond1q model:SM_G973F device:beyond1q transport_id:1\n',
  });

  const version = await adb.version();
  assert.equal(version.version, '1.0.41');

  const output = await adb.devicesRaw();
  assert.match(output, /SM_G973F/);
});

test('shell output is returned as text', async () => {
  const adb = createClient();
  const model = await adb.shell('R58M12345', ['getprop', 'ro.product.model']);
  assert.equal(model.trim(), 'Pixel 7');
});

test('non-zero exits become AdbError objects with stderr', async () => {
  const adb = createClient();

  await assert.rejects(adb.exec(['fail']), (err) => {
    assert.ok(err instanceof AdbError);
    assert.equal(err.code, 'EXIT');
    assert.match(err.message, /forced failure/);
    assert.equal(err.details.code, 2);
    return true;
  });
});

test('slow commands time out and are terminated', async () => {
  const adb = createClient();
  const started = Date.now();

  await assert.rejects(adb.exec(['sleep'], { timeoutMs: 300 }), (err) => {
    assert.equal(err.code, 'TIMEOUT');
    return true;
  });

  assert.ok(Date.now() - started < 3000, 'timeout must fire promptly');
});

test('invalid serials, sockets and device paths are rejected before spawning', async () => {
  const adb = createClient();

  await assert.rejects(adb.shell('bad; rm -rf /', ['getprop']), (err) => err.code === 'INVALID_ARGUMENT');
  await assert.rejects(adb.forward('R58M12345', 70000, 'localabstract:scrcpy_00000001'), (err) => err.code === 'INVALID_ARGUMENT');
  await assert.rejects(
    adb.forward('R58M12345', 27183, 'localabstract:scrcpy_00000001; reboot'),
    (err) => err.code === 'INVALID_ARGUMENT',
  );
  await assert.rejects(
    adb.push('R58M12345', __filename, '/data/local/tmp/../../etc/passwd'),
    (err) => err.code === 'INVALID_ARGUMENT',
  );
});

test('missing adb executable is reported as ADB_NOT_FOUND', async () => {
  const adb = new AdbClient({ adbPath: 'C:\\definitely\\not\\here\\adb.exe', env: process.env });
  await assert.rejects(adb.exec(['version']), (err) => err.code === 'ADB_NOT_FOUND');
});

test('wireless addresses and pairing codes are validated', async () => {
  const adb = createClient();

  await assert.rejects(adb.connect('not-an-address'), (err) => err.code === 'INVALID_ARGUMENT');
  await assert.rejects(adb.pair('192.168.1.5:41567', 'abc'), (err) => err.code === 'INVALID_ARGUMENT');

  const paired = await adb.pair('192.168.1.5:41567', '123456');
  assert.match(paired, /pair 192\.168\.1\.5:41567/);
});
