// Fast CI checks — no Android toolchain, no sample zips, no network.
// Run: node tests/ci-checks.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { BuildState } = require(path.join(ROOT, 'state.js'));
const { Generator } = require(path.join(ROOT, 'generator.js'));

let failed = 0;
function check(name, ok) {
  console.log((ok ? 'OK   ' : 'FAIL ') + name);
  if (!ok) failed++;
}

function main() {
  // --- state.js: version codes tracked PER PACKAGE ---
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h2a-ci-'));
  const state = new BuildState(tmp);
  check('fresh package starts at versionCode 1', state.nextVersionCode('com.a.one') === 1);
  state.record('com.a.one', '1.0.0', 1);
  check('after record, next is 2', state.nextVersionCode('com.a.one') === 2);
  check('other package unaffected (per-package counter)', state.nextVersionCode('com.b.two') === 1);
  state.record('com.a.one', '1.0.1', 2);
  state.record('com.a.one', '1.0.2', 3);
  check('sequence keeps counting', state.nextVersionCode('com.a.one') === 4);
  check('lookup returns last record', (state.lookup('com.a.one') || {}).lastVersionCode === 3);

  // --- generator cleanup safety rails ---
  const gen = new Generator(tmp);
  check('cleanupProject(null) rejected', gen.cleanupProject(null) === false);
  check('cleanupProject(data root) rejected', gen.cleanupProject(tmp) === false);
  const fake = path.join(tmp, 'work', 'com.ci.test', 'project');
  fs.mkdirSync(fake, { recursive: true });
  fs.writeFileSync(path.join(fake, 'x.txt'), 'x');
  check('cleanupProject(real work project) accepted', gen.cleanupProject(fake) === true);
  check('work/<package> removed', !fs.existsSync(path.join(tmp, 'work', 'com.ci.test')));

  // --- template integrity (what every generated app ships) ---
  const t = (p) => path.join(ROOT, 'template', 'android', p);
  const mainActivity = t('app/src/main/java/com/htmltoandroid/app/MainActivity.java');
  const ma = fs.existsSync(mainActivity) ? fs.readFileSync(mainActivity, 'utf8') : '';
  check(
    'MainActivity has fullscreen + back-exit markers',
    /HTML2ANDROID:FULLSCREEN/.test(ma) && /HTML2ANDROID:BACK_EXIT/.test(ma)
  );
  const bridge = t('app/src/main/java/com/htmltoandroid/app/AndroidBridge.java');
  check('AndroidBridge.java present', fs.existsSync(bridge));
  const manifest = fs.readFileSync(t('app/src/main/AndroidManifest.xml'), 'utf8');
  check(
    'storage permission limited to API <= 28',
    /WRITE_EXTERNAL_STORAGE/.test(manifest) && /maxSdkVersion="28"/.test(manifest)
  );
  check('gradle wrapper jar shipped', fs.existsSync(t('gradle/wrapper/gradle-wrapper.jar')));
  check('gradlew.bat shipped', fs.existsSync(t('gradlew.bat')));

  // --- packaging config sanity ---
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check(
    'template excluded from asar + shipped via extraResources',
    !!(pkg.build &&
      Array.isArray(pkg.build.files) &&
      pkg.build.files.includes('!template/**') &&
      Array.isArray(pkg.build.extraResources) &&
      pkg.build.extraResources.some((e) => e.from === 'template' && e.to === 'template'))
  );
  check('license field is MIT', pkg.license === 'MIT');
  check('LICENSE file exists', fs.existsSync(path.join(ROOT, 'LICENSE')));
  check('THIRD-PARTY-NOTICES exists', fs.existsSync(path.join(ROOT, 'THIRD-PARTY-NOTICES')));

  // --- back-button 4-combo matrix (dialog x history) ---
  const MA_REL = path.join('app', 'src', 'main', 'java', 'com', 'htmltoandroid', 'app', 'MainActivity.java');
  const maTpl = fs.readFileSync(mainActivity, 'utf8');
  const combos = [
    { dialog: true, history: true },
    { dialog: true, history: false },
    { dialog: false, history: true },
    { dialog: false, history: false }
  ];
  for (const c of combos) {
    const label = `back matrix: dialog=${c.dialog} history=${c.history}`;
    const dir = path.join(tmp, 'combo', `${c.dialog}-${c.history}`);
    fs.mkdirSync(path.dirname(path.join(dir, MA_REL)), { recursive: true });
    fs.writeFileSync(path.join(dir, MA_REL), maTpl, 'utf8');
    gen.patchMainActivity(dir, true, true, c.dialog, c.history);
    const src = fs.readFileSync(path.join(dir, MA_REL), 'utf8');
    const ok =
      // callback always registered (Capacitor has no back handling of its own)
      /getOnBackPressedDispatcher\(\)\.addCallback/.test(src) &&
      /OnBackPressedCallback\(true\)/.test(src) &&
      !/HTML2ANDROID:BACK_EXIT/.test(src) &&
      // history gate
      (c.history
        ? /webView\.canGoBack\(\)/.test(src) && /webView\.goBack\(\)/.test(src)
        : !/canGoBack/.test(src) && !/goBack/.test(src)) &&
      // dialog gate (exact copy when on, fully absent when off)
      (c.dialog
        ? /setTitle\("Exit the application\?"\)/.test(src) &&
          /setNegativeButton\("Cancel"/.test(src) &&
          /setPositiveButton\("Exit"/.test(src)
        : !/Exit the application\?/.test(src) && !/AlertDialog/.test(src)) &&
      // app still closes in every combo
      (c.dialog ? /\(dialog, which\) -> finish\(\)/.test(src) : /finish\(\);/.test(src));
    check(label, ok);
  }
  check(
    'backHistory defaults ON when input omits it',
    (() => {
      const dir = path.join(tmp, 'combo', 'default');
      fs.mkdirSync(path.dirname(path.join(dir, MA_REL)), { recursive: true });
      fs.writeFileSync(path.join(dir, MA_REL), maTpl, 'utf8');
      // simulate generate()'s call site: input.backHistory !== false
      const input = { backExit: true };
      gen.patchMainActivity(dir, true, true, input.backExit, input.backHistory !== false);
      const src = fs.readFileSync(path.join(dir, MA_REL), 'utf8');
      return /webView\.goBack\(\)/.test(src);
    })()
  );

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll CI checks passed');
  process.exit(failed ? 1 : 0);
}

main();
