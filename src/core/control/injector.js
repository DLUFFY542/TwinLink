'use strict';

const {
  injectTouch,
  injectScroll,
  injectKeycode,
  injectText,
  rotateDevice,
  expandNotificationPanel,
  expandSettingsPanel,
  collapsePanels,
  backOrScreenOn,
} = require('../protocol/control');
const { MOTION_ACTION, KEY_ACTION, ANDROID_KEYCODE, POINTER_ID_MOUSE } = require('../protocol/constants');
const { keycodeFromEvent, metaStateFrom, SPECIAL_CODE_TO_KEYCODE } = require('./keymap');

const MAX_TOUCH_COORDINATE = 100000;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Validates untrusted renderer input and turns it into scrcpy control
 * messages. The renderer never supplies screen dimensions: they always come
 * from the active video stream, which prevents mismatched injections.
 */
class InputInjector {
  constructor({ getVideoSize, send, logger = console }) {
    this.getVideoSize = getVideoSize;
    this.send = send;
    this.logger = logger;
    this.lastScrollAt = 0;
  }

  handle(raw) {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, reason: 'empty input' };
    }

    const size = this.getVideoSize();
    if (!size || !size.width || !size.height) {
      return { ok: false, reason: 'video stream not ready' };
    }

    switch (raw.type) {
      case 'touch':
        return this.#touch(raw, size);
      case 'scroll':
        return this.#scroll(raw, size);
      case 'keyboard':
        return this.#keyboard(raw);
      case 'text':
        return this.#text(raw);
      case 'action':
        return this.#action(raw);
      default:
        return { ok: false, reason: 'unknown input type' };
    }
  }

  #position(x, y, size) {
    return {
      x: clamp(Math.round(x), 0, size.width - 1),
      y: clamp(Math.round(y), 0, size.height - 1),
      screenWidth: size.width,
      screenHeight: size.height,
    };
  }

  #touch(message, size) {
    const action = message.action;
    if (![MOTION_ACTION.DOWN, MOTION_ACTION.UP, MOTION_ACTION.MOVE].includes(action)) {
      return { ok: false, reason: 'invalid touch action' };
    }
    if (!Number.isFinite(message.x) || !Number.isFinite(message.y)) {
      return { ok: false, reason: 'invalid touch coordinates' };
    }
    if (Math.abs(message.x) > MAX_TOUCH_COORDINATE || Math.abs(message.y) > MAX_TOUCH_COORDINATE) {
      return { ok: false, reason: 'touch coordinates out of range' };
    }

    const pressed = action !== MOTION_ACTION.UP;
    const buffer = injectTouch({
      action,
      pointerId: POINTER_ID_MOUSE,
      position: this.#position(message.x, message.y, size),
      pressure: pressed ? 1 : 0,
      actionButton: pressed ? 1 : 0,
      buttons: pressed ? 1 : 0,
    });
    return { ok: this.send(buffer) };
  }

  #scroll(message, size) {
    if (!Number.isFinite(message.x) || !Number.isFinite(message.y)) {
      return { ok: false, reason: 'invalid scroll coordinates' };
    }
    const sensitivity = Number.isFinite(message.sensitivity) ? clamp(message.sensitivity, 0.25, 4) : 1;
    const deltaX = Number.isFinite(message.deltaX) ? message.deltaX : 0;
    const deltaY = Number.isFinite(message.deltaY) ? message.deltaY : 0;

    // One wheel notch reports ~100px. scrcpy's raw unit is +/-16 per notch.
    const hscroll = clamp((deltaX / 100) * 16 * sensitivity, -16, 16);
    const vscroll = clamp((deltaY / 100) * 16 * sensitivity, -16, 16);
    if (hscroll === 0 && vscroll === 0) {
      return { ok: false, reason: 'empty scroll' };
    }

    const buffer = injectScroll({
      position: this.#position(message.x, message.y, size),
      hscroll,
      vscroll,
      buttons: 0,
    });
    return { ok: this.send(buffer) };
  }

  #keyboard(message) {
    if (message.phase !== 'down' && message.phase !== 'up') {
      return { ok: false, reason: 'invalid key phase' };
    }

    const hasModifier = Boolean(message.ctrlKey || message.altKey || message.metaKey);
    const keycode = keycodeFromEvent(message);

    // Printable characters without modifiers are injected as text so the
    // device applies its own keyboard layout and IME.
    const isPrintable =
      typeof message.key === 'string' &&
      message.key.length === 1 &&
      !hasModifier &&
      !Object.prototype.hasOwnProperty.call(SPECIAL_CODE_TO_KEYCODE, message.code);

    if (isPrintable) {
      if (message.phase === 'up') {
        return { ok: true, skipped: true };
      }
      return { ok: this.send(injectText(message.key)) };
    }

    if (!keycode) {
      return { ok: false, reason: 'unmapped key' };
    }

    const action = message.phase === 'down' ? KEY_ACTION.DOWN : KEY_ACTION.UP;
    const buffer = injectKeycode({
      action,
      keycode,
      repeat: 0,
      metaState: metaStateFrom(message),
    });
    return { ok: this.send(buffer) };
  }

  #text(message) {
    if (typeof message.text !== 'string' || message.text.length === 0) {
      return { ok: false, reason: 'empty text' };
    }
    if (message.text.length > 300) {
      return { ok: false, reason: 'text too long' };
    }
    return { ok: this.send(injectText(message.text)) };
  }

  #action(message) {
    const name = message.name;
    const press = (keycode) => {
      const down = this.send(injectKeycode({ action: KEY_ACTION.DOWN, keycode, repeat: 0, metaState: 0 }));
      const up = this.send(injectKeycode({ action: KEY_ACTION.UP, keycode, repeat: 0, metaState: 0 }));
      return { ok: down && up };
    };

    switch (name) {
      case 'back':
        return press(ANDROID_KEYCODE.BACK);
      case 'home':
        return press(ANDROID_KEYCODE.HOME);
      case 'recents':
        return press(ANDROID_KEYCODE.APP_SWITCH);
      case 'volumeUp':
        return press(ANDROID_KEYCODE.VOLUME_UP);
      case 'volumeDown':
        return press(ANDROID_KEYCODE.VOLUME_DOWN);
      case 'power':
        return press(ANDROID_KEYCODE.POWER);
      case 'rotate':
        return { ok: this.send(rotateDevice()) };
      case 'notifications':
        return { ok: this.send(expandNotificationPanel()) };
      case 'quickSettings':
        return { ok: this.send(expandSettingsPanel()) };
      case 'collapsePanels':
        return { ok: this.send(collapsePanels()) };
      case 'screenOn':
        return { ok: this.send(backOrScreenOn(KEY_ACTION.DOWN)) && this.send(backOrScreenOn(KEY_ACTION.UP)) };
      default:
        return { ok: false, reason: 'unknown action' };
    }
  }
}

module.exports = { InputInjector };
