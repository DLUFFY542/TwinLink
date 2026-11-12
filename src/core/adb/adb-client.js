'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { AdbError, ADB_ERROR_CODES } = require('./errors');

const SERIAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\-]{0,127}$/;
const REMOTE_SOCKET_PATTERN = /^(localabstract|tcp):[A-Za-z0-9_.:\-]{1,120}$/;
const DEVICE_PATH_PATTERN = /^\/data\/local\/tmp\/[A-Za-z0-9._-]{1,80}$/;
const HOST_PORT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-]{0,120}:\d{1,5}$/;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function assertSerial(serial) {
  if (typeof serial !== 'string' || !SERIAL_PATTERN.test(serial)) {
    throw new AdbError(`Invalid device serial: ${String(serial).slice(0, 40)}`, ADB_ERROR_CODES.INVALID_ARGUMENT);
  }
}

function assertPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AdbError(`Invalid TCP port: ${port}`, ADB_ERROR_CODES.INVALID_ARGUMENT);
  }
}

function assertRemoteSocket(remote) {
  if (typeof remote !== 'string' || !REMOTE_SOCKET_PATTERN.test(remote)) {
    throw new AdbError('Invalid remote socket name', ADB_ERROR_CODES.INVALID_ARGUMENT);
  }
}

function assertHostPort(address) {
  if (typeof address !== 'string' || !HOST_PORT_PATTERN.test(address)) {
    throw new AdbError(`Invalid host:port value: ${String(address).slice(0, 60)}`, ADB_ERROR_CODES.INVALID_ARGUMENT);
  }
  const port = Number(address.slice(address.lastIndexOf(':') + 1));
  assertPort(port);
}

class AdbClient {
  constructor({ adbPath, timeoutMs = 20000, env = process.env, prefixArgs = [] }) {
    this.adbPath = adbPath;
    this.timeoutMs = timeoutMs;
    this.env = env;
    this.prefixArgs = prefixArgs;
    this.running = new Set();
  }

  setAdbPath(adbPath) {
    this.adbPath = adbPath;
  }

  /**
   * Run adb with an explicit argument array. No shell is involved, so values
   * can never be interpreted as shell syntax.
   */
  exec(args, { timeoutMs = this.timeoutMs, signal, allowExitCodes = [0] } = {}) {
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      return Promise.reject(new AdbError('adb arguments must be an array of strings', ADB_ERROR_CODES.INVALID_ARGUMENT));
    }
    if (!this.adbPath) {
      return Promise.reject(new AdbError('adb executable not found', ADB_ERROR_CODES.ADB_NOT_FOUND));
    }

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(this.adbPath, [...this.prefixArgs, ...args], {
          windowsHide: true,
          env: this.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        reject(this.#spawnError(err));
        return;
      }

      this.running.add(child);

      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let timer = null;

      const finish = (fn, value) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        this.running.delete(child);
        fn(value);
      };

      const onAbort = () => {
        child.kill();
        finish(reject, new AdbError('adb command cancelled', ADB_ERROR_CODES.CANCELLED));
      };

      if (signal) {
        if (signal.aborted) {
          child.kill();
          finish(reject, new AdbError('adb command cancelled', ADB_ERROR_CODES.CANCELLED));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      timer = setTimeout(() => {
        child.kill();
        finish(
          reject,
          new AdbError(`adb command timed out after ${timeoutMs} ms: adb ${args[0] || ''}`, ADB_ERROR_CODES.TIMEOUT, {
            args,
          }),
        );
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout.push(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= MAX_OUTPUT_BYTES) stderr.push(chunk);
      });

      child.on('error', (err) => {
        finish(reject, this.#spawnError(err));
      });

      child.on('close', (code) => {
        const out = Buffer.concat(stdout).toString('utf8');
        const err = Buffer.concat(stderr).toString('utf8');
        if (allowExitCodes.includes(code)) {
          finish(resolve, { code, stdout: out, stderr: err });
          return;
        }
        const message = (err.trim() || out.trim() || `adb exited with code ${code}`).slice(0, 2000);
        finish(
          reject,
          new AdbError(message, ADB_ERROR_CODES.EXIT, { code, args, stderr: err.slice(0, 4000), stdout: out.slice(0, 4000) }),
        );
      });
    });
  }

  #spawnError(err) {
    if (err && err.code === 'ENOENT') {
      return new AdbError('adb executable not found', ADB_ERROR_CODES.ADB_NOT_FOUND);
    }
    return new AdbError(err?.message || 'failed to start adb', ADB_ERROR_CODES.EXIT);
  }

  async version() {
    const { stdout } = await this.exec(['version'], { timeoutMs: 15000 });
    const match = /Android Debug Bridge version ([0-9.]+)/.exec(stdout);
    return { version: match ? match[1] : null, raw: stdout.trim() };
  }

