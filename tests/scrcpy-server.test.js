'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  buildLaunchArgs,
  resolveServerJar,
  verifyServerJar,
  SERVER_ASSET,
  EXPECTED_SHA256,
} = require('../src/core/mirror/scrcpy-server');

const projectRoot = path.join(__dirname, '..');

const options = {
  maxSize: 1080,
  maxFps: 60,
  bitrate: 8000000,
  audio: false,
  audioBitrate: 128000,
  showTouches: false,
  stayAwake: true,
  powerOn: true,
};

function findArg(args, prefix) {
  return args.find((arg) => arg.startsWith(prefix));
}

test('bundled scrcpy-server matches the published v4.0 checksum', () => {
  const jar = resolveServerJar({ appRoot: projectRoot });
  assert.ok(jar, 'vendor jar must be present');
  assert.equal(path.basename(jar), SERVER_ASSET);

  const info = verifyServerJar(jar);
  assert.equal(info.ok, true);
  assert.equal(info.sha256, EXPECTED_SHA256);
  assert.equal(info.size, 732226);
});

test('launch arguments follow the scrcpy v4.0 command line contract', () => {
  const args = buildLaunchArgs({ serial: 'R58M12345', scid: 0x0a1b2c3d, options });
  const joined = args.join(' ');

  assert.deepEqual(args.slice(0, 4), ['-s', 'R58M12345', 'shell', 'CLASSPATH=/data/local/tmp/twinlink-scrcpy-server.jar']);
  assert.deepEqual(args.slice(4, 9), [
    'app_process',
    '/',
    'com.genymobile.scrcpy.Server',
    '4.0',
    'scid=0a1b2c3d',
  ]);

  assert.equal(findArg(args, 'tunnel_forward='), 'tunnel_forward=true');
  assert.equal(findArg(args, 'video=true'), 'video=true');
  assert.equal(findArg(args, 'audio='), 'audio=false');
  assert.equal(findArg(args, 'control=true'), 'control=true');
  assert.equal(findArg(args, 'send_dummy_byte='), 'send_dummy_byte=true');
  assert.equal(findArg(args, 'send_device_meta='), 'send_device_meta=true');
  assert.equal(findArg(args, 'video_codec='), 'video_codec=h264');
  assert.equal(findArg(args, 'max_size='), 'max_size=1080');
  assert.equal(findArg(args, 'max_fps='), 'max_fps=60');
  assert.equal(findArg(args, 'video_bit_rate='), 'video_bit_rate=8000000');
  assert.equal(findArg(args, 'cleanup='), 'cleanup=true');
  assert.ok(!joined.includes('audio_bit_rate'), 'audio bitrate must be omitted when audio is off');
});

test('native resolution omits max_size and audio adds its bitrate', () => {
  const args = buildLaunchArgs({
    serial: '192.168.1.5:39101',
    scid: 1,
    options: { ...options, maxSize: 0, audio: true, audioBitrate: 64000 },
  });

  assert.equal(findArg(args, 'max_size='), undefined);
  assert.equal(findArg(args, 'audio='), 'audio=true');
  assert.equal(findArg(args, 'audio_bit_rate='), 'audio_bit_rate=64000');
  assert.equal(findArg(args, 'scid='), 'scid=00000001');
});

test('out-of-range numeric options are clamped before reaching the device', () => {
  const args = buildLaunchArgs({
    serial: 'R58M12345',
    scid: 1,
    options: { ...options, maxSize: 999999, maxFps: 5000, bitrate: 1 },
  });

  assert.equal(findArg(args, 'max_size='), 'max_size=4096');
  assert.equal(findArg(args, 'max_fps='), 'max_fps=240');
  assert.equal(findArg(args, 'video_bit_rate='), 'video_bit_rate=256000');
});

test('unusable numeric options are dropped rather than serialized as NaN', () => {
  const args = buildLaunchArgs({
    serial: 'R58M12345',
    scid: 1,
    options: { ...options, maxSize: Number.NaN, maxFps: 'fast', bitrate: undefined },
  });

  assert.equal(findArg(args, 'max_size='), undefined);
  assert.equal(findArg(args, 'max_fps='), undefined);
  assert.equal(findArg(args, 'video_bit_rate='), undefined);
  assert.ok(!args.some((arg) => arg.includes('NaN')));
});
