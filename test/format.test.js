/**
 * formatZeitLokal: SQLite liefert datetime('now') als UTC ohne
 * Zeitzonen-Angabe ("YYYY-MM-DD HH:MM:SS") — die Anzeige (z. B. "zuletzt
 * synchronisiert") muss das in deutsche Ortszeit umrechnen, nicht UTC
 * unverändert anzeigen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatZeitLokal } from '../src/format.js';

test('formatZeitLokal: rechnet UTC in deutsche Winterzeit um (UTC+1)', () => {
  // 2026-01-15 12:00 UTC → 13:00 in Berlin (Winterzeit, kein DST).
  assert.equal(formatZeitLokal('2026-01-15 12:00:00'), '15.01.2026, 13:00');
});

test('formatZeitLokal: rechnet UTC in deutsche Sommerzeit um (UTC+2)', () => {
  // 2026-07-15 12:00 UTC → 14:00 in Berlin (Sommerzeit/DST).
  assert.equal(formatZeitLokal('2026-07-15 12:00:00'), '15.07.2026, 14:00');
});

test('formatZeitLokal: leerer/fehlender Wert ergibt leeren String', () => {
  assert.equal(formatZeitLokal(null), '');
  assert.equal(formatZeitLokal(''), '');
  assert.equal(formatZeitLokal(undefined), '');
});

test('formatZeitLokal: unparsbarer Wert wird unverändert zurückgegeben statt zu crashen', () => {
  assert.equal(formatZeitLokal('kein-datum'), 'kein-datum');
});
