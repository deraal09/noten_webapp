/**
 * CSV-Parser für den Schüler-Import per Datei-Upload (siehe
 * src/csv-import.js, verwendet von routes/teacher.js für
 * POST /klassen/:id/schueler/csv).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSchuelerCsv } from '../src/csv-import.js';

test('parseSchuelerCsv: Semikolon-getrennt mit deutscher Kopfzeile', () => {
  const text = 'Nachname;Vorname\nMüller;Anna\nSchmidt;Bernd';
  assert.deepEqual(parseSchuelerCsv(text), [
    { nachname: 'Müller', vorname: 'Anna' },
    { nachname: 'Schmidt', vorname: 'Bernd' },
  ]);
});

test('parseSchuelerCsv: Komma-getrennt mit englischer Kopfzeile, Spaltenreihenfolge vertauscht', () => {
  const text = 'Forename,Surname\nAnna,Müller\nBernd,Schmidt';
  assert.deepEqual(parseSchuelerCsv(text), [
    { nachname: 'Müller', vorname: 'Anna' },
    { nachname: 'Schmidt', vorname: 'Bernd' },
  ]);
});

test('parseSchuelerCsv: ohne Kopfzeile — erste zwei Spalten als Nachname/Vorname', () => {
  const text = 'Müller;Anna\nSchmidt;Bernd';
  assert.deepEqual(parseSchuelerCsv(text), [
    { nachname: 'Müller', vorname: 'Anna' },
    { nachname: 'Schmidt', vorname: 'Bernd' },
  ]);
});

test('parseSchuelerCsv: Tab-getrennt', () => {
  const text = 'Nachname\tVorname\nMüller\tAnna';
  assert.deepEqual(parseSchuelerCsv(text), [{ nachname: 'Müller', vorname: 'Anna' }]);
});

test('parseSchuelerCsv: Felder in Anführungszeichen mit eingebettetem Trennzeichen', () => {
  const text = 'Nachname;Vorname\n"Meier, jr.";Carla';
  assert.deepEqual(parseSchuelerCsv(text), [{ nachname: 'Meier, jr.', vorname: 'Carla' }]);
});

test('parseSchuelerCsv: leere Zeilen werden übersprungen, fehlender Nachname verworfen', () => {
  const text = 'Nachname;Vorname\nMüller;Anna\n\n;Ohne Nachname\nSchmidt;Bernd';
  assert.deepEqual(parseSchuelerCsv(text), [
    { nachname: 'Müller', vorname: 'Anna' },
    { nachname: 'Schmidt', vorname: 'Bernd' },
  ]);
});

test('parseSchuelerCsv: leerer Text ergibt leeres Array', () => {
  assert.deepEqual(parseSchuelerCsv(''), []);
  assert.deepEqual(parseSchuelerCsv('   \n  '), []);
});

test('parseSchuelerCsv: fehlender Vorname wird als leerer String übernommen', () => {
  const text = 'Nachname;Vorname\nMüller;';
  assert.deepEqual(parseSchuelerCsv(text), [{ nachname: 'Müller', vorname: '' }]);
});
