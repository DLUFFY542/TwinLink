'use strict';

const CODES = Object.freeze({
  ADB_NOT_FOUND: 'ADB_NOT_FOUND',
  TIMEOUT: 'TIMEOUT',
  EXIT: 'EXIT',
  CANCELLED: 'CANCELLED',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  DEVICE_NOT_FOUND: 'DEVICE_NOT_FOUND',
});

class AdbError extends Error {
  constructor(message, code = CODES.EXIT, details = {}) {
    super(message);
    this.name = 'AdbError';
    this.code = code;
    this.details = details;
  }
}

module.exports = { AdbError, ADB_ERROR_CODES: CODES };
