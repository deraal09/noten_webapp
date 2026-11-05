/**
 * Halbjahre mit Daten dürfen nicht wegfallen -- weder beim Kürzen der Laufzeit einer Klasse noch beim Ändern der
 * Halbjahre eines Fachs. Gezählt werden Leistungen, direkt eingetragene Endnoten, SPA-Noten (Halbjahr als Zahl) und
 * bei der Laufzeit auch die Fehlzeiten. Leere SPA-Eingabezeilen (Feld wieder geleert) zählen nicht.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-halbjahr-daten-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-halbjahr-daten-lang-genug-xxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { halbjahreMitDaten, halbjahreMitDatenInKlasse, setzeFachHalbjahre } = await import('../src/unterfaecher.js');
const { klassenLaufzeit } = await import('../src/klassen-jahre.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
const cookies = new Map();
async function admin(url, body) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const r = await fetch(base + url, { method: 'POST', headers, body: new URLSearchParams(body), redirect: 'manual' });
  for (const raw of r.headers.getSetCookie()) { const [k, ...v] = raw.split(';')[0].split('='); cookies.set(k.trim(), v.join('=').trim()); }
  return r;
}
const db = () => getDb();
const fach = (id) => db().prepare('SELECT * FROM faecher WHERE id = ?').get(id);
let ihk; let ihkFach; let person; let spa; let spaFach; let spaPerson;

test('Vorbereitung: IHK-Klasse (3 Jahre) und SPA-Klasse (2 Jahre) mit je einem Fach und einer Person', async () => {
  await admin('/setup', { username: 'admin', display_name: 'Admin', password: 'geheim12', password2: 'geheim12' });
  db().prepare("INSERT INTO schuljahre (id, bezeichnung) VALUES (1, '2025/26')").run();
  ihk = Number(db().prepare("INSERT INTO klassen (schuljahr_id, name, notenschluessel) VALUES (1, '10I', 'IHK')").run().lastInsertRowid);
  spa = Number(db().prepare("INSERT INTO klassen (schuljahr_id, name, notenschluessel, spa_bildungsgang) VALUES (1, '13SPA', 'SPA', 'SPA_PIA')").run().lastInsertRowid);
  ihkFach = Number(db().prepare("INSERT INTO faecher (klasse_id, name) VALUES (?, 'Mathe')").run(ihk).lastInsertRowid);
  spaFach = Number(db().prepare("INSERT INTO faecher (klasse_id, name, spa_fach_key) VALUES (?, 'LF1', 'LF1')").run(spa).lastInsertRowid);
  person = Number(db().prepare("INSERT INTO schueler (klasse_id, nachname, vorname) VALUES (?, 'Muster', 'Erika')").run(ihk).lastInsertRowid);
  spaPerson = Number(db().prepare("INSERT INTO schueler (klasse_id, nachname, vorname) VALUES (?, 'Beispiel', 'Ben')").run(spa).lastInsertRowid);
  assert.equal(klassenLaufzeit(ihk).anzahlHalbjahre, 6);
  assert.equal(klassenLaufzeit(spa).anzahlHalbjahre, 4);
});

test('Laufzeit kürzen: eine direkt eingetragene Endnote im wegfallenden Halbjahr verhindert es', async () => {
  db().prepare("INSERT INTO halbjahr_endnoten (fach_id, schueler_id, halbjahr, note) VALUES (?, ?, '6. Halbjahr', 2)").run(ihkFach, person);
  await admin(`/teacher/klassen/${ihk}/laufzeit`, { einschulung_jahr: '2025', anzahl_jahre: '2' });
  assert.equal(klassenLaufzeit(ihk).anzahlHalbjahre, 6, 'die Laufzeit bleibt');
  db().prepare('DELETE FROM halbjahr_endnoten').run();
});

test('Laufzeit kürzen: auch Fehlzeiten im wegfallenden Halbjahr verhindern es; ohne Daten geht es', async () => {
  db().prepare("INSERT INTO fehlzeiten (schueler_id, halbjahr, typ, stunden) VALUES (?, '5. Halbjahr', 'entschuldigt', 4)").run(person);
  await admin(`/teacher/klassen/${ihk}/laufzeit`, { einschulung_jahr: '2025', anzahl_jahre: '2' });
  assert.equal(klassenLaufzeit(ihk).anzahlHalbjahre, 6);
  db().prepare('DELETE FROM fehlzeiten').run();
  await admin(`/teacher/klassen/${ihk}/laufzeit`, { einschulung_jahr: '2025', anzahl_jahre: '2' });
  assert.equal(klassenLaufzeit(ihk).anzahlHalbjahre, 4, 'ohne Daten in Halbjahr 5/6 wird gekürzt');
});

test('SPA: Noten mit Halbjahr als Zahl zählen -- beim Kürzen der Laufzeit und beim Ändern der Fach-Halbjahre', async () => {
  db().prepare('INSERT INTO spa_eingaben (fach_id, schueler_id, halbjahr, direktwert) VALUES (?, ?, 4, 11)').run(spaFach, spaPerson);
  assert.deepEqual([...halbjahreMitDaten(spaFach)], [4]);
  await admin(`/teacher/klassen/${spa}/laufzeit`, { einschulung_jahr: '2025', anzahl_jahre: '1' });
  assert.equal(klassenLaufzeit(spa).anzahlHalbjahre, 4, 'die SPA-Note im 4. Halbjahr verhindert das Kürzen');
  const r = setzeFachHalbjahre(fach(spaFach), [1, 2, 3]);
  assert.equal(r.ok, false);
  assert.match(r.fehler, /4\. Halbjahr/);

  db().prepare('DELETE FROM spa_eingaben').run();
  db().prepare("INSERT INTO spa_komponenten_noten (fach_id, schueler_id, halbjahr, komponente_schluessel, punkte) VALUES (?, ?, 3, 'kunst', 9)").run(spaFach, spaPerson);
  assert.equal(setzeFachHalbjahre(fach(spaFach), [1, 2]).ok, false, 'auch Komponenten-Noten zählen');
  db().prepare('DELETE FROM spa_komponenten_noten').run();
});

test('Leere SPA-Eingabezeilen (Feld wieder geleert) blockieren nichts', () => {
  db().prepare('INSERT INTO spa_eingaben (fach_id, schueler_id, halbjahr) VALUES (?, ?, 4)').run(spaFach, spaPerson);
  assert.equal(halbjahreMitDaten(spaFach).size, 0);
  db().prepare('UPDATE spa_eingaben SET ist_na = 1').run();
  assert.deepEqual([...halbjahreMitDaten(spaFach)], [4], '"n. a." ist eine Eintragung');
  db().prepare('DELETE FROM spa_eingaben').run();
  assert.equal(setzeFachHalbjahre(fach(spaFach), [1, 2, 3]).ok, true);
});

test('Die Klassen-Prüfung umfasst alle Fächer der Klasse und die Fehlzeiten (auch zweite Schule)', () => {
  db().prepare("INSERT INTO klausuren (fach_id, halbjahr, name, max_punkte_pro_aufgabe, gewichtung) VALUES (?, '2. Halbjahr', 'K', '[10]', 0)").run(ihkFach);
  db().prepare("INSERT INTO fehlzeiten_schule2 (schueler_id, halbjahr, typ, stunden) VALUES (?, '3. Halbjahr', 'entschuldigt', 2)").run(person);
  db().prepare("INSERT INTO fehlzeiten (schueler_id, halbjahr, typ, stunden) VALUES (?, '4. Halbjahr', 'entschuldigt', 0)").run(person);
  assert.deepEqual([...halbjahreMitDatenInKlasse(ihk)].sort(), [2, 3], 'Fehlzeiten mit 0 Stunden zählen nicht');
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
