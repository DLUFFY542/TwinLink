import { api } from './api.js';
import { createToasts } from './ui.js';
import { createDashboard } from './dashboard.js';
import { createMirrorView } from './mirror.js';
import { createSettings } from './settings.js';
import { createWireless } from './wireless.js';

const state = {
  settings: null,
  devices: null,
  adb: null,
  mirror: null,
  info: null,
};

const toast = createToasts(document.getElementById('toasts'));

let currentView = 'dashboard';
let lastMirrorState = null;
let dashboard;
let mirrorView;
let settingsView;
let wireless;

function applyTheme(theme) {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const resolved = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
  document.documentElement.dataset.theme = resolved === 'light' ? 'light' : 'dark';
}

function navigate(view) {
  if (!['dashboard', 'mirror', 'settings'].includes(view)) return;
  currentView = view;

  for (const tab of document.querySelectorAll('.tab')) {
    const active = tab.dataset.view === view;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  }

  for (const section of document.querySelectorAll('.view')) {
    section.classList.toggle('is-active', section.id === `view-${view}`);
  }

  mirrorView.setActive(view === 'mirror');
}

function updateStatusChip() {
  const chip = document.getElementById('adb-chip');
  const text = document.getElementById('adb-chip-text');
  const adb = state.devices?.exe || state.adb;

  if (!adb || !adb.path) {
    chip.dataset.state = 'error';
    text.textContent = 'adb missing';
    return;
  }

  if (state.devices?.error) {
    chip.dataset.state = 'error';
    text.textContent = 'adb error';
    return;
  }

  const count = state.devices?.devices?.length || 0;
  chip.dataset.state = count > 0 ? 'ok' : 'idle';
  if (count === 0) {
    text.textContent = 'Waiting for a device';
  } else if (count === 1) {
    text.textContent = '1 device';
  } else {
    text.textContent = `${count} devices`;
  }
}

function wireEvents() {
  api.devices.onChanged((snapshot) => {
    state.devices = snapshot;
    state.adb = snapshot.exe;
    dashboard.render(snapshot);
    settingsView.renderAdb(snapshot.exe);
    updateStatusChip();
  });

  api.devices.onAdbChanged((adbInfo) => {
    state.adb = adbInfo;
    settingsView.renderAdb(adbInfo);
    updateStatusChip();
  });

  api.settings.onChanged(({ settings }) => {
    state.settings = settings;
    applyTheme(settings.theme);
    settingsView.render(settings);
    mirrorView.applySettings(settings);
  });

  api.mirror.onState((snapshot) => {
    // The controller re-emits state on every stats tick. Only switch tabs when
    // the session actually becomes live, otherwise the user is yanked back to
    // Mirror every second and cannot use Settings or Devices.
    const justStartedStreaming = snapshot.state === 'streaming' && lastMirrorState !== 'streaming';
    lastMirrorState = snapshot.state;
    state.mirror = snapshot;
    mirrorView.onState(snapshot);
    if (justStartedStreaming && currentView !== 'mirror') {
      navigate('mirror');
    }
  });

  api.mirror.onError(({ message }) => {
    if (message) toast(message, 'error', 6000);
  });

  api.onToast(({ message, kind }) => {
    if (message) toast(message, kind || 'info');
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.settings?.theme === 'system') applyTheme('system');
  });

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => navigate(tab.dataset.view));
  }
}

async function boot() {
  dashboard = createDashboard({
    state,
    toast,
    navigate,
    prepareAudio: (settings) => mirrorView.prepareAudio(settings || state.settings || {}),
  });
  mirrorView = createMirrorView({ state, toast, navigate });
  settingsView = createSettings({ state, toast });
  wireless = createWireless({ toast });

  dashboard.init();
  mirrorView.init();
  settingsView.init();
  wireless.init();
  wireEvents();

  navigate('dashboard');

  try {
    const [settings, info, devicesSnapshot, mirrorSnapshot] = await Promise.all([
      api.settings.get(),
      api.info(),
      api.devices.snapshot(),
      api.mirror.snapshot(),
    ]);

    state.settings = settings;
    state.info = info;
    state.devices = devicesSnapshot;
    state.adb = devicesSnapshot.exe;
    state.mirror = mirrorSnapshot;
    lastMirrorState = mirrorSnapshot.state;

    applyTheme(settings.theme);
    settingsView.render(settings);
    settingsView.renderInfo(info);
    settingsView.renderAdb(devicesSnapshot.exe);
    mirrorView.applySettings(settings);
    dashboard.render(devicesSnapshot);
    mirrorView.onState(mirrorSnapshot);
    updateStatusChip();

    await api.devices.watch();

    if (!info.server.verified) {
      toast('Mirroring server checksum could not be verified. Reinstall if mirroring fails.', 'warn', 7000);
    }
  } catch (err) {
    toast(`Startup problem: ${err.message}`, 'error', 9000);
  }
}

window.addEventListener('error', (event) => {
  console.error('[renderer]', event.error || event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[renderer] unhandled rejection', event.reason);
});

void boot();
