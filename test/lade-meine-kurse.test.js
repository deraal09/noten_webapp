/**
 * Unit-Test für ladeMeineKurse() (src/auth.js): deckt gezielt einen bereits
 * aufgetretenen Bug ab, bei dem die Kurse in "Meine Klassen" trotz
 * korrekter Fach-Zuweisung nie angezeigt wurden. Ursache: die Abfrage
 * lieferte zwar `schuljahr_bezeichnung`, aber kein `schuljahr_id` -- die
 * aufrufende Route (routes/teacher.js GET /klassen) gruppiert die Kurse
 * aber genau danach (`kurseNachSchuljahr.get(k.schuljahr_id)`), landete also
 * immer im (nicht existierenden) `undefined`-Eimer und wurde nie gerendert.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-lade-meine-kurse-test-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.NODE_ENV = 'test';

const { getDb } = await import('../src/db.js');
const { ladeMeineKurse } = await import('../src/auth.js');

const db = getDb();

db.prepare('INSERT INTO schuljahre (id, bezeichnung) VALUES (1, ?)').run('2026/27');
db.prepare('INSERT INTO klassen (id, schuljahr_id, name, notenschluessel) VALUES (1, 1, ?, ?)').run('__huelle', 'IHK');
db.prepare('INSERT INTO faecher (id, klasse_id, name, ist_kurs) VALUES (1, 1, ?, 1)').run('Musikkurs');
db.prepare('INSERT INTO users (id, username, display_name, password_hash) VALUES (1, ?, ?, ?)').run('lehrera', 'Lehrer A', 'x');
db.prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES (1, 1)').run();

test('ladeMeineKurse liefert schuljahr_id mit, nicht nur schuljahr_bezeichnung', () => {
  const kurse = ladeMeineKurse(1);
  assert.equal(kurse.length, 1);
  assert.equal(kurse[0].schuljahr_id, 1, 'schuljahr_id fehlt -- die Route kann den Kurs dann keinem Schuljahr zuordnen');
  assert.equal(kurse[0].schuljahr_bezeichnung, '2026/27');
});

test('ladeMeineKurse liefert nichts für eine Person ohne Fach-Zuweisung', () => {
  db.prepare('INSERT INTO users (id, username, display_name, password_hash) VALUES (2, ?, ?, ?)').run('lehrerb', 'Lehrer B', 'x');
  assert.deepEqual(ladeMeineKurse(2), []);
});
