'use strict';

/**
 * Parse `adb mdns services` output, used to discover wireless debugging
 * endpoints (Android 11+).
 *
 * Example:
 *   List of discovered mdns services
 *   adb-1A2B3C	_adb-tls-pairing._tcp	192.168.1.5:41567
 *   adb-1A2B3C	_adb-tls-connect._tcp	192.168.1.5:39101
 */
function parseMdnsServices(output) {
  if (typeof output !== 'string') return [];

  const services = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^List of discovered mdns services/i.test(line)) continue;

    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;

    const [name, service, address] = parts;
    if (!/^adb/i.test(name)) continue;

    let kind = null;
    if (service.includes('_adb-tls-pairing')) kind = 'pairing';
    else if (service.includes('_adb-tls-connect')) kind = 'connect';
    else continue;

    if (!/^[^\s:]+:\d{1,5}$/.test(address)) continue;

    services.push({ name, service, address, kind });
  }

  return services;
}

module.exports = { parseMdnsServices };
