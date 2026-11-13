// ============ signer.js — Phase 5: keystore creation + APK/AAB signing =====
//
// Signing tools (all local, all free, all downloaded by Setup):
//   keytool.exe   (JDK)    -> create a new release keystore (PKCS12, RSA 2048)
//   zipalign.exe  (SDK)    -> align the APK BEFORE signing (required for v2+)
//   apksigner.bat (SDK)    -> sign + verify the APK (v1/v2/v3 schemes)
//   jarsigner.exe (JDK)    -> sign + verify the AAB (JAR scheme, what Play wants)
//
// Password notes: passed as arguments (visible only to this local machine).
// Characters " and % are rejected up-front because cmd.exe would mangle them.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

class Signer {
  // ---------------- tool locations ----------------

  _buildToolsDir(sdkDir) {
    const base = path.join(sdkDir, 'build-tools');
    const dirs = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    if (!dirs.length) throw new Error('No build-tools installed in the Android SDK.');
    return path.join(base, dirs[dirs.length - 1]);
  }

  // ---------------- keystore creation ----------------

  async createKeystore(opts, jdkHome) {
    const file = (opts.file || '').trim();
    const alias = (opts.alias || '').trim();
    const storePass = opts.storePass || '';
    const keyPass = opts.keyPass || storePass;
    const cn = (opts.cn || '').trim();
    const org = (opts.org || '').trim();
    const country = (opts.country || '').trim().toUpperCase();

    if (!file) throw new Error('Choose where to save the keystore file.');
    if (fs.existsSync(file)) {
      throw new Error('That file already exists — pick a new name or delete it.');
    }
    if (!alias) throw new Error('Key alias is required.');
    if (!/^[A-Za-z0-9._-]+$/.test(alias)) {
      throw new Error('Key alias may only contain letters, digits, dot, dash, underscore.');
    }
    if (storePass.length < 6) throw new Error('Password must be at least 6 characters.');
    if (!cn) throw new Error('Your name (CN) is required.');
    if (country && !/^[A-Z]{2}$/.test(country)) {
      throw new Error('Country must be a 2-letter code (e.g. US, PK, DE).');
    }
    if (/[\"%]/.test(storePass) || /[\"%]/.test(keyPass)) {
      throw new Error('Passwords cannot contain the characters " or %.');
    }

    let dname = 'CN=' + cn;
    if (org) dname += ',O=' + org;
    if (country) dname += ',C=' + country;

    const keytool = path.join(jdkHome, 'bin', 'keytool.exe');
    if (!fs.existsSync(keytool)) throw new Error('keytool.exe not found in the JDK.');

    fs.mkdirSync(path.dirname(file), { recursive: true });

    const res = await this._runExe(keytool, [
      '-genkeypair',
      '-keystore', file,
      '-alias', alias,
      '-keyalg', 'RSA',
      '-keysize', '2048',
      '-validity', '10000',
      '-storetype', 'PKCS12',
      '-storepass', storePass,
      '-keypass', keyPass,
      '-dname', dname
    ]);

    if (res.code !== 0) throw new Error('keytool failed: ' + this._tail(res.out));
    if (!fs.existsSync(file)) {
      throw new Error('keytool reported success but no file was created.');
    }
    return { file, alias };
  }

  // ---------------- APK signing ----------------

  async signApk(apkPath, ks, sdkDir, jdkHome, log) {
    log = log || (() => {});
    const bt = this._buildToolsDir(sdkDir);
    const keyPass = ks.keyPass || ks.storePass;
    // apksigner.bat launches `java` — force our JDK 17 or an old PATH Java 8
    // cannot parse the modern PKCS12 written by keytool
    const env = { ...process.env, JAVA_HOME: jdkHome, PATH: path.join(jdkHome, 'bin') + ';' + (process.env.PATH || '') };

    // 1. zipalign (must happen BEFORE v2 signing)
    const zipalign = path.join(bt, 'zipalign.exe');
    const aligned = apkPath + '.aligned';
    log('zipalign -f -p 4 …');
    const z = await this._runExe(zipalign, ['-f', '-p', '4', apkPath, aligned]);
    if (z.code !== 0) throw new Error('zipalign failed: ' + this._tail(z.out));
    fs.rmSync(apkPath, { force: true });
    fs.renameSync(aligned, apkPath);

    // 2. apksigner (a .bat -> cmd.exe with canonical quoting)
    const apksigner = path.join(bt, 'apksigner.bat');
    const signCmd =
      '"' + apksigner + '" sign --ks "' + ks.keystorePath +
      '" --ks-type pkcs12' +
      ' --ks-key-alias "' + ks.alias +
      '" --ks-pass "pass:' + ks.storePass +
      '" --key-pass "pass:' + keyPass +
      '" "' + apkPath + '"';
    log('apksigner sign …');
    const s = await this._runCmd(signCmd, env);
    if (s.code !== 0) throw new Error('apksigner sign failed: ' + this._tail(s.out));

    // 3. verify + print certificate info
    const v = await this._runCmd('"' + apksigner + '" verify --print-certs "' + apkPath + '"', env);
    if (v.code !== 0) {
      throw new Error('APK verification failed after signing: ' + this._tail(v.out));
    }

    const dn = ((v.out.match(/Signer #1 certificate DN:\s*(.+)/) || [])[1] || '').trim();
    const schemes = (v.out.match(/Verified using v\d scheme/g) || []).join(', ');
    log('APK verified ✓ ' + (dn || 'signer certificate') + (schemes ? ' · ' + schemes : ''), 'ok');
    return { dn };
  }

  // ---------------- AAB signing ----------------

  async signAab(aabPath, ks, jdkHome, log) {
    log = log || (() => {});
    const jarsigner = path.join(jdkHome, 'bin', 'jarsigner.exe');
    const keyPass = ks.keyPass || ks.storePass;

    log('jarsigner (upload key) …');
    const s = await this._runExe(jarsigner, [
      '-keystore', ks.keystorePath,
      '-storepass', ks.storePass,
      '-keypass', keyPass,
      '-sigalg', 'SHA256withRSA',
      '-digestalg', 'SHA-256',
      aabPath,
      ks.alias
    ]);
    if (s.code !== 0) throw new Error('jarsigner failed: ' + this._tail(s.out));

    const v = await this._runExe(jarsigner, ['-verify', aabPath]);
    const out = v.out || '';
    if (v.code !== 0 || /jar is unsigned/.test(out)) {
      throw new Error('AAB verification failed after signing: ' + this._tail(out));
    }
    log('AAB verified ✓ jar verified', 'ok');
    return {};
  }

  // ---------------- default test keystore ----------------
  //
  // When "Sign with my keystore" is unticked the build must STILL be signed
  // (Android rejects unsigned APKs), so we auto-create and reuse a local
  // test keystore in the app's own data folder. Phone installs work; Play
  // Store releases should use the user's own keystore instead.

  defaultKeystoreInfo(dataRoot) {
    const dir = path.join(dataRoot, 'test-keys');
    return {
      keystorePath: path.join(dir, 'htmltoandroid-test.jks'),
      alias: 'htmltoandroid',
      storePass: 'htmltoandroid',
      keyPass: 'htmltoandroid',
      cn: 'html-to-android test key'
    };
  }

  async ensureDefaultKeystore(dataRoot, jdkHome) {
    const ks = this.defaultKeystoreInfo(dataRoot);
    if (fs.existsSync(ks.keystorePath)) return ks;
    await this.createKeystore(
      {
        file: ks.keystorePath,
        alias: ks.alias,
        storePass: ks.storePass,
        keyPass: ks.keyPass,
        cn: ks.cn,
        org: '',
        country: ''
      },
      jdkHome
    );
    return ks;
  }

  // ---------------- process helpers ----------------

  _tail(text, lines = 6) {
    return (
      String(text || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(-lines)
        .join(' | ') || 'no output'
    );
  }

  _runExe(exe, args) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(exe, args, { windowsHide: true });
      } catch (err) {
        return resolve({ code: -1, out: (err && err.message) || String(err) });
      }
      let out = '';
      if (child.stdout) child.stdout.on('data', (d) => (out += d.toString()));
      if (child.stderr) child.stderr.on('data', (d) => (out += d.toString()));
      child.on('error', (err) => resolve({ code: -1, out: (err && err.message) || String(err) }));
      child.on('close', (code) => resolve({ code: code === null ? -1 : code, out }));
    });
  }

  _runCmd(inner, env) {
    // canonical cmd.exe quoting: /s strips the outer first+last quote
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '"' + inner + '"'], {
          windowsHide: true,
          windowsVerbatimArguments: true,
          env: env || process.env
        });
      } catch (err) {
        return resolve({ code: -1, out: (err && err.message) || String(err) });
      }
      let out = '';
      if (child.stdout) child.stdout.on('data', (d) => (out += d.toString()));
      if (child.stderr) child.stderr.on('data', (d) => (out += d.toString()));
      child.on('error', (err) => resolve({ code: -1, out: (err && err.message) || String(err) }));
      child.on('close', (code) => resolve({ code: code === null ? -1 : code, out }));
    });
  }
}

module.exports = { Signer };
