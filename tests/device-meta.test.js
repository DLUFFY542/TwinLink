'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DeviceMetaParser } = require('../src/core/protocol/device-meta');
const { DEVICE_NAME_FIELD_LENGTH } = require('../src/core/protocol/constants');

function metaPacket(name) {
  const field = Buffer.alloc(DEVICE_NAME_FIELD_LENGTH);
  Buffer.from(name, 'utf8').copy(field, 0, 0, DEVICE_NAME_FIELD_LENGTH - 1);
  return field;
}

test('device metadata is a dummy byte followed by a 64-byte NUL-padded name', () => {
  const parser = new DeviceMetaParser();
  const packet = Buffer.concat([Buffer.from([0]), metaPacket('Pixel 7 Pro')]);

  const first = parser.push(packet.subarray(0, 10));
  assert.equal(first.name, null);
  assert.equal(parser.done, false);

  const result = parser.push(packet.subarray(10));
  assert.equal(parser.done, true);
  assert.equal(result.name, 'Pixel 7 Pro');
});

test('device metadata is robust to one-byte-at-a-time delivery', () => {
  const parser = new DeviceMetaParser();
  const packet = Buffer.concat([Buffer.from([0]), metaPacket('SM_G973F')]);
  const names = [];

  for (const byte of packet) {
    const result = parser.push(Buffer.from([byte]));
    if (result.name !== null) names.push(result.name);
  }

  assert.deepEqual(names, ['SM_G973F']);
});

test('bytes after the metadata field are returned as rest', () => {
  const parser = new DeviceMetaParser();
  const trailing = Buffer.from([0x68, 0x32, 0x36, 0x34]);
  const packet = Buffer.concat([Buffer.from([0]), metaPacket('Phone'), trailing]);

  const result = parser.push(packet);
  assert.equal(result.name, 'Phone');
  assert.deepEqual([...result.rest], [...trailing]);
});

test('dummy byte can be disabled (server without send_dummy_byte)', () => {
  const parser = new DeviceMetaParser({ expectDummyByte: false });
  const result = parser.push(metaPacket('Solo Phone'));

  assert.equal(result.name, 'Solo Phone');
});

test('UTF-8 device names survive the fixed-size field', () => {
  const parser = new DeviceMetaParser();
  const result = parser.push(Buffer.concat([Buffer.from([0]), metaPacket('Téléphone Élite')]));
  assert.equal(result.name, 'Téléphone Élite');
});
