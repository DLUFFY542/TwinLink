'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DEFAULTS, validateSettings } = require('./schema');

/**
 * Persistent, validated settings store.
 *
 * Corrupt files are preserved for inspection and replaced with defaults;
 * writes are atomic (temp file + rename) so a crash cannot truncate settings.
 */
class SettingsStore extends EventEmitter {
  constructor({ filePath, logger = console }) {
    super();
    this.filePath = filePath;
    this.logger = logger;
    this.settings = { ...DEFAULTS };
    this.loaded = false;
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const { settings, warnings } = validateSettings(parsed);
      this.settings = settings;
      if (warnings.length > 0) {
        this.logger.warn?.('[settings] adjusted on load:', warnings.join('; '));
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.logger.warn?.('[settings] unreadable settings file:', err.message);
        try {
          const backup = `${this.filePath}.corrupt-${Date.now()}`;
          fs.renameSync(this.filePath, backup);
        } catch {
          /* ignore */
        }
      }
      this.settings = { ...DEFAULTS };
    }
    this.loaded = true;
    return this.settings;
  }

  get() {
    if (!this.loaded) this.load();
    return { ...this.settings };
  }

  update(partial) {
    if (!this.loaded) this.load();
    const merged = { ...this.settings, ...(partial && typeof partial === 'object' ? partial : {}) };
    const { settings, warnings } = validateSettings(merged);

    const changedKeys = Object.keys(settings).filter((key) => settings[key] !== this.settings[key]);
    this.settings = settings;
    this.#save();

    if (changedKeys.length > 0) {
      this.emit('changed', this.get(), changedKeys);
    }

    return { settings: this.get(), warnings, changed: changedKeys };
  }

  reset() {
    this.settings = { ...DEFAULTS };
    this.#save();
    this.emit('changed', this.get(), Object.keys(DEFAULTS));
    return this.get();
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, `${JSON.stringify(this.settings, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      this.logger.error?.('[settings] failed to save:', err.message);
    }
  }
}

module.exports = { SettingsStore };
