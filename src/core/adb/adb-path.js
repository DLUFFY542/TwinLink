'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ADB_EXE = process.platform === 'win32' ? 'adb.exe' : 'adb';

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function scanPathDirs(envPath) {
  if (!envPath) {
    return [];
  }
  return envPath
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir.replace(/^"|"$/g, ''), ADB_EXE));
}

function scanWingetPackages() {
  const base = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages')
    : null;
  if (!base) {
    return [];
  }

  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !/platform-?tools/i.test(entry.name)) {
      continue;
    }
    const root = path.join(base, entry.name);
    results.push(path.join(root, 'platform-tools', ADB_EXE));
    // Some packages nest an extra directory level.
    try {
      for (const nested of fs.readdirSync(root, { withFileTypes: true })) {
        if (nested.isDirectory()) {
          results.push(path.join(root, nested.name, 'platform-tools', ADB_EXE));
        }
      }
    } catch {
      /* ignore */
    }
  }

  return results;
}

/**
 * Locate the adb executable. Never uses a shell; only existing files are
 * returned. Order: explicit setting, TWINLINK_ADB, bundled platform-tools,
 * PATH, Android SDK locations, WinGet package locations.
 */
function resolveAdbPath({ override = '', appRoot = '', resourcesPath = '', env = process.env } = {}) {
  const candidates = [];

  if (override) {
    candidates.push({ file: override, source: 'setting' });
  }
  if (env.TWINLINK_ADB) {
    candidates.push({ file: env.TWINLINK_ADB, source: 'environment' });
  }
  if (resourcesPath) {
    candidates.push({
      file: path.join(resourcesPath, 'platform-tools', ADB_EXE),
      source: 'bundled',
    });
  }
  if (appRoot) {
    candidates.push({
      file: path.join(appRoot, 'vendor', 'platform-tools', ADB_EXE),
      source: 'bundled',
    });
  }

  for (const file of scanPathDirs(env.PATH)) {
    candidates.push({ file, source: 'path' });
  }

  const sdkRoots = [env.ANDROID_SDK_ROOT, env.ANDROID_HOME].filter(Boolean);
  for (const root of sdkRoots) {
    candidates.push({
      file: path.join(root, 'platform-tools', ADB_EXE),
      source: 'android-sdk',
    });
  }

  if (env.LOCALAPPDATA) {
    candidates.push({
      file: path.join(env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', ADB_EXE),
      source: 'android-sdk',
    });
  }

  for (const file of scanWingetPackages()) {
    candidates.push({ file, source: 'winget' });
  }

  candidates.push({ file: 'C:\\Android\\platform-tools\\adb.exe', source: 'common' });
  candidates.push({ file: 'C:\\platform-tools\\adb.exe', source: 'common' });

  const seen = new Set();
  for (const candidate of candidates) {
    const key = path.resolve(candidate.file).toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (isFile(candidate.file)) {
      return { path: path.resolve(candidate.file), source: candidate.source };
    }
  }

  return { path: null, source: null };
}

module.exports = { resolveAdbPath, ADB_EXE };
