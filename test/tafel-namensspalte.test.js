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

test('Übersichtstabellen (Notenübersicht, Halbjahresübersicht) tragen die Klasse tabelle-fix; CSS fixiert die erste Spalte', () => {
  const regel = css.match(/table\.tabelle-fix th:first-child,\s*table\.tabelle-fix td:first-child\s*\{([^}]*)\}/);
  assert.ok(regel, 'Regel vorhanden');
  assert.match(regel[1], /position:\s*sticky/);
  assert.match(regel[1], /left:\s*0/);
  assert.match(css, /table\.tabelle-fix tbody tr:nth-child\(even\) td:first-child\s*\{[^}]*background:\s*var\(--bg-subtle\)/, 'folgt der Zebra-Streifung');
  assert.match(css, /table\.tabelle-fix,\s*table\.tafel\s*\{\s*border-collapse:\s*separate/, 'getrennte Rahmen gegen Durchscheinen');
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'views');
  for (const datei of ['teacher/fach_detail.ejs', 'teacher/fach_zusammensetzung.ejs', 'teacher/klasse_uebersicht.ejs', 'klassenlehrer/klasse_detail.ejs', 'teacher/klasse_abschluss.ejs']) {
    assert.match(fs.readFileSync(path.join(root, datei), 'utf8'), /<table class="data tabelle-fix"/, datei);
  }
  // Abschlussübersicht (beide Seiten) und die direkten Noteneingaben (Fach, SPA, Endnoten-Raster der Klassenleitung)
  const lies = (d) => fs.readFileSync(path.join(root, d), 'utf8');
  assert.match(lies('teacher/klasse_abschluss.ejs'), /<table class="data tabelle-fix">[\s\S]*Ø Abschluss/);
  assert.match(lies('klassenlehrer/klasse_detail.ejs'), /<table class="data tabelle-fix">\s*<thead>\s*<tr>\s*<th>Schüler\/in<\/th>\s*<% abschlussuebersicht\.faecher\.forEach/);
  assert.match(lies('klassenlehrer/klasse_detail.ejs'), /<table class="data tabelle-fix" id="endnoten-raster">/);
  assert.match(lies('teacher/fach_detail.ejs'), /<table class="data tabelle-fix" id="endnoten-tabelle">/);
  assert.match(lies('teacher/fach_detail_spa.ejs'), /<table class="data tabelle-fix" id="spa-tabelle"/);
});
