/**
 * formatZeitLokal: SQLite liefert datetime('now') als UTC ohne
 * Zeitzonen-Angabe ("YYYY-MM-DD HH:MM:SS") — die Anzeige (z. B. "zuletzt
 * synchronisiert") muss das in deutsche Ortszeit umrechnen, nicht UTC
 * unverändert anzeigen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatZeitLokal, baueEinladungsMailtoLink } from '../src/format.js';

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

test('baueEinladungsMailtoLink: Empfänger aus der E-Mail, Betreff/Text mit Anrede, Link und Gültigkeit als URL-kodierter mailto-Link', () => {
  const link = baueEinladungsMailtoLink(
    { display_name: 'Frau Müller', email: 'mueller@schule.de', expires_at: '2026-01-15 12:00:00' },
    'https://noten.example.org/einladung/abc123',
  );
  assert.ok(link.startsWith('mailto:mueller%40schule.de?'));
  assert.match(link, /subject=Einladung%20zur%20Notenverwaltung/);
  const body = decodeURIComponent(link.split('body=')[1]);
  assert.match(body, /^Hallo Frau Müller,/);
  assert.ok(body.includes('https://noten.example.org/einladung/abc123'));
  assert.ok(body.includes('Der Link ist bis zum 15.01.2026, 13:00 gültig.'));
});

test('baueEinladungsMailtoLink: ohne Anzeigename/E-Mail/Ablaufdatum bleiben Anrede generisch, Empfänger leer, kein Gültigkeits-Hinweis', () => {
  const link = baueEinladungsMailtoLink({ display_name: null, email: null, expires_at: null }, 'https://noten.example.org/einladung/xyz');
  assert.ok(link.startsWith('mailto:?'));
  const body = decodeURIComponent(link.split('body=')[1]);
  assert.match(body, /^Hallo,/);
  assert.doesNotMatch(body, /gültig/);
});
