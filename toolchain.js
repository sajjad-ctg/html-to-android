// ============ toolchain.js — Phase 2: local build-tool bootstrap ============
//
// Downloads the free Android build tools into the app's own data folder:
//   %LOCALAPPDATA%\html-to-android\toolchain\
// Nothing is installed globally, no admin rights needed, and everything is
// detected and reused by every later build.
//
//   jdk\            Temurin JDK 17 (extracted, portable)
//   android-sdk\    Google cmdline-tools + platform + build-tools
//   downloads\      temporary zips (deleted after extraction)

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const JDK_URL = 'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse';

const CMDLINE_URLS = [
  'https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip',
  'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip'
];

const TARGET_SDK = 36; // keep in sync with the Target API dropdown default
const SDK_BASE_PACKAGES = ['platform-tools', 'platforms;android-' + TARGET_SDK];
// AGP 8.13 uses Build-Tools 35.0.0 as its default — install that FIRST so the
// first build works fully offline. Others are fallbacks for future AGP versions.
const BUILD_TOOLS_CANDIDATES = [
  'build-tools;35.0.0',
  'build-tools;36.0.0',
  'build-tools;35.0.1',
  'build-tools;34.0.0'
];

// Publicly documented Android SDK license acceptance hashes (written locally
// so sdkmanager never prompts interactively).
const LICENSE_FILES = {
  'android-sdk-license':
    '8933bad161af4178b1185d1a37fbf41ea5269c55\n' +
    'd56f5187479451eabf01fb78af6dfcb131a6481e\n' +
    '24333f8a63b6825ea9c5514f83c2829b004d1fee\n',
  'android-sdk-preview-license': '84831b9409646a918e30573bab4c9c91346d8abd\n',
  'android-sdk-arm-dbt-license': '859f317696f67ef3d7f30a50a5560e7834b43963\n',
  'google-gdk-license': '33b6a2b64607f11b759f320ef9dff4ae5c47d97a\n',
  'intel-android-extra-license': 'd975f751698a77b662f1254ddbeed3901e976f5a\n',
  'mips-android-sysimage-license': 'e9acab5b5fbb560a72cfaecce8946896ff6aab9d\n'
};

class Toolchain {
  constructor(dataRoot, emit) {
    this.dataRoot = dataRoot;
    this.toolchainDir = path.join(dataRoot, 'toolchain');
    this.jdkDir = path.join(this.toolchainDir, 'jdk');
    this.sdkDir = path.join(this.toolchainDir, 'android-sdk');
    this.downloadDir = path.join(this.toolchainDir, 'downloads');
    this.logFile = path.join(dataRoot, 'logs', 'toolchain.log');
    this.emit = typeof emit === 'function' ? emit : () => {};

    this.running = false;
    this.cancelled = false;
    this.abort = null;
    this.child = null;
  }

  // ---------- logging ----------

