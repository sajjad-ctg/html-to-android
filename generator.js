// ============ generator.js — Phase 3: HTML5 .zip -> patched Android project =
//
// Flow:
//   1. validate all inputs
//   2. extract the .zip and locate index.html (root or single subfolder)
//   3. copy the committed Capacitor template (template/android) to a work dir
//   4. inject the web assets into assets/public
//   5. patch: applicationId, version, orientation, fullscreen, keep-screen-on,
//      app name strings, target/min API, advanced toolchain overrides
//   6. generate all launcher icon sizes from the 512x512 PNG (jimp)
//
// Result: a complete, self-contained Gradle project at
//   %LOCALAPPDATA%\html-to-android\work\<package>\project
// ready for Phase 4 to run gradlew assembleRelease + bundleRelease.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Jimp } = require('jimp');

// Template location: repo folder in dev (and in headless tests). In the
// PACKAGED app electron-builder ships template/ as a REAL folder next to the
// exe (extraResources -> resources/template) — file copies and Gradle must
// touch real files, not app.asar. Only trust resourcesPath when actually
// running inside a packaged Electron build (never in plain-node tests).
function resolveTemplateDir() {
  const dev = path.join(__dirname, 'template', 'android');
  if (process.versions.electron && !process.defaultApp && process.resourcesPath) {
    const packed = path.join(process.resourcesPath, 'template', 'android');
    if (fs.existsSync(packed)) return packed;
  }
  return dev;
}
const TEMPLATE_DIR = resolveTemplateDir();

const PACKAGE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

const DENSITY_DIRS = {
  'mipmap-mdpi': 48,
  'mipmap-hdpi': 72,
  'mipmap-xhdpi': 96,
  'mipmap-xxhdpi': 144,
  'mipmap-xxxhdpi': 192
};

const IGNORE_DIRS = new Set(['__macosx', '.git', 'node_modules', '.idea', '.vscode']);

// Fullscreen (immersive, both bars): hide status + nav bars and keep them
// hidden; swiping from an edge briefly reveals them (BEHAVIOR_SHOW_TRANSIENT_
// BARS_BY_SWIPE), which is the standard game behavior.
// API 30+ uses WindowInsetsController; older devices use the legacy
// immersive-sticky system UI flags.
// NOTE: must stay in sync with capacitor.config.json -> plugins.SystemBars.hidden
// (the SystemBars plugin posts show(systemBars()) at startup, which would
// otherwise override this hide call — the config makes the plugin hide instead).
const FULLSCREEN_CODE = `if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
    getWindow().setDecorFitsSystemWindows(false);
    android.view.WindowInsetsController insetsController = getWindow().getInsetsController();
    if (insetsController != null) {
        insetsController.hide(android.view.WindowInsets.Type.systemBars());
        insetsController.setSystemBarsBehavior(android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }
} else {
    getWindow().setFlags(
        android.view.WindowManager.LayoutParams.FLAG_FULLSCREEN,
        android.view.WindowManager.LayoutParams.FLAG_FULLSCREEN
    );
    getWindow().getDecorView().setSystemUiVisibility(
        android.view.View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            | android.view.View.SYSTEM_UI_FLAG_FULLSCREEN
            | android.view.View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | android.view.View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            | android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
    );
}`;

const KEEP_SCREEN_ON_CODE = `getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);`;

// Back button — the callback is ALWAYS registered so behavior is
// deterministic (Capacitor itself registers no back handling at all, so
// without it the app would just close on back press):
//   history ON : first walk the WebView's page history (browser-like)
//   dialog ON  : when nothing is left to handle, ask "Exit the application?" [Cancel] [Exit]
//   both OFF   : close the app immediately
// Registered via OnBackPressedDispatcher (the modern replacement for the
// deprecated onBackPressed() override).
function buildBackExitCode(backExit, backHistory) {
  const history = backHistory
    ? `
        android.webkit.WebView webView = getBridge() == null ? null : getBridge().getWebView();
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }`
    : '';
  const tail = backExit
    ? `
        new androidx.appcompat.app.AlertDialog.Builder(MainActivity.this)
            .setTitle("Exit the application?")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Exit", (dialog, which) -> finish())
            .show();`
    : `
        finish();`;

  return `getOnBackPressedDispatcher().addCallback(this, new androidx.activity.OnBackPressedCallback(true) {
    @Override
    public void handleOnBackPressed() {${history}${tail}
    }
});`;
}

