'use strict';

const net = require('node:net');
const { EventEmitter } = require('node:events');

const { DeviceMetaParser } = require('../protocol/device-meta');
const { VideoStreamParser } = require('../protocol/video-parser');
const { AUDIO_CODEC_IDS } = require('../protocol/constants');
const { connectWithRetry } = require('./net-utils');
const { launchServer } = require('./scrcpy-server');

const META_TIMEOUT_MS = 12000;
const CONNECT_TIMEOUT_MS = 20000;

/**
 * Wait until the socket produces at least one chunk. Used to wait for the
 * scrcpy dummy byte, which proves the device server has accepted the video
 * connection rather than the adb tunnel accepting before the server is ready.
 */
function readFirstChunk(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('close', onClose);
      socket.removeListener('error', onError);
      fn(value);
    };

    const onData = (chunk) => {
      if (!chunk || chunk.length === 0) return;
      socket.pause();
      finish(resolve, chunk);
    };
    const onClose = () => finish(reject, new Error('connection closed before the device server was ready'));
    const onError = (err) => finish(reject, err);

    const timer = setTimeout(
      () => finish(reject, new Error('timed out waiting for the device server')),
      timeoutMs,
    );

    socket.on('data', onData);
    socket.once('close', onClose);
    socket.once('error', onError);
    socket.resume();
  });
}

/**
 * One live mirroring session: a video socket, an optional audio socket and a
 * control socket, all multiplexed through a single adb forward port.
 *
 * States: idle -> preparing -> connecting -> streaming -> stopped | error
 */
class MirrorSession extends EventEmitter {
  constructor({ adb, serial, options, serverJar, logger = console, connectTimeoutMs = CONNECT_TIMEOUT_MS }) {
    super();
    this.adb = adb;
    this.serial = serial;
    this.options = options;
    this.serverJar = serverJar;
    this.logger = logger;
    this.connectTimeoutMs = connectTimeoutMs;

    this.state = 'idle';
    this.deviceName = null;
    this.codec = null;
    this.width = 0;
    this.height = 0;

    this.launch = null;
    this.videoSocket = null;
    this.controlSocket = null;
    this.videoParser = new VideoStreamParser();
    this.abort = new AbortController();

    this.framesReceived = 0;
    this.bytesReceived = 0;
    this.lastFrameAt = 0;
    this.clientResized = false;
    this.audioCodec = null;
  }

  get isStreaming() {
    return this.state === 'streaming';
  }

  async start() {
    if (this.state !== 'idle') {
      throw new Error(`session already started (state=${this.state})`);
    }
    this.state = 'preparing';
    this.emit('state', this.state);

    try {
      try {
        await this.#runAttempt({ audio: this.options.audio === true });
      } catch (err) {
        // Audio is optional. If its socket cannot be established the device
        // server is left waiting for it, so restart the attempt with audio
        // disabled instead of failing the video session.
        if (this.options.audio === true && !this.abort.signal.aborted) {
          this.logger.warn?.(`[mirror] audio unavailable, retrying without audio: ${err.message}`);
          this.emit('audio-disabled', { reason: err.message });
          await this.#resetAttempt();
          this.options = { ...this.options, audio: false };
          await this.#runAttempt({ audio: false });
        } else {
          throw err;
        }
      }

      this.state = 'streaming';
      this.lastFrameAt = Date.now();
      this.emit('state', this.state);
      this.emit('ready', {
        deviceName: this.deviceName,
        width: this.width,
        height: this.height,
        codec: this.codec,
      });
    } catch (err) {
      this.#fail(err.message || 'failed to start mirroring');
      throw err;
    }
  }

  /**
   * One connection attempt. The v4.0 server accepts the video, audio and
   * control sockets inside DesktopConnection.open() *before* it sends any
   * device metadata, so every socket must be connected before the client
   * reads the metadata or the two sides deadlock.
   */
  async #runAttempt({ audio }) {
    this.launch = await launchServer({
      adb: this.adb,
      serial: this.serial,
      options: { ...this.options, audio },
      serverJar: this.serverJar,
      logger: this.logger,
    });

    this.launch.child.once('close', (code) => {
      if (this.state === 'streaming' || this.state === 'connecting') {
        this.#fail(`device server exited (code ${code})`);
      }
    });

