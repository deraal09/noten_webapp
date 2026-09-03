/**
 * Notenberechnung – 1:1 portiert aus src/grade_calc.py.
 * Test-Suite deckt gleiche Szenarien ab wie der Python-Smoketest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nsCsvParse, nsCsvLookup, noteAusPunkten, gesamtnoteHj, teilNote,
  gesamtnoteJahr, autoDistribute, nichtBestanden, formatNote, DEFAULT_NS_CSV,
  unterrichtsleistungNote,
} from '../src/grade-calc.js';

const IHK_CSV = DEFAULT_NS_CSV.IHK;
const BG_CSV = DEFAULT_NS_CSV.BG;

test('nsCsvParse liefert korrekte Anzahl und Reihenfolge', () => {
  const entries = nsCsvParse('100,1;50,4;0,6');
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], [100, 1]);
  assert.deepEqual(entries[2], [0, 6]);
});

test('nsCsvLookup: 100 % → 1, 50 % → 4,4, 0 % → 6', () => {
  assert.equal(nsCsvLookup(100, IHK_CSV), 1);
  // Die IHK-Tabelle bildet 50 % auf 4,4 ab (Eintrag "50,4.4").
  assert.equal(nsCsvLookup(50, IHK_CSV), 4.4);
  assert.equal(nsCsvLookup(0, IHK_CSV), 6);
});

test('nsCsvLookup: 95 % → 1,3 (Ihk-Granularität)', () => {
  assert.equal(nsCsvLookup(95, IHK_CSV), 1.3);
});

test('nsCsvLookup: BG 95 % → 15, 50 % → 6', () => {
  assert.equal(nsCsvLookup(95, BG_CSV), 15);
  assert.equal(nsCsvLookup(50, BG_CSV), 6);
  assert.equal(nsCsvLookup(0, BG_CSV), 0);
});

test('noteAusPunkten: 18/20 → sehr gut', () => {
  const punkte = [9, 9];
  const maxArr = [10, 10];
  // 90 % → 1,6
  assert.equal(noteAusPunkten(punkte, maxArr, IHK_CSV), 1.6);
});

test('noteAusPunkten: 12/20 → 3,2', () => {
  const punkte = [6, 6];
  const maxArr = [10, 10];
  // 60 % → 3,9
  assert.equal(noteAusPunkten(punkte, maxArr, IHK_CSV), 3.9);
});

test('noteAusPunkten: 9/20 → 4,4', () => {
  const punkte = [5, 4];
  const maxArr = [10, 10];
  // 45 % → 4,7
  assert.equal(noteAusPunkten(punkte, maxArr, IHK_CSV), 4.7);
});

test('noteAusPunkten: null-Werte → null', () => {
  const punkte = [5, null];
  const maxArr = [10, 10];
  assert.equal(noteAusPunkten(punkte, maxArr, IHK_CSV), null);
});

test('noteAusPunkten: leerer Punkte-Array → null', () => {
  assert.equal(noteAusPunkten([], [10], IHK_CSV), null);
});

test('gesamtnoteHj: 60/40 mündlich, 2 ULs gleich gewichtet, 1 Klausur', () => {
  // 60 % mündlich, 40 % schriftlich
  // UL1 = 2 (30 %), UL2 = 3 (30 %), Klausur = 2 (40 %)
  // 2*0.3 + 3*0.3 + 2*0.4 = 0.6 + 0.9 + 0.8 = 2.3
  const klausuren = [{ note: 2, gewichtung: 40 }];
  const uls = [{ note: 2, gewichtung: 30 }, { note: 3, gewichtung: 30 }];
  assert.equal(gesamtnoteHj(40, 60, klausuren, uls, IHK_CSV), 2.3);
});

test('gesamtnoteHj: alle null → null', () => {
  const klausuren = [{ note: null, gewichtung: 40 }];
  const uls = [{ note: null, gewichtung: 60 }];
  assert.equal(gesamtnoteHj(40, 60, klausuren, uls, IHK_CSV), null);
});

test('gesamtnoteHj: keine Klausurnoten vorhanden → Unterrichtsleistung zählt 100 %', () => {
  // Noch keine Klausur benotet (oder gar keine angelegt): der nominale
  // schriftliche Anteil (40 %) darf die Gesamtnote nicht verwässern —
  // sie muss der vollen, gewichteten UL-Note entsprechen.
  const klausuren = [];
  const uls = [{ note: 2, gewichtung: 30 }, { note: 3, gewichtung: 30 }];
  assert.equal(gesamtnoteHj(40, 60, klausuren, uls, IHK_CSV), teilNote(uls));
});

test('gesamtnoteHj: nur eine Klausurnote, keine UL-Note → Klausurnote zählt 100 %', () => {
  const klausuren = [{ note: 3, gewichtung: 40 }];
  const uls = [{ note: null, gewichtung: 60 }]; // UL angelegt, aber noch nicht benotet
  assert.equal(gesamtnoteHj(40, 60, klausuren, uls, IHK_CSV), 3);
});

test('gesamtnoteHj: von zwei Klausuren nur eine benotet → zählt allein für den schriftlichen Anteil', () => {
  const klausuren = [{ note: 2, gewichtung: 20 }, { note: null, gewichtung: 20 }];
  const uls = [{ note: 4, gewichtung: 60 }];
  // Schriftlicher Anteil: nur K1 vorhanden → zählt zu 100 % des
  // schriftlichen Anteils (nicht nur zu ihrem nominalen 20-%-Teilgewicht).
  // Gesamt: 2*0,4 + 4*0,6 = 0,8 + 2,4 = 3,2
  assert.equal(gesamtnoteHj(40, 60, klausuren, uls, IHK_CSV), 3.2);
});

test('gesamtnoteJahr: Mittelwert beider Halbjahre', () => {
  assert.equal(gesamtnoteJahr([2, 3]), 2.5);
  assert.equal(gesamtnoteJahr([1, 1]), 1);
  assert.equal(gesamtnoteJahr([null, 3]), 3);
  assert.equal(gesamtnoteJahr([null, null]), null);
});

test('autoDistribute: gleichmäßige Verteilung', () => {
  const w = autoDistribute(3, 60);
  assert.equal(w.length, 3);
  assert.equal(w.reduce((a, b) => a + b, 0), 60);
});

test('autoDistribute: 4 Items, 60 %', () => {
  const w = autoDistribute(4, 60);
  assert.equal(w.length, 4);
  // Jeder bekommt 15 (kann 14.9 + 15 + 15 + 15.1 sein)
  assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 60) < 0.001);
});

test('nichtBestanden: IHK > 4,5 ist 5 oder 6', () => {
  assert.equal(nichtBestanden(5, 'IHK'), true);
  assert.equal(nichtBestanden(6, 'IHK'), true);
  assert.equal(nichtBestanden(4, 'IHK'), false);
  assert.equal(nichtBestanden(4.4, 'IHK'), false);
  assert.equal(nichtBestanden(null, 'IHK'), false);
});

test('nichtBestanden: BG < 4 ist 0-3', () => {
  assert.equal(nichtBestanden(3, 'BG'), true);
  assert.equal(nichtBestanden(0, 'BG'), true);
  assert.equal(nichtBestanden(4, 'BG'), false);
  assert.equal(nichtBestanden(15, 'BG'), false);
});

test('formatNote: mit Komma statt Punkt', () => {
  assert.equal(formatNote(2.5), '2,5');
  assert.equal(formatNote(null), '—');
  assert.equal(formatNote(1), '1,0');
});

test('teilNote: gewichteter Durchschnitt einer einzelnen Gruppe (z. B. nur Klausuren)', () => {
  assert.equal(teilNote([{ note: 2, gewichtung: 50 }, { note: 4, gewichtung: 50 }]), 3);
  // Ungleiche Gewichtung normalisiert sich innerhalb der Gruppe (nicht auf 100 der Gesamtnote).
  assert.equal(teilNote([{ note: 1, gewichtung: 75 }, { note: 5, gewichtung: 25 }]), 2);
});

test('teilNote: fehlende/ungewichtete Einträge werden ignoriert, leer → null', () => {
  assert.equal(teilNote([{ note: null, gewichtung: 50 }, { note: 3, gewichtung: 50 }]), 3);
  assert.equal(teilNote([{ note: 2, gewichtung: 0 }]), null);
  assert.equal(teilNote([]), null);
});

test('unterrichtsleistungNote: nur Datumstabelle (keine Zusatzleistungen) → Durchschnitt zählt zu 100 %', () => {
  const { datumsDurchschnitt, note } = unterrichtsleistungNote([2, 3, 4], []);
  assert.equal(datumsDurchschnitt, 3);
  assert.equal(note, 3);
});

test('unterrichtsleistungNote: Beispiel aus der Anforderung (60 % Unterrichtsleistung, Präsentation 10 %)', () => {
  // Datumstabelle-Ø 2, Präsentation-Note 4 mit 10 % Anteil an der
  // Unterrichtsleistung -> Rest (90 %) entfällt auf die Datumstabelle.
  // 2*0.9 + 4*0.1 = 1.8 + 0.4 = 2.2
  const { datumsDurchschnitt, note } = unterrichtsleistungNote([2, 2], [{ note: 4, gewichtung: 10 }]);
  assert.equal(datumsDurchschnitt, 2);
  assert.equal(note, 2.2);
});

test('unterrichtsleistungNote: keine Datumstabelle, nur Zusatzleistungen → diese zählen zu 100 % (untereinander normiert)', () => {
  const { datumsDurchschnitt, note } = unterrichtsleistungNote([], [{ note: 2, gewichtung: 50 }, { note: 4, gewichtung: 50 }]);
  assert.equal(datumsDurchschnitt, null);
  assert.equal(note, 3);
});

test('unterrichtsleistungNote: weder Datumstabelle noch benotete Zusatzleistungen → null', () => {
  const { datumsDurchschnitt, note } = unterrichtsleistungNote([], [{ note: null, gewichtung: 10 }]);
  assert.equal(datumsDurchschnitt, null);
  assert.equal(note, null);
});

test('unterrichtsleistungNote: Zusatzleistungen ohne Gewichtung (0) zählen nicht mit', () => {
  const { note } = unterrichtsleistungNote([2, 2], [{ note: 6, gewichtung: 0 }]);
  assert.equal(note, 2, 'ungewichtete Zusatzleistung darf die Datumstabelle nicht verwässern');
});

test('unterrichtsleistungNote: Summe der Zusatzleistungs-Gewichtungen über 100 % → Rest für Datumstabelle wird auf 0 begrenzt', () => {
  const { note } = unterrichtsleistungNote([1, 1], [{ note: 5, gewichtung: 60 }, { note: 3, gewichtung: 60 }]);
  // Rest = max(0, 100-120) = 0 -> Datumstabelle zählt nicht mit, nur die
  // beiden Zusatzleistungen (untereinander normiert auf ihre 60/60).
  assert.equal(note, 4);
});
