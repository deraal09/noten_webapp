/**
 * Datensicherung: Robustheit.
 * - Wiederherstellung: Änderungen, die nur im Write-Ahead-Log (-wal) der bisherigen Datenbank stehen, gehen nicht
 *   verloren -- sie werden eingearbeitet bzw. wandern mit der beiseitegelegten Kopie.
 * - Nie zwei Sicherungsläufe gleichzeitig, auch nicht aus mehreren Prozessen (Passenger mit mehreren Instanzen);
 *   ein liegengebliebener Lauf (Absturz) blockiert nicht für immer.
 * - SIGTERM beendet die Anwendung sauber und schließt die Datenbank.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3-multiple-ciphers';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-backup-robust-'));
process.env.DB_PFAD = path.join(tempDir, 'daten', 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-backup-robustheit-lang-genug-xxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const PROJEKT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { getDb, DB_ENCRYPTION_KEY, SCHEMA_VERSION } = await import('../src/db.js');
const E = await import('../src/backup/einstellungen.js');
const B = await import('../src/backup/backup.js');
const W = await import('../src/backup/wiederherstellen.js');

const db = () => getDb();
const zielDir = path.join(tempDir, 'ziel');
const laeufe = () => db().prepare('SELECT * FROM backup_laeufe ORDER BY id').all();

function oeffne(pfad) {
  const d = new Database(pfad);
  d.pragma("cipher='sqlcipher'");
  d.pragma(`key='${DB_ENCRYPTION_KEY}'`);
  return d;
}

/** Startet ein Node-Skript als eigenen Prozess; liefert {code, signal, stdout, stderr}. */
function lauf(args, env, { beiAusgabe } = {}) {
  return new Promise((resolve) => {
    const kind = spawn(process.execPath, args, { cwd: PROJEKT, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    kind.stdout.on('data', (d) => { stdout += d; beiAusgabe?.(stdout, kind); });
    kind.stderr.on('data', (d) => { stderr += d; });
    kind.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('Vorbereitung: Daten und ein Sicherungsziel (Verzeichnis)', () => {
  db().prepare("INSERT INTO schuljahre (bezeichnung) VALUES ('2026/27')").run();
  E.speichereEinstellungen({ aktiv: true, typ: 'verzeichnis', ziel: zielDir, benutzer: '', intervall_stunden: 24, aufbewahren: 10 });
});

test('Wiederherstellung: Änderungen, die nur im -wal der alten Datenbank stehen, bleiben in der Kopie erhalten', async () => {
  const sicherung = await B.erzeugeSchnappschuss();
  try {
    // Alte Datenbank wie nach einem harten Abbruch: Änderungen stehen nur im Write-Ahead-Log.
    const ziel = path.join(tempDir, 'wieder', 'noten.sqlite3');
    fs.mkdirSync(path.dirname(ziel), { recursive: true });
    const live = oeffne(path.join(tempDir, 'wieder', 'live.sqlite3'));
    live.pragma('journal_mode = WAL');
    live.pragma('wal_autocheckpoint = 0');
    live.exec('CREATE TABLE t (x TEXT)');
    live.pragma('wal_checkpoint(TRUNCATE)');
    live.prepare("INSERT INTO t VALUES ('nur im wal')").run();
    fs.copyFileSync(path.join(tempDir, 'wieder', 'live.sqlite3'), ziel);
    fs.copyFileSync(path.join(tempDir, 'wieder', 'live.sqlite3-wal'), `${ziel}-wal`);
    live.close();
    assert.ok(fs.statSync(`${ziel}-wal`).size > 0, 'Testannahme: das -wal enthält die Änderung');

    const r = W.stelleWiederHer({ quelle: sicherung.pfad, zielPfad: ziel, schluessel: DB_ENCRYPTION_KEY, maxVersion: SCHEMA_VERSION });
    assert.equal(r.ok, true, r.fehler);
    const kopie = oeffne(r.beiseite);
    assert.deepEqual(kopie.prepare('SELECT x FROM t').all(), [{ x: 'nur im wal' }], 'die beiseitegelegte Kopie ist vollständig');
    kopie.close();
    assert.equal(fs.existsSync(`${ziel}-wal`), false, 'kein fremdes -wal neben der wiederhergestellten Datenbank');
    const neu = oeffne(ziel);
    assert.ok(neu.prepare("SELECT 1 FROM schuljahre WHERE bezeichnung = '2026/27'").get(), 'die Sicherung ist eingesetzt');
    neu.close();
  } finally {
    fs.rmSync(sicherung.verzeichnis, { recursive: true, force: true });
  }
});

test('Läuft schon eine Sicherung (auch aus einem anderen Prozess), startet keine zweite', async () => {
  db().prepare('DELETE FROM backup_laeufe').run();
  const id = E.protokolliereStart('geplant'); // offener Lauf, z. B. eines anderen Prozesses
  const r = await B.fuehreBackupAus('manuell');
  assert.equal(r.ok, false);
  assert.equal(r.uebersprungen, true);
  assert.equal(laeufe().length, 1, 'kein zweiter Protokolleintrag');
  E.protokolliereEnde(id, { ok: true, meldung: 'fertig' });
});

test('Ein liegengebliebener Lauf (Absturz) blockiert nicht: er wird als abgebrochen beendet', async () => {
  db().prepare('DELETE FROM backup_laeufe').run();
  E.protokolliereStart('geplant', new Date(Date.now() - B.LAUF_FRIST_MS - 60_000));
  const r = await B.fuehreBackupAus('manuell');
  assert.equal(r.ok, true, r.meldung);
  const [alt, neu] = laeufe();
  assert.equal(alt.ok, 0);
  assert.match(alt.meldung, /Abgebrochen/);
  assert.equal(neu.ok, 1);
});

test('Zwei Prozesse mit fälligem Planer gleichzeitig: genau eine Sicherung', async () => {
  db().prepare('DELETE FROM backup_laeufe').run();
  fs.rmSync(zielDir, { recursive: true, force: true });
  const env = { DB_PFAD: process.env.DB_PFAD, START_UM: String(Date.now() + 1500) };
  const ergebnisse = await Promise.all([1, 2].map(() => lauf(['test/helfer/backup-planer-tick.mjs'], env)));
  for (const e of ergebnisse) assert.equal(e.code, 0, e.stderr);
  const json = ergebnisse.map((e) => JSON.parse(e.stdout.trim().split('\n').pop()));
  assert.equal(json.filter((j) => j.ok).length, 1, JSON.stringify(json));
  assert.equal(laeufe().length, 1, 'genau ein Lauf im Protokoll');
  assert.equal(fs.readdirSync(zielDir).filter((n) => /^noten-backup-/.test(n)).length, 1);
});

test('SIGTERM beendet die Anwendung sauber und schließt die Datenbank (kein -wal bleibt liegen)', async () => {
  const dbPfad = path.join(tempDir, 'app', 'noten.sqlite3');
  let gesendet = false;
  const e = await lauf(['app.js'], { NODE_ENV: 'development', PORT: '0', HOST: '127.0.0.1', DB_PFAD: dbPfad, DB_ENCRYPTION_KEY }, {
    beiAusgabe: (ausgabe, kind) => {
      if (!gesendet && /läuft auf/.test(ausgabe)) { gesendet = true; kind.kill('SIGTERM'); }
    },
  });
  assert.ok(gesendet, `die App ist nicht gestartet: ${e.stderr}`);
  assert.equal(e.signal, null, 'nicht hart vom Signal beendet');
  assert.equal(e.code, 0, e.stderr);
  assert.equal(fs.existsSync(`${dbPfad}-wal`), false);
});

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});
