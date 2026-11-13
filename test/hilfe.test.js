/**
 * Hilfe (/hilfe): Artikel mit Screenshots, Suche (Seite und Live-JSON) und geführter Rundgang.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-hilfe-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-hilfe-bitte-lang-genug-xxxxxxxxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { ARTIKEL, RUNDGANG, RUNDGANG_KLASSENLEITUNG, KATEGORIEN, sucheHilfe, normalisiere, formatiere } = await import('../src/hilfe.js');
const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
test.after(() => fastify.close());
const get = (u) => fetch(base + u, { redirect: 'manual' });
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Inhalte: eindeutige Slugs, gültige Kategorien und Verweise, alle Bilder existieren', () => {
  const slugs = ARTIKEL.map((a) => a.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  for (const a of ARTIKEL) {
    assert.ok(KATEGORIEN.some((k) => k.id === a.kategorie), a.slug);
    assert.ok(a.abschnitte.length > 0, a.slug);
    for (const v of a.verwandt || []) assert.ok(slugs.includes(v), `${a.slug} -> ${v}`);
    for (const b of a.bilder || []) assert.ok(fs.existsSync(path.join(ROOT, 'static', 'hilfe', `${b.datei}.jpg`)), `Bild ${b.datei}.jpg fehlt (node scripts/hilfe-screenshots.mjs)`);
  }
  for (const s of [...RUNDGANG, ...RUNDGANG_KLASSENLEITUNG]) {
    if (s.artikel) assert.ok(slugs.includes(s.artikel), s.titel);
    if (s.bild) assert.ok(fs.existsSync(path.join(ROOT, 'static', 'hilfe', `${s.bild}.jpg`)), `Bild ${s.bild}.jpg fehlt`);
    assert.match(s.href, /^\//);
  }
});

test('Suche: Umlaute und Schreibweisen, Rangfolge, mehrere Wörter, Unsinn', () => {
  assert.equal(sucheHilfe('Hörverstehen')[0].slug, 'klausur-teile');
  assert.equal(sucheHilfe('hoerverstehen')[0].slug, 'klausur-teile', 'oe = ö');
  assert.equal(sucheHilfe('papierkorb')[0].slug, 'papierkorb');
  assert.equal(sucheHilfe('csv kurs')[0].slug, 'kurse', 'alle Wörter müssen vorkommen');
  assert.ok(sucheHilfe('csv').length >= 2);
  assert.equal(sucheHilfe('api schlüssel')[0].slug, 'api');
  assert.equal(sucheHilfe('Lernfeld')[0].slug, 'spa');
  assert.ok(!sucheHilfe('Administration').some((t) => t.slug === 'administration'), 'kein Admin-Artikel in der Hilfe');
  assert.equal(sucheHilfe('sofort endgültig löschen')[0].slug, 'papierkorb');
  assert.equal(sucheHilfe('Konferenz')[0].slug, 'notenkonferenz');
  assert.equal(sucheHilfe('Fehlzeiten')[0].slug, 'fehlzeiten-notizen');
  assert.equal(sucheHilfe('Entsperrung')[0].slug, 'notenkonferenz');
  assert.equal(sucheHilfe('Abgangszeugnis')[0].slug, 'abschluss-zeugnisse');
  assert.equal(sucheHilfe('noch nie synchronisiert')[0].slug, 'halbjahresuebersicht');
  assert.deepEqual(sucheHilfe('qwxyzunsinn'), []);
  assert.deepEqual(sucheHilfe('a'), [], 'zu kurz');
  assert.match(sucheHilfe('verrechnungspunkte')[0].snippet, /Verrechnungspunkte/i);
  assert.equal(normalisiere('Müller Straße'), normalisiere('Mueller Strasse'));
});

test('Formatierung maskiert HTML und setzt nur fett/code', () => {
  assert.equal(formatiere('**fett** `code` <script>x</script>'), '<strong>fett</strong> <code>code</code> &lt;script&gt;x&lt;/script&gt;');
});

test('/hilfe ist öffentlich: Suchfeld, Rundgang, alle Themen; Suche über die Seite', async () => {
  const r = await get('/hilfe');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /id="hilfe-suche-eingabe"/);
  assert.match(html, /Geführter Rundgang/);
  for (const k of KATEGORIEN) assert.match(html, new RegExp(k.titel));
  for (const a of ARTIKEL) assert.match(html, new RegExp(`href="/hilfe/${a.slug}"`));
  const s = await (await get('/hilfe?q=Papierkorb')).text();
  assert.match(s, /Suchergebnisse für „Papierkorb“/);
  assert.match(s, /href="\/hilfe\/papierkorb"/);
  assert.match(await (await get('/hilfe?q=xyzqq')).text(), /Nichts gefunden/);
  const xss = await (await get('/hilfe?q=%3Cscript%3Ealert(1)%3C/script%3E')).text();
  assert.match(xss, /value="&lt;script&gt;alert\(1\)&lt;\/script&gt;"/, 'Eingabe wird maskiert');
  assert.doesNotMatch(xss, /<script>alert\(1\)/);
});

test('Live-Suche (JSON)', async () => {
  const d = await (await get('/hilfe/suche?q=klausur')).json();
  assert.ok(d.treffer.length > 0 && d.treffer.length <= 8);
  assert.ok(d.treffer.every((t) => t.slug && t.titel && typeof t.snippet === 'string'));
  assert.deepEqual((await (await get('/hilfe/suche?q=')).json()).treffer, []);
});

test('Artikel: Bilder, Abschnitte, Links, Weiterlesen; unbekannter Artikel 404', async () => {
  const html = await (await get('/hilfe/klausur-teile')).text();
  assert.match(html, /<h1>Mehrteilige Klausuren: Hörverstehen und Inhalt &amp; Sprache<\/h1>/);
  assert.match(html, /src="\/static\/hilfe\/klausur-teile\.jpg\?v=/);
  assert.match(html, /ab \<strong\>4,05\<\/strong\> Punkten/);
  assert.match(html, /Weiterlesen/);
  assert.equal((await get('/hilfe/gibt-es-nicht')).status, 404);
  assert.equal((await get('/static/hilfe/klausur-teile.jpg')).status, 200, 'Bild wird ausgeliefert');
});

test('Rundgang: Schritte, Fortschritt, Zurück/Weiter, Ende; ungültiger Schritt -> Schritt 1', async () => {
  assert.equal((await get('/hilfe/rundgang')).headers.get('location'), '/hilfe/rundgang/1');
  const erster = await (await get('/hilfe/rundgang/1')).text();
  assert.match(erster, new RegExp(`Schritt 1 von ${RUNDGANG.length}`));
  assert.doesNotMatch(erster, /rel="prev"/);
  assert.match(erster, /rel="next"/);
  const mitte = await (await get('/hilfe/rundgang/3')).text();
  assert.match(mitte, /rel="prev"/);
  assert.match(mitte, new RegExp(`href="${RUNDGANG[2].href.replace(/\//g, '\\/')}"`), 'Knopf zur echten Seite');
  assert.match(mitte, /Mehr dazu:/);
  const letzter = await (await get(`/hilfe/rundgang/${RUNDGANG.length}`)).text();
  assert.match(letzter, /Fertig ✓/);
  assert.equal((await get('/hilfe/rundgang/99')).headers.get('location'), '/hilfe/rundgang/1');
  assert.equal((await get('/hilfe/rundgang/abc')).headers.get('location'), '/hilfe/rundgang/1');
});

test('Rundgang Klassenleitung: eigene Adresse, Schritte, Ende, eigener Speicherschlüssel', async () => {
  const basis = '/hilfe/rundgang-klassenleitung';
  assert.equal((await get(basis)).headers.get('location'), `${basis}/1`);
  const erster = await (await get(`${basis}/1`)).text();
  assert.match(erster, new RegExp(`Schritt 1 von ${RUNDGANG_KLASSENLEITUNG.length}`));
  assert.match(erster, new RegExp(`href="${basis}/2"`), 'Weiter bleibt im selben Rundgang');
  assert.match(erster, /rundgang-klassenleitung-schritt/);
  const letzter = await (await get(`${basis}/${RUNDGANG_KLASSENLEITUNG.length}`)).text();
  assert.match(letzter, /Fertig ✓/);
  assert.equal((await get(`${basis}/99`)).headers.get('location'), `${basis}/1`);
  const idx = await (await get('/hilfe')).text();
  assert.match(idx, /Rundgang für die Klassenleitung/);
  assert.match(idx, /href="\/hilfe\/rundgang-klassenleitung\/1"/);
  const art = await (await get('/hilfe/notenkonferenz')).text();
  assert.match(art, /href="\/hilfe\/rundgang-klassenleitung"/, 'Artikel der Klassenleitung verlinken den Rundgang');
  assert.match(art, /leitung-konferenz\.jpg/);
});

test('Die Hilfe enthält keine Admin-Artikel (Administration, Aktivität)', async () => {
  assert.ok(!ARTIKEL.some((a) => ['administration', 'aktivitaet'].includes(a.slug)));
  assert.equal((await get('/hilfe/administration')).status, 404);
  assert.equal((await get('/hilfe/aktivitaet')).status, 404);
  const index = await (await get('/hilfe')).text();
  assert.doesNotMatch(index, /\/hilfe\/(administration|aktivitaet)/);
});

test('Menü und Fußzeile verlinken die Hilfe; Startseite zeigt den Rundgang-Hinweis', async () => {
  const offen = await (await get('/hilfe')).text();
  assert.match(offen, /<a href="\/hilfe">Hilfe<\/a>/, 'Fußzeile auch ohne Anmeldung');
  const r = await fetch(`${base}/setup`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' }) });
  const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const start = await (await fetch(`${base}/start`, { headers: { cookie } })).text();
  assert.match(start, /id="hilfe-banner"/);
  assert.match(start, /href="\/hilfe\/rundgang"/);
  assert.match(start, /<a href="\/hilfe">❓ Hilfe<\/a>/, 'Menüpunkt');
});
