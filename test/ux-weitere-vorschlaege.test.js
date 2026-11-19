/**
 * UI/UX „weitere Vorschläge“: Favoriten (★) in der Noteneingabe, Combobox, Speicher-Rückmeldung, eigener Bestätigungsdialog,
 * Info-Ausklapper, Hilfe als Akkordeon, Zurück-Knöpfe als Umriss, Kopfzeile der SPA-Endnotenseite im ☰-Muster.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-ux-weitere-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-ux-weitere-bitte-lang-genug-xxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
test.after(async () => { await fastify.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });

function client() {
  const cookies = new Map();
  return async function req(url, opts = {}) {
    const headers = { ...opts.headers };
    if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(base + url, { ...opts, headers, redirect: 'manual' });
    for (const raw of r.headers.getSetCookie?.() ?? []) { const [k, ...v] = raw.split(';')[0].split('='); cookies.set(k.trim(), v.join('=').trim()); }
    return r;
  };
}
const form = (req, url, body) => req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });

const admin = client();
const lehrer = client();
const fremd = client();
let fachId, fach2Id, klasseId;

test('Vorbereitung', async () => {
  await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;
  for (const n of ['Lehrer', 'Fremd']) await form(admin, '/admin/einladungen/neu', { display_name: n, ttl_days: '14' });
  const invs = getDb().prepare('SELECT token FROM invitations ORDER BY id').all();
  await form(lehrer, `/einladung/${invs[0].token}`, { username: 'lehrer', display_name: 'Lehrer', password: 'passwort1234', password2: 'passwort1234' });
  await form(fremd, `/einladung/${invs[1].token}`, { username: 'fremd', display_name: 'Fremd', password: 'passwort1234', password2: 'passwort1234' });
  getDb().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'lehrer'").run();
  await form(lehrer, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '11A', notenschluessel: 'IHK' });
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '11A'").get().id;
  await form(lehrer, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Physik' });
  await form(lehrer, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Chemie' });
  fachId = getDb().prepare("SELECT id FROM faecher WHERE name = 'Physik'").get().id;
  fach2Id = getDb().prepare("SELECT id FROM faecher WHERE name = 'Chemie'").get().id;
});

test('Favoriten: Stern an jeder Kachel, Umschalten, Abschnitt „★ Favoriten“, nur pro Konto', async () => {
  let html = await (await lehrer('/teacher')).text();
  assert.match(html, new RegExp(`action="/teacher/faecher/${fachId}/favorit"`));
  assert.ok(!html.includes('★ Favoriten'), 'ohne Favoriten kein Abschnitt');
  assert.match(html, /aria-pressed="false"/);

  const r = await form(lehrer, `/teacher/faecher/${fachId}/favorit`, {});
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/teacher');
  html = await (await lehrer('/teacher')).text();
  const abschnitt = /<section class="favoriten"[\s\S]*?<\/section>/.exec(html)[0];
  assert.match(abschnitt, /★ Favoriten/);
  assert.match(abschnitt, new RegExp(`href="/teacher/fach/${fachId}"`));
  assert.ok(!abschnitt.includes(`/teacher/fach/${fach2Id}"`), 'nur das markierte Fach');
  assert.match(html, /aria-pressed="true"/);

  // Anderes Konto sieht nichts davon und darf kein fremdes Fach markieren
  const rf = await form(fremd, `/teacher/faecher/${fachId}/favorit`, {});
  assert.equal(rf.status, 404);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM fach_favoriten').get().n, 1);

  await form(lehrer, `/teacher/faecher/${fachId}/favorit`, {});
  html = await (await lehrer('/teacher')).text();
  assert.ok(!html.includes('<section class="favoriten"'), 'wieder entfernt');
});

test('Gemeinsame Skripte sind eingebunden und werden ausgeliefert', async () => {
  const html = await (await lehrer('/teacher')).text();
  for (const js of ['select-filter', 'ui-menues', 'speicher-status', 'bestaetigen']) {
    assert.match(html, new RegExp(`/static/js/${js}\\.js\\?v=`), js);
    assert.equal((await fetch(`${base}/static/js/${js}.js`)).status, 200);
  }
});

test('Speicher-Rückmeldung: window.speicherStatus und Anzeige-Element', () => {
  const quelle = fs.readFileSync(path.join(ROOT, 'static/js/speicher-status.js'), 'utf8');
  assert.match(quelle, /speicherStatus/);
  assert.match(quelle, /Gespeichert/);
  assert.match(quelle, /Offline/);
  assert.doesNotThrow(() => new vm.Script(quelle));
});

test('Bestätigungsdialog ersetzt confirm(): Skript parst, Dialog ist beschriftet und per Tastatur bedienbar', () => {
  const quelle = fs.readFileSync(path.join(ROOT, 'static/js/bestaetigen.js'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(quelle));
  assert.match(quelle, /showModal/, 'natives <dialog>: Escape schließt, Fokus bleibt im Dialog');
  assert.match(quelle, /aria-labelledby/);
  assert.match(quelle, /bestaetig-nein/);
});

test('Combobox: select-filter baut ein Eingabefeld mit Trefferliste (ARIA), die Auswahlliste bleibt im Formular', () => {
  const quelle = fs.readFileSync(path.join(ROOT, 'static/js/select-filter.js'), 'utf8');
  for (const teil of ["role', 'combobox'", "role', 'listbox'", "role', 'option'", 'aria-activedescendant', 'ArrowDown', 'sf-versteckt']) assert.ok(quelle.includes(teil), teil);
  const css = fs.readFileSync(path.join(ROOT, 'static/css/app.css'), 'utf8');
  assert.match(css, /select\.sf-versteckt/);
  assert.match(css, /\.sf-liste/);
});

test('Fachseite: Hilfetexte als Ausklapper, Zurück als Umriss-Knopf', async () => {
  await form(lehrer, `/teacher/fach/${fachId}/klausuren/neu`, { name: 'K1', aufgaben: '1', halbjahr: '1' });
  const html = await (await lehrer(`/teacher/fach/${fachId}`)).text();
  assert.match(html, /<details class="info-ausklapp">/);
  assert.match(html, /<a class="btn btn-zurueck" href="\/teacher">← Meine Noteneingabe<\/a>/);
});

test('Hilfe-Übersicht: Kategorien als aufklappbare Abschnitte', async () => {
  const html = await (await lehrer('/hilfe')).text();
  assert.match(html, /<details class="card hilfe-kategorie"/);
});

test('SPA-Endnotenseite: Kopfzeile nur Zurück-Knopf + ☰-Menü', () => {
  const quelle = fs.readFileSync(path.join(ROOT, 'views/teacher/fach_detail_spa.ejs'), 'utf8');
  assert.match(quelle, /<div class="kopf-aktionen">/);
  assert.match(quelle, /partials\/kopf-menue/);
  assert.ok(!/<p class="kopf-aktionen">/.test(quelle));
});

test('Bestätigungsdialog: Formular aus dem Aktionsmenü wird auch abgeschickt, wenn es nicht mehr im Dokument liegt', async () => {
  const quelle = fs.readFileSync(path.join(ROOT, 'static/js/bestaetigen.js'), 'utf8');
  assert.match(quelle, /isConnected/, 'Kopie des Formulars, falls das Aktionsmenü sich geleert hat');
  assert.match(quelle, /absenden\(form, ausloeser\)/);
  const html = await (await lehrer(`/teacher/klassen/${klasseId}`)).text();
  assert.match(html, /!e\.target\.closest\('dialog'\)/, 'Klick im Dialog schließt das Aktionsmenü nicht');
});
