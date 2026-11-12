'use strict';

const { EventEmitter } = require('node:events');
const { parseDevices } = require('../adb/device-parser');

const DETAILS_TTL_MS = 60000;

function signatureOf(devices, detailsBySerial) {
  return devices
    .map((device) => {
      const details = detailsBySerial.get(device.serial);
      const detailKey = details ? `${details.model}|${details.androidVersion}|${details.screenWidth}x${details.screenHeight}` : '';
      return `${device.serial}|${device.state}|${device.model || ''}|${device.connection}|${detailKey}`;
    })
    .sort()
    .join(';;');
}

/**
 * Polls `adb devices -l`, enriches authorized devices with properties, and
 * emits state only when something actually changed.
 */
class DeviceManager extends EventEmitter {
  constructor({ adb, pollIntervalMs = 2000, logger = console }) {
    super();
    this.adb = adb;
    this.pollIntervalMs = pollIntervalMs;
    this.logger = logger;

    this.devices = [];
    this.details = new Map();
    this.error = null;
    this.adbInfo = { path: null, source: null, version: null };
    this.polling = false;
    this.timer = null;
    this.busy = false;
    this.lastSignature = '';
    this.lastUpdated = 0;
    this.started = false;
  }

  setAdbInfo(info) {
    this.adbInfo = { ...this.adbInfo, ...info };
    this.emitSnapshotIfChanged(true);
  }

  getSnapshot() {
    return {
      devices: this.devices.map((device) => ({
        ...device,
        details: this.details.get(device.serial) || null,
      })),
      error: this.error,
      exe: { ...this.adbInfo },
      polling: this.polling,
      updatedAt: this.lastUpdated,
    };
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.polling = true;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.pollIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    this.started = false;
    this.polling = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async refresh() {
    if (this.busy) return;
    this.busy = true;
    try {
      const hadError = this.error !== null;
      const output = await this.adb.devicesRaw();
      const devices = parseDevices(output);

      // Drop details for devices that disappeared or lost authorization.
      for (const serial of [...this.details.keys()]) {
        if (!devices.some((device) => device.serial === serial)) {
          this.details.delete(serial);
        }
      }

      this.devices = devices;
      this.error = null;
      this.lastUpdated = Date.now();

      await this.#enrich(devices);
      this.emitSnapshotIfChanged(hadError);
    } catch (err) {
      const message = err?.code === 'ADB_NOT_FOUND'
        ? 'adb was not found. Install Android Platform Tools or set the adb path in Settings.'
        : err?.message || 'failed to query adb';
      if (this.error !== message) {
        this.error = message;
        this.logger.warn?.(`[devices] ${message}`);
      }
      this.devices = [];
      this.emitSnapshotIfChanged();
    } finally {
      this.busy = false;
    }
  }

  async #enrich(devices) {
    const authorized = devices.filter((device) => device.state === 'device');
    await Promise.all(
      authorized.map(async (device) => {
        const cached = this.details.get(device.serial);
        if (cached && Date.now() - cached.fetchedAt < DETAILS_TTL_MS) {
          return;
        }
        try {
          const props = await this.adb.getProps(device.serial, [
            'ro.product.model',
            'ro.product.manufacturer',
            'ro.build.version.release',
            'ro.build.version.sdk',
          ]);
          let screenWidth = null;
          let screenHeight = null;
          let density = null;
          try {
            const wmSize = await this.adb.shell(device.serial, ['wm', 'size'], { timeoutMs: 10000 });
            const sizeMatch = /(\d+)\s*x\s*(\d+)/.exec(wmSize);
            if (sizeMatch) {
              screenWidth = Number.parseInt(sizeMatch[1], 10);
              screenHeight = Number.parseInt(sizeMatch[2], 10);
            }
            const wmDensity = await this.adb.shell(device.serial, ['wm', 'density'], { timeoutMs: 10000 });
            const densityMatch = /(\d+)/.exec(wmDensity);
            if (densityMatch) density = Number.parseInt(densityMatch[1], 10);
          } catch {
            /* screen data is best-effort */
          }

          this.details.set(device.serial, {
            model: props['ro.product.model'] || device.model || null,
            manufacturer: props['ro.product.manufacturer'] || null,
            androidVersion: props['ro.build.version.release'] || null,
            sdk: Number.parseInt(props['ro.build.version.sdk'], 10) || null,
            screenWidth,
            screenHeight,
            density,
            fetchedAt: Date.now(),
          });
        } catch (err) {
          this.logger.debug?.(`[devices] could not read properties for ${device.serial}: ${err.message}`);
        }
      }),
    );
  }

  emitSnapshotIfChanged(force = false) {
    const signature = signatureOf(this.devices, this.details);
    if (!force && signature === this.lastSignature && !this.error) {
      return;
    }
    this.lastSignature = signature;
    this.emit('changed', this.getSnapshot());
  }
}

module.exports = { DeviceManager };
