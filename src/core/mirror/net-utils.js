'use strict';

const net = require('node:net');

/**
 * Ask the OS for an unused localhost TCP port.
 * There is an unavoidable (tiny) race between closing the probe socket and
 * the caller connecting; callers must handle a failed bind by retrying.
 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Connect to 127.0.0.1:port, retrying while the on-device server starts up.
 * Honour an AbortSignal so a cancelled session stops immediately.
 */
function connectWithRetry(port, { timeoutMs = 15000, signal, intervalMs = 100 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let settled = false;

    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(Object.assign(new Error('connection cancelled'), { code: 'CANCELLED' }));
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const attempt = () => {
      if (settled) return;

      const socket = net.createConnection({ port, host: '127.0.0.1' });
      socket.setNoDelay(true);

      const onError = () => {
        socket.destroy();
        if (settled) return;
        if (Date.now() >= deadline) {
          settled = true;
          cleanup();
          reject(Object.assign(new Error('timed out waiting for the device server'), { code: 'CONNECT_TIMEOUT' }));
          return;
        }
        setTimeout(attempt, intervalMs);
      };

      socket.once('error', onError);
      socket.once('connect', () => {
        socket.removeListener('error', onError);
        if (settled) {
          socket.destroy();
          return;
        }
        settled = true;
        cleanup();
        resolve(socket);
      });
    };

    attempt();
  });
}

module.exports = { getFreePort, connectWithRetry };
