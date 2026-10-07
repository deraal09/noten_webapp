/**
 * Migration: Die historischen Halbjahre wurden entfernt (ersetzt durch Endnoten
 * je Halbjahr). Beim Start einer Bestandsdatenbank fallen die Tabellen
 * historische_halbjahre/historische_noten, rein historische Fächer und die
 * Spalte faecher.nur_historisch weg; normale Fächer bleiben. Außerdem wird die
 * Laufzeit-Spalte klassen.einschulung_jahr aus dem Schuljahr nachgetragen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-migration-historie-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-migration-historie-lang-genug';
process.env.NODE_ENV = 'test';

const { getDb, closeDb } = await import('../src/db.js');
const { klassenLaufzeit } = await import('../src/klassen-jahre.js');

test('Vorbereitung: Bestandsdatenbank mit historischen Halbjahren, einem rein historischen Fach und ohne Einschulungsjahr', () => {
  const db = getDb();
  db.prepare("INSERT INTO schuljahre (bezeichnung) VALUES ('2025/26')").run();
  db.prepare("INSERT INTO klassen (schuljahr_id, name) VALUES (1, '10A')").run();
  db.prepare("INSERT INTO schueler (klasse_id, nachname, vorname) VALUES (1, 'Adler', 'Anna')").run();
  db.exec(`
    ALTER TABLE faecher ADD COLUMN nur_historisch INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE historische_halbjahre (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fach_id INTEGER NOT NULL REFERENCES faecher(id) ON DELETE CASCADE,
      bezeichnung TEXT NOT NULL, reihenfolge INTEGER NOT NULL DEFAULT 0,
      erstellt_von_id INTEGER, erstellt_am TEXT, erstellt_als_fachlehrkraft INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE historische_noten (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      historisches_halbjahr_id INTEGER NOT NULL REFERENCES historische_halbjahre(id) ON DELETE CASCADE,
      schueler_id INTEGER NOT NULL, note REAL
    );
  `);
  db.prepare("INSERT INTO faecher (klasse_id, name, nur_historisch) VALUES (1, 'Mathe', 0)").run();
  db.prepare("INSERT INTO faecher (klasse_id, name, nur_historisch) VALUES (1, 'Religion (alt)', 1)").run();
  db.prepare("INSERT INTO historische_halbjahre (fach_id, bezeichnung) VALUES (1, '1. Halbjahr 2023/24')").run();
  db.prepare('INSERT INTO historische_noten (historisches_halbjahr_id, schueler_id, note) VALUES (1, 1, 2)').run();
  db.prepare('UPDATE klassen SET einschulung_jahr = NULL').run();
  closeDb();
});

test('Nach dem Neustart: historische Tabellen und rein historische Fächer sind weg, normale Fächer bleiben', () => {
  const db = getDb();
  const tabellen = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  assert.ok(!tabellen.includes('historische_halbjahre'));
  assert.ok(!tabellen.includes('historische_noten'));
  assert.deepEqual(db.prepare('SELECT name FROM faecher ORDER BY name').all().map((f) => f.name), ['Mathe']);
  const spalten = db.prepare('PRAGMA table_info(faecher)').all().map((c) => c.name);
  assert.ok(!spalten.includes('nur_historisch'), 'Spalte entfernt');
  assert.ok(tabellen.includes('halbjahr_endnoten'), 'Endnoten-Tabelle vorhanden');
});

test('Einschulungsjahr wird aus dem Schuljahr der Klasse nachgetragen, Standard-Laufzeit 3 Jahre', () => {
  const k = getDb().prepare('SELECT einschulung_jahr, abschluss_jahr FROM klassen').get();
  assert.equal(k.einschulung_jahr, 2025);
  assert.equal(k.abschluss_jahr, null);
  assert.equal(klassenLaufzeit(1).anzahlHalbjahre, 6);
});
