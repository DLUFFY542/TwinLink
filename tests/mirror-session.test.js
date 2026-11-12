'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { MirrorSession } = require('../src/core/mirror/session');
const { MirrorController } = require('../src/core/mirror/controller');
const { createFakeServer } = require('./helpers/fake-scrcpy-server');

const quiet = { info() {}, warn() {}, debug() {}, error() {} };

function fakeAdbServer(server) {
  return {
    push: async () => {},
    forward: async (_serial, port) => {
      await server.start(port);
    },
    removeForward: async () => {},
    spawnLongRunning: () => {
      const emitter = new EventEmitter();
      emitter.kill = () => {};
      return emitter;
    },
  };
}

function waitFor(predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('condition not met in time'));
      }
    }, 20);
  });
}

const baseOptions = {
  maxSize: 720,
  maxFps: 30,
  bitrate: 2000000,
  audio: false,
  audioBitrate: 128000,
  showTouches: false,
  stayAwake: true,
  powerOn: true,
};

test('session performs the v4.0 handshake and decodes stream framing', async (t) => {
  const server = createFakeServer({ deviceName: 'Pixel Test', frames: 4 });
  const session = new MirrorSession({
    adb: fakeAdbServer(server),
    serial: 'FAKE12345',
    options: baseOptions,
    serverJar: 'fake-server.jar',
    logger: quiet,
  });

  t.after(async () => {
    await session.stop().catch(() => {});
    await server.stop();
  });

  const meta = [];
  const sessions = [];
  const frames = [];
  const codecs = [];
  session.on('meta', (info) => {
    meta.push(info);
    // The v4.0 server accepts every socket before sending metadata, so the
    // control socket must already be connected when 'meta' fires.
    assert.ok(server.state.controlSocket, 'control socket must be open before metadata');
  });
  session.on('session', (info) => sessions.push(info));
  session.on('frame', (frame) => frames.push(frame));
  session.on('codec', (info) => codecs.push(info));

  await session.start();
  await waitFor(() => frames.length >= 5);

  assert.equal(session.state, 'streaming');
  assert.equal(meta[0].deviceName, 'Pixel Test');
  assert.equal(codecs[0].codec, 'h264');
  assert.deepEqual(
    [sessions[0].width, sessions[0].height],
    [720, 1280],
  );

  const config = frames.find((frame) => frame.isConfig);
  const media = frames.filter((frame) => !frame.isConfig);
  assert.ok(config, 'config packet must be surfaced');
  assert.equal(media.length, 4);
  assert.equal(media[0].isKey, true);
  assert.equal(media[0].pts, 0);
  assert.equal(media[1].pts, 33333);

  const stats = session.consumeStats();
  assert.equal(stats.width, 720);
  assert.equal(stats.height, 1280);
  assert.ok(stats.bytes > 0);
});

test('session forwards control bytes to the device', async (t) => {
  const server = createFakeServer({ frames: 1 });
  const session = new MirrorSession({
    adb: fakeAdbServer(server),
    serial: 'FAKE12345',
    options: baseOptions,
    serverJar: 'fake-server.jar',
    logger: quiet,
  });

  t.after(async () => {
    await session.stop().catch(() => {});
    await server.stop();
  });

  await session.start();
  await waitFor(() => server.state.connections >= 2, 2000);

  assert.equal(session.sendControl(Buffer.from([11])), true);
  await waitFor(() => server.state.control.length === 1);
  assert.deepEqual([...server.state.control], [11]);
});

test('session surfaces audio codec and frames when audio is enabled', async (t) => {
  const server = createFakeServer({ frames: 1, audio: true });
  const session = new MirrorSession({
    adb: fakeAdbServer(server),
    serial: 'FAKE12345',
    options: { ...baseOptions, audio: true },
    serverJar: 'fake-server.jar',
    logger: quiet,
  });

  const codecs = [];
  const frames = [];
  session.on('audio-codec', (info) => codecs.push(info));
  session.on('audio-frame', (frame) => frames.push(frame));

  t.after(async () => {
    await session.stop().catch(() => {});
    await server.stop();
  });

  await session.start();
  await waitFor(() => frames.length >= 2);

  assert.equal(codecs[0].codec, 'opus');
  assert.equal(frames.find((frame) => frame.isConfig).isConfig, true);
});

