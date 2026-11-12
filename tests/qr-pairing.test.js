'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const jsQR = require('jsqr');
const {
  PAIRING_CODE_PATTERN,
  PAYLOAD_PATTERN,
  buildPairingPayload,
  buildQrMatrix,
  createPairingSession,
} = require('../src/core/wireless/pairing-qr');

const QUIET_ZONE = 4;
const SCALE = 8;

/** Render a QR matrix into an RGBA buffer the way the UI draws it. */
function renderMatrix(matrix) {
  const size = matrix.size;
  const total = size + QUIET_ZONE * 2;
  const width = total * SCALE;
  const height = total * SCALE;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);

  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (!matrix.modules[row][column]) continue;
      for (let dy = 0; dy < SCALE; dy += 1) {
        for (let dx = 0; dx < SCALE; dx += 1) {
          const x = (column + QUIET_ZONE) * SCALE + dx;
          const y = (row + QUIET_ZONE) * SCALE + dy;
          const offset = (y * width + x) * 4;
          data[offset] = 0;
          data[offset + 1] = 0;
          data[offset + 2] = 0;
        }
      }
    }
  }

  return { data, width, height };
}

test('the pairing payload uses Android\'s adb pairing format', () => {
  const payload = buildPairingPayload('adbqr-1a2b3c4d', '042195');
  assert.equal(payload, 'WIFI:T:ADB;S:adbqr-1a2b3c4d;P:042195;;');
  assert.match(payload, PAYLOAD_PATTERN);
});

test('an invalid service name or pairing code is rejected', () => {
  assert.throws(() => buildPairingPayload('not a service', '123456'), /service name/);
  assert.throws(() => buildPairingPayload('adbqr-1a2b3c4d', '12345'), /6 digits/);
  assert.throws(() => buildPairingPayload('adbqr-1a2b3c4d', 'abcdef'), /6 digits/);
});

test('a pairing session carries a 6-digit code and a matching payload', () => {
  const session = createPairingSession();
  assert.match(session.code, PAIRING_CODE_PATTERN);
  assert.match(session.payload, PAYLOAD_PATTERN);
  assert.ok(session.payload.includes(`S:${session.serviceName}`));
  assert.ok(session.payload.includes(`P:${session.code}`));
});

test('every session gets a fresh service name and code', () => {
  const first = createPairingSession();
  const second = createPairingSession();
  assert.notEqual(first.serviceName, second.serviceName);
  assert.notEqual(first.payload, second.payload);
});

test('the QR matrix is a square QR with finder patterns', () => {
  const session = createPairingSession();
  const { size, modules } = session.qr;

  assert.ok(size >= 21, `expected at least version 1 size, got ${size}`);
  assert.equal(modules.length, size);
  for (const row of modules) assert.equal(row.length, size);

  // Finder patterns: dark border, light ring, dark 3x3 core in each corner.
  for (const [row, column] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    assert.equal(modules[row][column], 1);
    assert.equal(modules[row + 1][column + 1], 0);
    assert.equal(modules[row + 3][column + 3], 1);
  }
});

test('the generated QR decodes back to the pairing payload', () => {
  const session = createPairingSession();
  const matrix = buildQrMatrix(session.payload);
  const { data, width, height } = renderMatrix(matrix);

  const decoded = jsQR(data, width, height);
  assert.ok(decoded, 'the QR code could not be decoded');
  assert.equal(decoded.data, session.payload);
});