  log(message) {
    console.log('[toolchain] ' + message);
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.appendFileSync(this.logFile, `[${new Date().toISOString()}] ${message}\n`);
    } catch (_) {
      /* logging must never break setup */
    }
  }

  progress(step, status, percent, message) {
    const payload = { step, status, message };
    if (typeof percent === 'number') payload.percent = Math.max(0, Math.min(100, Math.round(percent)));
    this.emit('toolchain:progress', payload);
    if (status !== 'busy' || typeof percent !== 'number' || percent % 20 === 0) {
      this.log(`${step}: ${status}${percent != null ? ' ' + percent + '%' : ''} — ${message || ''}`);
    }
  }

  // ---------- detection / reuse ----------

  findJdkHome() {
    try {
      for (const entry of fs.readdirSync(this.jdkDir)) {
        if (fs.existsSync(path.join(this.jdkDir, entry, 'bin', 'java.exe'))) {
          return path.join(this.jdkDir, entry);
        }
      }
    } catch (_) {}
    return null;
  }

  sdkReady() {
    try {
      const sm = fs.existsSync(path.join(this.sdkDir, 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat'));
      const platform = fs.existsSync(path.join(this.sdkDir, 'platforms', 'android-' + TARGET_SDK));
      const btDir = path.join(this.sdkDir, 'build-tools');
      const buildTools = fs.existsSync(btDir) && fs.readdirSync(btDir).length > 0;
      return sm && platform && buildTools;
    } catch (_) {
      return false;
    }
  }

  detect() {
    const jdkHome = this.findJdkHome();
    return {
      jdk: !!jdkHome,
      sdk: this.sdkReady(),
      ready: !!jdkHome && this.sdkReady(),
      jdkHome,
      sdkDir: this.sdkDir,
      toolchainDir: this.toolchainDir,
      dataRoot: this.dataRoot
    };
  }

  // ---------- public API ----------

  async start() {
    if (this.running) return { ok: false, error: 'Setup is already running.' };

    this.running = true;
    this.cancelled = false;
    this.abort = new AbortController();

    try {
      // clean stale partial downloads from a previous failed run
      fs.rmSync(this.downloadDir, { recursive: true, force: true });
      fs.mkdirSync(this.downloadDir, { recursive: true });

      let det = this.detect();

      if (det.jdk) {
        this.progress('jdk', 'ready', 100, 'Ready ✓ (reused)');
      } else {
        await this.installJdk();
      }

      det = this.detect();
      if (det.sdk) {
        this.progress('sdk', 'ready', 100, 'Ready ✓ (reused)');
      } else {
        await this.installSdk();
      }

      const final = this.detect();
      fs.rmSync(this.downloadDir, { recursive: true, force: true });
      this.log('Setup complete.');
      this.emit('toolchain:done', { ok: true, detect: final });
      return { ok: true, detect: final };
    } catch (err) {
      const cancelled = this.cancelled;
      const message = cancelled ? 'Setup cancelled.' : (err && err.message) || String(err);
      this.log(cancelled ? 'Setup cancelled by user.' : 'Setup failed: ' + message);
      this.emit('toolchain:done', { ok: false, cancelled, error: message, detect: this.detect() });
      return { ok: false, cancelled, error: message, detect: this.detect() };
    } finally {
      this.running = false;
      this.abort = null;
      this.child = null;
    }
  }

  cancel() {
    if (!this.running) return { ok: false, error: 'Nothing is running.' };
    this.cancelled = true;
    this.log('Cancel requested.');
    try {
      if (this.abort) this.abort.abort();
    } catch (_) {}
    if (this.child && this.child.pid) {
      try {
        spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { windowsHide: true });
      } catch (_) {}
    }
    return { ok: true };
  }

  // ---------- JDK ----------

  async installJdk() {
    const zip = path.join(this.downloadDir, 'jdk.zip');

    this.progress('jdk', 'busy', 0, 'Downloading JDK…');
    await this.download(JDK_URL, zip, (pct) =>
      this.progress('jdk', 'busy', pct, `Downloading JDK… ${pct}%`)
    );

    this.progress('jdk', 'busy', null, 'Extracting JDK…');
    await this.extract(zip, this.jdkDir);
    fs.rmSync(zip, { force: true });

    if (!this.findJdkHome()) throw new Error('JDK extraction failed — java.exe not found.');
    this.progress('jdk', 'ready', 100, 'Ready ✓');
  }

  // ---------- Android SDK ----------

  async installSdk() {
    // 1. command-line tools
    const zip = path.join(this.downloadDir, 'cmdline-tools.zip');
    let downloaded = false;
    let lastError = null;

    for (const url of CMDLINE_URLS) {
      try {
        this.progress('sdk', 'busy', 0, 'Downloading Android SDK tools…');
        await this.download(url, zip, (pct) =>
          this.progress('sdk', 'busy', pct, `Downloading Android SDK tools… ${pct}%`)
        );
        downloaded = true;
        break;
      } catch (err) {
        lastError = err;
        if (this.cancelled) throw err;
        this.log('Download failed (' + (err && err.message) + ') — trying fallback URL');
      }
    }
    if (!downloaded) {
      throw new Error('Could not download Android command-line tools: ' + ((lastError && lastError.message) || 'unknown error'));
    }

    this.progress('sdk', 'busy', null, 'Extracting SDK tools…');
    await this.installCmdlineTools(zip);
    fs.rmSync(zip, { force: true });

    // 2. licenses (so sdkmanager never prompts)
    this.writeLicenses();

    // 3. platform + build-tools
    this.progress('sdk', 'busy', 0, 'Installing SDK packages…');
    await this.installPackages();

    this.progress('sdk', 'ready', 100, 'Ready ✓');
  }

  async installCmdlineTools(zip) {
    const temp = path.join(this.downloadDir, 'cli-extract');
    fs.rmSync(temp, { recursive: true, force: true });
    fs.mkdirSync(temp, { recursive: true });
    await this.extract(zip, temp);

    const root = this.findSdkmanagerRoot(temp);
    if (!root) throw new Error('Unexpected cmdline-tools zip layout (sdkmanager.bat not found).');

    const dest = path.join(this.sdkDir, 'cmdline-tools', 'latest');
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(root, dest, { recursive: true });
    fs.rmSync(temp, { recursive: true, force: true });

    if (!fs.existsSync(path.join(dest, 'bin', 'sdkmanager.bat'))) {
      throw new Error('cmdline-tools installation failed.');
    }
  }

  findSdkmanagerRoot(base) {
    const hasBin = (dir) => fs.existsSync(path.join(dir, 'bin', 'sdkmanager.bat'));
    if (hasBin(base)) return base;
    try {
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const level1 = path.join(base, entry.name);
        if (hasBin(level1)) return level1;
        try {
          for (const sub of fs.readdirSync(level1, { withFileTypes: true })) {
            if (!sub.isDirectory()) continue;
            const level2 = path.join(level1, sub.name);
            if (hasBin(level2)) return level2;
          }
        } catch (_) {}
      }
    } catch (_) {}
    return null;
  }

  writeLicenses() {
    const dir = path.join(this.sdkDir, 'licenses');
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(LICENSE_FILES)) {
      fs.writeFileSync(path.join(dir, name), content, 'utf8');
    }
    this.log('Android SDK licenses accepted locally.');
  }

  async installPackages() {
    let lastError = null;
    for (const buildTools of BUILD_TOOLS_CANDIDATES) {
      try {
        await this.runSdkManager([...SDK_BASE_PACKAGES, buildTools]);
        this.log('Installed: ' + [...SDK_BASE_PACKAGES, buildTools].join(', '));
        return;
      } catch (err) {
        if (this.cancelled) throw err;
        lastError = err;
        this.log('sdkmanager failed for ' + buildTools + ' (' + (err && err.message) + ') — trying fallback');
      }
    }
    throw lastError || new Error('SDK package installation failed.');
  }

  runSdkManager(packages) {
    return new Promise((resolve, reject) => {
      const sm = path.join(this.sdkDir, 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat');
      if (!fs.existsSync(sm)) return reject(new Error('sdkmanager.bat not found.'));
      const jdkHome = this.findJdkHome();
      if (!jdkHome) return reject(new Error('JDK not found.'));

      const env = {
        ...process.env,
        JAVA_HOME: jdkHome,
        ANDROID_HOME: this.sdkDir,
        ANDROID_SDK_ROOT: this.sdkDir,
        PATH: path.join(jdkHome, 'bin') + ';' + (process.env.PATH || '')
      };

      const inner =
        '"' + sm + '" --sdk_root="' + this.sdkDir + '" ' +
        packages.map((p) => '"' + p + '"').join(' ');

      this.log('Running sdkmanager: ' + packages.join(', '));

      // Canonical cmd.exe quoting: /s strips the outer first+last quote
      const child = spawn(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', '"' + inner + '"'],
        { windowsVerbatimArguments: true, windowsHide: true, env }
      );
      this.child = child;

      let out = '';
      let errBuf = '';

      const handle = (chunk, isError) => {
        const text = chunk.toString();
        if (isError) errBuf += text;
        else out += text;
        const matches = text.match(/(\d{1,3})%/g);
        if (matches && matches.length) {
          const pct = Math.min(99, parseInt(matches[matches.length - 1], 10));
          this.progress('sdk', 'busy', pct, `Installing SDK packages… ${pct}%`);
        }
      };

      if (child.stdout) child.stdout.on('data', (d) => handle(d, false));
      if (child.stderr) child.stderr.on('data', (d) => handle(d, true));

      child.on('error', (err) => {
        this.child = null;
        reject(err);
      });

      child.on('close', (code) => {
        this.child = null;
        if (this.cancelled) return reject(new Error('cancelled'));
        if (code === 0) return resolve();
        const tail = (errBuf + '\n' + out)
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(-6)
          .join(' | ');
        reject(new Error('sdkmanager exited with code ' + code + (tail ? ': ' + tail : '')));
      });
    });
  }

  // ---------- download / extract helpers ----------

  async download(url, dest, onPercent) {
    fs.mkdirSync(this.downloadDir, { recursive: true });
    const part = dest + '.part';
    fs.rmSync(part, { force: true });

    this.log('GET ' + url);
    const res = await fetch(url, { redirect: 'follow', signal: this.abort && this.abort.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    if (!res.body) throw new Error('Empty response body for ' + url);

    const total = Number(res.headers.get('content-length')) || 0;
    const out = fs.createWriteStream(part);
    const source = Readable.fromWeb(res.body);

    let done = 0;
    let lastEmit = 0;
    source.on('data', (chunk) => {
      done += chunk.length;
      const now = Date.now();
      if (total && now - lastEmit > 300) {
        lastEmit = now;
        if (onPercent) onPercent(Math.min(99, Math.floor((done / total) * 100)));
      }
    });

    try {
      await pipeline(source, out);
    } catch (err) {
      fs.rmSync(part, { force: true });
      throw err;
    }

    if (total && done < total) {
      fs.rmSync(part, { force: true });
      throw new Error('Download incomplete (' + done + '/' + total + ' bytes).');
    }

    if (onPercent) onPercent(100);
    fs.renameSync(part, dest);
    this.log('Downloaded ' + path.basename(dest) + ' (' + Math.round(done / 1024 / 1024) + ' MB)');
  }

  async extract(zip, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const tarOk = await this.run('tar.exe', ['-xf', zip, '-C', dest]);
    if (tarOk) return;

    this.log('tar.exe failed — falling back to PowerShell Expand-Archive');
    const ps =
      "Expand-Archive -LiteralPath '" + zip.replace(/'/g, "''") +
      "' -DestinationPath '" + dest.replace(/'/g, "''") + "' -Force";
    const psOk = await this.run('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      ps
    ]);
    if (!psOk) throw new Error('Extraction failed for ' + path.basename(zip));
  }

  run(cmd, args) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      let child;
      try {
        child = spawn(cmd, args, { windowsHide: true });
      } catch (_) {
        return finish(false);
      }
      let errBuf = '';
      if (child.stderr) child.stderr.on('data', (d) => (errBuf += d.toString()));
      child.on('error', () => finish(false));
      child.on('close', (code) => {
        if (code !== 0 && errBuf) this.log(cmd + ' stderr: ' + errBuf.trim().slice(0, 300));
        finish(code === 0);
      });
    });
  }
}

module.exports = { Toolchain };
