'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pipeline', {
  ready: () => ipcRenderer.send('pipeline:ready'),
  result: (payload) => ipcRenderer.send('pipeline:result', payload),
  fail: (message) => ipcRenderer.send('pipeline:error', String(message)),
  onSession: (callback) => {
    ipcRenderer.on('pipeline:session', (_event, info) => callback(info));
  },
  onFrame: (callback) => {
    ipcRenderer.on('pipeline:frame', (_event, frame) => callback(frame));
  },
});