  async devicesRaw() {
    const { stdout } = await this.exec(['devices', '-l'], { timeoutMs: 25000 });
    return stdout;
  }

  async shell(serial, args, options = {}) {
    assertSerial(serial);
    if (!Array.isArray(args) || args.length === 0 || args.some((a) => typeof a !== 'string')) {
      throw new AdbError('shell arguments are invalid', ADB_ERROR_CODES.INVALID_ARGUMENT);
    }
    const { stdout } = await this.exec(['-s', serial, 'shell', ...args], options);
    return stdout;
  }

  async getProps(serial, props) {
    const results = await Promise.all(
      props.map(async (prop) => {
        try {
          return (await this.shell(serial, ['getprop', prop], { timeoutMs: 12000 })).trim();
        } catch {
          return '';
        }
      }),
    );
    return Object.fromEntries(props.map((prop, index) => [prop, results[index]]));
  }

  async forward(serial, localPort, remote) {
    assertSerial(serial);
    assertPort(localPort);
    assertRemoteSocket(remote);
    await this.exec(['-s', serial, 'forward', `tcp:${localPort}`, remote], { timeoutMs: 15000 });
    return { localPort, remote };
  }

  async removeForward(serial, localPort) {
    assertSerial(serial);
    assertPort(localPort);
    await this.exec(['-s', serial, 'forward', '--remove', `tcp:${localPort}`], {
      timeoutMs: 10000,
      allowExitCodes: [0, 1],
    });
  }

  async push(serial, localPath, remotePath) {
    assertSerial(serial);
    if (typeof localPath !== 'string' || !fs.existsSync(localPath)) {
      throw new AdbError(`local file does not exist: ${localPath}`, ADB_ERROR_CODES.INVALID_ARGUMENT);
    }
    if (typeof remotePath !== 'string' || !DEVICE_PATH_PATTERN.test(remotePath)) {
      throw new AdbError('invalid device path for push', ADB_ERROR_CODES.INVALID_ARGUMENT);
    }
    await this.exec(['-s', serial, 'push', localPath, remotePath], { timeoutMs: 90000 });
    return remotePath;
  }

  async getSdkVersion(serial) {
    try {
      const value = (await this.shell(serial, ['getprop', 'ro.build.version.sdk'], { timeoutMs: 10000 })).trim();
      const sdk = Number.parseInt(value, 10);
      return Number.isFinite(sdk) ? sdk : null;
    } catch {
      return null;
    }
  }

  async connect(address) {
    assertHostPort(address);
    const { stdout, stderr } = await this.exec(['connect', address], { timeoutMs: 25000 });
    return (stdout + stderr).trim();
  }

  async disconnect(address) {
    assertHostPort(address);
    const { stdout, stderr } = await this.exec(['disconnect', address], {
      timeoutMs: 15000,
      allowExitCodes: [0, 1],
    });
    return (stdout + stderr).trim();
  }

  async pair(address, code) {
    assertHostPort(address);
    if (typeof code !== 'string' || !/^\d{4,8}$/.test(code)) {
      throw new AdbError('pairing code must be 4-8 digits', ADB_ERROR_CODES.INVALID_ARGUMENT);
    }
    const { stdout, stderr } = await this.exec(['pair', address, code], { timeoutMs: 45000 });
    return (stdout + stderr).trim();
  }

  async mdnsServices() {
    const { stdout } = await this.exec(['mdns', 'services'], { timeoutMs: 15000, allowExitCodes: [0, 1] });
    return stdout;
  }

  async killServer() {
    await this.exec(['kill-server'], { timeoutMs: 15000, allowExitCodes: [0, 1] });
  }

  /**
   * Start a long-lived adb command (the on-device mirroring server) and keep
   * the child handle. stdout/stderr are surfaced line-by-line for diagnostics.
   */
  spawnLongRunning(args, { onLine = () => {} } = {}) {
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      throw new AdbError('adb arguments must be an array of strings', ADB_ERROR_CODES.INVALID_ARGUMENT);
    }
    if (!this.adbPath) {
      throw new AdbError('adb executable not found', ADB_ERROR_CODES.ADB_NOT_FOUND);
    }

    const child = spawn(this.adbPath, [...this.prefixArgs, ...args], {
      windowsHide: true,
      env: this.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.running.add(child);

    const forward = (stream) => {
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, newline).trimEnd();
          pending = pending.slice(newline + 1);
          if (line) onLine(line);
        }
        if (pending.length > 8192) {
          onLine(pending.slice(0, 8192));
          pending = '';
        }
      });
    };

    forward(child.stdout);
    forward(child.stderr);
    child.once('close', () => this.running.delete(child));
    return child;
  }

  dispose() {
    for (const child of this.running) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    this.running.clear();
  }
}

module.exports = {
  AdbClient,
  assertSerial,
  assertPort,
  assertRemoteSocket,
  assertHostPort,
};
