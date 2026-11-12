'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { SCRCPY_VERSION } = require('../protocol/constants');
const { getFreePort } = require('./net-utils');

const SERVER_ASSET = `scrcpy-server-v${SCRCPY_VERSION}.jar`;
const DEVICE_JAR_PATH = '/data/local/tmp/twinlink-scrcpy-server.jar';
// Published in the official v4.0 SHA256SUMS.txt release asset.
const EXPECTED_SHA256 = '84924bd564a1eb6089c872c7521f968058977f91f5ff02514a8c74aff3210f3a';

const OPTION_LIMITS = Object.freeze({
  maxSize: [0, 4096],
  maxFps: [1, 240],
  bitrate: [256000, 100000000],
  audioBitrate: [16000, 512000],
});

function resolveServerJar({ resourcesPath = '', appRoot = '', extraPaths = [] } = {}) {
  const candidates = [];
  if (resourcesPath) candidates.push(path.join(resourcesPath, 'vendor', SERVER_ASSET));
  if (appRoot) candidates.push(path.join(appRoot, 'vendor', SERVER_ASSET));
  candidates.push(path.join(__dirname, '..', '..', '..', 'vendor', SERVER_ASSET));
  candidates.push(...extraPaths);

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        return path.resolve(candidate);
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

function verifyServerJar(file) {
  try {
    const data = fs.readFileSync(file);
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    return { ok: sha256 === EXPECTED_SHA256, sha256, size: data.length };
  } catch (err) {
    return { ok: false, sha256: null, size: 0, error: err.message };
  }
}

function clampOption(name, value) {
  const [min, max] = OPTION_LIMITS[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function buildLaunchArgs({ serial, scid, options }) {
  const maxSize = clampOption('maxSize', options.maxSize);
  const maxFps = clampOption('maxFps', options.maxFps);
  const bitrate = clampOption('bitrate', options.bitrate);
  const audioBitrate = clampOption('audioBitrate', options.audioBitrate);

  const args = [
    '-s',
    serial,
    'shell',
    `CLASSPATH=${DEVICE_JAR_PATH}`,
    'app_process',
    '/',
    'com.genymobile.scrcpy.Server',
    SCRCPY_VERSION,
    `scid=${scid.toString(16).padStart(8, '0')}`,
    'log_level=info',
    'tunnel_forward=true',
    'video=true',
    `audio=${options.audio === true ? 'true' : 'false'}`,
    'control=true',
    'send_device_meta=true',
    'send_dummy_byte=true',
    'send_stream_meta=true',
    'cleanup=true',
    'clipboard_autosync=false',
    `power_on=${options.powerOn !== false ? 'true' : 'false'}`,
    `stay_awake=${options.stayAwake !== false ? 'true' : 'false'}`,
    `show_touches=${options.showTouches === true ? 'true' : 'false'}`,
    'video_codec=h264',
  ];

  if (maxSize) args.push(`max_size=${maxSize}`);
  if (maxFps) args.push(`max_fps=${maxFps}`);
  if (bitrate) args.push(`video_bit_rate=${bitrate}`);
  if (options.audio === true && audioBitrate) {
    args.push(`audio_bit_rate=${audioBitrate}`);
  }

  return args;
}

/**
 * Push and start scrcpy-server on the device, then create the adb forward that
 * carries all sockets. The caller connects to 127.0.0.1:<port>.
 */
async function launchServer({ adb, serial, options = {}, serverJar, logger = console }) {
  if (!serverJar) {
    throw new Error('scrcpy-server jar not found');
  }

  await adb.push(serial, serverJar, DEVICE_JAR_PATH);

  const port = await getFreePort();
  const scid = crypto.randomInt(1, 0x7fffffff);
  const abstractName = `localabstract:scrcpy_${scid.toString(16).padStart(8, '0')}`;

  await adb.forward(serial, port, abstractName);

  const args = buildLaunchArgs({ serial, scid, options });
  logger.info?.(`[mirror] launching server on ${serial} (scid=${scid.toString(16)}, port=${port})`);

  let child;
  try {
    child = adb.spawnLongRunning(args, {
      onLine: (line) => logger.debug?.(`[device] ${line}`),
    });
  } catch (err) {
    await adb.removeForward(serial, port).catch(() => {});
    throw err;
  }

  let stopped = false;
  const handle = {
    port,
    scid,
    abstractName,
    serverJar,
    child,
    get stopped() {
      return stopped;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      await adb.removeForward(serial, port).catch(() => {});
    },
  };

  return handle;
}

module.exports = {
  DEVICE_JAR_PATH,
  SERVER_ASSET,
  EXPECTED_SHA256,
  resolveServerJar,
  verifyServerJar,
  buildLaunchArgs,
  launchServer,
};
