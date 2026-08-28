/**
 * TOTP-Berechnung für die Secret-basierte Untis-Anmeldung (aktiv, wenn am
 * Konto eine Zwei-Faktor-Authentifizierung erzwungen wird). Verifiziert
 * gegen die offiziellen HOTP-Testvektoren aus RFC 4226 Anhang D — der
 * Zeitpunkt wird dafür so gewählt, dass floor(zeitMs / 1000 / 30) exakt dem
 * jeweiligen HOTP-Zähler entspricht.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { berechneTotp } from '../src/untis-client.js';

// Base32 von "12345678901234567890" (der ASCII-Schlüssel aus RFC 4226 Anhang D).
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const ERWARTETE_CODES = [
  755224, 287082, 359152, 969429, 338314, 254676, 287922, 162583, 399871, 520489,
];

test('berechneTotp: reproduziert die RFC-4226-Testvektoren für Zähler 0–9', () => {
  ERWARTETE_CODES.forEach((erwartet, counter) => {
    const zeitMs = counter * 30000;
    assert.equal(berechneTotp(RFC_SECRET, zeitMs), erwartet);
  });
});

test('berechneTotp: derselbe 30-Sekunden-Zeitschritt liefert denselben Code', () => {
  const a = berechneTotp(RFC_SECRET, 30000);
  const b = berechneTotp(RFC_SECRET, 30000 + 29000);
  assert.equal(a, b);
});

test('berechneTotp: der nächste Zeitschritt liefert einen anderen Code', () => {
  const a = berechneTotp(RFC_SECRET, 30000);
  const b = berechneTotp(RFC_SECRET, 60000);
  assert.notEqual(a, b);
});

test('berechneTotp: ist robust gegen Leerzeichen/Kleinschreibung im Secret (wie beim Abtippen aus der App)', () => {
  const sauber = berechneTotp(RFC_SECRET, 0);
  const mitLeerzeichenUndKlein = berechneTotp('gezd gnbv gy3t qojq gezd gnbv gy3t qojq', 0);
  assert.equal(sauber, mitLeerzeichenUndKlein);
});
