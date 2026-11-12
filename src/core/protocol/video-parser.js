'use strict';

const {
  PACKET_FLAG_CONFIG,
  PACKET_FLAG_KEY_FRAME,
  PACKET_PTS_MASK,
  VIDEO_CODEC_IDS,
} = require('./constants');

const MAX_PACKET_SIZE = 64 * 1024 * 1024;
const HEADER_SIZE = 12;

/**
 * Parse the 12-byte video packet header.
 *
 * A packet whose most significant bit is set is a session packet carrying the
 * new video size. Otherwise it is a media packet header:
 *
 *   u64 ptsAndFlags (BE) | u32 packetSize (BE)
 *
 * bit 62 marks a codec-config packet (SPS/PPS), bit 61 marks a key frame.
 */
function parseVideoPacketHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_SIZE) {
    throw new RangeError('video packet header requires 12 bytes');
  }

  if ((buf[0] & 0x80) !== 0) {
    return {
      kind: 'session',
      width: buf.readUInt32BE(4),
      height: buf.readUInt32BE(8),
      clientResized: (buf[3] & 0x01) !== 0,
    };
  }

  const ptsAndFlags = buf.readBigUInt64BE(0);
  const size = buf.readUInt32BE(8);
  const isConfig = (ptsAndFlags & PACKET_FLAG_CONFIG) !== 0n;
  const isKey = (ptsAndFlags & PACKET_FLAG_KEY_FRAME) !== 0n;

  return {
    kind: 'frame',
    size,
    isConfig,
    isKey,
    pts: Number(ptsAndFlags & PACKET_PTS_MASK),
  };
}

/**
 * Incremental parser for the scrcpy video socket.
 *
 * Emits:
 *   { type: 'codec', codecId, codec }
 *   { type: 'session', width, height, clientResized }
 *   { type: 'frame', data, isConfig, isKey, pts }
 *   { type: 'disabled', error }
 *
 * The parser is deliberately tolerant of arbitrary TCP fragmentation: callers
 * push whatever arrived and receive complete events.
 */
class VideoStreamParser {
  constructor({ maxPacketSize = MAX_PACKET_SIZE } = {}) {
    this.maxPacketSize = maxPacketSize;
    this.state = 'codec';
    this.buffer = Buffer.alloc(0);
    this.codecId = 0;
    this.codec = null;
    this.pendingSize = 0;
    this.pendingMeta = null;
    this.bytesReceived = 0;
    this.framesReceived = 0;
  }

  push(chunk) {
    if (!chunk || chunk.length === 0) {
      return [];
    }
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.bytesReceived += buf.length;
    this.buffer = this.buffer.length === 0 ? buf : Buffer.concat([this.buffer, buf]);
    return this.#drain();
  }

  #drain() {
    const events = [];

    for (;;) {
      if (this.state === 'codec') {
        if (this.buffer.length < 4) break;
        const codecId = this.buffer.readUInt32BE(0);
        this.buffer = this.buffer.subarray(4);
        this.codecId = codecId;

        if (codecId === 0 || codecId === 1) {
          this.state = 'done';
          events.push({ type: 'disabled', error: codecId === 1 });
          break;
        }

        const codec = VIDEO_CODEC_IDS[codecId] || null;
        this.codec = codec;
        this.state = 'header';
        events.push({ type: 'codec', codecId, codec });
        continue;
      }

      if (this.state === 'header') {
        if (this.buffer.length < HEADER_SIZE) break;
        const header = parseVideoPacketHeader(this.buffer.subarray(0, HEADER_SIZE));
        this.buffer = this.buffer.subarray(HEADER_SIZE);

        if (header.kind === 'session') {
          events.push({
            type: 'session',
            width: header.width,
            height: header.height,
            clientResized: header.clientResized,
          });
          continue;
        }

        if (header.size > this.maxPacketSize) {
          this.state = 'done';
          events.push({
            type: 'error',
            message: `video packet too large (${header.size} bytes)`,
          });
          break;
        }

        this.pendingSize = header.size;
        this.pendingMeta = header;
        this.state = 'payload';
        continue;
      }

      if (this.state === 'payload') {
        if (this.buffer.length < this.pendingSize) break;
        const data = Buffer.from(this.buffer.subarray(0, this.pendingSize));
        this.buffer = this.buffer.subarray(this.pendingSize);
        this.state = 'header';
        this.framesReceived += 1;
        events.push({
          type: 'frame',
          data,
          isConfig: this.pendingMeta.isConfig,
          isKey: this.pendingMeta.isKey,
          pts: this.pendingMeta.pts,
        });
        this.pendingMeta = null;
        this.pendingSize = 0;
        continue;
      }

      break;
    }

    return events;
  }
}

module.exports = { parseVideoPacketHeader, VideoStreamParser, HEADER_SIZE };
