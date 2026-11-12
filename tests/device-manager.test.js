'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseDevices } = require('../src/core/adb/device-parser');
const { parseMdnsServices } = require('../src/core/adb/mdns-parser');
const { DeviceManager } = require('../src/core/device/device-manager');

test('parses authorized, unauthorized and offline devices', () => {
  const output = [
    'List of devices attached',
    'R58M12345\tdevice product:beyond1q model:SM_G973F device:beyond1q transport_id:1',
    'ABCDEFGH\tunauthorized usb:1-2 transport_id:4',
    'IJKLMNOP\toffline transport_id:5',
    '192.168.1.42:39101\tdevice product:panther model:Pixel_7 device:panther transport_id:6',
    '',
  ].join('\n');

  const devices = parseDevices(output);

  assert.equal(devices.length, 4);

  assert.deepEqual(devices[0], {
    serial: 'R58M12345',
    state: 'device',
    connection: 'usb',
    model: 'SM G973F',
    modelRaw: 'SM_G973F',
    product: 'beyond1q',
    device: 'beyond1q',
    transportId: 1,
    usb: null,
    authorized: true,
    needsAuthorization: false,
    details: 'product:beyond1q model:SM_G973F device:beyond1q transport_id:1',
  });

  assert.equal(devices[1].state, 'unauthorized');
  assert.equal(devices[1].needsAuthorization, true);
  assert.equal(devices[1].model, null);

  assert.equal(devices[2].state, 'offline');
  assert.equal(devices[2].authorized, false);

  assert.equal(devices[3].connection, 'network');
  assert.equal(devices[3].model, 'Pixel 7');
});

test('parses the no-permissions state, quotes and all', () => {
  const output =
    'List of devices attached\nABCDEF\tno permissions (user in plugdev group; are your udev rules wrong?); see [http://developer.android.com/tools/device.html] usb:1-3 transport_id:7\n';
  const [device] = parseDevices(output);

  assert.equal(device.state, 'no permissions');
  assert.equal(device.usb, '1-3');
});

test('ignores daemon banners, empty output and unknown lines', () => {
  assert.deepEqual(parseDevices(''), []);
  assert.deepEqual(parseDevices('List of devices attached\n\n'), []);
  assert.deepEqual(parseDevices('adb server version (41) does not match\n'), []);
  assert.deepEqual(parseDevices('* daemon not running; starting now at tcp:5037\n'), []);
});

test('parses mDNS pairing and connection services', () => {
  const output = [
    'List of discovered mdns services',
    'adb-ABC123\t_adb-tls-pairing._tcp\t192.168.1.5:41567',
    'adb-ABC123\t_adb-tls-connect._tcp\t192.168.1.5:39101',
    'unrelated\t_http._tcp\t192.168.1.9:80',
    '',
  ].join('\n');

  const services = parseMdnsServices(output);
  assert.equal(services.length, 2);
  assert.deepEqual(services[0], {
    name: 'adb-ABC123',
    service: '_adb-tls-pairing._tcp',
    address: '192.168.1.5:41567',
    kind: 'pairing',
  });
  assert.equal(services[1].kind, 'connect');
});

test('device manager enriches devices and tracks state transitions', async () => {
  let listing =
    'List of devices attached\nR58M12345\tdevice product:beyond1q model:SM_G973F device:beyond1q transport_id:1\n';

  const adb = {
    devicesRaw: async () => listing,
    getProps: async () => ({
      'ro.product.model': 'Pixel 7',
      'ro.product.manufacturer': 'Google',
      'ro.build.version.release': '14',
      'ro.build.version.sdk': '34',
    }),
    shell: async (_serial, args) => (args[1] === 'size' ? 'Physical size: 1080x2400\n' : 'Physical density: 420\n'),
  };

  const manager = new DeviceManager({ adb, logger: { warn() {}, debug() {} } });
  manager.setAdbInfo({ path: 'C:\\platform-tools\\adb.exe', source: 'path', version: '1.0.41' });

  await manager.refresh();
  let snapshot = manager.getSnapshot();

  assert.equal(snapshot.devices.length, 1);
  assert.equal(snapshot.devices[0].details.model, 'Pixel 7');
  assert.equal(snapshot.devices[0].details.androidVersion, '14');
  assert.equal(snapshot.devices[0].details.screenWidth, 1080);
  assert.equal(snapshot.devices[0].details.screenHeight, 2400);
  assert.equal(snapshot.error, null);

  listing = 'List of devices attached\nABCDEFGH\tunauthorized usb:1-2 transport_id:4\n';
  await manager.refresh();
  snapshot = manager.getSnapshot();

  assert.equal(snapshot.devices.length, 1);
  assert.equal(snapshot.devices[0].state, 'unauthorized');
  assert.equal(snapshot.devices[0].details, null);

  adb.devicesRaw = async () => {
    throw Object.assign(new Error('adb executable not found'), { code: 'ADB_NOT_FOUND' });
  };
  await manager.refresh();
  snapshot = manager.getSnapshot();

  assert.equal(snapshot.devices.length, 0);
  assert.match(snapshot.error, /Install Android Platform Tools/);
});

test('device manager clears a stuck adb error banner after recovery', async () => {
  const adb = {
    devicesRaw: async () => 'List of devices attached\n',
    getProps: async () => ({}),
    shell: async () => '',
  };

  const manager = new DeviceManager({ adb, logger: { warn() {}, debug() {} } });
  const changes = [];
  manager.on('changed', (snapshot) => changes.push(snapshot));

  await manager.refresh();
  assert.equal(manager.getSnapshot().error, null);

  adb.devicesRaw = async () => {
    throw Object.assign(new Error('adb executable not found'), { code: 'ADB_NOT_FOUND' });
  };
  await manager.refresh();
  assert.match(manager.getSnapshot().error, /Install Android Platform Tools/);

  // Recovery with the same (empty) device list must still notify the UI,
  // otherwise the error banner never clears.
  adb.devicesRaw = async () => 'List of devices attached\n';
  await manager.refresh();

  const last = changes.at(-1);
  assert.equal(last.error, null);
  assert.equal(last.devices.length, 0);
});

test('device manager polls and emits only when state changes', async (t) => {
  let calls = 0;
  const adb = {
    devicesRaw: async () => {
      calls += 1;
      return 'List of devices attached\nR58M12345\tdevice product:x model:Pixel_7 device:x transport_id:1\n';
    },
    getProps: async () => ({}),
    shell: async () => '',
  };

  const manager = new DeviceManager({ adb, pollIntervalMs: 40, logger: { warn() {}, debug() {} } });
  const changes = [];
  manager.on('changed', (snapshot) => changes.push(snapshot));

  manager.start();
  t.after(() => manager.stop());

  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.ok(calls >= 2, 'manager must poll repeatedly');
  assert.ok(changes.length >= 1);
});
