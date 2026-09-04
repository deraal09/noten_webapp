/**
 * Datenbank-Verschlüsselung (SQLCipher via better-sqlite3-multiple-ciphers,
 * siehe src/db.js): die komplette SQLite-Datei liegt verschlüsselt auf der
 * Platte statt einzelner Felder. Bestehende Klartext-Installationen werden
 * beim ersten Start nach dem Update automatisch (und ohne Datenverlust)
 * migriert.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-db-crypto-'));

test('Eine neu angelegte Datenbank ist auf der Platte nicht im Klartext lesbar', async () => {
  process.env.DB_PFAD = path.join(tempDir, 'neu.sqlite3');
  process.env.DB_ENCRYPTION_KEY = 'test-schluessel-fuer-neue-db-bitte-lang-genug';
  const { getDb, closeDb } = await import('../src/db.js?neu');
  const db = getDb();
  db.prepare(`INSERT INTO users (username, password_hash, role, active) VALUES (?, ?, 'admin', 1)`)
    .run('geheimeslehrkraft', 'x');
  closeDb();

  const rohbytes = fs.readFileSync(process.env.DB_PFAD);
  assert.ok(!rohbytes.includes(Buffer.from('geheimeslehrkraft')),
    'Benutzername darf nicht im Klartext in der Datei stehen');
  // SQLite-Klartext-Dateien beginnen immer mit dieser Signatur -- eine
  // verschlüsselte Datei darf das NICHT tun.
  assert.notEqual(rohbytes.slice(0, 15).toString('utf8'), 'SQLite format 3');
});

test('Falscher Schlüssel kann die Datenbank nicht öffnen', async () => {
  const dbPfad = path.join(tempDir, 'falscher-schluessel.sqlite3');
  process.env.DB_PFAD = dbPfad;
  process.env.DB_ENCRYPTION_KEY = 'richtiger-schluessel-lang-genug-12345';
  const { getDb: getDbRichtig, closeDb: closeDbRichtig } = await import('../src/db.js?falscher-schluessel-schreiben');
  getDbRichtig().prepare(`INSERT INTO users (username, password_hash, role, active) VALUES (?, ?, 'admin', 1)`)
    .run('admin', 'x');
  closeDbRichtig();

  const Database = (await import('better-sqlite3-multiple-ciphers')).default;
  const db = new Database(dbPfad);
  db.pragma("cipher='sqlcipher'");
  db.pragma("key='falscher-schluessel'");
  assert.throws(() => db.prepare('SELECT * FROM users').all(), /file is not a database|not a database/i);
  db.close();
});

test('Bestehende Klartext-Datenbank wird beim nächsten Start automatisch verschlüsselt, Daten bleiben erhalten', async () => {
  const dbPfad = path.join(tempDir, 'bestand.sqlite3');
  process.env.DB_PFAD = dbPfad;
  process.env.DB_ENCRYPTION_KEY = 'migrations-schluessel-lang-genug-abc123';

  // Eine "alte" Installation simulieren: eine reine Klartext-SQLite-Datei
  // mit Nutzdaten, ohne jede Verschlüsselung -- so, wie sie vor diesem
  // Feature auf einem produktiven Server lag.
  const Database = (await import('better-sqlite3-multiple-ciphers')).default;
  const klartext = new Database(dbPfad);
  klartext.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'teacher',
    display_name TEXT, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), invited_by_id INTEGER,
    auth_source TEXT NOT NULL DEFAULT 'lokal', login_sub TEXT, email TEXT
  )`);
  klartext.prepare(`INSERT INTO users (username, password_hash, role, active) VALUES (?, ?, 'admin', 1)`)
    .run('bestandskonto', 'alter-hash-123');
  klartext.close();

  const vorherKlartextLesbar = fs.readFileSync(dbPfad).slice(0, 15).toString('utf8') === 'SQLite format 3';
  assert.ok(vorherKlartextLesbar, 'Testannahme: die Ausgangsdatei ist echter Klartext');

  // getDb() (die reguläre Startroutine der App) muss das automatisch erkennen und migrieren.
  const { getDb, closeDb } = await import('../src/db.js?migration');
  const db = getDb();
  const zeile = db.prepare('SELECT * FROM users WHERE username = ?').get('bestandskonto');
  assert.ok(zeile, 'das vor der Migration angelegte Konto muss danach weiterhin lesbar sein');
  assert.equal(zeile.password_hash, 'alter-hash-123');
  closeDb();

  const nachherBytes = fs.readFileSync(dbPfad);
  assert.notEqual(nachherBytes.slice(0, 15).toString('utf8'), 'SQLite format 3',
    'nach der Migration muss die Hauptdatei verschlüsselt sein');
  assert.ok(!nachherBytes.includes(Buffer.from('bestandskonto')));
});

test('Die Migration lässt KEINE Klartext-Kopie der Daten im Datenverzeichnis zurück', () => {
  // Eine dauerhaft daneben liegende, unverschlüsselte Vollkopie würde die
  // Verschlüsselung praktisch aufheben (jedes Backup des Verzeichnisses
  // hätte sie mitgenommen) -- deshalb wird die Klartext-Datei nach
  // bestandener Gegenprüfung ersetzt, nicht umbenannt.
  const dbPfad = path.join(tempDir, 'bestand.sqlite3');
  for (const uebrig of fs.readdirSync(tempDir)) {
    if (!uebrig.startsWith('bestand.sqlite3')) continue;
    const bytes = fs.readFileSync(path.join(tempDir, uebrig));
    assert.ok(!bytes.includes(Buffer.from('bestandskonto')),
      `${uebrig} enthält die Daten im Klartext -- nach der Migration darf keine Datei das mehr tun`);
  }
  assert.ok(!fs.existsSync(dbPfad + '.vor-verschluesselung.bak'));
  assert.ok(!fs.existsSync(dbPfad + '.migration-tmp'));
});

test('Wiederholter Start nach der Migration löst keine erneute Migration mehr aus', async () => {
  const dbPfad = path.join(tempDir, 'bestand.sqlite3');
  const dbVorher = fs.statSync(dbPfad).mtimeMs;

  process.env.DB_PFAD = dbPfad;
  process.env.DB_ENCRYPTION_KEY = 'migrations-schluessel-lang-genug-abc123';
  const { getDb, closeDb } = await import('../src/db.js?nochmal-oeffnen');
  const zeile = getDb().prepare('SELECT username FROM users WHERE username = ?').get('bestandskonto');
  assert.equal(zeile.username, 'bestandskonto');
  closeDb();

  assert.equal(fs.statSync(dbPfad).mtimeMs, dbVorher,
    'die Datenbankdatei darf beim zweiten Start nicht erneut ersetzt werden (keine erneute Migration)');
});

/** Startet src/db.js in einem eigenen Prozess und gibt zurück, ob der Start gelang. */
function starteDbModulMit(env) {
  const dbJsUrl = new URL('../src/db.js', import.meta.url).href;
  const skriptPfad = path.join(tempDir, 'start-check.mjs');
  fs.writeFileSync(skriptPfad, `import(${JSON.stringify(dbJsUrl)}).then(() => console.log('gestartet'));`);
  try {
    execFileSync('node', [skriptPfad], {
      env: { ...process.env, SECRET: 'irrelevant-fuer-diesen-test-lang-genug', ...env },
      stdio: 'pipe',
    });
    return { gestartet: true, ausgabe: '' };
  } catch (e) {
    return { gestartet: false, ausgabe: String(e.stderr || '') };
  }
}