class Generator {
  constructor(dataRoot) {
    this.dataRoot = dataRoot;
  }

  // ---------------- validation ----------------

  validate(input) {
    const errors = [];

    if (!fs.existsSync(TEMPLATE_DIR)) {
      errors.push('Template project is missing (template/android).');
    }

    if (!input.zipPath || !input.zipPath.trim()) {
      errors.push('Select your HTML5 .zip file.');
    } else if (!/\.zip$/i.test(input.zipPath)) {
      errors.push('The selected file is not a .zip archive.');
    } else if (!fs.existsSync(input.zipPath)) {
      errors.push('ZIP file not found: ' + input.zipPath);
    }

    if (!input.appName || !input.appName.trim()) {
      errors.push('App name is required.');
    }

    if (!input.packageName || !PACKAGE_RE.test(input.packageName)) {
      errors.push('Package name must look like com.example.myapp (lowercase, e.g. com.myname.mygame).');
    }

    if (!input.versionName || !input.versionName.trim()) {
      errors.push('Version name is required (e.g. 1.0.0).');
    }

    const vc = Number(input.versionCode);
    if (!Number.isInteger(vc) || vc < 1) {
      errors.push('Version code must be a whole number of 1 or more.');
    }

    const target = Number(input.targetApi);
    const min = Number(input.minApi);
    if (!Number.isInteger(target) || target < 21) errors.push('Target API is invalid.');
    if (!Number.isInteger(min) || min < 21) errors.push('Minimum API is invalid.');
    if (Number.isInteger(target) && Number.isInteger(min) && min > target) {
      errors.push('Minimum API cannot be higher than Target API.');
    }

    if (input.iconPath && input.iconPath.trim()) {
      const p = input.iconPath.trim();
      if (!/\.png$/i.test(p)) errors.push('App icon must be a .png file.');
      else if (!fs.existsSync(p)) errors.push('Icon file not found: ' + p);
    }

    return errors;
  }

  // ---------------- main entry ----------------

