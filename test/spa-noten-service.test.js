/**
 * Integrationstests für src/spa-noten-service.js: verdrahtet Rechenkern +
 * feste Konfiguration mit echten DB-Zeilen (spa_eingaben/
 * spa_komponenten_noten) -- deckt die Fälle ab, die reines Unit-Testen des
 * Rechenkerns (spa-grade-calc.test.js) nicht sieht: Direktwert/Komponenten
 * aus der DB laden, externe Werte über Fachgrenzen (Blockpraxis → Praxis)
 * und über die eigene Prüfungsnote (Englisch/Mathematik FHR) injizieren,
 * sowie die Vorwerte-Anzeige für die Eingabemaske.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-spa-service-test-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.NODE_ENV = 'test';

const { getDb } = await import('../src/db.js');
const {
  berechneFachFuerSchueler, vorwerteFuer, ladeEingabeAnzeige, zeugnisFuerKlasse,
} = await import('../src/spa-noten-service.js');
const { spaSchemaFuer } = await import('../src/spa-schema.js');

const db = getDb();

db.prepare('INSERT INTO schuljahre (id, bezeichnung) VALUES (1, ?)').run('2026/27');
db.prepare('INSERT INTO klassen (id, schuljahr_id, name, notenschluessel, spa_bildungsgang) VALUES (1, 1, ?, ?, ?)')
  .run('13SPA1', 'SPA', 'SPA_PIA');
db.prepare('INSERT INTO klassen (id, schuljahr_id, name, notenschluessel, spa_bildungsgang) VALUES (2, 1, ?, ?, ?)')
  .run('13SPA2', 'SPA', 'SPA_REGULAR');

db.prepare('INSERT INTO schueler (id, klasse_id, nachname, vorname) VALUES (1, 1, ?, ?)').run('Musterfrau', 'Maxi');
db.prepare('INSERT INTO schueler (id, klasse_id, nachname, vorname) VALUES (2, 2, ?, ?)').run('Beispiel', 'Bea');

function legeFachAn(id, klasseId, name, spaFachKey) {
  db.prepare('INSERT INTO faecher (id, klasse_id, name, spa_fach_key) VALUES (?, ?, ?, ?)')
    .run(id, klasseId, name, spaFachKey);
  db.prepare('INSERT INTO fach_teilnehmer (fach_id, schueler_id) VALUES (?, ?)')
    .run(id, klasseId === 1 ? 1 : 2);
}

// Klasse 1 (SPA_PIA): LF1 (direkt/fortlaufend_50_50), LF2 (komponenten),
// Praxis + Blockpraxis (externerWert), Englisch (FHR-Prüfung), WPK (Mittelwert).
legeFachAn(1, 1, 'Lernfeld 1', 'LF1');
legeFachAn(2, 1, 'Lernfeld 2', 'LF2');
legeFachAn(3, 1, 'Praxis', 'PRAXIS');
legeFachAn(4, 1, 'Blockpraxis', 'BLOCKPRAXIS');
legeFachAn(5, 1, 'Englisch', 'ENGLISCH');
legeFachAn(6, 1, 'Wahlpflichtkurs', 'WPK');

// Klasse 2 (SPA_REGULAR): eigenes LF1, um Bildungsgang-Trennung zu prüfen.
legeFachAn(7, 2, 'Lernfeld 1', 'LF1');

function setzeDirekt(fachId, schuelerId, halbjahr, direktwert, extra = {}) {
  db.prepare(`
    INSERT INTO spa_eingaben (fach_id, schueler_id, halbjahr, direktwert, ist_na, pruefungswert, importierte_endnote)
    VALUES (@fachId, @schuelerId, @halbjahr, @direktwert, @istNa, @pruefungswert, @importierteEndnote)
  `).run({
    fachId, schuelerId, halbjahr, direktwert,
    istNa: extra.istNa ? 1 : 0,
    pruefungswert: extra.pruefungswert ?? null,
    importierteEndnote: extra.importierteEndnote ?? null,
  });
}

function setzeKomponente(fachId, schuelerId, halbjahr, schluessel, punkte) {
  db.prepare(`
    INSERT INTO spa_komponenten_noten (fach_id, schueler_id, halbjahr, komponente_schluessel, punkte)
    VALUES (?, ?, ?, ?, ?)
  `).run(fachId, schuelerId, halbjahr, schluessel, punkte);
}

test('LF1 (direkt, fortlaufend_50_50): 1./2. Hj. eingetragen -> 2. Hj. = 50/50-Kumulation', () => {
  setzeDirekt(1, 1, 1, 10);
  setzeDirekt(1, 1, 2, 12);
  const erg = berechneFachFuerSchueler(db, 1, 1);
  assert.equal(erg.length, 4);
  assert.equal(erg[0].endpunkte, 10);
  assert.equal(erg[1].endpunkte, 0.5 * 10 + 0.5 * 12);
  assert.equal(erg[1].tendenz, '2'); // 11 Punkte
});

test('LF2 (komponenten_gewichtet): Komponentenwerte aus der DB korrekt gewichtet', () => {
  // LF2-Komponenten (spa-schema.js): gesundheit 40%, erziehung 30%, entwicklung 30% -- alles feste Gewichte.
  setzeKomponente(2, 1, 1, 'gesundheit', 15);
  setzeKomponente(2, 1, 1, 'erziehung', 10);
  setzeKomponente(2, 1, 1, 'entwicklung', 10);
  const erg = berechneFachFuerSchueler(db, 2, 1);
  const hj1 = erg.find((e) => e.halbjahr === 1);
  assert.equal(hj1.zwischennote, 0.4 * 15 + 0.3 * 10 + 0.3 * 10);
  assert.equal(hj1.endpunkte, hj1.zwischennote); // 1. Hj. hat keinen Vorgänger
});

test('Praxis PiA 4. Hj. bezieht externerWert aus Blockpraxis 3. Hj. (fachübergreifend)', () => {
  setzeDirekt(3, 1, 2, 12); // Praxis 2. Hj.
  setzeDirekt(4, 1, 3, 9); // Blockpraxis 3. Hj.
  setzeDirekt(3, 1, 4, 13); // Praxis 4. Hj. (Zwischennote)
  const erg = berechneFachFuerSchueler(db, 3, 1);
  const hj4 = erg.find((e) => e.halbjahr === 4);
  assert.equal(hj4.endpunkte, 0.7 * 13 + 0.3 * 9);
});

test('Englisch 4. Hj. (FHR): Prüfungsnote fließt zu 40 % als externerWert ein', () => {
  setzeDirekt(5, 1, 3, 11); // Vorgänger-Halbjahr (klassischer Modus bei 1.-3. Hj.)
  setzeDirekt(5, 1, 4, 10, { pruefungswert: 14 }); // Vornote 10, Prüfung 14
  const erg = berechneFachFuerSchueler(db, 5, 1);
  const hj4 = erg.find((e) => e.halbjahr === 4);
  assert.equal(hj4.endpunkte, 0.6 * 10 + 0.4 * 14);
});

test('WPK: Zeugnisnote 2. Hj. ist Mittelwert aus 1./2. Hj.', () => {
  setzeDirekt(6, 1, 1, 8);
  setzeDirekt(6, 1, 2, 12);
  const erg = berechneFachFuerSchueler(db, 6, 1);
  const hj2 = erg.find((e) => e.halbjahr === 2);
  assert.equal(hj2.endpunkte, (8 + 12) / 2);
});

test('Bildungsgang-Trennung: SPA_REGULAR-Klasse bekommt kein Blockpraxis, LF1 rechnet unabhängig', () => {
  setzeDirekt(7, 2, 1, 5);
  const erg = berechneFachFuerSchueler(db, 7, 2);
  assert.equal(erg.length, 4);
  assert.equal(erg[0].endpunkte, 5);
  // Kein Blockpraxis-Fach in Klasse 2 -- Fach existiert nicht, kein Crash.
  assert.equal(db.prepare("SELECT id FROM faecher WHERE klasse_id = 2 AND spa_fach_key = 'BLOCKPRAXIS'").get(), undefined);
});

test('berechneFachFuerSchueler liefert [] für Nicht-SPA-Fach oder unbekannte ID', () => {
  db.prepare('INSERT INTO faecher (id, klasse_id, name) VALUES (99, 1, ?)').run('Normales Fach');
  assert.deepEqual(berechneFachFuerSchueler(db, 99, 1), []);
  assert.deepEqual(berechneFachFuerSchueler(db, 12345, 1), []);
});

test('vorwerteFuer: LF1 2. Hj. zeigt Endnote 1. Hj. mit korrektem Label', () => {
  const info = vorwerteFuer(db, 1, 'LF1', 2);
  assert.equal(info.label, 'Endnote 1. Hj. — fließt zu 50 % ein');
  assert.equal(info.werte.length, 1);
  assert.equal(info.werte[0].schuelerId, 1);
  assert.equal(info.werte[0].endpunkte, 10); // 1. Hj.-Endnote von LF1 oben
});

test('vorwerteFuer: Praxis 4. Hj. zeigt Blockpraxis 3. Hj. mit 30 %-Label', () => {
  const info = vorwerteFuer(db, 1, 'PRAXIS', 4);
  assert.ok(info.label.startsWith('Blockpraxis 3. Hj.'));
  assert.ok(info.label.includes('30 %'));
  assert.equal(info.werte[0].endpunkte, 9); // Blockpraxis-Wert von oben
});

test('vorwerteFuer: WPK 2. Hj. zeigt 1. Hj. als Mittelwerts-Partner', () => {
  const info = vorwerteFuer(db, 1, 'WPK', 2);
  assert.equal(info.label, '1. Hj. — Mittelwert mit diesem Halbjahr');
  assert.equal(info.werte[0].endpunkte, 8);
});

test('vorwerteFuer: 1. Hj. (kein Vorgänger) liefert leeres Ergebnis', () => {
  assert.deepEqual(vorwerteFuer(db, 1, 'LF1', 1), { label: null, werte: [] });
});

test('ladeEingabeAnzeige: Direktwert-Fach liefert Rohwerte ohne Komponenten', () => {
  const schema = spaSchemaFuer('LF1', 'SPA_PIA').find((s) => s.halbjahr === 1);
  const eingabe = ladeEingabeAnzeige(db, 1, 1, 1, schema);
  assert.equal(eingabe.direktwert, 10);
  assert.equal(eingabe.istNa, false);
  assert.equal(eingabe.komponenten, null);
});

test('ladeEingabeAnzeige: Komponenten-Fach liefert alle Schema-Komponenten (unbelegte als null)', () => {
  const schema = spaSchemaFuer('LF2', 'SPA_PIA').find((s) => s.halbjahr === 1);
  const eingabe = ladeEingabeAnzeige(db, 2, 1, 1, schema);
  assert.deepEqual(eingabe.komponenten, { gesundheit: 15, erziehung: 10, entwicklung: 10 });
});

test('ladeEingabeAnzeige: Prüfungswert einer FHR-Note wird mitgeliefert', () => {
  const schema = spaSchemaFuer('ENGLISCH', 'SPA_PIA').find((s) => s.halbjahr === 4);
  const eingabe = ladeEingabeAnzeige(db, 5, 1, 4, schema);
  assert.equal(eingabe.direktwert, 10);
  assert.equal(eingabe.pruefungswert, 14);
});

test('ladeEingabeAnzeige: fehlende Zeile liefert lauter null statt Fehler', () => {
  const schema = spaSchemaFuer('LF1', 'SPA_PIA').find((s) => s.halbjahr === 3);
  const eingabe = ladeEingabeAnzeige(db, 1, 1, 3, schema);
  assert.deepEqual(eingabe, { direktwert: null, pruefungswert: null, importierteEndnote: null, istNa: false, komponenten: null });
});

test('zeugnisFuerKlasse: 2. Hj. zeigt nur die vorhandenen, für dieses Halbjahr aktiven Fächer in fester Reihenfolge', () => {
  const zeilen = zeugnisFuerKlasse(db, 1, 2);
  assert.equal(zeilen.length, 1);
  const zeile = zeilen[0];
  // Klasse 1 hat nur LF1/LF2/PRAXIS/BLOCKPRAXIS/ENGLISCH/WPK angelegt (siehe oben) --
  // Blockpraxis ist im 2. Hj. nicht aktiv, alle anderen fünf schon.
  assert.deepEqual(zeile.faecher.map((f) => f.fach), ['LF1', 'LF2', 'PRAXIS', 'ENGLISCH', 'WPK']);

  assert.equal(zeile.faecher.find((f) => f.fach === 'LF1').endpunkte, 11); // 0,5*10 + 0,5*12
  assert.equal(zeile.faecher.find((f) => f.fach === 'LF1').tendenz, '2');
  assert.equal(zeile.faecher.find((f) => f.fach === 'LF2').endpunkte, null); // im 2. Hj. nichts eingetragen
  assert.equal(zeile.faecher.find((f) => f.fach === 'PRAXIS').endpunkte, 12);
  assert.equal(zeile.faecher.find((f) => f.fach === 'ENGLISCH').endpunkte, null); // erst ab 3. Hj. Werte

  const wpk = zeile.faecher.find((f) => f.fach === 'WPK');
  assert.equal(wpk.endpunkte, 10); // Ø(8, 12)
  assert.equal(wpk.tendenz, '2,0'); // Komma-Note statt Tendenz (kommaNote-Schema-Flag)
});

test('zeugnisFuerKlasse: 4. Hj. liefert das Abschlusszeugnis mit Mehrfachpositionen, Hochziehen und Prüfungsblock', () => {
  const zeilen = zeugnisFuerKlasse(db, 1, 4);
  assert.equal(zeilen.length, 1);
  const zeile = zeilen[0];

  // Praxis erscheint zweimal (2./4. Hj., eigene Positionen), alle anderen einmal.
  assert.deepEqual(
    zeile.faecher.map((f) => f.fach),
    ['LF1:4', 'LF2:4', 'PRAXIS:2', 'PRAXIS:4', 'BLOCKPRAXIS:3', 'ENGLISCH:4', 'WPK:2'],
  );

  // LF1/LF2 haben im 4. Hj. selbst keinen Wert -- Einzelposition, also wird
  // die letzte vorhandene Note hochgezogen (LF1: 2. Hj. = 11, LF2: 1. Hj. = 12).
  const lf1 = zeile.faecher.find((f) => f.fach === 'LF1:4');
  assert.equal(lf1.label, 'Lernfeld 1');
  assert.equal(lf1.endpunkte, 11);
  const lf2 = zeile.faecher.find((f) => f.fach === 'LF2:4');
  assert.equal(lf2.endpunkte, 12);

  // Praxis: zwei eigene, unveränderte Positionen (keine Hochzieh-Logik bei Mehrfachpositionen).
  const praxis2 = zeile.faecher.find((f) => f.fach === 'PRAXIS:2');
  assert.equal(praxis2.label, 'Praxis (2. Hj.)');
  assert.equal(praxis2.endpunkte, 12);
  const praxis4 = zeile.faecher.find((f) => f.fach === 'PRAXIS:4');
  assert.equal(praxis4.label, 'Praxis (4. Hj.)');
  assert.equal(praxis4.endpunkte, 0.7 * 13 + 0.3 * 9);

  const englisch = zeile.faecher.find((f) => f.fach === 'ENGLISCH:4');
  assert.equal(englisch.endpunkte, 0.6 * 10 + 0.4 * 14);

  const wpk = zeile.faecher.find((f) => f.fach === 'WPK:2');
  assert.equal(wpk.tendenz, '2,0');

  // Prüfungsblock: LF2 (eigenständig, nichts eingetragen) + Englisch-FHR (14 Punkte).
  assert.deepEqual(zeile.pruefungen.map((p) => p.fach), ['PRUEF:LF2:4', 'PRUEF:ENGLISCH:4']);
  assert.equal(zeile.pruefungen.find((p) => p.fach === 'PRUEF:LF2:4').endpunkte, null);
  const pruefEnglisch = zeile.pruefungen.find((p) => p.fach === 'PRUEF:ENGLISCH:4');
  assert.equal(pruefEnglisch.label, 'Englisch-FHR');
  assert.equal(pruefEnglisch.endpunkte, 14);
  assert.equal(pruefEnglisch.tendenz, '1');
});

test('zeugnisFuerKlasse: unbekannte/nicht-SPA-Klasse liefert leere Liste statt Fehler', () => {
  assert.deepEqual(zeugnisFuerKlasse(db, 999, 1), []);
});
