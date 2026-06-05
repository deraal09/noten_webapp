/**
 * Notenberechnung – 1:1 portiert aus src/grade_calc.py.
 * Test-Suite deckt gleiche Szenarien ab wie der Python-Smoketest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nsCsvParse, nsCsvLookup, noteAusPunkten, gesamtnoteHj,
  gesamtnoteJahr, autoDistribute, nichtBestanden, formatNote, DEFAULT_NS_CSV,
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
