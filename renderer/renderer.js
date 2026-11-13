// ============ html-to-android — renderer logic (Phase 1: UI only) ============

const $ = (id) => document.getElementById(id);

// ---------- Theme (light / dark) ----------

const THEME_KEY = 'h2a-theme';

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  const btn = $('btn-theme');
  btn.textContent = theme === 'light' ? '\u{1F319}' : '\u2600\uFE0F';
  btn.title = theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
}

applyTheme(localStorage.getItem(THEME_KEY) || 'dark');

$('btn-theme').addEventListener('click', () => {
  const next = document.body.dataset.theme === 'light' ? 'dark' : 'light';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});

// ---------- Browse buttons ----------

const FILE_FILTERS = {
  zip: {
    title: 'Select HTML5 .zip',
    filters: [{ name: 'ZIP archive', extensions: ['zip'] }]
  },
  icon: {
    title: 'Select app icon (PNG 512x512)',
    filters: [{ name: 'PNG image', extensions: ['png'] }]
  },
  keystore: {
    title: 'Select keystore',
    filters: [{ name: 'Keystore', extensions: ['jks', 'keystore'] }]
  }
};

const FILE_TARGETS = {
  zip: 'in-zip',
  icon: 'in-icon',
  keystore: 'in-keystore'
};

document.querySelectorAll('[data-browse]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const kind = btn.dataset.browse;

    if (kind === 'output') {
      const folder = await window.api.browseFolder();
      if (folder) $('in-output').value = folder;
      return;
    }

    const options = FILE_FILTERS[kind];
    const file = await window.api.browseFile(options);
    if (file) $(FILE_TARGETS[kind]).value = file;
  });
});

// ---------- Signing section enable/disable ----------

const signToggle = $('in-sign');
const signFieldIds = ['in-keystore', 'in-alias', 'in-kspass', 'in-keypass', 'btn-newkeystore'];

function syncSigningFields() {
  const enabled = signToggle.checked;
  signFieldIds.forEach((id) => {
    $(id).disabled = !enabled;
  });
}

signToggle.addEventListener('change', syncSigningFields);

// ---------- External link ----------

$('link-play').addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal('https://developer.android.com/google/play/requirements/target-sdk');
});

// ---------- First-run setup (Phase 2: real downloads) ----------

const setupUi = { running: false };

function setStep(step, status, message) {
  const el = $('status-' + step);
  if (!el) return;
  el.textContent = message || '';
  el.className = 'step-status ' + status;
}

function setBar(step, percent) {
  const bar = $('bar-' + step);
  if (bar && typeof percent === 'number') bar.style.width = percent + '%';
}

function showSetupError(message) {
  const box = $('setup-error');
  box.textContent = message;
  box.hidden = false;
}

function clearSetupError() {
  $('setup-error').hidden = true;
}

function updateStartButton(det) {
  const btn = setupUi.$start;
  if (setupUi.running) {
    btn.disabled = false;
    btn.textContent = 'Cancel setup';
  } else if (det && det.jdk && det.sdk) {
    btn.disabled = true;
    btn.textContent = 'All tools ready \u2713';
  } else {
    btn.disabled = false;
    btn.textContent = 'Start setup';
  }
}

async function refreshToolchain() {
  try {
    const det = await window.api.toolchainDetect();
    setStep('jdk', det.jdk ? 'ready' : 'pending', det.jdk ? 'Ready \u2713 (reused)' : 'Pending');
    setBar('jdk', det.jdk ? 100 : 0);
    setStep('sdk', det.sdk ? 'ready' : 'pending', det.sdk ? 'Ready \u2713 (reused)' : 'Pending');
    setBar('sdk', det.sdk ? 100 : 0);
    $('install-loc').textContent = det.toolchainDir;
    updateStartButton(det);
    return det;
  } catch (err) {
    showSetupError('Could not check tools: ' + (err && err.message));
    return null;
  }
}

