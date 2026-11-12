'use strict';

const { DEVICE_NAME_FIELD_LENGTH } = require('./constants');

/**
 * Parses the first bytes of the video socket when tunnel_forward=true.
 *
 * Layout (verified from DesktopConnection.java + app/src/server.c):
 *   1 byte  dummy (0x00), sent only once, only when send_dummy_byte=true
 *   64 byte device name, UTF-8, NUL padded, no length prefix
 */
class DeviceMetaParser {
  constructor({ expectDummyByte = true } = {}) {
    this.expectDummyByte = expectDummyByte;
    this.buffer = Buffer.alloc(0);
    this.done = false;
  }

  get required() {
    return (this.expectDummyByte ? 1 : 0) + DEVICE_NAME_FIELD_LENGTH;
  }

  push(chunk) {
    if (this.done) {
      return { name: null };
    }
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = this.buffer.length === 0 ? buf : Buffer.concat([this.buffer, buf]);

    if (this.buffer.length < this.required) {
      return { name: null };
    }

    const offset = this.expectDummyByte ? 1 : 0;
    const field = this.buffer.subarray(offset, offset + DEVICE_NAME_FIELD_LENGTH);
    const nul = field.indexOf(0);
    const nameBytes = nul === -1 ? field : field.subarray(0, nul);

    this.done = true;
    this.buffer = this.buffer.subarray(this.required);

    return { name: nameBytes.toString('utf8'), rest: this.buffer };
  }
}

module.exports = { DeviceMetaParser };
