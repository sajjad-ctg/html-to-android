// ============ state.js — per-package build history (auto-increment) ============
// Stored at %LOCALAPPDATA%\html-to-android\state\builds.json

const fs = require('fs');
const path = require('path');

class BuildState {
  constructor(dataRoot) {
    this.file = path.join(dataRoot, 'state', 'builds.json');
  }

  _read() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data && typeof data === 'object' && data.packages) return data;
    } catch (_) {}
    return { packages: {} };
  }

  _write(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2), 'utf8');
  }

  lookup(packageName) {
    if (!packageName) return null;
    const data = this._read();
    return data.packages[packageName] || null;
  }

  nextVersionCode(packageName) {
    const entry = this.lookup(packageName);
    return entry && typeof entry.lastVersionCode === 'number' ? entry.lastVersionCode + 1 : 1;
  }

  // Called after a SUCCESSFUL APK+AAB build (Phase 4 wires this up)
  record(packageName, versionName, versionCode) {
    const data = this._read();
    data.packages[packageName] = {
      lastVersionName: versionName,
      lastVersionCode: versionCode,
      lastBuiltAt: new Date().toISOString()
    };
    this._write(data);
  }
}

module.exports = { BuildState };
