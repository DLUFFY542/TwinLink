'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => {
    try {
      callback(payload);
    } catch (err) {
      console.error(`[preload] listener for ${channel} failed`, err);
    }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  info: () => ipcRenderer.invoke('app:info'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),

  window: {
    setFullscreen: (value) => ipcRenderer.invoke('window:set-fullscreen', value),
    onFullscreen: (cb) => subscribe('window:fullscreen-changed', cb),
  },

  devices: {
    snapshot: () => ipcRenderer.invoke('devices:snapshot'),
    refresh: () => ipcRenderer.invoke('devices:refresh'),
    watch: () => ipcRenderer.invoke('devices:watch'),
    onChanged: (cb) => subscribe('devices:changed', cb),
    onAdbChanged: (cb) => subscribe('adb:changed', cb),
  },

  mirror: {
    start: (serial) => ipcRenderer.invoke('mirror:start', serial),
    stop: () => ipcRenderer.invoke('mirror:stop'),
    snapshot: () => ipcRenderer.invoke('mirror:snapshot'),
    sendInput: (payload) => ipcRenderer.send('mirror:input', payload),
    onState: (cb) => subscribe('mirror:state', cb),
    onSession: (cb) => subscribe('mirror:session', cb),
    onFrame: (cb) => subscribe('mirror:frame', cb),
    onStats: (cb) => subscribe('mirror:stats', cb),
    onError: (cb) => subscribe('mirror:error', cb),
    onAudioCodec: (cb) => subscribe('mirror:audio-codec', cb),
    onAudioFrame: (cb) => subscribe('mirror:audio-frame', cb),
    onAudioDisabled: (cb) => subscribe('mirror:audio-disabled', cb),
  },

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (partial) => ipcRenderer.invoke('settings:update', partial),
    reset: () => ipcRenderer.invoke('settings:reset'),
    onChanged: (cb) => subscribe('settings:changed', cb),
  },

  adb: {
    pick: () => ipcRenderer.invoke('adb:pick'),
    redetect: () => ipcRenderer.invoke('adb:redetect'),
  },

  files: {
    saveScreenshot: (data) => ipcRenderer.invoke('files:save-screenshot', { data }),
    saveRecording: (data, format) => ipcRenderer.invoke('files:save-recording', { data, format }),
  },

  wireless: {
    discover: () => ipcRenderer.invoke('wireless:discover'),
    pair: (payload) => ipcRenderer.invoke('wireless:pair', payload),
    connect: (payload) => ipcRenderer.invoke('wireless:connect', payload),
    disconnect: (payload) => ipcRenderer.invoke('wireless:disconnect', payload),
  },

  onToast: (cb) => subscribe('toast', cb),
};

contextBridge.exposeInMainWorld('twinlink', api);