window.api.onToolchainProgress((data) => {
  const status = data.status || 'busy';
  setStep(data.step, status, data.message);
  setBar(data.step, data.percent);
  if (status === 'ready') setBar(data.step, 100);
});

window.api.onToolchainDone((data) => {
  setupUi.running = false;
  if (data && data.ok) {
    clearSetupError();
    refreshToolchain();
  } else if (data && data.cancelled) {
    clearSetupError();
    refreshToolchain();
  } else {
    showSetupError((data && data.error) || 'Setup failed.');
    refreshToolchain();
  }
});

$('btn-setup').addEventListener('click', () => {
  $('setup-screen').hidden = false;
  clearSetupError();
  refreshToolchain();
});

$('btn-setup-back').addEventListener('click', () => {
  $('setup-screen').hidden = true;
});

setupUi.$start = $('btn-setup-start');
setupUi.$start.addEventListener('click', async () => {
  if (setupUi.running) {
    window.api.toolchainCancel();
    return;
  }
  setupUi.running = true;
  clearSetupError();
  updateStartButton(null);

  const result = await window.api.toolchainStart();
  setupUi.running = false;

  if (result && result.ok) {
    clearSetupError();
  } else if (result && result.cancelled) {
    clearSetupError();
  } else {
    showSetupError((result && result.error) || 'Setup failed.');
  }
  refreshToolchain();
});

$('link-sdk-license').addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal('https://developer.android.com/studio/terms');
});

// ---------- Status line ----------

let statusTimer = null;

function status(message, ms = 4500, kind = 'ok') {
  const el = $('status-line');
  el.textContent = message;
  el.classList.toggle('error', kind === 'error');
  el.classList.add('visible');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => el.classList.remove('visible'), ms);
}

// ---------- Build log console (live stream) ----------

const MAX_LOG_LINES = 1000;

function appendLog(line, cls) {
  const body = $('log-body');
  const pinned =
    body.scrollHeight - body.scrollTop - body.clientHeight < 24 ||
    body.childElementCount === 0;

  const div = document.createElement('div');
  div.className = 'log-line' + (cls && cls !== 'out' ? ' ' + cls : '');
  div.textContent = line;
  body.appendChild(div);

  while (body.childElementCount > MAX_LOG_LINES) {
    body.removeChild(body.firstElementChild);
  }

  $('log-panel').hidden = false;
  if (pinned) body.scrollTop = body.scrollHeight;
}

function clearLog() {
  $('log-body').innerHTML = '';
  $('log-panel').hidden = true;
}

$('btn-log-clear').addEventListener('click', clearLog);
window.api.onBuildLog((data) => appendLog(data.line, data.cls));

// ---------- Elapsed-time indicator while building ----------

let elapsedTimer = null;

function startElapsed(label) {
  stopElapsed();
  const started = Date.now();
  const el = $('status-line');
  el.classList.add('visible');
  const tick = () => {
    const s = Math.floor((Date.now() - started) / 1000);
    el.textContent = `${label} ${s}s…`;
  };
  tick();
  elapsedTimer = setInterval(tick, 1000);
}