  async generate(input) {
    try {
      const errors = this.validate(input);
      if (errors.length) return { ok: false, error: errors.join('  ') };

      const warnings = [];
      const appName = String(input.appName).trim();
      const packageName = input.packageName.trim();
      const versionName = String(input.versionName).trim().replace(/["'<>]/g, '');
      const versionCode = Number(input.versionCode);
      const iconPath = input.iconPath && input.iconPath.trim() ? input.iconPath.trim() : null;
      const overrides = input.overrides || {};

      const workRoot = path.join(this.dataRoot, 'work', packageName);
      const projectDir = path.join(workRoot, 'project');
      const zipDir = path.join(workRoot, 'zip');

      // fresh work area
      fs.rmSync(workRoot, { recursive: true, force: true });
      fs.mkdirSync(zipDir, { recursive: true });

      // 1. extract + locate web root
      await this.extractZip(input.zipPath.trim(), zipDir);
      const webRoot = this.findWebRoot(zipDir);
      if (!webRoot) {
        fs.rmSync(workRoot, { recursive: true, force: true });
        return {
          ok: false,
          error: 'No index.html found inside the ZIP (checked the root and one level of folders).'
        };
      }

      // 2. copy template
      fs.cpSync(TEMPLATE_DIR, projectDir, { recursive: true });

      // 3. inject web assets
      const publicDir = path.join(projectDir, 'app', 'src', 'main', 'assets', 'public');
      fs.rmSync(publicDir, { recursive: true, force: true });
      fs.mkdirSync(publicDir, { recursive: true });
      fs.cpSync(webRoot, publicDir, { recursive: true });

      // keep Capacitor's cordova shims unless the zip ships its own
      for (const shim of ['cordova.js', 'cordova_plugins.js']) {
        const dest = path.join(publicDir, shim);
        if (!fs.existsSync(dest)) {
          const src = path.join(TEMPLATE_DIR, 'app', 'src', 'main', 'assets', 'public', shim);
          if (fs.existsSync(src)) fs.copyFileSync(src, dest);
        }
      }
      fs.rmSync(zipDir, { recursive: true, force: true });

      if (!fs.existsSync(path.join(publicDir, 'index.html'))) {
        fs.rmSync(workRoot, { recursive: true, force: true });
        return { ok: false, error: 'index.html disappeared while copying — check the ZIP contents.' };
      }

      // 4. patch everything
      this.patchAppGradle(projectDir, packageName, versionName, versionCode);
      this.patchVariables(projectDir, input, overrides);
      this.patchToolchainOverrides(projectDir, overrides);
      this.patchManifestOrientation(projectDir, input.orientation);
      this.patchStrings(projectDir, appName, packageName);
      this.patchMainActivity(projectDir, !!input.fullscreen, !!input.keepScreenOn, !!input.backExit, input.backHistory !== false);
      this.patchCapacitorConfig(projectDir, packageName, appName, !!input.fullscreen);

      // 5. icons
      if (iconPath) {
        const iconWarnings = await this.applyIcon(projectDir, iconPath);
        warnings.push(...iconWarnings);
      } else {
        warnings.push('No icon selected — the template icon is kept.');
      }

      return { ok: true, projectDir, warnings };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  }

  // ---------------- zip handling ----------------

  findWebRoot(dir, depth = 0) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return null;
    }

    const hasIndex = entries.some(
      (e) => e.isFile() && e.name.toLowerCase() === 'index.html'
    );
    if (hasIndex) return dir;

    if (depth >= 3) return null;

    const matches = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (IGNORE_DIRS.has(entry.name.toLowerCase())) continue;
      const found = this.findWebRoot(path.join(dir, entry.name), depth + 1);
      if (found) matches.push(found);
    }

    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(
        'This ZIP has index.html in several folders — keep only one app root folder inside the zip.'
      );
    }
    return null;
  }

  async extractZip(zipPath, destDir) {
    const ok = await this._run('tar.exe', ['-xf', zipPath, '-C', destDir]);
    if (ok) return;

    const ps =
      "Expand-Archive -LiteralPath '" + zipPath.replace(/'/g, "''") +
      "' -DestinationPath '" + destDir.replace(/'/g, "''") + "' -Force";
    const ok2 = await this._run('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      ps
    ]);
    if (!ok2) throw new Error('Could not read the ZIP file — is it a valid .zip archive?');
  }

  _run(cmd, args) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      let child;
      try {
        child = spawn(cmd, args, { windowsHide: true });
      } catch (_) {
        return done(false);
      }
      child.on('error', () => done(false));
      child.on('close', (code) => done(code === 0));
    });
  }

  // ---------------- text patches ----------------

  _replaceOnce(file, pattern, replacement, what) {
    let text = fs.readFileSync(file, 'utf8');
    if (!pattern.test(text)) {
      throw new Error(
        'Template patch failed (' + what + '): pattern not found in ' + path.basename(file)
      );
    }
    text = text.replace(pattern, replacement);
    fs.writeFileSync(file, text, 'utf8');
  }

  patchAppGradle(projectDir, packageName, versionName, versionCode) {
    const f = path.join(projectDir, 'app', 'build.gradle');
    this._replaceOnce(f, /applicationId "[^"]+"/, `applicationId "${packageName}"`, 'applicationId');
    this._replaceOnce(f, /versionCode \d+/, `versionCode ${versionCode}`, 'versionCode');
    this._replaceOnce(f, /versionName "[^"]*"/, `versionName "${versionName}"`, 'versionName');
  }

  patchVariables(projectDir, input, overrides) {
    const f = path.join(projectDir, 'variables.gradle');
    const compileSdk = overrides.compileApi
      ? parseInt(overrides.compileApi, 10)
      : Number(input.targetApi);

    this._replaceOnce(f, /minSdkVersion = \d+/, `minSdkVersion = ${Number(input.minApi)}`, 'minSdkVersion');
    this._replaceOnce(
      f,
      /compileSdkVersion = \d+/,
      `compileSdkVersion = ${Number.isInteger(compileSdk) ? compileSdk : Number(input.targetApi)}`,
      'compileSdkVersion'
    );
    this._replaceOnce(f, /targetSdkVersion = \d+/, `targetSdkVersion = ${Number(input.targetApi)}`, 'targetSdkVersion');
  }

  patchToolchainOverrides(projectDir, overrides) {
    if (overrides.agp && overrides.agp.trim()) {
      const version = overrides.agp.trim().replace(/[^0-9.]/g, '');
      if (version) {
        const f = path.join(projectDir, 'build.gradle');
        this._replaceOnce(
          f,
          /classpath 'com\.android\.tools\.build:gradle:[^']+'/,
          `classpath 'com.android.tools.build:gradle:${version}'`,
          'AGP override'
        );
      }
    }

    if (overrides.gradle && overrides.gradle.trim()) {
      const version = overrides.gradle.trim().replace(/[^0-9.]/g, '');
      if (version) {
        const f = path.join(projectDir, 'gradle', 'wrapper', 'gradle-wrapper.properties');
        this._replaceOnce(
          f,
          /gradle-[\d.]+-(?:bin|all)\.zip/,
          `gradle-${version}-all.zip`,
          'Gradle override'
        );
      }
    }
  }

  patchManifestOrientation(projectDir, orientation) {
    const f = path.join(projectDir, 'app', 'src', 'main', 'AndroidManifest.xml');
    const value = String(orientation || 'portrait').replace(/[^a-zA-Z]/g, '') || 'portrait';

    let text = fs.readFileSync(f, 'utf8');
    if (text.includes('android:screenOrientation=')) {
      this._replaceOnce(
        f,
        /android:screenOrientation="[^"]*"/,
        `android:screenOrientation="${value}"`,
        'orientation'
      );
    } else {
      this._replaceOnce(
        f,
        /(\n[ \t]*)(android:name="\.MainActivity")/,
        `$1android:screenOrientation="${value}"$1$2`,
        'orientation insert'
      );
    }
  }

  patchStrings(projectDir, appName, packageName) {
    const f = path.join(projectDir, 'app', 'src', 'main', 'res', 'values', 'strings.xml');
    const esc = (s) =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

    this._replaceOnce(
      f,
      /<string name="app_name">[^<]*<\/string>/,
      `<string name="app_name">${esc(appName)}</string>`,
      'app_name'
    );
    this._replaceOnce(
      f,
      /<string name="title_activity_main">[^<]*<\/string>/,
      `<string name="title_activity_main">${esc(appName)}</string>`,
      'title_activity_main'
    );
    this._replaceOnce(
      f,
      /<string name="package_name">[^<]*<\/string>/,
      `<string name="package_name">${esc(packageName)}</string>`,
      'package_name'
    );
    this._replaceOnce(
      f,
      /<string name="custom_url_scheme">[^<]*<\/string>/,
      `<string name="custom_url_scheme">${esc(packageName)}</string>`,
      'custom_url_scheme'
    );
  }

  patchMainActivity(projectDir, fullscreen, keepScreenOn, backExit, backHistory) {
    const f = path.join(
      projectDir,
      'app',
      'src',
      'main',
      'java',
      'com',
      'htmltoandroid',
      'app',
      'MainActivity.java'
    );

    let text = fs.readFileSync(f, 'utf8');

    const apply = (marker, enabled, code) => {
      const re = new RegExp('^([ \\t]*)//[ \\t]*' + marker + '[ \\t]*\r?$', 'm');
      if (!re.test(text)) {
        throw new Error('Template patch failed: marker //' + marker + ' missing in MainActivity.java');
      }
      if (enabled) {
        text = text.replace(re, (match, indent) =>
          code.split('\n').map((line) => indent + line).join('\n')
        );
      } else {
        text = text.replace(re, '');
      }
    };

    apply('HTML2ANDROID:FULLSCREEN', fullscreen, FULLSCREEN_CODE);
    apply('HTML2ANDROID:KEEP_SCREEN_ON', keepScreenOn, KEEP_SCREEN_ON_CODE);
    // Always registered — content varies with the two checkbox options
    apply('HTML2ANDROID:BACK_EXIT', true, buildBackExitCode(backExit, backHistory));

    fs.writeFileSync(f, text, 'utf8');
  }

  patchCapacitorConfig(projectDir, packageName, appName, fullscreen) {
    const f = path.join(projectDir, 'app', 'src', 'main', 'assets', 'capacitor.config.json');
    const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
    cfg.appId = packageName;
    cfg.appName = appName;

    // Fullscreen: tell Capacitor's SystemBars plugin to hide the bars itself.
    // Its load() posts show(systemBars()) to the main thread, which would
    // otherwise override any native hide() done in MainActivity.onCreate().
    // hidden:true makes the plugin post hide() instead — no race.
    if (fullscreen) {
      cfg.plugins = cfg.plugins || {};
      cfg.plugins.SystemBars = Object.assign({}, cfg.plugins.SystemBars, { hidden: true });
    } else if (cfg.plugins && cfg.plugins.SystemBars) {
      delete cfg.plugins.SystemBars.hidden;
      if (!Object.keys(cfg.plugins.SystemBars).length) delete cfg.plugins.SystemBars;
      if (!Object.keys(cfg.plugins).length) delete cfg.plugins;
    }

    fs.writeFileSync(f, JSON.stringify(cfg, null, '\t') + '\n', 'utf8');
  }

  // ---------------- cleanup ----------------

  // Remove the generated project + extracted zip after a SUCCESSFUL build.
  // generate() wipes workRoot and rebuilds it from scratch on every build, so
  // after success the folder is pure waste (hundreds of MB) and holds a copy
  // of the user's source. Failures keep it for debugging.
  // Safety: only ever deletes <dataRoot>/work/<package> — anything else is a no-op.
  cleanupProject(projectDir) {
    if (!projectDir) return false;
    const project = path.resolve(projectDir);
    const workRoot = path.dirname(project); // <dataRoot>/work/<package>
    const workBase = path.dirname(workRoot); // <dataRoot>/work
    const dataRoot = path.resolve(this.dataRoot);

    if (path.basename(workBase) !== 'work') return false;
    if (path.dirname(workBase) !== dataRoot) return false;
    if (!fs.existsSync(workRoot)) return false;

    fs.rmSync(workRoot, { recursive: true, force: true });
    return true;
  }

  // ---------------- icons ----------------

  async applyIcon(projectDir, iconPath) {
    const warnings = [];
    const resDir = path.join(projectDir, 'app', 'src', 'main', 'res');

    let source;
    try {
      source = await Jimp.read(iconPath);
    } catch (_) {
      throw new Error('Could not read the icon PNG — is it a valid image?');
    }

    const { width, height } = source.bitmap;
    if (width !== height) {
      throw new Error(`Icon must be square (yours is ${width}x${height}). Use a 512x512 PNG.`);
    }
    if (width !== 512) {
      warnings.push(`Icon is ${width}x${height} — 512x512 recommended; resized automatically.`);
    }

    for (const [dir, size] of Object.entries(DENSITY_DIRS)) {
      const target = path.join(resDir, dir);
      if (!fs.existsSync(target)) continue;

      for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) {
        const clone = source.clone().resize({ w: size, h: size });
        await clone.write(path.join(target, name));
      }
    }

    return warnings;
  }
}

module.exports = { Generator };
