/**
 * Fächer-Vorlagen: Fächerstruktur (Fächer, Unterfächer, Halbjahre, Gewichte,
 * Verrechnung) speichern und bei neuen Klassen desselben Notenschlüssels
 * importieren -- ohne Lehrkraftzuordnung.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

process.env.DB_PFAD = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-vorlagen-')), 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-vorlagen-test-bitte-lang-genug-xxxxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });

function client() {
  const cookies = new Map();
  return async function req(url, opts = {}) {
    const headers = { ...opts.headers };
    if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(base + url, { ...opts, headers, redirect: 'manual' });
    for (const raw of r.headers.getSetCookie?.() ?? []) {
      const [k, ...v] = raw.split(';')[0].split('=');
      cookies.set(k.trim(), v.join('=').trim());
    }
    return r;
  };
}
async function form(req, url, body) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) for (const w of Array.isArray(v) ? v : [v]) params.append(k, w);
  return req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params });
}

const admin = client();
const lehrer = client();
let sj, klasseA, klasseB, klasseBG, lehrerId;
const faecher = (klasseId) => getDb().prepare('SELECT * FROM faecher WHERE klasse_id = ? ORDER BY id').all(klasseId);
const fachNamed = (klasseId, name) => getDb().prepare('SELECT * FROM faecher WHERE klasse_id = ? AND name = ?').get(klasseId, name);

test('Vorbereitung: Klasse A mit Mathe (1.-2. Hj., Verrechnung), Deutsch mit Unterfach, Lehrkraft zugeordnet; leere Klassen B (IHK) und BG', async () => {
  await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  sj = getDb().prepare('SELECT id FROM schuljahre').get().id;
  await form(admin, '/admin/einladungen/neu', { display_name: 'Lehrer', ttl_days: '14' });
  const inv = getDb().prepare('SELECT token FROM invitations').get();
  await form(lehrer, `/einladung/${inv.token}`, { username: 'lehrer', display_name: 'Lehrer', password: 'passwort123', password2: 'passwort123' });
  lehrerId = getDb().prepare("SELECT id FROM users WHERE username = 'lehrer'").get().id;
  for (const [name, ns] of [['A', 'IHK'], ['B', 'IHK'], ['C', 'BG']]) {
    await form(admin, '/teacher/klassen/neu', { schuljahr_id: String(sj), name, notenschluessel: ns, einschulung_jahr: '2025' });
  }
  klasseA = getDb().prepare("SELECT id FROM klassen WHERE name = 'A'").get().id;
  klasseB = getDb().prepare("SELECT id FROM klassen WHERE name = 'B'").get().id;
  klasseBG = getDb().prepare("SELECT id FROM klassen WHERE name = 'C'").get().id;
  await form(admin, `/teacher/klassen/${klasseA}/faecher/neu`, { name: 'Mathe', halbjahre: ['1', '2'], verrechnung_gesetzt: '1', p_1: '30' });
  await form(admin, `/teacher/klassen/${klasseA}/faecher/neu`, { name: 'Deutsch' });
  const deutsch = fachNamed(klasseA, 'Deutsch');
  await form(admin, `/teacher/faecher/${deutsch.id}/unterfaecher`, { name: 'Lesen' });
  getDb().prepare('UPDATE faecher SET gewicht = 2 WHERE parent_fach_id = ?').run(deutsch.id);
  await form(admin, `/teacher/klassen/${klasseA}/zuweisungen/neu`, { user_id: String(lehrerId), fach_id: String(fachNamed(klasseA, 'Mathe').id) });
  assert.ok(getDb().prepare('SELECT 1 FROM fach_zuweisungen WHERE user_id = ? AND fach_id = ?').get(lehrerId, fachNamed(klasseA, 'Mathe').id));
});

test('Speichern: Buttons auf der Klassenseite, Vorlage ohne Lehrkräfte', async () => {
  const html = await (await admin(`/teacher/klassen/${klasseA}`)).text();
  assert.match(html, /id="vorlage-import-knopf">📥 Fächer aus Vorlage importieren/);
  assert.match(html, /id="vorlage-speichern-knopf">💾 Fächer als Vorlage speichern/);
  assert.ok(html.indexOf('id="fach-neu-knopf"') < html.indexOf('id="vorlage-import-knopf"'), 'neben dem Button Neues Fach anlegen');
  assert.equal((await form(admin, `/teacher/klassen/${klasseA}/vorlagen/speichern`, { name: '  ' })).status, 302);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM fach_vorlagen').get().c, 0, 'ohne Namen keine Vorlage');
  await form(admin, `/teacher/klassen/${klasseA}/vorlagen/speichern`, { name: 'Standard', fach_ids: faecher(klasseA).filter((f) => !f.parent_fach_id).map((f) => String(f.id)) });
  const v = getDb().prepare('SELECT * FROM fach_vorlagen').get();
  assert.equal(v.name, 'Standard');
  assert.equal(v.notenschluessel, 'IHK');
  const eintraege = getDb().prepare('SELECT * FROM fach_vorlagen_faecher WHERE vorlage_id = ?').all(v.id);
  assert.equal(eintraege.length, 3, 'Mathe, Deutsch und das Unterfach Lesen');
  // Ersetzen bei gleichem Namen
  await form(admin, `/teacher/klassen/${klasseA}/vorlagen/speichern`, { name: 'Standard', fach_ids: [String(fachNamed(klasseA, 'Mathe').id)] });
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM fach_vorlagen').get().c, 1);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM fach_vorlagen_faecher').get().c, 1);
  await form(admin, `/teacher/klassen/${klasseA}/vorlagen/speichern`, { name: 'Standard' }); // alle
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM fach_vorlagen_faecher').get().c, 3);
});

test('Import in neue Klasse gleichen Notenschlüssels: Fächer, Halbjahre, Gewichte, Verrechnung -- ohne die Lehrkraft', async () => {
  const html = await (await admin(`/teacher/klassen/${klasseB}`)).text();
  assert.match(html, /<strong>Standard<\/strong>/);
  const v = getDb().prepare('SELECT id FROM fach_vorlagen').get().id;
  const r = await form(admin, `/teacher/klassen/${klasseB}/vorlagen/importieren`, { vorlage_id: String(v) });
  assert.equal(r.status, 302);
  const mathe = fachNamed(klasseB, 'Mathe');
  assert.equal(mathe.halbjahre, '[1,2]');
  assert.equal(mathe.verrechnung, JSON.stringify({ 1: 30 }));
  const deutsch = fachNamed(klasseB, 'Deutsch');
  const kind = getDb().prepare('SELECT * FROM faecher WHERE parent_fach_id = ?').get(deutsch.id);
  assert.equal(kind.name, 'Deutsch › Lesen');
  assert.equal(kind.gewicht, 2);
  // Keine Zuordnung: weder die Lehrkraft aus Klasse A noch die importierende Person -- alle Fächer starten leer
  const zugewiesen = getDb().prepare('SELECT user_id FROM fach_zuweisungen WHERE fach_id IN (?, ?, ?)').all(mathe.id, deutsch.id, kind.id);
  assert.equal(zugewiesen.length, 0);
  // Nochmal importieren: nichts doppelt
  await form(admin, `/teacher/klassen/${klasseB}/vorlagen/importieren`, { vorlage_id: String(v) });
  assert.equal(faecher(klasseB).filter((f) => !f.parent_fach_id).length, 2);
});

test('Vorlagen sind je Notenschlüssel und je Lehrkraft; Löschen nur eigener Vorlagen', async () => {
  const v = getDb().prepare('SELECT id FROM fach_vorlagen').get().id;
  const html = await (await admin(`/teacher/klassen/${klasseBG}`)).text();
  assert.doesNotMatch(html, /<strong>Standard<\/strong>/, 'andere Notenschlüssel sehen die Vorlage nicht');
  let r = await form(admin, `/teacher/klassen/${klasseBG}/vorlagen/importieren`, { vorlage_id: String(v) });
  assert.equal(r.status, 302);
  assert.equal(faecher(klasseBG).length, 0, 'Import in anderen Notenschlüssel wird abgelehnt');
  // Eine andere Lehrkraft kann die Vorlage weder importieren noch löschen
  await form(admin, `/teacher/klassen/${klasseB}/klassenleitung/hinzufuegen`, { user_id: String(lehrerId) });
  await form(lehrer, `/teacher/vorlagen/${v}/loeschen`, { klasse_id: String(klasseB) });
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM fach_vorlagen').get().c, 1);
  await form(admin, `/teacher/vorlagen/${v}/loeschen`, { klasse_id: String(klasseB) });
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM fach_vorlagen').get().c, 0);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM fach_vorlagen_faecher').get().c, 0, 'Einträge verschwinden mit der Vorlage');
});

test('Import-Dialog: Filter erscheint ab zwei Vorlagen und durchsucht Name und Fächer', async () => {
  await form(admin, `/teacher/klassen/${klasseA}/vorlagen/speichern`, { name: 'Informatik 3 Jahre', fach_ids: [String(fachNamed(klasseA, 'Mathe').id)] });
  let html = await (await admin(`/teacher/klassen/${klasseB}`)).text();
  assert.doesNotMatch(html, /id="vorlage-filter"/, 'bei nur einer Vorlage kein Filter');
  await form(admin, `/teacher/klassen/${klasseA}/vorlagen/speichern`, { name: 'Pflege', fach_ids: [String(fachNamed(klasseA, 'Deutsch').id)] });
  html = await (await admin(`/teacher/klassen/${klasseB}`)).text();
  assert.match(html, /<input type="search" id="vorlage-filter"/);
  assert.match(html, /data-suche="informatik 3 jahre mathe /);
  assert.match(html, /data-suche="pflege deutsch lesen/, 'Fachnamen und Unterfächer sind durchsuchbar');
  assert.match(html, /id="vorlage-filter-leer" hidden/);
});

test.after(async () => {
  await fastify.close();
});
