/**
 * Golden-Master- und Verhaltenstests für den SPA-Rechenkern (src/spa-grade-calc.js),
 * 1:1 übernommen aus dclausen01/notentabellen-spa (packages/core/test/
 * engine.test.ts + golden.test.ts), damit der Port exakt dieselben Ergebnisse
 * liefert wie das Original (gegen die dort dokumentierten Excel-Daten
 * verifiziert, siehe Spec Kap. 9).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { berechneFach, berechneZwischennote, kaufmaennischRunden } from '../src/spa-grade-calc.js';

function direkt(halbjahr, kumulationModus, extra = {}) {
  return {
    halbjahr, aktiv: true, halbjahrModus: 'direkt', kumulationModus,
    deaktivierbar: false, komponenten: [], ...extra,
  };
}

test('Kumulation fortlaufend 50/50 (Spec 5.4, durchgerechnetes LF2-Beispiel)', () => {
  const schema = [1, 2, 3, 4].map((h) => direkt(h, 'fortlaufend_50_50'));
  const zw = [5.8, 9.0, 11.0, 12.0];
  const eingaben = zw.map((v, i) => ({ halbjahr: i + 1, istNa: false, direktwert: v }));
  const r = berechneFach({ schema, eingaben });
  assert.deepEqual(r.map((x) => x.endpunkte), [5.8, 7.4, 9.2, 10.6]);
  assert.deepEqual(r.map((x) => x.tendenz), ['4+', '3-', '3+', '2']);
});

test('LF3-Restverteilung: 3 aktive Rest-Komponenten -> je 0,2 (Excel-Fall)', () => {
  const schema = {
    halbjahr: 1, aktiv: true, halbjahrModus: 'komponenten_gewichtet', kumulationModus: 'keine',
    deaktivierbar: false,
    komponenten: [
      { schluessel: 'paed', gewichtFix: 0.4 },
      { schluessel: 'kunst', restAnteil: true },
      { schluessel: 'spiel', restAnteil: true },
      { schluessel: 'musik', restAnteil: true },
    ],
  };
  // 0.4*7 + 0.2*(8+4+9) = 2.8 + 4.2 = 7.0
  const zw = berechneZwischennote(schema, {
    halbjahr: 1, istNa: false, komponenten: { paed: 7, kunst: 8, spiel: 4, musik: 9 },
  });
  assert.ok(Math.abs(zw - 7.0) < 1e-9);
});

test('LF3-Restverteilung: eine Rest-Komponente n/a -> Restbudget 0,6 auf 2 -> je 0,3', () => {
  const schema = {
    halbjahr: 1, aktiv: true, halbjahrModus: 'komponenten_gewichtet', kumulationModus: 'keine',
    deaktivierbar: false,
    komponenten: [
      { schluessel: 'paed', gewichtFix: 0.4 },
      { schluessel: 'kunst', restAnteil: true },
      { schluessel: 'spiel', restAnteil: true },
      { schluessel: 'musik', restAnteil: true },
    ],
  };
  // 0.4*10 + 0.3*(10+10) = 4 + 6 = 10
  const zw = berechneZwischennote(schema, {
    halbjahr: 1, istNa: false, komponenten: { paed: 10, kunst: 10, spiel: 10, musik: null },
  });
  assert.ok(Math.abs(zw - 10.0) < 1e-9);
});

test('LF3-Restverteilung: feste Komponente (Päd.) selbst n/a -> Restbudget 1,0 auf 3', () => {
  const schema = {
    halbjahr: 1, aktiv: true, halbjahrModus: 'komponenten_gewichtet', kumulationModus: 'keine',
    deaktivierbar: false,
    komponenten: [
      { schluessel: 'paed', gewichtFix: 0.4 },
      { schluessel: 'kunst', restAnteil: true },
      { schluessel: 'spiel', restAnteil: true },
      { schluessel: 'musik', restAnteil: true },
    ],
  };
  const zw = berechneZwischennote(schema, {
    halbjahr: 1, istNa: false, komponenten: { paed: null, kunst: 10, spiel: 10, musik: 10 },
  });
  assert.ok(Math.abs(zw - 10.0) < 1e-9);
});

test('LF3-Restverteilung: zwei feste Komponenten, eine davon n/a -> Rest 0,8 auf 4', () => {
  const s2 = {
    halbjahr: 2, aktiv: true, halbjahrModus: 'komponenten_gewichtet', kumulationModus: 'keine',
    deaktivierbar: false,
    komponenten: [
      { schluessel: 'paed', gewichtFix: 0.2 },
      { schluessel: 'bericht', gewichtFix: 0.2 },
      { schluessel: 'bewegung', restAnteil: true },
      { schluessel: 'spiel', restAnteil: true },
      { schluessel: 'kunst', restAnteil: true },
      { schluessel: 'musik', restAnteil: true },
    ],
  };
  const zw = berechneZwischennote(s2, {
    halbjahr: 2, istNa: false,
    komponenten: { paed: 10, bericht: null, bewegung: 10, spiel: 10, kunst: 10, musik: 10 },
  });
  assert.ok(Math.abs(zw - 10.0) < 1e-9);
});

test('LF4: deaktivierbar, n/a-Halbjahre schreiben den Vorwert unveraendert fort', () => {
  const schema = [1, 2, 3, 4].map((h) => direkt(h, 'fortlaufend_50_50', { deaktivierbar: true }));
  const eingaben = [
    { halbjahr: 1, istNa: false, direktwert: 10 },
    { halbjahr: 2, istNa: true },
    { halbjahr: 3, istNa: false, direktwert: 14 },
    { halbjahr: 4, istNa: true },
  ];
  const r = berechneFach({ schema, eingaben });
  assert.equal(r[0].endpunkte, 10);
  assert.equal(r[1].endpunkte, 10);
  assert.equal(r[1].zwischennote, null);
  assert.equal(r[2].endpunkte, 12);
  assert.equal(r[3].endpunkte, 12);
  assert.equal(r[3].tendenz, '2+');
});

test('Praxis-Endnote PiA (externer Modus): 0,7*Praxis(4.) + 0,3*Blockpraxis(3.)', () => {
  const praxis4 = direkt(4, 'gewichtet_vorgaenger', { gewichtAktuell: 0.7, gewichtExtern: 0.3 });
  const r = berechneFach({
    schema: [praxis4],
    eingaben: [{ halbjahr: 4, istNa: false, direktwert: 15, externerWert: 10 }],
  });
  const hj4 = r.find((x) => x.halbjahr === 4);
  assert.ok(Math.abs(hj4.endpunkte - 13.5) < 1e-9);
  assert.equal(hj4.zwischennote, 15);
});

test('Praxis-Endnote PiA: ohne externen Wert zaehlt nur die aktuelle Note', () => {
  const praxis4 = direkt(4, 'gewichtet_vorgaenger', { gewichtAktuell: 0.7, gewichtExtern: 0.3 });
  const r = berechneFach({
    schema: [praxis4],
    eingaben: [{ halbjahr: 4, istNa: false, direktwert: 12, externerWert: null }],
  });
  assert.equal(r.find((x) => x.halbjahr === 4).endpunkte, 12);
});

test('WPK (mittelwert_halbjahre = Durchschnitt 1.+2. Hj.)', () => {
  const schema = [direkt(1, 'keine'), direkt(2, 'mittelwert_halbjahre', { mittelwertHalbjahre: [1, 2] })];
  const eingaben = [
    { halbjahr: 1, istNa: false, direktwert: 9 },
    { halbjahr: 2, istNa: false, direktwert: 7 },
  ];
  const r = berechneFach({ schema, eingaben });
  const hj2 = r.find((x) => x.halbjahr === 2);
  assert.ok(Math.abs(hj2.endpunkte - 8) < 1e-9);
  assert.equal(hj2.tendenz, '3');
});

test('Praxis regulaer: zwei separate Noten ohne Verrechnung', () => {
  const schema = [direkt(2, 'keine'), direkt(3, 'keine')];
  const eingaben = [
    { halbjahr: 2, istNa: false, direktwert: 11 },
    { halbjahr: 3, istNa: false, direktwert: 8 },
  ];
  const r = berechneFach({ schema, eingaben });
  assert.deepEqual(r.map((x) => x.endpunkte), [11, 8]);
  assert.deepEqual(r.map((x) => x.tendenz), ['2', '3']);
});

test('Inaktive Halbjahre liefern kein Ergebnis', () => {
  const schema = [
    { ...direkt(1, 'keine'), aktiv: false },
    direkt(2, 'keine'),
    direkt(3, 'keine'),
    { ...direkt(4, 'keine'), aktiv: false },
  ];
  const eingaben = [
    { halbjahr: 2, istNa: false, direktwert: 10 },
    { halbjahr: 3, istNa: false, direktwert: 12 },
  ];
  const r = berechneFach({ schema, eingaben });
  assert.deepEqual(r.map((x) => x.halbjahr), [2, 3]);
});

test('Kaufmaennische Rundung', () => {
  assert.equal(kaufmaennischRunden(9.5), 10);
  assert.equal(kaufmaennischRunden(5.5), 6);
  assert.equal(kaufmaennischRunden(5.4), 5);
});

test('Uebernommene Endnote (Import): ueberschreibt die Berechnung', () => {
  const schema = [1, 2, 3, 4].map((h) => direkt(h, 'fortlaufend_50_50'));
  const importierte = { 1: 7.4, 2: 8.3, 3: 8.35, 4: 6.875 };
  const eingaben = [1, 2, 3, 4].map((h) => ({
    halbjahr: h, istNa: false, direktwert: 15, importierteEndnote: importierte[h],
  }));
  const r = berechneFach({ schema, eingaben });
  assert.deepEqual(r.map((x) => x.endpunkte), [7.4, 8.3, 8.35, 6.875]);
  assert.deepEqual(r.map((x) => x.tendenz), ['3-', '3', '3', '3-']);
});

test('Uebernommene Endnote dient als Vorgaengerwert der 50/50-Kumulation', () => {
  const schema = [1, 2, 3, 4].map((h) => direkt(h, 'fortlaufend_50_50'));
  const eingaben = [
    { halbjahr: 1, istNa: false, importierteEndnote: 7.4 },
    { halbjahr: 2, istNa: false, importierteEndnote: 8.3 },
    { halbjahr: 3, istNa: false, importierteEndnote: 8.35 },
    { halbjahr: 4, istNa: false, direktwert: 5.4 },
  ];
  const r = berechneFach({ schema, eingaben });
  // 0,5*8,35 + 0,5*5,4 = 6,875
  assert.ok(Math.abs(r.find((x) => x.halbjahr === 4).endpunkte - 6.875) < 1e-8);
});

test('Uebernommene Endnote fliesst in mittelwert_halbjahre ein', () => {
  const schema = [
    direkt(1, 'keine', { aktiv: true }),
    direkt(2, 'mittelwert_halbjahre', { aktiv: true, mittelwertHalbjahre: [1, 2] }),
  ];
  const eingaben = [
    { halbjahr: 1, istNa: false, importierteEndnote: 9 },
    { halbjahr: 2, istNa: false, direktwert: 7 },
  ];
  const r = berechneFach({ schema, eingaben });
  assert.equal(r.find((x) => x.halbjahr === 2).endpunkte, 8);
});

// ---- Golden-Master (Spec Kap. 9): aus SPA_LF2/LF3_Berechnung.xlsx, Blatt "1. Hj." ----

test('Golden-Master LF2 1. Hj. (gewichtet 0.4/0.3/0.3)', () => {
  const schema = [{
    halbjahr: 1, aktiv: true, halbjahrModus: 'komponenten_gewichtet',
    kumulationModus: 'fortlaufend_50_50', deaktivierbar: false,
    komponenten: [
      { schluessel: 'gesundheit', gewichtFix: 0.4 },
      { schluessel: 'erziehung', gewichtFix: 0.3 },
      { schluessel: 'entwicklung', gewichtFix: 0.3 },
    ],
  }];
  const zeilen = [
    [7, 5, 5, 5.8, '4+'], [12, 8, 8, 9.6, '2-'], [8, 6, 6, 6.8, '3-'], [7, 6, 6, 6.4, '4+'],
    [12, 12, 12, 12.0, '2+'], [9, 4, 4, 6.0, '4+'], [11, 12, 12, 11.6, '2+'], [13, 10, 10, 11.2, '2'],
    [7, 5, 5, 5.8, '4+'], [9, 4, 4, 6.0, '4+'], [12, 7, 7, 9.0, '3+'], [11, 11, 11, 11.0, '2'],
    [4, 2, 2, 2.8, '5+'], [11, 12, 12, 11.6, '2+'], [7, 8, 8, 7.6, '3'], [9, 5, 5, 6.6, '3-'],
    [11, 14, 14, 12.8, '1-'], [9, 7, 7, 7.8, '3'], [11, 7, 7, 8.6, '3+'], [9, 9, 9, 9.0, '3+'],
    [10, 4, 4, 6.4, '4+'], [8, 8, 8, 8.0, '3'], [11, 9, 9, 9.8, '2-'], [9, 3, 3, 5.4, '4'],
    [9, 9, 9, 9.0, '3+'], [8, 10, 10, 9.2, '3+'], [8, 7, 7, 7.4, '3-'],
  ];
  for (const [gesundheit, erziehung, entwicklung, erwartetEndpunkte, erwartetTendenz] of zeilen) {
    const eingaben = [{ halbjahr: 1, istNa: false, komponenten: { gesundheit, erziehung, entwicklung } }];
    const [r] = berechneFach({ schema, eingaben });
    assert.ok(Math.abs(r.endpunkte - erwartetEndpunkte) < 1e-6, `endpunkte ${r.endpunkte} != ${erwartetEndpunkte}`);
    assert.equal(r.tendenz, erwartetTendenz);
  }
});

test('Golden-Master LF3 1. Hj. (Paed. fix 0.4, Rest 0.6 gleichmaessig)', () => {
  const schema = [{
    halbjahr: 1, aktiv: true, halbjahrModus: 'komponenten_gewichtet',
    kumulationModus: 'fortlaufend_50_50', deaktivierbar: false,
    komponenten: [
      { schluessel: 'paedagogik', gewichtFix: 0.4 },
      { schluessel: 'kunst', restAnteil: true },
      { schluessel: 'spiel', restAnteil: true },
      { schluessel: 'musik', restAnteil: true },
    ],
  }];
  const zeilen = [
    [7, 8, 4, 9, 7.0, '3-'], [5, 10, 10, 9, 7.8, '3'], [8, 13, 6, 10, 9.0, '3+'], [5, 11, 9, 9, 7.8, '3'],
    [12, 14, 10, 12, 12.0, '2+'], [4, 6, 6, 10, 6.0, '4+'], [12, 14, 10, 11, 11.8, '2+'], [14, 14, 12, 11, 13.0, '1-'],
    [8, 11, 6, 10, 8.6, '3+'], [6, 5, 8, 9, 6.8, '3-'], [11, 11, 10, 11, 10.8, '2'], [11, 14, 12, 11, 11.8, '2+'],
    [3, 8, 5, 7, 5.2, '4'], [9, 12, 11, 12, 10.6, '2'], [9, 12, 9, 10, 9.8, '2-'], [8, 11, 7, 11, 9.0, '3+'],
    [14, 14, 15, 12, 13.8, '1'], [5, 13, 9, 10, 8.4, '3'], [7, 8, 7, 9, 7.6, '3'], [10, 13, 11, 12, 11.2, '2'],
    [5, 5, 5, 9, 5.8, '4+'], [6, 8, 8, 5, 6.6, '3-'], [9, 10, 10, 10, 9.6, '2-'], [6, 8, 6, 11, 7.4, '3-'],
    [13, 14, 9, 13, 12.4, '2+'], [7, 10, 7, 10, 8.2, '3'], [8, 10, 11, 6, 8.6, '3+'],
  ];
  for (const [paedagogik, kunst, spiel, musik, erwartetEndpunkte, erwartetTendenz] of zeilen) {
    const eingaben = [{ halbjahr: 1, istNa: false, komponenten: { paedagogik, kunst, spiel, musik } }];
    const [r] = berechneFach({ schema, eingaben });
    assert.ok(Math.abs(r.endpunkte - erwartetEndpunkte) < 1e-6, `endpunkte ${r.endpunkte} != ${erwartetEndpunkte}`);
    assert.equal(r.tendenz, erwartetTendenz);
  }
});
