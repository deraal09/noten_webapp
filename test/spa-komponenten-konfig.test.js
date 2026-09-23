/**
 * SPA-Komponenten-Konfigurierbarkeit: die Klassenleitung kann einzelne
 * Rest-Anteil-Komponenten eines Lernfelds (in der festen Konfiguration nur
 * LF3: Kunst/Spiel/Musik/Bewegung, siehe spa-schema.js) je Klasse/Halbjahr
 * abschalten -- angelehnt an dclausen01/notentabellen-spa,
 * packages/server/src/db/komponenten.ts. Feste Gewichte (z. B. Pädagogik/
 * Bericht) bleiben immer aktiv. Deckt spaKomponentenKonfig/
 * spaSetzeKomponenteAktiv/spaSchemaFuerFach in src/spa-noten-service.js ab,
 * sowie dass die Deaktivierung tatsächlich in berechneFachFuerSchueler
 * ankommt (Restbudget-Umverteilung auf die verbleibenden Komponenten).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-spa-komponenten-konfig-test-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.NODE_ENV = 'test';

const { getDb } = await import('../src/db.js');
const {
  berechneFachFuerSchueler, spaKomponentenKonfig, spaSetzeKomponenteAktiv, spaSchemaFuerFach,
} = await import('../src/spa-noten-service.js');

const db = getDb();

db.prepare('INSERT INTO schuljahre (id, bezeichnung) VALUES (1, ?)').run('2026/27');
db.prepare('INSERT INTO klassen (id, schuljahr_id, name, notenschluessel, spa_bildungsgang) VALUES (1, 1, ?, ?, ?)')
  .run('13SPA1', 'SPA', 'SPA_REGULAR');
db.prepare('INSERT INTO schueler (id, klasse_id, nachname, vorname) VALUES (1, 1, ?, ?)').run('Musterfrau', 'Maxi');
db.prepare('INSERT INTO faecher (id, klasse_id, name, spa_fach_key) VALUES (1, 1, ?, ?)').run('Lernfeld 3', 'LF3');
db.prepare('INSERT INTO fach_teilnehmer (fach_id, schueler_id) VALUES (1, 1)').run();

function setzeKomponente(halbjahr, schluessel, punkte) {
  db.prepare(`
    INSERT INTO spa_komponenten_noten (fach_id, schueler_id, halbjahr, komponente_schluessel, punkte)
    VALUES (1, 1, ?, ?, ?)
    ON CONFLICT(fach_id, schueler_id, halbjahr, komponente_schluessel) DO UPDATE SET punkte = excluded.punkte
  `).run(halbjahr, schluessel, punkte);
}

test('spaKomponentenKonfig: LF3 1. Hj. hat 4 Rest-Komponenten, alle standardmäßig aktiv', () => {
  const konfig = spaKomponentenKonfig(db, 1, 1);
  assert.deepEqual(konfig.map((k) => k.schluessel).sort(), ['bewegung', 'kunst', 'musik', 'spiel']);
  assert.ok(konfig.every((k) => k.aktiv));
});

test('spaKomponentenKonfig: feste Komponenten (Pädagogik) tauchen nicht in der schaltbaren Liste auf', () => {
  const konfig = spaKomponentenKonfig(db, 1, 1);
  assert.ok(!konfig.some((k) => k.schluessel === 'paedagogik'));
});

test('spaKomponentenKonfig: LF3 2. Hj. hat dieselben 4 Rest-Komponenten (Bericht ist dort fix, nicht schaltbar)', () => {
  const konfig = spaKomponentenKonfig(db, 1, 2);
  assert.deepEqual(konfig.map((k) => k.schluessel).sort(), ['bewegung', 'kunst', 'musik', 'spiel']);
  assert.ok(!konfig.some((k) => k.schluessel === 'bericht'));
});

test('Fach ohne Rest-Komponenten (z. B. nicht-SPA oder unbekannte ID) liefert leere Liste', () => {
  assert.deepEqual(spaKomponentenKonfig(db, 99999, 1), []);
});

test('spaSetzeKomponenteAktiv: unbekannte oder feste Komponente wird abgelehnt', () => {
  assert.equal(spaSetzeKomponenteAktiv(db, 1, 1, 'paedagogik', false), false, 'feste Komponente nicht schaltbar');
  assert.equal(spaSetzeKomponenteAktiv(db, 1, 1, 'nichtvorhanden', false), false, 'unbekannte Komponente');
  // Keine Zeile darf dabei entstanden sein.
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM spa_deaktivierte_komponenten').get().c, 0);
});

test('spaSetzeKomponenteAktiv: Musik im 1. Hj. abschalten wirkt nur dort, nicht im 2. Hj.', () => {
  const erfolg = spaSetzeKomponenteAktiv(db, 1, 1, 'musik', false);
  assert.equal(erfolg, true);

  const konfigHj1 = spaKomponentenKonfig(db, 1, 1);
  assert.equal(konfigHj1.find((k) => k.schluessel === 'musik').aktiv, false);
  assert.ok(konfigHj1.filter((k) => k.schluessel !== 'musik').every((k) => k.aktiv));

  const konfigHj2 = spaKomponentenKonfig(db, 1, 2);
  assert.ok(konfigHj2.every((k) => k.aktiv), 'Deaktivierung im 1. Hj. darf das 2. Hj. nicht betreffen');
});

test('spaSchemaFuerFach: deaktivierte Komponente fehlt im Schema, feste Komponente bleibt', () => {
  const { schema } = spaSchemaFuerFach(db, 1);
  const hj1 = schema.find((s) => s.halbjahr === 1);
  assert.deepEqual(hj1.komponenten.map((k) => k.schluessel).sort(), ['bewegung', 'kunst', 'paedagogik', 'spiel']);
});

test('berechneFachFuerSchueler: Restbudget verteilt sich nach Deaktivierung auf die verbleibenden Komponenten', () => {
  // Musik ist für Hj1 deaktiviert (siehe oben) -- ein Wert dafür in der DB
  // (Karteileiche, z. B. von vor der Deaktivierung) wird dabei ignoriert.
  setzeKomponente(1, 'paedagogik', 10);
  setzeKomponente(1, 'kunst', 6);
  setzeKomponente(1, 'spiel', 9);
  setzeKomponente(1, 'musik', 100);
  setzeKomponente(1, 'bewegung', 12);

  const erg = berechneFachFuerSchueler(db, 1, 1);
  const hj1 = erg.find((e) => e.halbjahr === 1);
  // 0,4*10 (fix) + 0,6/3*(6+9+12) (Rest gleichmäßig auf 3 statt 4 Komponenten)
  const erwartet = 0.4 * 10 + (0.6 / 3) * 6 + (0.6 / 3) * 9 + (0.6 / 3) * 12;
  assert.ok(Math.abs(hj1.zwischennote - erwartet) < 1e-9, `${hj1.zwischennote} !== ${erwartet}`);
  assert.equal(hj1.endpunkte, hj1.zwischennote); // 1. Hj. hat keinen Vorgänger
});

test('Musik wieder aktivieren stellt die ursprüngliche 4er-Aufteilung wieder her', () => {
  const erfolg = spaSetzeKomponenteAktiv(db, 1, 1, 'musik', true);
  assert.equal(erfolg, true);
  assert.ok(spaKomponentenKonfig(db, 1, 1).every((k) => k.aktiv));

  const erg = berechneFachFuerSchueler(db, 1, 1);
  const hj1 = erg.find((e) => e.halbjahr === 1);
  // Musik-Wert (100) ist noch in der DB und zählt jetzt wieder mit.
  const erwartet = 0.4 * 10 + 0.15 * 6 + 0.15 * 9 + 0.15 * 100 + 0.15 * 12;
  assert.ok(Math.abs(hj1.zwischennote - erwartet) < 1e-9, `${hj1.zwischennote} !== ${erwartet}`);
});