    this.state = 'connecting';
    this.emit('state', this.state);

    const socket = await this.#connectVideoSocket();
    this.videoSocket = socket;
    socket.setNoDelay(true);
    socket.on('error', (err) => this.#fail(`video socket error: ${err.message}`));
    socket.on('close', () => {
      if (this.state === 'streaming' || this.state === 'connecting') {
        this.#fail('video connection closed');
      }
    });

    if (audio) {
      await this.#openAudioSocket();
    }

    await this.#openControlSocket();

    const deviceName = await this.#readDeviceMeta(socket);
    this.deviceName = deviceName;
    this.emit('meta', { deviceName });
  }

  /**
   * The forwarded TCP port accepts connections before the device-side server
   * has bound its abstract socket, so a successful connect is not proof that
   * the pipe is live. The server writes one dummy byte as soon as it accepts
   * the video socket; wait for it, then put it back for the metadata parser.
   */
  async #connectVideoSocket() {
    const deadline = Date.now() + this.connectTimeoutMs;
    let lastError = null;

    while (Date.now() < deadline) {
      let socket = null;
      try {
        socket = await connectWithRetry(this.launch.port, {
          timeoutMs: Math.max(500, deadline - Date.now()),
          signal: this.abort.signal,
        });
        const first = await readFirstChunk(
          socket,
          Math.min(4000, Math.max(500, deadline - Date.now())),
        );
        socket.pause();
        socket.unshift(first);
        return socket;
      } catch (err) {
        if (err && err.code === 'CANCELLED') throw err;
        lastError = err;
        if (socket) socket.destroy();
        if (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }

    throw new Error(
      `timed out waiting for the device server${lastError ? `: ${lastError.message}` : ''}`,
    );
  }

  async #resetAttempt() {
    this.state = 'preparing';
    this.#destroySockets();
    this.videoParser = new VideoStreamParser();
    this.audioCodec = null;
    if (this.launch) {
      await this.launch.stop().catch(() => {});
      this.launch = null;
    }
  }