function stopElapsed() {
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

// ---------- Build history (auto-increment, per package) ----------

async function refreshPackageState() {
  const pkg = $('in-package').value.trim();
  const note = $('last-built');
  if (!pkg) {
    note.hidden = true;
    return;
  }
  try {
    const entry = await window.api.stateLookup(pkg);
    if (entry && typeof entry.lastVersionCode === 'number') {
      note.hidden = false;
      note.textContent = `Last built for this package: ${entry.lastVersionName} (code ${entry.lastVersionCode}).`;
      if ($('in-autoinc').checked) {
        $('in-vercode').value = entry.lastVersionCode + 1;
      }
    } else {
      note.hidden = true;
    }
  } catch (_) {
    note.hidden = true;
  }
}

$('in-package').addEventListener('change', refreshPackageState);
$('in-autoinc').addEventListener('change', refreshPackageState);
refreshPackageState();

// ---------- Collect form values ----------

function collectInput() {
  return {
    zipPath: $('in-zip').value.trim(),
    appName: $('in-appname').value.trim(),
    packageName: $('in-package').value.trim(),
    versionName: $('in-vername').value.trim(),
    versionCode: Number($('in-vercode').value),
    orientation: $('in-orientation').value,
    fullscreen: $('in-fullscreen').checked,
    keepScreenOn: $('in-keepon').checked,
    backExit: $('in-backexit').checked,
    backHistory: $('in-backhistory').checked,
    iconPath: $('in-icon').value.trim(),
    outputFolder: $('in-output').value.trim(),
    autoIncrement: $('in-autoinc').checked,
    targetApi: Number($('in-target').value),
    minApi: Number($('in-min').value),
    signing: $('in-sign').checked
      ? {
          keystorePath: $('in-keystore').value.trim(),
          alias: $('in-alias').value.trim(),
          storePass: $('in-kspass').value,
          keyPass: $('in-keypass').value || $('in-kspass').value
        }
      : null,
    overrides: {
      compileApi: $('in-compile').value.trim(),
      agp: $('in-agp').value.trim(),
      gradle: $('in-gradle').value.trim()
    }
  };
}

function safeFilePart(text) {
  return String(text || 'app').replace(/[<>:"/\\|?*\s]+/g, '_').replace(/^_+|_+$/g, '') || 'app';
}

function formatSize(bytes) {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

// ---------- BUILD button: generate -> gradle -> deliver ----------

let buildRunning = false;

function setBuildMode(running) {
  buildRunning = running;
  const btn = $('btn-build');
  btn.textContent = running ? 'CANCEL BUILD' : 'BUILD APK + AAB';
  btn.classList.toggle('cancel', running);
}

$('btn-build').addEventListener('click', async () => {
  // ----- cancel path -----
  if (buildRunning) {
    window.api.buildCancel();
    status('Cancelling build…', 10000);
    return;
  }

  // ----- preconditions -----
  const det = await window.api.toolchainDetect();
  if (!det || !det.jdk || !det.sdk) {
    $('setup-screen').hidden = false;
    clearSetupError();
    refreshToolchain();
    status('Build tools are not installed yet — run the setup first.', 6000, 'error');
    return;
  }

  const input = collectInput();
  if (!input.outputFolder) {
    status('Choose an Output folder first (where the .apk and .aab are saved).', 7000, 'error');
    return;
  }

  // ----- signing preconditions -----
  if (input.signing) {
    const s = input.signing;
    if (!s.keystorePath) {
      status('Signing is on — choose a keystore file (or create one) first.', 7000, 'error');
      return;
    }
    if (!s.alias) {
      status('Signing is on — enter the key alias (the one you used when creating the keystore).', 7000, 'error');
      return;
    }
    if (!s.storePass || s.storePass.length < 6) {
      status('Signing is on — enter your keystore password (min. 6 characters).', 7000, 'error');
      return;
    }
    if (/[\"%]/.test(s.storePass) || /[\"%]/.test(s.keyPass)) {
      status('Passwords cannot contain " or % — please change them.', 7000, 'error');
      return;
    }
  }

  clearLog();
  setBuildMode(true);

  // ----- step 1: generate the patched project -----
  startElapsed('Generating project');
  const gen = await window.api.projectGenerate(input);
  if (!gen || !gen.ok) {
    stopElapsed();
    setBuildMode(false);
    status((gen && gen.error) || 'Generation failed.', 10000, 'error');
    return;
  }

  // ----- step 2: Gradle build -----
  startElapsed('Building');
  const result = await window.api.projectBuild({
    projectDir: gen.projectDir,
    outputFolder: input.outputFolder,
    baseName: `${safeFilePart(input.packageName)}-v${safeFilePart(input.versionName)}`,
    signing: input.signing,
    record: input.autoIncrement
      ? {
          packageName: input.packageName,
          versionName: input.versionName,
          versionCode: input.versionCode
        }
      : null
  });

  stopElapsed();
  setBuildMode(false);

  // ----- outcome -----
  if (result && result.ok) {
    const name = (p) => p.split(/[\\/]/).pop();
    const signNote =
      result.signMode === 'user'
        ? ' · SIGNED with YOUR keystore ✓'
        : result.signed
          ? ' · SIGNED with default test key ✓ (use your own keystore for Play Store)'
          : ' · UNSIGNED?!';
    status(
      `APK + AAB ✓ ${name(result.apk)} (${formatSize(result.apkSize)}) + ` +
        `${name(result.aab)} (${formatSize(result.aabSize)}) · ${result.duration}s${signNote}`,
      14000
    );
    refreshPackageState();
  } else if (result && result.cancelled) {
    status('Build cancelled.', 5000);
  } else {
    status((result && result.error) || 'Build failed — see the build log.', 14000, 'error');
    refreshPackageState();
  }
});

// ---------- Create-keystore modal (Phase 5) ----------

function showKsError(message) {
  const box = $('ks-error');
  box.textContent = message;
  box.hidden = false;
}

function clearKsError() {
  $('ks-error').hidden = true;
}

$('btn-newkeystore').addEventListener('click', () => {
  clearKsError();
  $('ks-file').value = '';
  $('ks-alias').value = 'upload';
  $('ks-pass').value = '';
  $('ks-pass2').value = '';
  $('ks-cn').value = '';
  $('ks-org').value = '';
  $('ks-country').value = '';
  $('keystore-screen').hidden = false;
  $('ks-file').focus();
});

$('btn-ks-cancel').addEventListener('click', () => {
  $('keystore-screen').hidden = true;
});

$('btn-ks-browse').addEventListener('click', async () => {
  const file = await window.api.saveFile({
    title: 'Save release keystore',
    defaultPath: 'release-keystore.jks',
    filters: [{ name: 'Keystore', extensions: ['jks'] }]
  });
  if (file) $('ks-file').value = file;
});

$('btn-ks-create').addEventListener('click', async () => {
  clearKsError();

  const opts = {
    file: $('ks-file').value.trim(),
    alias: $('ks-alias').value.trim(),
    storePass: $('ks-pass').value,
    keyPass: $('ks-pass').value,
    cn: $('ks-cn').value.trim(),
    org: $('ks-org').value.trim(),
    country: $('ks-country').value.trim()
  };

  // renderer-side checks for the friendliest messages
  if (!opts.file) return showKsError('Choose where to save the keystore file (Browse).');
  if (!opts.alias) return showKsError('Key alias is required — "upload" is a good choice.');
  if (opts.storePass.length < 6) return showKsError('Password must be at least 6 characters.');
  if (opts.storePass !== $('ks-pass2').value) return showKsError('The two passwords do not match.');
  if (/[\"%]/.test(opts.storePass)) return showKsError('Password cannot contain " or % characters.');
  if (!opts.cn) return showKsError('Your name (CN) is required.');
  if (opts.country && !/^[A-Za-z]{2}$/.test(opts.country)) {
    return showKsError('Country must be a 2-letter code (e.g. PK, US, DE).');
  }

  const btn = $('btn-ks-create');
  btn.disabled = true;
  btn.textContent = 'Creating…';

  const res = await window.api.keystoreCreate(opts);

  btn.disabled = false;
  btn.textContent = 'Create keystore';

  if (!res || !res.ok) {
    return showKsError((res && res.error) || 'Keystore creation failed.');
  }

  // success: fill the SIGNING section and turn signing on
  $('keystore-screen').hidden = true;
  $('in-keystore').value = res.file;
  $('in-alias').value = res.alias;
  $('in-kspass').value = opts.storePass;
  $('in-keypass').value = '';
  signToggle.checked = true;
  syncSigningFields();
  status(
    'Keystore created ✓ — WRITE DOWN the password and keep the file safe. ' +
      'You will also need both when uploading your key to Google Play.',
    12000
  );
});
