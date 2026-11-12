'use strict';

/**
 * Wireless debugging pairing over QR code.
 *
 * Android 11+ can pair a computer without typing an address and code: the
 * computer shows a QR code and the phone scans it from
 * Developer options -> Wireless debugging -> "Pair device with QR code".
 *
 * The QR payload is Android's adb pairing format:
 *
 *   WIFI:T:ADB;S:<service-name>;P:<pairing-code>;;
 *
 * `S` is an mDNS service name (not an SSID) and `P` is the pairing code (not a
 * Wi-Fi password). The phone then advertises its `_adb-tls-pairing._tcp`
 * endpoint, and the host pairs with `adb pair <host:port> <code>`.
 */

const crypto = require('node:crypto');
const qrcode = require('qrcode-generator');

const SERVICE_PREFIX = 'adbqr';
const SERVICE_NAME_PATTERN = /^adbqr-[0-9a-f]{8}$/;
const PAIRING_CODE_PATTERN = /^\d{6}$/;
const PAYLOAD_PATTERN = /^WIFI:T:ADB;S:[A-Za-z0-9._-]+;P:\d{6};;$/;

function generateServiceName() {
  return `${SERVICE_PREFIX}-${crypto.randomBytes(4).toString('hex')}`;
}

function generatePairingCode() {
  // Six digits, zero padded, in the same shape Android itself shows.
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function buildPairingPayload(serviceName, code) {
  if (!SERVICE_NAME_PATTERN.test(serviceName)) {
    throw new Error('service name is not a valid adb pairing service name');
  }
  if (!PAIRING_CODE_PATTERN.test(code)) {
    throw new Error('pairing code must be 6 digits');
  }
  return `WIFI:T:ADB;S:${serviceName};P:${code};;`;
}

/**
 * Encode the payload as a QR matrix (1 = dark module, 0 = light module).
 * The matrix is plain data so the renderer can draw it without a bundler.
 */
function buildQrMatrix(payload) {
  const qr = qrcode(0, 'M');
  qr.addData(payload);
  qr.make();

  const size = qr.getModuleCount();
  const modules = [];
  for (let row = 0; row < size; row += 1) {
    const line = [];
    for (let column = 0; column < size; column += 1) {
      line.push(qr.isDark(row, column) ? 1 : 0);
    }
    modules.push(line);
  }

  return { size, modules };
}

/**
 * Create one pairing session: a service name, a code, the QR payload, and the
 * QR matrix the UI displays.
 */
function createPairingSession() {
  const serviceName = generateServiceName();
  const code = generatePairingCode();
  const payload = buildPairingPayload(serviceName, code);
  const qr = buildQrMatrix(payload);

  return { serviceName, code, payload, qr };
}

module.exports = {
  SERVICE_NAME_PATTERN,
  PAIRING_CODE_PATTERN,
  PAYLOAD_PATTERN,
  generateServiceName,
  generatePairingCode,
  buildPairingPayload,
  buildQrMatrix,
  createPairingSession,
};
