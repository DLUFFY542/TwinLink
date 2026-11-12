'use strict';

const { EventEmitter } = require('node:events');
const { MirrorSession } = require('./session');

const STALL_TIMEOUT_MS = 12000;
const STATS_INTERVAL_MS = 1000;

/**
 * Owns the lifetime of mirroring for one device: start, stop, auto-reconnect,
 * watchdog and throughput statistics. All renderer-facing events originate here.
 */
class MirrorController extends EventEmitter {
  constructor({ adb, serverJar, logger = console }) {
    super();
    this.adb = adb;
    this.serverJar = serverJar;
    this.logger = logger;

    this.state = 'idle';
    this.serial = null;
    this.session = null;
    this.deviceName = null;
    this.width = 0;
    this.height = 0;
    this.codec = null;
    this.error = null;
    this.attempt = 0;
    this.userStopped = true;

    this.options = {};
    this.autoReconnect = true;
    this.maxReconnectAttempts = 3;

    this.statsTimer = null;
    this.reconnectTimer = null;
    this.lastStatsAt = 0;
    this.fps = 0;
    this.kbps = 0;
  }

  configure(settings) {
    this.options = {
      maxSize: settings.maxSize,
      maxFps: settings.maxFps,
      bitrate: settings.bitrate,
      audio: settings.audio === true,
      audioBitrate: settings.audioBitrate,
      showTouches: settings.showTouches,
      stayAwake: settings.stayAwake,
      powerOn: settings.powerOn,
    };
    this.autoReconnect = settings.autoReconnect === true;
    this.maxReconnectAttempts = Number.isInteger(settings.maxReconnectAttempts)
      ? settings.maxReconnectAttempts
      : 3;
  }

  get isActive() {
    return this.state === 'starting' || this.state === 'streaming' || this.state === 'reconnecting';
  }

  getSnapshot() {
    return {
      state: this.state,
      serial: this.serial,
      deviceName: this.deviceName,
      width: this.width,
      height: this.height,
      codec: this.codec,
      error: this.error,
      attempt: this.attempt,
      fps: this.fps,
      kbps: this.kbps,
      audio: this.session?.audioCodec || null,
    };
  }

  async start(serial, settings) {
    if (this.isActive) {
      if (this.serial === serial) {
        return this.getSnapshot();
      }
      await this.stop('switching device');
    }

    if (settings) this.configure(settings);

    this.serial = serial;
    this.deviceName = null;
    this.width = 0;
    this.height = 0;
    this.codec = null;
    this.error = null;
    this.attempt = 0;
    this.userStopped = false;

    await this.#connect();
    return this.getSnapshot();
  }

  async #connect() {
    this.#clearReconnectTimer();
    this.#setState(this.attempt === 0 ? 'starting' : 'reconnecting');

    const session = new MirrorSession({
      adb: this.adb,
      serial: this.serial,
      options: this.options,
      serverJar: this.serverJar,
      logger: this.logger,
    });
    this.session = session;

    session.on('meta', (info) => {
      this.deviceName = info.deviceName;
      this.#emitState();
    });

    session.on('session', (info) => {
      this.width = info.width;
      this.height = info.height;
      this.emit('session', info);
    });

    session.on('codec', (info) => {
      this.codec = info.codec;
    });

    session.on('frame', (frame) => {
      this.emit('frame', frame);
    });

    session.on('audio-codec', (info) => this.emit('audio-codec', info));
    session.on('audio-frame', (frame) => this.emit('audio-frame', frame));
    session.on('audio-disabled', (info) => this.emit('audio-disabled', info));

    session.on('ready', (info) => {
      if (this.serial !== session.serial) return;
      this.width = info.width || this.width;
      this.height = info.height || this.height;
      this.codec = info.codec || this.codec;
      this.deviceName = info.deviceName || this.deviceName;
      this.attempt = 0;
      this.error = null;
      this.#setState('streaming');
      this.#startStats();
      this.emit('ready', this.getSnapshot());
    });

    session.on('error', (err) => {
      this.logger.warn?.(`[mirror] ${err.message}`);
    });

    session.on('closed', (info) => {
      if (this.session !== session) return;
      this.session = null;
      this.#stopStats();
      if (this.userStopped) {
        this.#setState('stopped');
        return;
      }
      this.#handleUnexpectedClose(info);
    });

    try {
      await session.start();
    } catch (err) {
      this.error = err.message || 'failed to start mirroring';
      // 'closed' is emitted by the session on failure, which schedules a retry.
    }
  }

  #handleUnexpectedClose(info) {
    this.error = info?.reason || 'connection lost';
    this.emit('disconnected', { reason: this.error });

    const canRetry = this.autoReconnect && this.attempt < this.maxReconnectAttempts;
    if (!canRetry) {
      this.#setState('error');
      this.emit('failed', { error: this.error });
      return;
    }

    this.attempt += 1;
    const delay = Math.min(4000, 500 * 2 ** (this.attempt - 1));
    this.#setState('reconnecting');
    this.logger.info?.(`[mirror] reconnecting in ${delay} ms (attempt ${this.attempt}/${this.maxReconnectAttempts})`);

    this.#clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.userStopped) return;
      this.#connect().catch(() => {});
    }, delay);
  }

  sendControl(buffer) {
    return this.session ? this.session.sendControl(buffer) : false;
  }

  async stop(reason = 'user') {
    this.userStopped = true;
    this.#clearReconnectTimer();
    this.#stopStats();

    const session = this.session;
    this.session = null;
    if (session) {
      await session.stop(reason).catch(() => {});
    }

    this.#setState('stopped');
    this.emit('stopped', { reason });
  }

  dispose() {
    this.#clearReconnectTimer();
    this.#stopStats();
  }

  #setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.#emitState();
  }

  #emitState() {
    this.emit('state', this.getSnapshot());
  }

  #startStats() {
    this.#stopStats();
    this.lastStatsAt = Date.now();
    this.statsTimer = setInterval(() => {
      const session = this.session;
      if (!session || session.state !== 'streaming') return;
      const stats = session.consumeStats();
      const now = Date.now();
      const elapsed = Math.max(1, now - this.lastStatsAt) / 1000;
      this.lastStatsAt = now;
      this.fps = Math.round(stats.frames / elapsed);
      this.kbps = Math.round(((stats.bytes * 8) / elapsed) / 1000);

      if (stats.lastFrameAt > 0 && now - stats.lastFrameAt > STALL_TIMEOUT_MS) {
        this.logger.warn?.('[mirror] stream stalled; reconnecting');
        void session.stop('stream stalled').catch(() => {});
        return;
      }

      this.emit('stats', {
        fps: this.fps,
        kbps: this.kbps,
        width: stats.width,
        height: stats.height,
      });
    }, STATS_INTERVAL_MS);
  }

  #stopStats() {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.fps = 0;
    this.kbps = 0;
  }

  #clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

module.exports = { MirrorController };
