import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sitzplanNamensvorschlaege } from '../src/sitzplan-namen.js';

function label(ergebnis, id) {
  return ergebnis.find((e) => e.id === id).label;
}

test('sitzplanNamensvorschlaege: eindeutige Vornamen bleiben unverändert', () => {
  const schueler = [
    { id: 1, vorname: 'Anna', nachname: 'Meyer' },
    { id: 2, vorname: 'Ben', nachname: 'Schmidt' },
  ];
  const erg = sitzplanNamensvorschlaege(schueler);
  assert.equal(label(erg, 1), 'Anna');
  assert.equal(label(erg, 2), 'Ben');
});

test('sitzplanNamensvorschlaege: doppelter Vorname bekommt ersten Buchstaben des Nachnamens', () => {
  const schueler = [
    { id: 1, vorname: 'Anna', nachname: 'Meyer' },
    { id: 2, vorname: 'Anna', nachname: 'Schmidt' },
  ];
  const erg = sitzplanNamensvorschlaege(schueler);
  assert.equal(label(erg, 1), 'Anna M.');
  assert.equal(label(erg, 2), 'Anna S.');
});

test('sitzplanNamensvorschlaege: gleicher erster Buchstabe des Nachnamens -> Präfix wird verlängert bis eindeutig', () => {
  const schueler = [
    { id: 1, vorname: 'Anna', nachname: 'Meyer' },
    { id: 2, vorname: 'Anna', nachname: 'Mueller' },
    { id: 3, vorname: 'Anna', nachname: 'Schmidt' },
  ];
  const erg = sitzplanNamensvorschlaege(schueler);
  assert.equal(label(erg, 1), 'Anna Me.');
  assert.equal(label(erg, 2), 'Anna Mu.');
  assert.equal(label(erg, 3), 'Anna S.');
  // Alle Labels müssen paarweise verschieden sein.
  const labels = erg.map((e) => e.label);
  assert.equal(new Set(labels).size, labels.length);
});

test('sitzplanNamensvorschlaege: drei Ebenen — mehrfache Verlängerung bis zur vollen Eindeutigkeit', () => {
  const schueler = [
    { id: 1, vorname: 'Ben', nachname: 'Maier' },
    { id: 2, vorname: 'Ben', nachname: 'Mai' },
    { id: 3, vorname: 'Ben', nachname: 'Malik' },
  ];
  const erg = sitzplanNamensvorschlaege(schueler);
  const labels = erg.map((e) => e.label);
  assert.equal(new Set(labels).size, 3, 'auch bei überlappenden Präfixen (Mai/Maier) müssen alle drei eindeutig werden');
});

test('sitzplanNamensvorschlaege: Dopplungen in unterschiedlichen Vorname-Gruppen beeinflussen sich nicht gegenseitig', () => {
  const schueler = [
    { id: 1, vorname: 'Anna', nachname: 'Meyer' },
    { id: 2, vorname: 'Anna', nachname: 'Schmidt' },
    { id: 3, vorname: 'Ben', nachname: 'Weber' },
  ];
  const erg = sitzplanNamensvorschlaege(schueler);
  assert.equal(label(erg, 3), 'Ben');
});
