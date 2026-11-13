const { contextBridge, ipcRenderer } = require('electron');

// Safe, minimal API surface exposed to the renderer
contextBridge.exposeInMainWorld('api', {
  browseFile: (options) => ipcRenderer.invoke('dialog:browseFile', options),
  browseFolder: () => ipcRenderer.invoke('dialog:browseFolder'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // Phase 2 — local toolchain setup
  toolchainDetect: () => ipcRenderer.invoke('toolchain:detect'),
  toolchainStart: () => ipcRenderer.invoke('toolchain:start'),
  toolchainCancel: () => ipcRenderer.invoke('toolchain:cancel'),

  // Phase 3 — project generation + build history
  projectGenerate: (input) => ipcRenderer.invoke('project:generate', input),
  stateLookup: (packageName) => ipcRenderer.invoke('state:lookup', packageName),

  // Phase 4 — Gradle build + live log
  projectBuild: (opts) => ipcRenderer.invoke('project:build', opts),
  buildCancel: () => ipcRenderer.invoke('build:cancel'),

  // Phase 5 — signing
  keystoreCreate: (opts) => ipcRenderer.invoke('keystore:create', opts),
  saveFile: (options) => ipcRenderer.invoke('dialog:saveFile', options),
  onBuildLog: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('build:log', handler);
    return () => ipcRenderer.removeListener('build:log', handler);
  },
  onToolchainProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('toolchain:progress', handler);
    return () => ipcRenderer.removeListener('toolchain:progress', handler);
  },
  onToolchainDone: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('toolchain:done', handler);
    return () => ipcRenderer.removeListener('toolchain:done', handler);
  }
});
