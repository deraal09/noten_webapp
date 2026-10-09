/**
 * Noteneingabe-Tafeln (Datumstabelle, Klausuren, Unterrichtsleistung): die Namensspalte bleibt beim seitlichen
 * Scrollen links stehen (CSS position: sticky), sonst sieht man auf dem Handy die Namen nicht mehr.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'css', 'app.css'), 'utf8');

test('Erste Spalte der Notentafeln ist fixiert (sticky, links, mit Hintergrund über den Zellen)', () => {
  const regel = css.match(/table\.tafel th:first-child,\s*table\.tafel td:first-child\s*\{([^}]*)\}/);
  assert.ok(regel, 'Regel für die erste Spalte vorhanden');
  assert.match(regel[1], /position:\s*sticky/);
  assert.match(regel[1], /left:\s*0/);
  assert.match(regel[1], /background:\s*var\(--bg-card\)/, 'deckend, damit die scrollenden Zellen nicht durchscheinen');
  assert.match(css, /table\.tafel thead th:first-child\s*\{[^}]*z-index:\s*3/, 'Kopfzelle liegt über den Namen');
});

test('Die Tabelle selbst scrollt seitlich (Voraussetzung für sticky)', () => {
  assert.match(css, /table\.data,\s*table\.tafel\s*\{[^}]*display:\s*block;[^}]*overflow-x:\s*auto/);
});