test('an interrupted connection closes the session instead of hanging', async (t) => {
  const server = createFakeServer({ closeImmediately: true });
  const session = new MirrorSession({
    adb: fakeAdbServer(server),
    serial: 'FAKE12345',
    options: baseOptions,
    serverJar: 'fake-server.jar',
    logger: quiet,
    connectTimeoutMs: 1200,
  });

  const closed = new Promise((resolve) => session.once('closed', resolve));
  session.on('error', () => {}); // expected in this scenario

  t.after(async () => {
    await session.stop().catch(() => {});
    await server.stop();
  });

  await assert.rejects(session.start());
  const info = await closed;
  assert.ok(info.reason);
  assert.match(info.reason, /closed/i);
  assert.equal(session.state, 'error');
});

test('controller reconnects automatically after a dropped stream', async (t) => {
  const servers = [];
  let forwards = 0;

  const adb = {
    push: async () => {},
    forward: async (_serial, port) => {
      forwards += 1;
      const server = createFakeServer({
        frames: 2,
        closeAfterFrames: forwards === 1,
      });
      servers.push(server);
      await server.start(port);
    },
    removeForward: async () => {},
    spawnLongRunning: () => {
      const emitter = new EventEmitter();
      emitter.kill = () => {};
      return emitter;
    },
  };

  const controller = new MirrorController({ adb, serverJar: 'fake-server.jar', logger: quiet });
  controller.configure({
    ...baseOptions,
    autoReconnect: true,
    maxReconnectAttempts: 2,
  });

  const states = [];
  controller.on('state', (snapshot) => states.push(snapshot.state));

  t.after(async () => {
    await controller.stop('test end').catch(() => {});
    controller.dispose();
    for (const server of servers) await server.stop();
  });

  await controller.start('FAKE12345');
  await waitFor(() => states.includes('streaming'));

  // First server drops the video socket, so the controller must reconnect.
  await waitFor(() => states.filter((state) => state === 'streaming').length >= 2, 8000);

  assert.ok(states.includes('reconnecting'));
  assert.ok(forwards >= 2, 'a second device server must have been launched');
  assert.equal(controller.getSnapshot().state, 'streaming');
});

test('controller reports a terminal error when retries are exhausted', async (t) => {
  const servers = [];
  const adb = {
    push: async () => {},
    forward: async (_serial, port) => {
      const server = createFakeServer({ closeAfterFrames: true });
      servers.push(server);
      await server.start(port);
    },
    removeForward: async () => {},
    spawnLongRunning: () => {
      const emitter = new EventEmitter();
      emitter.kill = () => {};
      return emitter;
    },
  };

  const controller = new MirrorController({ adb, serverJar: 'fake-server.jar', logger: quiet });
  controller.configure({ ...baseOptions, autoReconnect: false, maxReconnectAttempts: 0 });

  const errors = [];
  controller.on('failed', (info) => errors.push(info));

  t.after(async () => {
    await controller.stop('test end').catch(() => {});
    controller.dispose();
    for (const server of servers) await server.stop();
  });

  await controller.start('FAKE12345');
  await waitFor(() => errors.length === 1, 8000);

  assert.equal(controller.getSnapshot().state, 'error');
  assert.ok(errors[0].error);
});

test('controller does not re-emit state on every stats tick', async (t) => {
  const server = createFakeServer({ frames: 120 });
  const controller = new MirrorController({
    adb: fakeAdbServer(server),
    serverJar: 'fake-server.jar',
    logger: quiet,
  });
  controller.configure({ ...baseOptions, autoReconnect: false, maxReconnectAttempts: 0 });

  const states = [];
  const stats = [];
  controller.on('state', (snapshot) => states.push(snapshot.state));
  controller.on('stats', (entry) => stats.push(entry));

  t.after(async () => {
    await controller.stop('test end').catch(() => {});
    controller.dispose();
    await server.stop();
  });

  await controller.start('FAKE12345');
  await waitFor(() => controller.getSnapshot().state === 'streaming');

  const statesAtStart = states.length;
  await waitFor(() => stats.length >= 1, 3000);
  await new Promise((resolve) => setTimeout(resolve, 1200));

  // Periodic state snapshots used to force the renderer back to Mirror every
  // second, which made Settings unreachable while streaming.
  assert.equal(states.length, statesAtStart, 'no state event should be emitted by the stats timer');
});
