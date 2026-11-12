'use strict';

/**
 * Parse `adb devices -l` output.
 *
 * Real output examples:
 *   R58M12345\tdevice product:beyond1q model:SM_G973F device:beyond1q transport_id:1
 *   ABCDEF\tunauthorized usb:1-1 transport_id:4
 *   ABCDEF\toffline transport_id:5
 *   ABCDEF\tno permissions (user in plugdev group; ...); see [http://...] usb:1-2 transport_id:6
 */

const KNOWN_STATES = [
  'no permissions',
  'unauthorized',
  'authorizing',
  'connecting',
  'bootloader',
  'recovery',
  'sideload',
  'rescue',
  'detached',
  'offline',
  'device',
  'unknown',
  'host',
];

const DETAIL_KEYS = new Set(['product', 'model', 'device', 'transport_id', 'usb']);

function matchState(remainder) {
  const lower = remainder.toLowerCase();
  let best = null;
  for (const state of KNOWN_STATES) {
    if (lower.startsWith(state) && (best === null || state.length > best.length)) {
      best = state;
    }
  }
  return best;
}

function parseDetails(text) {
  const details = {};
  for (const token of text.split(/\s+/)) {
    const colon = token.indexOf(':');
    if (colon <= 0) continue;
    const key = token.slice(0, colon);
    if (!DETAIL_KEYS.has(key)) continue;
    details[key] = token.slice(colon + 1);
  }
  return details;
}

function prettifyModel(model) {
  if (!model) return null;
  return model.replace(/_/g, ' ').trim() || null;
}

function parseDevices(output) {
  if (typeof output !== 'string') {
    return [];
  }

  const devices = [];
  const seen = new Set();

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('*')) continue;
    if (/^List of devices attached/i.test(line)) continue;
    if (/^adb server/i.test(line)) continue;

    const match = /^(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;

    const serial = match[1];
    const remainder = match[2].trim();
    const state = matchState(remainder);

    if (!state) continue;
    if (seen.has(serial)) continue;
    seen.add(serial);

    const detailText = remainder.slice(state.length).trim();
    const details = parseDetails(detailText);

    devices.push({
      serial,
      state,
      connection: serial.includes(':') ? 'network' : 'usb',
      model: prettifyModel(details.model),
      modelRaw: details.model || null,
      product: details.product || null,
      device: details.device || null,
      transportId: details.transport_id ? Number.parseInt(details.transport_id, 10) : null,
      usb: details.usb || null,
      authorized: state === 'device',
      needsAuthorization: state === 'unauthorized',
      details: detailText,
    });
  }

  return devices;
}

module.exports = { parseDevices, prettifyModel };
