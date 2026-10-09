/**
 * Klassenseite: Die Aktions-Icons eines Fachs (✎ · 👥 · 🎓 · ⚙ · 🗑) sitzen in einem festen Container mit festen
 * Plätzen, damit sie nicht je nach Namenslänge mal in dieser, mal in der nächsten Zeile stehen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(root, 'static', 'css', 'app.css'), 'utf8');
const view = fs.readFileSync(path.join(root, 'views', 'teacher', 'klasse_detail.ejs'), 'utf8');

test('Fach- und Unterfach-Zeilen: Name links (.fach-kopf), Icons im Container .fach-aktionen mit Plätzen', () => {
  assert.match(view, /<div class="fach-kopf">/);
  assert.match(view, /<div class="fach-aktionen" role="group"/);
  const platz = view.match(/<span class="aktion-platz">/g) || [];
  assert.ok(platz.length >= 7, 'fünf Plätze je Fach, zwei je Unterfach');
});

test('CSS: Container bricht nicht um, Plätze haben feste Breite; mobil eigene Zeile', () => {
  assert.match(css, /\.fach-aktionen\s*\{[^}]*flex-wrap:\s*nowrap/);
  assert.match(css, /\.aktion-platz\s*\{[^}]*width:\s*2\.75rem/);
  assert.match(css, /\.aktion-platz\s*\{[^}]*flex:\s*none/);
  assert.match(css, /@media \(max-width:\s*600px\)\s*\{\s*(?:\/\*[^*]*\*\/\s*)?\.fach-aktionen\s*\{[^}]*flex-basis:\s*100%/);
});
