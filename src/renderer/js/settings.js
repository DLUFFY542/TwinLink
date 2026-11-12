import { api } from './api.js';
import {
  RECORDING_FORMATS,
  isRecordingFormatSupported,
  resolveRecordingFormat,
} from './recording-formats.js';

export function createSettings({ state, toast }) {
  const refs = {};

  function init() {
    refs.resolution = document.getElementById('set-resolution');
    refs.fps = document.getElementById('set-fps');
    refs.bitrate = document.getElementById('set-bitrate');
    refs.touches = document.getElementById('set-touches');
    refs.stayAwake = document.getElementById('set-stayawake');
    refs.audio = document.getElementById('set-audio');
    refs.audioBitrate = document.getElementById('set-audiobitrate');
    refs.autoReconnect = document.getElementById('set-autoreconnect');
    refs.attempts = document.getElementById('set-attempts');
    refs.scroll = document.getElementById('set-scroll');
    refs.scrollOut = document.getElementById('set-scroll-out');
    refs.theme = document.getElementById('set-theme');
    refs.stats = document.getElementById('set-stats');
    refs.recordingFormat = document.getElementById('set-recording-format');
    refs.recordingFormatNote = document.getElementById('recording-format-note');
    refs.adbPath = document.getElementById('adb-path');
    refs.diagAdb = document.getElementById('diag-adb');
    refs.diagAdbSource = document.getElementById('diag-adb-source');
    refs.diagServer = document.getElementById('diag-server');
    refs.diagChecksum = document.getElementById('diag-checksum');
    refs.diagVersions = document.getElementById('diag-versions');
    refs.diagSettingsPath = document.getElementById('diag-settings-path');

    bind('resolution', (value) => ({ maxSize: Number(value) }));
    bind('fps', (value) => ({ maxFps: Number(value) }));
    bind('bitrate', (value) => ({ bitrate: Number(value) }));
    bind('audioBitrate', (value) => ({ audioBitrate: Number(value) }));
    bind('attempts', (value) => ({ maxReconnectAttempts: Number(value) }));
    bind('theme', (value) => ({ theme: value }));
    bind('recordingFormat', (value) => ({ recordingFormat: value }));

    bindCheckbox(refs.touches, 'showTouches');
    bindCheckbox(refs.stayAwake, 'stayAwake');
    bindCheckbox(refs.audio, 'audio');
    bindCheckbox(refs.autoReconnect, 'autoReconnect');
    bindCheckbox(refs.stats, 'statsOverlay');

    refs.scroll.addEventListener('input', () => {
      refs.scrollOut.textContent = `${Number(refs.scroll.value).toFixed(2).replace(/\.00$/, '')}×`;
    });
    refs.scroll.addEventListener('change', () => {
      void update({ scrollSensitivity: Number(refs.scroll.value) });
    });

    document.getElementById('set-pick-adb').addEventListener('click', async () => {
      try {
        const result = await api.adb.pick();
        if (result.canceled) return;
        toast('adb path updated', 'ok');
        render(result.settings);
        renderAdb(result.adb);
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    document.getElementById('diag-refresh').addEventListener('click', async () => {
      try {
        const [info, adb] = await Promise.all([api.info(), api.adb.redetect()]);
        renderInfo(info);
        renderAdb(adb);
        toast('Checks completed', 'ok');
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    document.getElementById('open-platform-tools').addEventListener('click', () => {
      api
        .openExternal('https://developer.android.com/tools/releases/platform-tools')
        .catch((err) => toast(err.message, 'error'));
    });

    document.getElementById('reset-settings').addEventListener('click', async () => {
      try {
        const next = await api.settings.reset();
        render(next);
        toast('Settings reset', 'ok');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  function bind(key, mapper) {
    const node = refs[key];
    node.addEventListener('change', () => {
      void update(mapper(node.value));
    });
  }

  function bindCheckbox(node, key) {
    node.addEventListener('change', () => {
      void update({ [key]: node.checked });
    });
  }

  async function update(partial) {
    try {
      await api.settings.update(partial);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function render(settings) {
    if (!settings) return;
    refs.resolution.value = String(settings.maxSize);
    refs.fps.value = String(settings.maxFps);
    refs.bitrate.value = String(settings.bitrate);
    refs.touches.checked = settings.showTouches;
    refs.stayAwake.checked = settings.stayAwake;
    refs.audio.checked = settings.audio;
    refs.audioBitrate.value = String(settings.audioBitrate);
    refs.autoReconnect.checked = settings.autoReconnect;
    refs.attempts.value = String(settings.maxReconnectAttempts);
    refs.scroll.value = String(settings.scrollSensitivity);
    refs.scrollOut.textContent = `${Number(settings.scrollSensitivity).toFixed(2).replace(/\.00$/, '')}×`;
    refs.theme.value = settings.theme;
    refs.stats.checked = settings.statsOverlay;
    renderRecordingFormat(settings.recordingFormat);
  }

  /**
   * Disable formats this Chromium build cannot encode instead of offering a
   * choice that would silently fail, and say which format recording will use.
   */
  function renderRecordingFormat(selected) {
    if (!refs.recordingFormat) return;

    let supportedCount = 0;
    for (const option of refs.recordingFormat.options) {
      const supported = isRecordingFormatSupported(option.value);
      option.disabled = !supported;
      if (supported) supportedCount += 1;
    }

    refs.recordingFormat.value = selected;
    refs.recordingFormat.disabled = supportedCount === 0;

    if (supportedCount === 0) {
      refs.recordingFormatNote.textContent = 'This build cannot record video; no supported encoder was found.';
      return;
    }

    const resolved = resolveRecordingFormat(selected);
    if (resolved && resolved.id !== selected) {
      const preferred = RECORDING_FORMATS[selected]?.label || selected;
      refs.recordingFormatNote.textContent =
        `${preferred} is unavailable in this build; recordings will use ${resolved.label}.`;
      return;
    }

    refs.recordingFormatNote.textContent =
      'Formats this build cannot encode are disabled automatically.';
  }

  function renderAdb(adbInfo) {
    const label = adbInfo?.path || 'not found';
    refs.adbPath.textContent = label;
    refs.adbPath.title = label;
    refs.diagAdb.textContent = adbInfo?.version ? `${adbInfo.version}${adbInfo.available ? '' : ' (not running)'}` : label;
    refs.diagAdbSource.textContent = adbInfo?.source || '—';
  }

  function renderInfo(info) {
    if (!info) return;
    refs.diagVersions.textContent = `${info.app.version} · Electron ${info.runtime.electron} · Node ${info.runtime.node}`;
    refs.diagServer.textContent = info.server.jar
      ? `${info.server.jar} ${info.server.verified ? '· checksum verified' : '· checksum NOT verified'}`
      : 'missing';
    refs.diagChecksum.textContent = info.server.sha256 ? `${info.server.sha256.slice(0, 24)}…` : '—';
    refs.diagSettingsPath.textContent = info.settingsFile;
    refs.diagSettingsPath.title = info.settingsFile;
  }

  return { init, render, renderAdb, renderInfo };
}
