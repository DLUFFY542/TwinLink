import { api } from './api.js';
import { StreamDecoder } from './decoder.js';
import { AudioPlayer } from './audio.js';
import { formatBitrate, stateLabel } from './ui.js';
import { resolveRecordingFormat } from './recording-formats.js';

export function createMirrorView({ state, toast, navigate }) {
  const refs = {};
  let decoder = null;
  let audio = null;
  let audioEnabled = false;
  let viewActive = false;
  let videoSize = { width: 0, height: 0 };
  let recording = null;
  let recordingChunks = [];
  let discardRecording = false;
  let recordingStartedAt = 0;
  let recordTimer = null;
  let activeRecordingFormat = null;
  let pendingScroll = null;
  let scrollTimer = null;
  let dragging = false;

  function init() {
    refs.stage = document.getElementById('stage');
    refs.canvas = document.getElementById('phone-canvas');
    refs.placeholder = document.getElementById('stage-placeholder');
    refs.loading = document.getElementById('stage-loading');
    refs.loadingText = document.getElementById('stage-loading-text');
    refs.res = document.getElementById('mirror-res');
    refs.stats = document.getElementById('mirror-stats');
    refs.deviceName = document.getElementById('mirror-device-name');
    refs.statePill = document.getElementById('mirror-state-pill');
    refs.disconnect = document.getElementById('btn-disconnect');
    refs.fullscreen = document.getElementById('btn-fullscreen');
    refs.screenshot = document.getElementById('btn-screenshot');
    refs.record = document.getElementById('btn-recording');
    refs.recordLabel = document.getElementById('record-label');
    refs.mute = document.getElementById('mute-btn');
    refs.exitFullscreen = document.getElementById('btn-exit-fullscreen');

    decoder = new StreamDecoder({
      canvas: refs.canvas,
      onError: (err) => toast(`Video decoder: ${err.message}`, 'error'),
      onSize: () => fitCanvas(),
    });

    audio = new AudioPlayer({
      onError: (err) => {
        audioEnabled = false;
        refs.mute.classList.add('hidden');
        toast(`Audio disabled: ${err.message}`, 'warn');
      },
    });

    refs.canvas.classList.add('is-hidden');
    refs.res.classList.add('hidden');

    bindPointer();
    bindToolbar();
    bindKeyboard();

    new ResizeObserver(() => fitCanvas()).observe(refs.stage);
    api.window.onFullscreen(({ fullscreen }) => applyFullscreenUi(Boolean(fullscreen)));

    window.addEventListener('resize', fitCanvas);
    window.addEventListener('blur', () => {
      dragging = false;
    });

    api.mirror.onState(onState);
    api.mirror.onSession(onSession);
    api.mirror.onFrame(onFrame);
    api.mirror.onStats(onStats);
    api.mirror.onAudioCodec(onAudioCodec);
    api.mirror.onAudioFrame(onAudioFrame);
    api.mirror.onAudioDisabled(onAudioDisabled);

    document.getElementById('stage-connect').addEventListener('click', () => navigate('dashboard'));
  }

  function setActive(active) {
    viewActive = active;
    if (active) fitCanvas();
    else if (document.body.classList.contains('is-fullscreen')) void setFullscreen(false);
  }

  function isActive() {
    return viewActive;
  }

  function showPlaceholder(title, message) {
    refs.placeholder.classList.remove('hidden');
    refs.canvas.classList.add('is-hidden');
    const heading = refs.placeholder.querySelector('h3');
    const paragraph = refs.placeholder.querySelector('p');
    if (heading) heading.textContent = title;
    if (paragraph) paragraph.textContent = message;
    refs.res.classList.add('hidden');
    refs.stats.classList.add('hidden');
  }

  function onState(snapshot) {
    const stateName = snapshot.state || 'idle';
    refs.statePill.dataset.state = stateName;
    refs.statePill.textContent = stateLabel(stateName);

    if (snapshot.serial) {
      refs.deviceName.textContent = snapshot.deviceName || snapshot.serial;
    } else {
      refs.deviceName.textContent = 'Not connected';
    }

    const streaming = stateName === 'streaming';
    refs.disconnect.disabled = !(streaming || stateName === 'starting' || stateName === 'reconnecting');

    if (streaming) {
      refs.loading.classList.add('hidden');
      refs.placeholder.classList.add('hidden');
      refs.canvas.classList.remove('is-hidden');
      if (videoSize.width) refs.res.classList.remove('hidden');
      fitCanvas();
    } else if (stateName === 'starting' || stateName === 'reconnecting') {
      refs.loading.classList.remove('hidden');
      refs.loadingText.textContent =
        stateName === 'starting'
          ? 'Connecting to the device…'
          : `Reconnecting… (attempt ${snapshot.attempt || 1})`;
      refs.placeholder.classList.add('hidden');
      refs.canvas.classList.add('is-hidden');
    } else if (stateName === 'error') {
      refs.loading.classList.add('hidden');
      showPlaceholder('Connection failed', snapshot.error || 'The device could not be mirrored.');
    } else if (stateName === 'stopped' || stateName === 'idle') {
      refs.loading.classList.add('hidden');
      showPlaceholder('No active session', 'Choose a device and press Connect.');
      stopRecording(false);
    }

    if (!streaming && snapshot.state !== 'reconnecting' && snapshot.state !== 'starting') {
      stopRecording(false);
    }
  }

  function onSession(info) {
    videoSize = { width: info.width, height: info.height };
    decoder.setSession(info);
    refs.res.textContent = `${info.width} × ${info.height}`;
    refs.res.classList.remove('hidden');
    fitCanvas();
  }

  function onFrame(frame) {
    if (!frame || !frame.data) return;
    decoder.push({ data: frame.data, isConfig: frame.isConfig, isKey: frame.isKey });
  }

  function onStats(stats) {
    if (!state.settings?.statsOverlay) {
      refs.stats.classList.add('hidden');
      return;
    }
    refs.stats.textContent = `${stats.fps} fps · ${formatBitrate(stats.kbps)}`;
    refs.stats.classList.remove('hidden');
  }

  function onAudioCodec({ codec }) {
    try {
      audio.configure(codec);
      audioEnabled = true;
      refs.mute.classList.remove('hidden');
    } catch (err) {
      audioEnabled = false;
      toast(`Audio unavailable: ${err.message}`, 'warn');
    }
  }

  function onAudioFrame(frame) {
    if (!audioEnabled || !frame?.data) return;
    audio.push({ data: frame.data, isConfig: frame.isConfig });
  }

  function onAudioDisabled({ reason }) {
    audioEnabled = false;
    refs.mute.classList.add('hidden');
    if (reason) toast(`Audio: ${reason}`, 'warn');
  }

  function applySettings(settings) {
    if (refs.stats) {
      refs.stats.classList.toggle('hidden', !settings.statsOverlay);
    }
  }

  function fitCanvas() {
    if (!refs.stage || !refs.canvas) return;
    if (refs.canvas.classList.contains('is-hidden')) return;
    const width = videoSize.width || refs.canvas.width;
    const height = videoSize.height || refs.canvas.height;
    if (!width || !height) return;

    const rect = refs.stage.getBoundingClientRect();
    const padding = 20;
    const availableWidth = Math.max(80, rect.width - padding * 2);
    const availableHeight = Math.max(80, rect.height - padding * 2);
    const scale = Math.min(availableWidth / width, availableHeight / height);

    refs.canvas.style.width = `${Math.floor(width * scale)}px`;
    refs.canvas.style.height = `${Math.floor(height * scale)}px`;
  }

  function mapPoint(event) {
    const rect = refs.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const width = videoSize.width || refs.canvas.width;
    const height = videoSize.height || refs.canvas.height;
    return {
      x: ((event.clientX - rect.left) / rect.width) * width,
      y: ((event.clientY - rect.top) / rect.height) * height,
    };
  }

  function sendTouch(action, point) {
    api.mirror.sendInput({ type: 'touch', action, x: point.x, y: point.y });
  }

  function bindPointer() {
    const canvas = refs.canvas;

    canvas.addEventListener('contextmenu', (event) => event.preventDefault());

    canvas.addEventListener('pointerdown', (event) => {
      const point = mapPoint(event);
      if (!point) return;
      event.preventDefault();
      canvas.focus();

      if (event.button === 0) {
        dragging = true;
        canvas.setPointerCapture(event.pointerId);
        sendTouch(0, point);
      } else if (event.button === 2) {
        api.mirror.sendInput({ type: 'action', name: 'back' });
      } else if (event.button === 1) {
        api.mirror.sendInput({ type: 'action', name: 'home' });
      }
    });

    canvas.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      if (event.buttons === 0) {
        // The pointer-up happened outside the canvas (for example on another
        // monitor); stop dragging so the next click is not a phantom drag.
        dragging = false;
        return;
      }
      const point = mapPoint(event);
      if (point) sendTouch(2, point);
    });

    const endDrag = (event) => {
      if (!dragging) return;
      dragging = false;
      const point = mapPoint(event);
      if (point) sendTouch(1, point);
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
    };

    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    canvas.addEventListener(
      'wheel',
      (event) => {
        if (!videoSize.width) return;
        event.preventDefault();
        const point = mapPoint(event);
        if (!point) return;

        let dy = event.deltaY;
        let dx = event.deltaX;
        if (event.deltaMode === 1) {
          dy *= 16;
          dx *= 16;
        } else if (event.deltaMode === 2) {
          dy *= 320;
          dx *= 320;
        }

        if (!pendingScroll) {
          pendingScroll = { x: point.x, y: point.y, dx: 0, dy: 0 };
        }
        pendingScroll.dx += dx;
        pendingScroll.dy += dy;
        pendingScroll.x = point.x;
        pendingScroll.y = point.y;

        if (!scrollTimer) {
          scrollTimer = setTimeout(() => {
            scrollTimer = null;
            const pending = pendingScroll;
            pendingScroll = null;
            if (!pending) return;
            api.mirror.sendInput({
              type: 'scroll',
              x: pending.x,
              y: pending.y,
              deltaX: pending.dx,
              deltaY: pending.dy,
              sensitivity: state.settings?.scrollSensitivity ?? 1,
            });
          }, 16);
        }
      },
      { passive: false },
    );
  }

  function bindToolbar() {
    for (const button of document.querySelectorAll('[data-action]')) {
      button.addEventListener('click', () => {
        api.mirror.sendInput({ type: 'action', name: button.dataset.action });
      });
    }

    for (const button of document.querySelectorAll('[data-rail]')) {
      const rail = button.dataset.rail;
      button.addEventListener('click', () => {
        if (rail === 'screenshot') void takeScreenshot();
        else if (rail === 'record') void toggleRecording();
        else if (rail === 'fullscreen') void toggleFullscreen();
        else if (rail === 'mute') {
          const muted = button.classList.toggle('is-active');
          audio.setMuted(muted);
        }
      });
    }

    refs.screenshot.addEventListener('click', () => void takeScreenshot());
    refs.record.addEventListener('click', () => void toggleRecording());
    refs.fullscreen.addEventListener('click', () => void toggleFullscreen());
    refs.exitFullscreen.addEventListener('click', () => void setFullscreen(false));
    refs.disconnect.addEventListener('click', async () => {
      try {
        await api.mirror.stop();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  function bindKeyboard() {
    const isTypingTarget = (target) =>
      target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

    window.addEventListener('keydown', (event) => {
      if (!viewActive || isTypingTarget(event.target)) return;
      if (event.key === 'F11' || (event.altKey && event.key === 'Enter')) {
        event.preventDefault();
        toggleFullscreen();
        return;
      }
      if (event.key === 'Escape' && document.body.classList.contains('is-fullscreen')) {
        event.preventDefault();
        void setFullscreen(false);
        return;
      }
      if (!videoSize.width) return;

      api.mirror.sendInput({
        type: 'keyboard',
        phase: 'down',
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
      });

      if (event.key !== 'F5' && !event.ctrlKey) {
        event.preventDefault();
      }
    });

    window.addEventListener('keyup', (event) => {
      if (!viewActive || isTypingTarget(event.target)) return;
      if (!videoSize.width) return;
      if (event.key === 'F11' || (event.altKey && event.key === 'Enter')) return;
      api.mirror.sendInput({
        type: 'keyboard',
        phase: 'up',
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
      });
    });
  }

  function applyFullscreenUi(fullscreen) {
    document.body.classList.toggle('is-fullscreen', fullscreen);
    refs.fullscreen.textContent = fullscreen ? 'Exit fullscreen' : 'Fullscreen';
    if (fullscreen) {
      // The window enters fullscreen asynchronously; refit after layout settles.
      requestAnimationFrame(fitCanvas);
      setTimeout(fitCanvas, 120);
    } else {
      fitCanvas();
    }
  }

  async function setFullscreen(fullscreen) {
    try {
      const result = await api.window.setFullscreen(fullscreen);
      applyFullscreenUi(Boolean(result.fullscreen));
    } catch (err) {
      toast(`Fullscreen unavailable: ${err.message}`, 'warn');
    }
  }

  function toggleFullscreen() {
    void setFullscreen(!document.body.classList.contains('is-fullscreen'));
  }

  async function takeScreenshot() {
    if (!videoSize.width) {
      toast('Nothing to capture yet', 'warn');
      return;
    }
    try {
      const blob = await new Promise((resolve, reject) => {
        refs.canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('canvas export failed'))), 'image/png');
      });
      const buffer = new Uint8Array(await blob.arrayBuffer());
      const result = await api.files.saveScreenshot(buffer);
      if (result.ok) toast(`Screenshot saved to ${result.path}`, 'ok');
    } catch (err) {
      toast(`Screenshot failed: ${err.message}`, 'error');
    }
  }

  function updateRecordUi() {
    if (!recording) {
      refs.record.textContent = 'Record';
      refs.recordLabel.textContent = 'Record';
      return;
    }
    const seconds = Math.floor((Date.now() - recordingStartedAt) / 1000);
    const label = `Stop ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    refs.record.textContent = label;
    refs.recordLabel.textContent = 'Stop';
  }

  async function toggleRecording() {
    if (recording) {
      discardRecording = false;
      recording.stop();
      return;
    }
    if (!videoSize.width) {
      toast('Nothing to record yet', 'warn');
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      toast('Recording is not supported by this build', 'error');
      return;
    }

    const preferred = state.settings?.recordingFormat || 'webm-vp9';
    const format = resolveRecordingFormat(preferred);
    if (!format) {
      toast('This build cannot record video in any supported format', 'error');
      return;
    }
    if (format.id !== preferred) {
      toast(`Recording format ${preferred} is unavailable; using ${format.label}`, 'warn');
    }

    try {
      const stream = refs.canvas.captureStream(30);
      recordingChunks = [];
      activeRecordingFormat = format;
      recording = new MediaRecorder(stream, { mimeType: format.mime, videoBitsPerSecond: 8000000 });
      recordingStartedAt = Date.now();

      recording.addEventListener('dataavailable', (event) => {
        if (event.data && event.data.size > 0) recordingChunks.push(event.data);
      });

      recording.addEventListener('stop', async () => {
        const chunks = recordingChunks;
        const discard = discardRecording;
        const usedFormat = activeRecordingFormat;
        discardRecording = false;
        recording = null;
        recordingChunks = [];
        activeRecordingFormat = null;
        if (recordTimer) {
          clearInterval(recordTimer);
          recordTimer = null;
        }
        updateRecordUi();

        if (discard) {
          toast('Recording discarded because the session ended', 'warn');
          return;
        }

        if (chunks.length === 0) {
          toast('Recording was empty', 'warn');
          return;
        }
        try {
          const blob = new Blob(chunks, { type: usedFormat.mime });
          const result = await api.files.saveRecording(
            new Uint8Array(await blob.arrayBuffer()),
            usedFormat.container,
          );
          if (result.ok) toast(`Recording saved to ${result.path}`, 'ok');
        } catch (err) {
          toast(`Saving recording failed: ${err.message}`, 'error');
        }
      });

      recording.start(1000);
      recordTimer = setInterval(updateRecordUi, 500);
      updateRecordUi();
      toast('Recording started', 'ok');
    } catch (err) {
      recording = null;
      activeRecordingFormat = null;
      toast(`Recording failed: ${err.message}`, 'error');
    }
  }

  function stopRecording(save) {
    if (!recording) return;
    // The 'stop' handler owns cleanup and saving. When the session ends on its
    // own we must not pop a save dialog, so mark the capture as discarded.
    discardRecording = !save;
    recording.stop();
  }

  async function prepareAudio(settings) {
    if (!settings.audio) return;
    try {
      await audio.init();
    } catch (err) {
      toast(`Audio could not start: ${err.message}`, 'warn');
    }
  }

  return {
    init,
    setActive,
    isActive,
    onState,
    onSession,
    onFrame,
    onStats,
    onAudioCodec,
    onAudioFrame,
    onAudioDisabled,
    applySettings,
    prepareAudio,
    closeAudio: () => audio?.close(),
  };
}