test('DB_ENCRYPTION_KEY ist in Produktion zwingend (Prozess beendet sich sonst mit Fehler)', () => {
  const { gestartet } = starteDbModulMit({ NODE_ENV: 'production', DB_ENCRYPTION_KEY: '' });
  assert.equal(gestartet, false);
});

test('Ohne DB_ENCRYPTION_KEY startet die App auch bei fehlendem NODE_ENV nicht', () => {
  // Der eigentliche Fallstrick: auf einem Plesk-Server wird NODE_ENV leicht
  // vergessen. Früher fiel die App dann auf einen im Quelltext stehenden
  // Ersatzschlüssel zurück -- die Datei war zwar verschlüsselt, aber mit
  // einem öffentlich bekannten Schlüssel, ohne jeden Hinweis darauf.
  const { gestartet, ausgabe } = starteDbModulMit({ NODE_ENV: '', DB_ENCRYPTION_KEY: '' });
  assert.equal(gestartet, false, 'ohne Schlüssel darf die App nicht einfach durchstarten');
  assert.match(ausgabe, /DB_ENCRYPTION_KEY/);
});

test('Der Quelltext enthält keinen als Datenschlüssel nutzbaren Ersatzwert', async () => {
  // Gegenprobe zum Test darüber: selbst wenn die Abfrage oben einmal
  // umgebaut wird, darf kein Schlüssel-Literal übrig bleiben, mit dem sich
  // echte Daten verschlüsseln ließen.
  const quelltext = fs.readFileSync(new URL('../src/db.js', import.meta.url), 'utf8');
  assert.doesNotMatch(quelltext, /entwicklung-unsicherer-default-schluessel/);
  assert.match(quelltext, /NODE_ENV === 'test'/,
    'der einzige Ersatzwert darf ausschließlich für die Testsuite gelten');
});

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});
