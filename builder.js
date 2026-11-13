// ============ builder.js — Phase 4: run Gradle, deliver APK + AAB ============
//
// Runs the generated project's gradlew (assembleRelease + bundleRelease) with:
//   JAVA_HOME         -> local Temurin JDK from the toolchain
//   GRADLE_USER_HOME  -> %LOCALAPPDATA%\html-to-android\gradle-home (local cache)
//   ANDROID_HOME      -> local Android SDK from the toolchain
// Streams every log line to the UI, then copies the artifacts to the
// user-chosen output folder as <package>-v<version>.apk / .aab.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

class Builder {
  constructor(dataRoot) {
    this.dataRoot = dataRoot;
    this.gradleHome = path.join(dataRoot, 'gradle-home');
    this.child = null;
    this.cancelled = false;
    this.wrongBlock = [];
    this.capturingWrong = false;
  }

  cancel() {
    if (!this.child || !this.child.pid) return { ok: false, error: 'No build is running.' };
    this.cancelled = true;
    try {
      spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { windowsHide: true });
    } catch (_) {}
    return { ok: true };
  }

  async build(options) {
    const { projectDir, outputFolder, baseName, javaHome, sdkDir, onLog } = options;

    if (this.child) return { ok: false, error: 'A build is already running.' };
    if (!javaHome || !fs.existsSync(path.join(javaHome, 'bin', 'java.exe'))) {
      return { ok: false, error: 'JDK not found — run Setup first.' };
    }
    if (!fs.existsSync(path.join(projectDir, 'gradlew.bat'))) {
      return { ok: false, error: 'Project is missing gradlew — generate the project again.' };
    }
    if (!outputFolder || !outputFolder.trim()) {
      return { ok: false, error: 'Choose an output folder first.' };
    }

    this.cancelled = false;
    this.wrongBlock = [];
    this.capturingWrong = false;

    const started = Date.now();
    const log = (line, cls) => {
      try {
        if (onLog) onLog(line, cls);
      } catch (_) {}
    };

    log('── html-to-android build · ' + new Date().toLocaleString() + ' ──', 'head');
    log('project : ' + projectDir, 'head');
    log('task    : gradlew assembleRelease bundleRelease', 'head');
    log('');

    const code = await this._runGradle(projectDir, javaHome, sdkDir, log);
    const duration = Math.round((Date.now() - started) / 1000);

    if (this.cancelled) return { ok: false, cancelled: true, duration };

    if (code !== 0) {
      const summary = this.wrongBlock.length ? ' — ' + this.wrongBlock.join(' | ') : '';
      return {
        ok: false,
        error: ('Gradle failed (exit ' + code + ')' + summary).slice(0, 700),
        duration
      };
    }

    // collect artifacts (name can be app-release-unsigned.apk etc.)
    const apk = this._firstFile(
      path.join(projectDir, 'app', 'build', 'outputs', 'apk', 'release'),
      '.apk'
    );
    const aab = this._firstFile(
      path.join(projectDir, 'app', 'build', 'outputs', 'bundle', 'release'),
      '.aab'
    );
    if (!apk || !aab) {
      return { ok: false, error: 'Build succeeded but the APK/AAB outputs were not found.' };
    }

    // deliver to the output folder
    try {
      fs.mkdirSync(outputFolder, { recursive: true });
      const outApk = path.join(outputFolder, baseName + '.apk');
      const outAab = path.join(outputFolder, baseName + '.aab');
      fs.copyFileSync(apk, outApk);
      fs.copyFileSync(aab, outAab);

      log('');
      log('Delivered: ' + outApk, 'ok');
      log('Delivered: ' + outAab, 'ok');

      return {
        ok: true,
        apk: outApk,
        aab: outAab,
        apkSize: fs.statSync(outApk).size,
        aabSize: fs.statSync(outAab).size,
        duration,
        signed: false
      };
    } catch (err) {
      return {
        ok: false,
        error:
          'Build succeeded but copying to the output folder failed: ' +
          ((err && err.message) || err)
      };
    }
  }

  // ---------------- internals ----------------

  _firstFile(dir, ext) {
    try {
      const name = fs.readdirSync(dir).find((n) => n.toLowerCase().endsWith(ext));
      return name ? path.join(dir, name) : null;
    } catch (_) {
      return null;
    }
  }

  _classify(line) {
    const t = line.trim();
    if (!t) return 'out';
    if (/BUILD SUCCESSFUL/.test(t)) return 'ok';
    if (/BUILD FAILED|FAILURE:|error:|Exception in thread|What went wrong/.test(t)) return 'err';
    if (/^WARNING:|^\s*warning:/.test(t)) return 'warn';
    if (/^> Task .*EXECUTED$/.test(t)) return 'task';
    return 'out';
  }

  _runGradle(projectDir, javaHome, sdkDir, log) {
    return new Promise((resolve) => {
      const gradlew = path.join(projectDir, 'gradlew.bat');
      const inner = `"${gradlew}" --console=plain --no-daemon assembleRelease bundleRelease`;

      const env = {
        ...process.env,
        JAVA_HOME: javaHome,
        GRADLE_USER_HOME: this.gradleHome,
        ANDROID_HOME: sdkDir,
        ANDROID_SDK_ROOT: sdkDir,
        PATH: path.join(javaHome, 'bin') + ';' + (process.env.PATH || '')
      };

      let child;
      try {
        child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '"' + inner + '"'], {
          windowsVerbatimArguments: true,
          windowsHide: true,
          cwd: projectDir,
          env
        });
      } catch (err) {
        log('Failed to start Gradle: ' + ((err && err.message) || err), 'err');
        return resolve(-1);
      }

      this.child = child;

      const makeStream = () => {
        let pending = '';
        return {
          push: (chunk) => {
            pending += chunk.toString();
            const parts = pending.split(/\r?\n/);
            pending = parts.pop();
            for (const line of parts) this._handleLine(line, log);
          },
          flush: () => {
            if (pending.trim()) this._handleLine(pending, log);
            pending = '';
          }
        };
      };

      const out = makeStream();
      const err = makeStream();

      if (child.stdout) child.stdout.on('data', (d) => out.push(d));
      if (child.stderr) child.stderr.on('data', (d) => err.push(d));

      child.on('error', (e) => {
        this.child = null;
        log('Failed to start Gradle: ' + ((e && e.message) || e), 'err');
        resolve(-1);
      });

      child.on('close', (code) => {
        out.flush();
        err.flush();
        this.child = null;
        resolve(code === null || code === undefined ? -1 : code);
      });
    });
  }

  _handleLine(line, log) {
    const cls = this._classify(line);
    log(line, cls);

    // capture the "What went wrong" block for a compact error message
    if (/What went wrong:/.test(line)) {
      this.capturingWrong = true;
      this.wrongBlock = [];
      return;
    }
    if (this.capturingWrong) {
      if (/^\s*\*\s*Try:/.test(line) || /BUILD FAILED/.test(line)) {
        this.capturingWrong = false;
        return;
      }
      const t = line.replace(/^\s*>\s*/, '').trim();
      if (t) {
        this.wrongBlock.push(t);
        if (this.wrongBlock.length >= 4) this.capturingWrong = false;
      }
    }
  }
}

module.exports = { Builder };
