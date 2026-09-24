/**
 * Migration der Sitzplan-Tabellen auf "ein Plan je Raum" (src/db.js,
 * migriereSitzplanRaeume). Bestandsdatenbanken hatten
 * UNIQUE (klasse_id, owner_id) bzw. PRIMARY KEY (klasse_id) — höchstens ein
 * Plan je Lehrkraft und Klasse. Diese Regel lässt sich in SQLite nicht per
 * ALTER TABLE ändern, die Tabellen werden deshalb neu aufgebaut. Dabei darf
 * nichts verloren gehen: bestehende Pläne landen unter raum = ''.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-sitzplan-migration-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-sitzplan-migration-lang-genug';
process.env.NODE_ENV = 'test';

const { getDb, closeDb } = await import('../src/db.js');

const PLAETZE = JSON.stringify([{ id: 'p1', x: 10, y: 20, text: 'Anna A.' }]);

test('Vorbereitung: Bestandsdatenbank mit den alten Sitzplan-Tabellen samt Inhalt', () => {
  const db = getDb();
  db.prepare("INSERT INTO users (username, password_hash, role, active) VALUES ('lehrer', 'x', 'teacher', 1)").run();
  db.prepare("INSERT INTO schuljahre (bezeichnung) VALUES ('2026/27')").run();
  db.prepare("INSERT INTO klassen (schuljahr_id, name) VALUES (1, '10A')").run();
  // Die Tabellen genau so zurückbauen, wie sie vor der Raumangabe aussahen.
  db.exec(`
    DROP TABLE sitzplaene;
    DROP TABLE sitzplan_geteilt;
    CREATE TABLE sitzplaene (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      klasse_id INTEGER NOT NULL REFERENCES klassen(id) ON DELETE CASCADE,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plaetze TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (klasse_id, owner_id)
    );
    CREATE TABLE sitzplan_geteilt (
      klasse_id INTEGER PRIMARY KEY REFERENCES klassen(id) ON DELETE CASCADE,
      plaetze TEXT NOT NULL DEFAULT '[]',
      geteilt_von_id INTEGER REFERENCES users(id),
      geteilt_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare('INSERT INTO sitzplaene (klasse_id, owner_id, plaetze) VALUES (1, 1, ?)').run(PLAETZE);
  db.prepare('INSERT INTO sitzplan_geteilt (klasse_id, plaetze, geteilt_von_id) VALUES (1, ?, 1)').run(PLAETZE);
  closeDb();
});

test('Beim nächsten Start: Raum-Spalte da, bestehende Pläne unter raum = \'\' erhalten', () => {
  const db = getDb(); // läuft durch migrate()
  const spalten = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  assert.ok(spalten('sitzplaene').includes('raum'));
  assert.ok(spalten('sitzplan_geteilt').includes('raum'));

  const entwurf = db.prepare('SELECT * FROM sitzplaene').get();
  assert.equal(entwurf.raum, '');
  assert.equal(entwurf.plaetze, PLAETZE);
  const geteilt = db.prepare('SELECT * FROM sitzplan_geteilt').get();
  assert.equal(geteilt.raum, '');
  assert.equal(geteilt.plaetze, PLAETZE);
  assert.equal(geteilt.geteilt_von_id, 1);

  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('Danach: mehrere Räume je Lehrkraft möglich, gleicher Raum in anderer Schreibweise nicht', () => {
  const db = getDb();
  db.prepare("INSERT INTO sitzplaene (klasse_id, owner_id, raum) VALUES (1, 1, 'Computerraum')").run();
  assert.throws(
    () => db.prepare("INSERT INTO sitzplaene (klasse_id, owner_id, raum) VALUES (1, 1, 'COMPUTERRAUM')").run(),
    /UNIQUE constraint failed/,
  );
  db.prepare("INSERT INTO sitzplan_geteilt (klasse_id, raum) VALUES (1, 'Computerraum')").run();
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sitzplaene').get().c, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sitzplan_geteilt').get().c, 2);
});

test('Ein weiterer Start baut nichts erneut um', () => {
  closeDb();
  const db = getDb();
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sitzplaene').get().c, 2);
  assert.equal(db.prepare("SELECT plaetze FROM sitzplaene WHERE raum = ''").get().plaetze, PLAETZE);
});

test.after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