  #readDeviceMeta(socket) {
    return new Promise((resolve, reject) => {
      const metaParser = new DeviceMetaParser();
      let settled = false;
      let timer = null;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        socket.removeListener('data', onData);
        socket.removeListener('close', onClose);
        socket.removeListener('error', onError);
        fn(value);
      };

      const onClose = () => finish(reject, new Error('connection closed before device metadata'));
      const onError = (err) => finish(reject, new Error(`video socket error: ${err.message}`));

      const onData = (chunk) => {
        const { name, rest } = metaParser.push(chunk);
        if (!metaParser.done) return;

        socket.pause();
        socket.on('data', (data) => this.#onVideoData(data));
        socket.resume();

        finish(resolve, name || 'Android device');
        if (rest && rest.length > 0) {
          this.#onVideoData(rest);
        }
      };

      timer = setTimeout(() => {
        finish(reject, new Error('timed out waiting for device metadata'));
      }, META_TIMEOUT_MS);

      socket.on('data', onData);
      socket.once('close', onClose);
      socket.once('error', onError);
      socket.resume();
    });
  }

  #onVideoData(chunk) {
    this.bytesReceived += chunk.length;
    let events;
    try {
      events = this.videoParser.push(chunk);
    } catch (err) {
      this.#fail(`video stream parse error: ${err.message}`);
      return;
    }

    for (const event of events) {
      switch (event.type) {
        case 'codec':
          this.codec = event.codec;
          if (!event.codec) {
            this.#fail(`unsupported video codec id 0x${event.codecId.toString(16)}`);
            return;
          }
          this.emit('codec', { codec: event.codec, codecId: event.codecId });
          break;
        case 'session':
          this.width = event.width;
          this.height = event.height;
          this.clientResized = event.clientResized;
          this.emit('session', { width: event.width, height: event.height, clientResized: event.clientResized });
          break;
        case 'frame':
          this.framesReceived += 1;
          this.lastFrameAt = Date.now();
          this.emit('frame', event);
          break;
        case 'disabled':
          this.#fail(event.error ? 'device reported a configuration error' : 'device disabled the video stream');
          return;
        case 'error':
          this.#fail(event.message);
          return;
        default:
          break;
      }
    }
  }

  async #openAudioSocket() {
    if (!this.launch) return;
    let socket;
    try {
      socket = await connectWithRetry(this.launch.port, {
        timeoutMs: 8000,
        signal: this.abort.signal,
      });
    } catch (err) {
      if (err && err.code === 'CANCELLED') throw err;
      // The server is blocked waiting for this socket, so the attempt cannot
      // continue; start() restarts it with audio disabled.
      throw new Error(`audio socket unavailable: ${err.message}`);
    }

    this.audioSocket = socket;
    socket.setNoDelay(true);
    socket.on('error', (err) => {
      this.logger.debug?.(`[mirror] audio socket error: ${err.message}`);
    });

    const parser = new VideoStreamParser();
    socket.on('data', (chunk) => {
      let events;
      try {
        events = parser.push(chunk);
      } catch (err) {
        this.logger.warn?.(`[mirror] audio parse error: ${err.message}`);
        return;
      }
      for (const event of events) {
        if (event.type === 'codec') {
          this.audioCodec = AUDIO_CODEC_IDS[event.codecId] || null;
          if (!this.audioCodec) {
            this.emit('audio-disabled', { reason: 'unsupported audio codec' });
          } else {
            this.emit('audio-codec', { codec: this.audioCodec, codecId: event.codecId });
          }
        } else if (event.type === 'frame') {
          this.emit('audio-frame', {
            data: event.data,
            isConfig: event.isConfig,
            pts: event.pts,
          });
        } else if (event.type === 'disabled') {
          this.emit('audio-disabled', { reason: 'device disabled audio' });
        }
      }
    });
  }

  async #openControlSocket() {
    if (!this.launch) return;
    const socket = await connectWithRetry(this.launch.port, {
      timeoutMs: 8000,
      signal: this.abort.signal,
    });
    this.controlSocket = socket;
    socket.setNoDelay(true);
    socket.on('error', (err) => this.logger.debug?.(`[mirror] control socket error: ${err.message}`));
    socket.on('close', () => {
      if (this.state === 'streaming') {
        this.#fail('control connection closed');
      }
    });
    // The device may send clipboard/ack messages; read and discard them so the
    // socket never stalls, but never let them influence the UI.
    socket.on('data', () => {});
    this.emit('control-open');
  }

  sendControl(buffer) {
    if (!Buffer.isBuffer(buffer) || !this.controlSocket || this.controlSocket.destroyed) {
      return false;
    }
    try {
      this.controlSocket.write(buffer);
      return true;
    } catch {
      return false;
    }
  }

  consumeStats() {
    const stats = {
      frames: this.framesReceived,
      bytes: this.bytesReceived,
      width: this.width,
      height: this.height,
      lastFrameAt: this.lastFrameAt,
    };
    this.framesReceived = 0;
    this.bytesReceived = 0;
    return stats;
  }

  async stop(reason = 'user') {
    if (this.state === 'stopped' || this.state === 'error') {
      return;
    }
    const wasActive = this.state !== 'idle';
    this.state = 'stopping';
    this.emit('state', this.state);

    this.abort.abort();
    this.#destroySockets();

    if (this.launch) {
      await this.launch.stop().catch(() => {});
      this.launch = null;
    }

    this.state = 'stopped';
    this.emit('state', this.state);
    if (wasActive) {
      this.emit('closed', { reason, code: null });
    }
  }

  #destroySockets() {
    for (const socket of [this.videoSocket, this.audioSocket, this.controlSocket]) {
      if (socket && !socket.destroyed) {
        socket.removeAllListeners('data');
        socket.destroy();
      }
    }
    this.videoSocket = null;
    this.audioSocket = null;
    this.controlSocket = null;
  }

  #fail(message) {
    if (this.state === 'stopped' || this.state === 'error' || this.state === 'stopping') {
      return;
    }
    this.state = 'error';
    this.emit('state', this.state);
    this.emit('error', new Error(message));
    this.emit('closed', { reason: message, code: 'ERROR' });
    void this.#cleanupAfterFailure();
  }

  async #cleanupAfterFailure() {
    this.abort.abort();
    this.#destroySockets();
    if (this.launch) {
      await this.launch.stop().catch(() => {});
      this.launch = null;
    }
  }
}

module.exports = { MirrorSession };
