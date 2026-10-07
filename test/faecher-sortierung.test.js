/**
 * Sortierung der Fächer nach Halbjahren: Teilbereiche aufsteigend, Fächer in
 * allen Halbjahren und lückenhafte Angaben ganz unten, jeweils alphabetisch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PFAD = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-sortierung-')), 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-sortierung-test-bitte-lang-genug-xxxxxx';
process.env.NODE_ENV = 'test';

const { sortiereFaecher, halbjahrGruppe } = await import('../src/klassen-jahre.js');

const laufzeit = { anzahlHalbjahre: 6, halbjahre: [1, 2, 3, 4, 5, 6].map((n) => ({ nr: n })) };
const f = (name, halbjahre) => ({ name, halbjahre: halbjahre ? JSON.stringify(halbjahre) : null, klasse_id: 1 });

test('Teilbereiche aufsteigend, "alle Halbjahre" und inkonsistente Angaben unten', () => {
  const liste = [
    f('Zeichnen'), f('Bio', [3, 4]), f('Chemie', [1, 2]), f('Deutsch'), f('Physik', [1, 3]),
    f('Ethik', [1, 2, 3, 4, 5, 6]), f('Algebra', [1, 2]), f('Sport', [5, 6]), f('Kunst', [1, 2, 3]),
  ];
  assert.deepEqual(sortiereFaecher(liste, laufzeit).map((x) => x.name), [
    'Algebra', 'Chemie', // 1.–2. Hj.
    'Kunst', // 1.–3. Hj.
    'Bio', // 3.–4. Hj.
    'Sport', // 5.–6. Hj.
    'Deutsch', 'Ethik', 'Physik', 'Zeichnen', // alle bzw. inkonsistent (Physik 1+3), alphabetisch
  ]);
});

test('halbjahrGruppe: zusammenhängend = [von, bis], sonst null', () => {
  assert.deepEqual(halbjahrGruppe(f('A', [2, 3]), laufzeit), [2, 3]);
  assert.equal(halbjahrGruppe(f('A', [1, 3]), laufzeit), null);
  assert.equal(halbjahrGruppe(f('A'), laufzeit), null);
});
