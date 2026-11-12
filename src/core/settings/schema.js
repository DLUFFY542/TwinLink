'use strict';

const RESOLUTION_CHOICES = Object.freeze([0, 720, 1080, 1440]);
const FPS_CHOICES = Object.freeze([30, 60, 90, 120]);
const THEMES = Object.freeze(['dark', 'light', 'system']);
const RECORDING_FORMATS = Object.freeze(['webm-vp9', 'webm-vp8', 'webm-av1', 'mp4-h264']);

const DEFAULTS = Object.freeze({
  schemaVersion: 1,
  maxSize: 1080,
  maxFps: 60,
  bitrate: 8000000,
  videoCodec: 'h264',
  audio: false,
  audioBitrate: 128000,
  theme: 'system',
  autoReconnect: true,
  maxReconnectAttempts: 3,
  showTouches: false,
  stayAwake: true,
  powerOn: true,
  adbPath: '',
  scrollSensitivity: 1,
  statsOverlay: false,
  recordingFormat: 'webm-vp9',
});

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function nearestChoice(value, choices, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (choices.includes(value)) return value;
  return choices.reduce((best, choice) => (Math.abs(choice - value) < Math.abs(best - value) ? choice : best), fallback);
}

/**
 * Validate untrusted settings input (renderer IPC or a hand-edited file).
 * Every field falls back to its default and produces a warning; nothing is
 * ever passed through unvalidated.
 */
function validateSettings(input) {
  const warnings = [];
  const source = isPlainObject(input) ? input : {};
  const result = { ...DEFAULTS };

  const take = (key) => {
    if (!Object.prototype.hasOwnProperty.call(source, key)) return false;
    return true;
  };

  if (take('maxSize')) {
    const next = nearestChoice(source.maxSize, RESOLUTION_CHOICES, DEFAULTS.maxSize);
    if (next !== source.maxSize) warnings.push(`maxSize coerced to ${next}`);
    result.maxSize = next;
  }

  if (take('maxFps')) {
    const next = nearestChoice(source.maxFps, FPS_CHOICES, DEFAULTS.maxFps);
    if (next !== source.maxFps) warnings.push(`maxFps coerced to ${next}`);
    result.maxFps = next;
  }

  if (take('bitrate')) {
    const next = clampNumber(source.bitrate, 500000, 50000000, DEFAULTS.bitrate);
    if (next !== source.bitrate) warnings.push(`bitrate clamped to ${next}`);
    result.bitrate = next;
  }

  if (take('videoCodec')) {
    // Only H.264 is decoded by the current renderer pipeline.
    if (source.videoCodec !== 'h264') warnings.push('only h264 is supported; value ignored');
    result.videoCodec = 'h264';
  }

  if (take('audio')) {
    result.audio = source.audio === true;
  }

  if (take('audioBitrate')) {
    result.audioBitrate = clampNumber(source.audioBitrate, 16000, 512000, DEFAULTS.audioBitrate);
  }

  if (take('theme')) {
    result.theme = THEMES.includes(source.theme) ? source.theme : DEFAULTS.theme;
    if (result.theme !== source.theme) warnings.push('theme reset to default');
  }

  if (take('autoReconnect')) {
    result.autoReconnect = source.autoReconnect === true;
  }

  if (take('maxReconnectAttempts')) {
    result.maxReconnectAttempts = clampNumber(source.maxReconnectAttempts, 0, 10, DEFAULTS.maxReconnectAttempts);
  }

  if (take('showTouches')) {
    result.showTouches = source.showTouches === true;
  }

  if (take('stayAwake')) {
    result.stayAwake = source.stayAwake === true;
  }

  if (take('powerOn')) {
    result.powerOn = source.powerOn === true;
  }

  if (take('adbPath')) {
    if (typeof source.adbPath === 'string' && source.adbPath.length <= 512 && !source.adbPath.includes('\0')) {
      result.adbPath = source.adbPath.trim();
    } else {
      warnings.push('adbPath ignored (invalid value)');
    }
  }

  if (take('scrollSensitivity')) {
    const value = typeof source.scrollSensitivity === 'number' && Number.isFinite(source.scrollSensitivity)
      ? source.scrollSensitivity
      : DEFAULTS.scrollSensitivity;
    result.scrollSensitivity = Math.min(4, Math.max(0.25, Math.round(value * 100) / 100));
  }

  if (take('statsOverlay')) {
    result.statsOverlay = source.statsOverlay === true;
  }

  if (take('recordingFormat')) {
    result.recordingFormat = RECORDING_FORMATS.includes(source.recordingFormat)
      ? source.recordingFormat
      : DEFAULTS.recordingFormat;
    if (result.recordingFormat !== source.recordingFormat) warnings.push('recordingFormat reset to default');
  }

  if (take('schemaVersion')) {
    result.schemaVersion = DEFAULTS.schemaVersion;
  }

  return { settings: result, warnings };
}

module.exports = {
  DEFAULTS,
  RESOLUTION_CHOICES,
  FPS_CHOICES,
  THEMES,
  RECORDING_FORMATS,
  validateSettings,
};
