#!/usr/bin/env node
//
// scripts/build.js
//
// Kleiner Build-Check, der sicherstellt, dass die App vor dem Deploy in
// Plesk syntaktisch in Ordnung ist. Führt selbst keine Transformation
// durch (kein Bundler/TS), sondern prüft:
//   1. package.json ist valides JSON und enthält die erforderlichen Felder
//   2. app.js lässt sich ohne Fehler parsen
//   3. Alle in app.js referenzierten EJS-Views existieren
//
// Aufruf:
//   npm run build

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function fail(message) {
  console.error(`[build] ✗ ${message}`);
  process.exit(1);
}

function ok(message) {
  console.log(`[build] ✓ ${message}`);
}

// --- 1. package.json validieren -------------------------------------------

let pkg;
try {
  pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
} catch (err) {
  fail(`package.json lässt sich nicht parsen: ${err.message}`);
}

for (const field of ['name', 'version', 'main', 'scripts']) {
  if (!pkg[field]) {
    fail(`package.json fehlt das Feld "${field}"`);
  }
}

if (pkg.main !== 'app.js') {
  fail(`package.json.main ist "${pkg.main}", erwartet wird "app.js"`);
}

if (!pkg.scripts?.start) {
  fail('package.json.scripts.start fehlt');
}

ok('package.json ist valide');

// --- 2. app.js syntaktisch prüfen -----------------------------------------
// `node --check` parsed die Datei, führt sie aber NICHT aus. Das vermeidet,
// dass native Abhängigkeiten (z. B. better-sqlite3-multiple-ciphers)
// kompiliert werden müssen, nur um die Syntax zu validieren.

import { execFileSync } from 'node:child_process';

try {
  execFileSync(process.execPath, ['--check', path.join(root, 'app.js')], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ok('app.js lässt sich syntaktisch parsen');
} catch (err) {
  fail(`app.js enthält einen Syntax-Fehler: ${err.stderr?.toString() || err.message}`);
}

// --- 3. EJS-Views prüfen --------------------------------------------------
// Alle .js-Dateien nach viewEjs('...')-Aufrufen durchsuchen.

import { readdirSync, statSync } from 'node:fs';

const IGNORED_DIRS = new Set(['node_modules', '.git', 'data', 'tmp']);

function walkJs(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkJs(full, files);
    } else if (st.isFile() && entry.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

const views = new Set();
for (const file of walkJs(root)) {
  const source = readFileSync(file, 'utf8');
  const matches = source.matchAll(/\.viewEjs\s*\(\s*['"]([^'"]+)['"]\s*[,)]/g);
  for (const match of matches) {
    let view = match[1];
    if (view.endsWith('.ejs')) {
      view = view.slice(0, -4);
    }
    views.add(view);
  }
}

for (const view of views) {
  const viewPath = path.join(root, 'views', `${view}.ejs`);
  if (!existsSync(viewPath)) {
    fail(`EJS-View fehlt: views/${view}.ejs`);
  }
}

ok(`Alle ${views.size} referenzierten EJS-Views sind vorhanden`);

console.log('[build] Build-Check erfolgreich.');
