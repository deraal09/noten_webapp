/**
 * Sanity-Checks für die feste SPA-Bewertungskonfiguration (src/spa-schema.js) --
 * kein Rechen-Test (das deckt spa-grade-calc.test.js ab), sondern Kontrolle,
 * dass die Konfiguration selbst vollständig und in sich konsistent ist.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spaSchemaFuer, spaFaecherFuerBildungsgang, SPA_FAECHER, WPK_KURSE } from '../src/spa-schema.js';

test('Jedes Fach hat für beide Bildungsgänge (wo anwendbar) genau 4 Halbjahres-Einträge', () => {
  for (const f of SPA_FAECHER) {
    if (f.schluessel === 'BLOCKPRAXIS') continue; // Sonderfall: nur 3. Hj., eigener Test unten
    for (const bg of ['SPA_REGULAR', 'SPA_PIA']) {
      const schema = spaSchemaFuer(f.schluessel, bg);
      if (schema.length === 0) continue; // z. B. Praxis-Sonderfaelle
      assert.equal(schema.length, 4, `${f.schluessel}/${bg} sollte 4 Halbjahre haben`);
      assert.deepEqual(schema.map((s) => s.halbjahr).sort(), [1, 2, 3, 4]);
    }
  }
});

test('Blockpraxis existiert nur bei SPA_PIA (nur 3. Hj.)', () => {
  assert.equal(spaSchemaFuer('BLOCKPRAXIS', 'SPA_REGULAR').length, 0);
  const pia = spaSchemaFuer('BLOCKPRAXIS', 'SPA_PIA');
  assert.equal(pia.length, 1);
  assert.equal(pia[0].halbjahr, 3);
});

test('Praxis PiA: nur 2./4. Hj. aktiv, 4. Hj. verrechnet mit Blockpraxis 3. Hj.', () => {
  const schema = spaSchemaFuer('PRAXIS', 'SPA_PIA');
  const aktive = schema.filter((s) => s.aktiv).map((s) => s.halbjahr);
  assert.deepEqual(aktive, [2, 4]);
  const hj4 = schema.find((s) => s.halbjahr === 4);
  assert.equal(hj4.externFach, 'BLOCKPRAXIS');
  assert.equal(hj4.externHalbjahr, 3);
  assert.equal(hj4.gewichtAktuell, 0.7);
  assert.equal(hj4.gewichtExtern, 0.3);
});

test('Praxis regulaer: nur 2./3. Hj. aktiv, keine Verrechnung', () => {
  const schema = spaSchemaFuer('PRAXIS', 'SPA_REGULAR');
  const aktive = schema.filter((s) => s.aktiv).map((s) => s.halbjahr);
  assert.deepEqual(aktive, [2, 3]);
  assert.ok(schema.every((s) => s.kumulationModus === 'keine'));
});

test('LF3-Komponenten je Halbjahr: 1./4. Hj. ohne Bericht, 2./3. Hj. mit Bericht', () => {
  const schema = spaSchemaFuer('LF3', 'SPA_REGULAR');
  for (const hj of [1, 4]) {
    const s = schema.find((x) => x.halbjahr === hj);
    assert.ok(!s.komponenten.some((k) => k.schluessel === 'bericht'), `Hj ${hj} sollte kein Bericht haben`);
    assert.equal(s.komponenten.find((k) => k.schluessel === 'paedagogik').gewichtFix, 0.4);
  }
  for (const hj of [2, 3]) {
    const s = schema.find((x) => x.halbjahr === hj);
    assert.ok(s.komponenten.some((k) => k.schluessel === 'bericht'), `Hj ${hj} sollte Bericht haben`);
    assert.equal(s.komponenten.find((k) => k.schluessel === 'paedagogik').gewichtFix, 0.2);
    assert.equal(s.komponenten.find((k) => k.schluessel === 'bericht').gewichtFix, 0.2);
  }
});

test('LF4 ist nur bei SPA_PIA deaktivierbar (n/a-Schalter)', () => {
  assert.ok(spaSchemaFuer('LF4', 'SPA_PIA').every((s) => s.deaktivierbar));
  assert.ok(spaSchemaFuer('LF4', 'SPA_REGULAR').every((s) => !s.deaktivierbar));
});

test('Englisch/Mathematik 4. Hj.: FHR-Pruefung verrechnet zu 40 %, andere Faecher nicht', () => {
  for (const fach of ['ENGLISCH', 'MATHEMATIK']) {
    const hj4 = spaSchemaFuer(fach, 'SPA_REGULAR').find((s) => s.halbjahr === 4);
    assert.equal(hj4.pruefungVerrechnen, true);
    assert.equal(hj4.kumulationModus, 'gewichtet_vorgaenger');
    assert.equal(hj4.gewichtAktuell, 0.6);
    assert.equal(hj4.gewichtExtern, 0.4);
  }
  for (const fach of ['WIPO', 'RELIGION']) {
    const hj4 = spaSchemaFuer(fach, 'SPA_REGULAR').find((s) => s.halbjahr === 4);
    assert.ok(!hj4.pruefungVerrechnen);
    assert.equal(hj4.kumulationModus, 'keine');
  }
  const deutsch4 = spaSchemaFuer('DEUTSCH', 'SPA_REGULAR').find((s) => s.halbjahr === 4);
  assert.equal(deutsch4.pruefung, true);
  assert.ok(!deutsch4.pruefungVerrechnen);
});

test('WPK: nur 1./2. Hj. aktiv, 2. Hj. mittelt beide, Komma-Note', () => {
  const schema = spaSchemaFuer('WPK', 'SPA_REGULAR');
  assert.deepEqual(schema.filter((s) => s.aktiv).map((s) => s.halbjahr), [1, 2]);
  const hj2 = schema.find((s) => s.halbjahr === 2);
  assert.deepEqual(hj2.mittelwertHalbjahre, [1, 2]);
  assert.ok(schema.every((s) => s.kommaNote));
  assert.ok(WPK_KURSE.length > 0);
});

test('spaFaecherFuerBildungsgang: SPA_REGULAR hat kein Blockpraxis, SPA_PIA schon', () => {
  const regulaer = spaFaecherFuerBildungsgang('SPA_REGULAR').map((f) => f.schluessel);
  const pia = spaFaecherFuerBildungsgang('SPA_PIA').map((f) => f.schluessel);
  assert.ok(!regulaer.includes('BLOCKPRAXIS'));
  assert.ok(pia.includes('BLOCKPRAXIS'));
  for (const key of ['LF1', 'LF2', 'LF3', 'LF4', 'PRAXIS', 'DEUTSCH', 'ENGLISCH', 'WIPO', 'RELIGION', 'MATHEMATIK', 'WPK']) {
    assert.ok(regulaer.includes(key), `SPA_REGULAR sollte ${key} enthalten`);
    assert.ok(pia.includes(key), `SPA_PIA sollte ${key} enthalten`);
  }
});
