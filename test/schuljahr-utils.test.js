/**
 * Erkennung/Sortierung von Schuljahr-Bezeichnungen (src/schuljahr-utils.js).
 * Format ist immer "YYYY/YY", wobei die zweite Zahl (YYYY + 1) modulo 100
 * entspricht — wichtig, damit ein nachträglich erfasstes, vergangenes
 * Schuljahr nie als "aktuell" oder "nächstes" erscheint, nur weil es
 * zuletzt angelegt wurde.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSchuljahr, istGueltigesSchuljahrFormat, baueSchuljahrBezeichnung,
  sortiereSchuljahreAbsteigend, aktuellesStartjahr,
} from '../src/schuljahr-utils.js';

test('parseSchuljahr: erkennt gültige Bezeichnungen und ihr Startjahr', () => {
  assert.deepEqual(parseSchuljahr('2025/26'), { startJahr: 2025 });
  assert.deepEqual(parseSchuljahr('2099/00'), { startJahr: 2099 }); // Jahrhundertwechsel
  assert.deepEqual(parseSchuljahr('  2030/31  '), { startJahr: 2030 });
});

test('parseSchuljahr: lehnt falsches Format oder falsche Endziffern ab', () => {
  assert.equal(parseSchuljahr('2025/27'), null, 'Endziffern passen nicht zu Startjahr + 1');
  assert.equal(parseSchuljahr('2025/2026'), null, 'vierstellige Endziffern statt zweistellig');
  assert.equal(parseSchuljahr('25/26'), null, 'Startjahr muss vierstellig sein');
  assert.equal(parseSchuljahr('2025-26'), null, 'falscher Trenner');
  assert.equal(parseSchuljahr('Schuljahr 2025/26'), null, 'zusätzlicher Text nicht erlaubt');
  assert.equal(parseSchuljahr(''), null);
  assert.equal(parseSchuljahr(null), null);
});

test('istGueltigesSchuljahrFormat: kurze Wahr/Falsch-Prüfung', () => {
  assert.equal(istGueltigesSchuljahrFormat('2025/26'), true);
  assert.equal(istGueltigesSchuljahrFormat('2025/99'), false);
});

test('baueSchuljahrBezeichnung: baut die korrekte Bezeichnung inkl. Jahrhundertwechsel', () => {
  assert.equal(baueSchuljahrBezeichnung(2025), '2025/26');
  assert.equal(baueSchuljahrBezeichnung(2099), '2099/00');
});

test('sortiereSchuljahreAbsteigend: sortiert nach echtem Startjahr, nicht nach Anlage-Reihenfolge', () => {
  // Absichtlich in "falscher"/gemischter Reihenfolge übergeben, wie es
  // entstünde, wenn ein vergangenes Schuljahr nachträglich (nach den
  // neueren) angelegt wird.
  const eingabe = [
    { id: 3, bezeichnung: '2025/26' },
    { id: 4, bezeichnung: '2022/23' }, // nachgetragen, höchste id, aber ältestes Jahr
    { id: 1, bezeichnung: '2024/25' },
    { id: 2, bezeichnung: '2023/24' },
  ];
  const sortiert = sortiereSchuljahreAbsteigend(eingabe).map((sj) => sj.bezeichnung);
  assert.deepEqual(sortiert, ['2025/26', '2024/25', '2023/24', '2022/23']);
});

test('sortiereSchuljahreAbsteigend: verändert die Eingabe nicht (neues Array)', () => {
  const eingabe = [{ bezeichnung: '2023/24' }, { bezeichnung: '2025/26' }];
  const kopie = [...eingabe];
  sortiereSchuljahreAbsteigend(eingabe);
  assert.deepEqual(eingabe, kopie);
});

test('aktuellesStartjahr: Schuljahr läuft August–Juli', () => {
  assert.equal(aktuellesStartjahr(new Date('2026-08-01T00:00:00')), 2026, 'ab August zählt das laufende Kalenderjahr');
  assert.equal(aktuellesStartjahr(new Date('2026-07-31T23:59:59')), 2025, 'im Juli noch das vorherige Schuljahr');
  assert.equal(aktuellesStartjahr(new Date('2026-01-15T00:00:00')), 2025);
});
