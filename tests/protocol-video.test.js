'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { VideoStreamParser, parseVideoPacketHeader } = require('../src/core/protocol/video-parser');
const { sessionPacket, framePacket, fakeSps, fakeNal, H264_ID } = require('./helpers/fake-scrcpy-server');

function codecHeader(id = H264_ID) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(id, 0);
  return buf;
}

function buildStream() {
  return Buffer.concat([
    codecHeader(),
    sessionPacket(720, 1280),
    framePacket({ config: true, payload: fakeSps() }),
    framePacket({ pts: 0, key: true, payload: fakeNal(0) }),
    framePacket({ pts: 33333, payload: fakeNal(1) }),
    framePacket({ pts: 66666, payload: fakeNal(2) }),
  ]);
}

test('video parser reassembles a stream split into 7-byte chunks', () => {
  const stream = buildStream();
  const parser = new VideoStreamParser();
  const events = [];

  for (let offset = 0; offset < stream.length; offset += 7) {
    events.push(...parser.push(stream.subarray(offset, offset + 7)));
  }

  assert.equal(events[0].type, 'codec');
  assert.equal(events[0].codec, 'h264');
  assert.equal(events[0].codecId, H264_ID);

  assert.equal(events[1].type, 'session');
  assert.deepEqual(
    { width: events[1].width, height: events[1].height, clientResized: events[1].clientResized },
    { width: 720, height: 1280, clientResized: false },
  );

  assert.equal(events[2].type, 'frame');
  assert.equal(events[2].isConfig, true);
  assert.equal(events[2].isKey, false);
  assert.deepEqual([...events[2].data], [...fakeSps()]);

  const media = events.filter((event) => event.type === 'frame' && !event.isConfig);
  assert.equal(media.length, 3);
  assert.equal(media[0].isKey, true);
  assert.equal(media[0].pts, 0);
  assert.equal(media[1].isKey, false);
  assert.equal(media[1].pts, 33333);
  assert.equal(media[2].pts, 66666);
  assert.equal(media[2].data.length, fakeNal(2).length);
});

test('video parser handles a mid-stream session packet (rotation)', () => {
  const stream = Buffer.concat([
    codecHeader(),
    sessionPacket(720, 1280),
    framePacket({ pts: 0, key: true, payload: fakeNal(0) }),
    sessionPacket(1280, 720, true),
    framePacket({ pts: 100000, key: true, payload: fakeNal(1) }),
  ]);

  const parser = new VideoStreamParser();
  const events = parser.push(stream);
  const sessions = events.filter((event) => event.type === 'session');

  assert.equal(sessions.length, 2);
  assert.deepEqual([sessions[1].width, sessions[1].height, sessions[1].clientResized], [1280, 720, true]);
});

test('video parser reports an explicitly disabled stream', () => {
  const parser = new VideoStreamParser();
  const events = parser.push(Buffer.alloc(4));

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'disabled');
  assert.equal(events[0].error, false);
  assert.equal(parser.state, 'done');
});

test('video parser distinguishes a configuration error from a disabled stream', () => {
  const parser = new VideoStreamParser();
  const code = Buffer.from([0, 0, 0, 1]);
  const events = parser.push(code);

  assert.equal(events[0].type, 'disabled');
  assert.equal(events[0].error, true);
});

test('video parser rejects an implausible packet size instead of allocating', () => {
  const header = Buffer.alloc(12);
  header.writeBigUInt64BE(1n, 0);
  header.writeUInt32BE(100 * 1024 * 1024, 8);

  const parser = new VideoStreamParser();
  parser.push(codecHeader());
  const events = parser.push(header);

  assert.equal(events[0].type, 'error');
  assert.match(events[0].message, /too large/);
});

test('header parser exposes key/config/session flags', () => {
  const key = parseVideoPacketHeader(framePacket({ pts: 42, key: true, payload: Buffer.from([1]) }).subarray(0, 12));
  assert.deepEqual(key, { kind: 'frame', size: 1, isConfig: false, isKey: true, pts: 42 });

  const session = parseVideoPacketHeader(sessionPacket(111, 222, true));
  assert.deepEqual(session, { kind: 'session', width: 111, height: 222, clientResized: true });
});
