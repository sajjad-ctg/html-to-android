const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { Toolchain } = require('./toolchain');
const { Generator } = require('./generator');
const { Builder } = require('./builder');
const { Signer } = require('./signer');
const { BuildState } = require('./state');

let mainWindow = null;
let toolchain = null;
let generator = null;
let builder = null;
let signer = null;
let buildState = null;

// Everything this app installs lives here — local only, never global
function getDataRoot() {
  if (process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'html-to-android');
  }
  return app.getPath('userData');
}

function emit(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createWindow() {
  // Window icon in dev; the packaged exe carries its own icon (build/ is
  // excluded from the bundle on purpose)
  const iconPath = path.join(__dirname, 'build', 'icon.png');

  mainWindow = new BrowserWindow({
    width: 940,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    height: 1100,
    minWidth: 800,
    minHeight: 720,
    backgroundColor: '#0d1220',
    title: 'html-to-android',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Safety net: never allow the renderer to open arbitrary windows
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
}

// ---------- IPC: file / folder pickers (Phase 1) ----------

ipcMain.handle('dialog:browseFile', async (_event, options = {}) => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: options.title || 'Select file',
    properties: ['openFile'],
    filters: options.filters || [{ name: 'All files', extensions: ['*'] }]
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:browseFolder', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select folder',
    properties: ['openDirectory', 'createDirectory']
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:saveFile', async (_event, options = {}) => {
  if (!mainWindow) return null;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: options.title || 'Save file',
    defaultPath: options.defaultPath || '',
    filters: options.filters || [{ name: 'All files', extensions: ['*'] }]
  });
  return result.canceled ? null : result.filePath;
});

ipcMain.handle('shell:openExternal', (_event, url) => {
  if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
    return shell.openExternal(url);
  }
});

// ---------- App lifecycle ----------

Menu.setApplicationMenu(null);

app.whenReady().then(() => {
  const dataRoot = getDataRoot();

  toolchain = new Toolchain(dataRoot, emit);
  generator = new Generator(dataRoot);
  builder = new Builder(dataRoot);
  signer = new Signer();
  buildState = new BuildState(dataRoot);

  ipcMain.handle('toolchain:detect', () => toolchain.detect());
  ipcMain.handle('toolchain:start', () => toolchain.start());
  ipcMain.handle('toolchain:cancel', () => toolchain.cancel());
  ipcMain.handle('project:generate', (_event, input) => generator.generate(input));
  ipcMain.handle('state:lookup', (_event, packageName) => buildState.lookup(packageName));

  // Phase 5 — keystore creation
  ipcMain.handle('keystore:create', async (_event, opts) => {
    const det = toolchain.detect();
    if (!det.jdk) return { ok: false, error: 'JDK not found — run Setup first.' };
    try {
      const res = await signer.createKeystore(opts, det.jdkHome);
      return { ok: true, ...res };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('project:build', async (_event, opts) => {
    const det = toolchain.detect();
    if (!det.jdk || !det.sdk) {
      return { ok: false, error: 'Build tools are missing — run Setup first.' };
    }
    const logLine = (line, cls) => emit('build:log', { line, cls });
    const result = await builder.build({
      ...opts,
      javaHome: det.jdkHome,
      sdkDir: det.sdkDir,
      onLog: logLine
    });

    // Phase 5 — ALWAYS sign: user's own keystore when chosen, otherwise the
    // local default test keystore (Android rejects unsigned APKs)
    if (result.ok) {
      const userKs = opts.signing && opts.signing.keystorePath;
      let ks;
      try {
        ks = userKs
          ? opts.signing
          : await signer.ensureDefaultKeystore(dataRoot, det.jdkHome);
      } catch (err) {
        result.ok = false;
        result.signed = false;
        result.error =
          'Could not prepare signing key: ' + ((err && err.message) || err);
        return result;
      }

      const mode = userKs ? 'your keystore' : 'default test key';
      logLine('');
      logLine('── Signing with ' + mode + ' ──', 'head');
      const signStarted = Date.now();
      try {
        await signer.signApk(result.apk, ks, det.sdkDir, det.jdkHome, logLine);
        await signer.signAab(result.aab, ks, det.jdkHome, logLine);
        result.signed = true;
        result.signMode = userKs ? 'user' : 'test';
        result.signDuration = Math.round((Date.now() - signStarted) / 1000);
        result.signedNote = 'SIGNED ✓';
      } catch (err) {
        // files are delivered but unsigned — say so clearly
        result.signed = false;
        result.error =
          'Built OK but signing FAILED: ' + ((err && err.message) || err) +
          ' — the files in your output folder are UNSIGNED.';
        result.ok = false;
      }
    }

    if (result.ok && opts.record && opts.record.packageName) {
      buildState.record(opts.record.packageName, opts.record.versionName, opts.record.versionCode);
      result.recorded = true;
    }

    // Success → drop the generated project + extracted zip (regenerated fresh
    // on every build; kept on failure so errors can be investigated).
    if (result.ok) {
      try {
        if (generator.cleanupProject(opts.projectDir)) {
          logLine('Local build files cleaned up.');
        }
      } catch (_) {
        // cleanup must never fail a build
      }
    }
    return result;
  });

  ipcMain.handle('build:cancel', () => builder.cancel());

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
