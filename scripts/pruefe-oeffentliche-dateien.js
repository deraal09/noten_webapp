#!/usr/bin/env node
/**
 * Prüft von außen, ob der Webserver Dateien aus dem Anwendungsverzeichnis ausliefert (Datenbank, Quellcode,
 * Konfiguration). Gedacht für die Kontrolle nach der Einrichtung bzw. nach Änderungen an Plesk/nginx:
 *
 *   npm run pruefe:oeffentlich -- https://noten.bbz-rd-eck.com
 *
 * Fragt je Pfad nur das erste Byte ab (Range-Anfrage), lädt also nichts vollständig herunter. Exit-Code 0 = nichts
 * gefunden, 1 = mindestens eine Datei ist öffentlich abrufbar, 2 = Aufruf falsch.
 */

export const PFADE = [
  '/data/noten.sqlite3', '/data/noten.sqlite3-wal', '/data/noten.sqlite3-shm',
  '/data/noten.sqlite3.vor-verschluesselung.bak',
  '/app.js', '/package.json', '/package-lock.json', '/README.md', '/CHANGELOG.md',
  '/.env', '/.env.example', '/.gitignore', '/.git/HEAD', '/.git/config',
  '/src/db.js', '/src/auth.js', '/views/partials/layout.ejs', '/test/e2e.test.js',
  '/scripts/build.js', '/scripts/plesk-debug.js', '/node_modules/fastify/package.json', '/tmp/restart.txt',
];

/** Liefert die Pfade, die nicht mit 404/403 abgewiesen werden ({pfad, status}). */
export async function findeOeffentliche(basis, pfade = PFADE, holen = fetch) {
  const funde = [];
  for (const pfad of pfade) {
    const r = await holen(new URL(pfad, basis), { headers: { Range: 'bytes=0-0' }, redirect: 'manual' });
    await r.body?.cancel?.();
    if (r.status !== 404 && r.status !== 403 && r.status !== 401) funde.push({ pfad, status: r.status });
  }
  return funde;
}

const istDirektaufruf = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (istDirektaufruf) {
  const basis = process.argv[2];
  if (!basis || !/^https?:\/\//.test(basis)) {
    console.error('Aufruf: npm run pruefe:oeffentlich -- https://noten.example.org');
    process.exit(2);
  }
  const funde = await findeOeffentliche(basis);
  if (!funde.length) {
    console.log(`OK: keine der ${PFADE.length} geprüften Dateien ist unter ${basis} abrufbar.`);
    process.exit(0);
  }
  console.error('ACHTUNG: diese Dateien sind öffentlich abrufbar:');
  for (const f of funde) console.error(`  ${f.status}  ${f.pfad}`);
  console.error('Dokumentenstamm in Plesk auf den Ordner "public" stellen (siehe README, Deployment).');
  process.exit(1);
}
