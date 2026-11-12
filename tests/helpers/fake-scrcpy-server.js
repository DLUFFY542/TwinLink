'use strict';

const net = require('node:net');

const H264_ID = 0x68323634;
const OPUS_ID = 0x6f707573;

function sessionPacket(width, height, clientResized = false) {
  const buf = Buffer.alloc(12);
  buf.writeUInt32BE((0x80000000 | (clientResized ? 1 : 0)) >>> 0, 0);
  buf.writeUInt32BE(width, 4);
  buf.writeUInt32BE(height, 8);
  return buf;
}

function framePacket({ pts = 0, config = false, key = false, payload }) {
  const header = Buffer.alloc(12);
  let flags = BigInt(pts);
  if (config) flags = 1n << 62n;
  if (key) flags |= 1n << 61n;
  header.writeBigUInt64BE(flags, 0);
  header.writeUInt32BE(payload.length, 8);
  return Buffer.concat([header, payload]);
}

function fakeSps() {
  // Start code + NAL header + profile/constraints/level + padding.
  return Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1e, 0xab, 0xcd]);
}

function fakeNal(index) {
  return Buffer.from([0x00, 0x00, 0x00, 0x01, 0x41, index & 0xff, 0x11, 0x22, 0x33]);
}

function opusHead() {
  return Buffer.from('OpusHead\x01\x02\x38\x01\x80\xbb\x00\x00\x00\x00\x00', 'binary');
}

/**
 * Minimal scrcpy server emulator: speaks the real v4.0 handshake and stream
 * framing over a single forwarded TCP port.
 */
function createFakeServer(options = {}) {
  const config = {
    deviceName: 'Fake Phone',
    width: 720,
    height: 1280,
    frames: 3,
    audio: false,
    closeAfterFrames: false,
    closeImmediately: false,
    ...options,
  };

  const state = {
    connections: 0,
    control: Buffer.alloc(0),
    sockets: [],
    started: [],
    videoSocket: null,
    audioSocket: null,
    controlSocket: null,
  };

  let server = null;
  let opened = false;

  function sendMetadata() {
    if (opened) return;
    const videoSocket = state.videoSocket;
    if (!videoSocket || videoSocket.destroyed) return;
    // The real v4.0 server accepts every socket in DesktopConnection.open()
    // before it sends device metadata, so wait for the full set.
    if (config.audio && !state.audioSocket) return;
    if (config.control !== false && !state.controlSocket) return;
    opened = true;

    // The dummy byte was already written on video accept.
    const name = Buffer.alloc(64);
    Buffer.from(config.deviceName, 'utf8').copy(name, 0, 0, 63);
    videoSocket.write(name);

    const codec = Buffer.alloc(4);
    codec.writeUInt32BE(H264_ID, 0);
    videoSocket.write(codec);
    videoSocket.write(sessionPacket(config.width, config.height));

    videoSocket.write(framePacket({ config: true, payload: fakeSps() }));
    for (let i = 0; i < config.frames; i += 1) {
      videoSocket.write(framePacket({ pts: i * 33333, key: i === 0, payload: fakeNal(i) }));
    }

    if (state.audioSocket) {
      const audioCodec = Buffer.alloc(4);
      audioCodec.writeUInt32BE(OPUS_ID, 0);
      state.audioSocket.write(audioCodec);
      state.audioSocket.write(framePacket({ config: true, payload: opusHead() }));
      state.audioSocket.write(framePacket({ payload: Buffer.from([0xaa, 0xbb, 0xcc]) }));
    }

    if (config.closeAfterFrames) {
      setTimeout(() => videoSocket.destroy(), 60);
    }
  }

  function handleConnection(socket) {
    const index = state.connections;
    state.connections += 1;
    state.sockets.push(socket);
    state.started.push(index);
    socket.on('error', () => {});

    if (!state.videoSocket) {
      if (config.closeImmediately) {
        socket.destroy();
        return;
      }
      state.videoSocket = socket;
      socket.write(Buffer.from([0])); // dummy byte, like scrcpy v4.0
      sendMetadata();
      return;
    }

    if (config.audio && !state.audioSocket) {
      state.audioSocket = socket;
      sendMetadata();
      return;
    }

    if (!state.controlSocket) {
      state.controlSocket = socket;
      socket.on('data', (chunk) => {
        state.control = Buffer.concat([state.control, chunk]);
      });
      sendMetadata();
      return;
    }

    socket.destroy();
  }

  return {
    config,
    state,
    start(port) {
      return new Promise((resolve, reject) => {
        server = net.createServer(handleConnection);
        server.once('error', reject);
        server.listen({ port, host: '127.0.0.1' }, () => resolve(server.address().port));
      });
    },
    async stop() {
      for (const socket of state.sockets) socket.destroy();
      if (server) {
        await new Promise((resolve) => server.close(resolve));
        server = null;
      }
    },
  };
}

module.exports = { createFakeServer, sessionPacket, framePacket, fakeSps, fakeNal, H264_ID, OPUS_ID };
