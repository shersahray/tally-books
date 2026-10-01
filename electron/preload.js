'use strict';
// Only the app's own connection page (a file inside the app) gets these. Pages from a server never do.
const { contextBridge, ipcRenderer } = require('electron');
if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('tallyDesktop', {
    info: () => ipcRenderer.invoke('desktop:info'),
    useLocal: () => ipcRenderer.invoke('desktop:use-local'),
    useServer: url => ipcRenderer.invoke('desktop:use-server', String(url || '')),
    retry: () => ipcRenderer.invoke('desktop:retry'),
    change: () => ipcRenderer.invoke('desktop:change'),
    pickFolder: () => ipcRenderer.invoke('desktop:pick-folder'),
    useFolder: how => ipcRenderer.invoke('desktop:use-folder', how === 'open' ? 'open' : 'move'),
  });
}
