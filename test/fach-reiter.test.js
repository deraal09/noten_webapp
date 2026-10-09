/**
 * Die Klassenseite zeigt je Fach nur noch das Zahnrad (⚙). Dort -- in den Reitern Allgemein · Lehrkräfte ·
 * Unterfächer (automatisch, wenn es welche gibt) · Teilnehmer -- werden Lehrkräfte zugeordnet, Halbjahre gestellt,
 * Teilnehmer verwaltet und das Fach gelöscht. IHK/BG und SPA.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-fach-reiter-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-fach-reiter-bitte-lang-genug-xxxxxxx';
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
const form = (req, url, body = {}) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) for (const w of Array.isArray(v) ? v : [v]) params.append(k, w);
  return req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params });
};
const db = () => getDb();
const admin = client();
const lehrer = client();
let klasseId, matheId, deutschId, spaKlasseId, lf3Id, lehrerId;
const text = async (req, url) => (await req(url)).text();

test('Vorbereitung: IHK-Klasse mit Fach Mathe (Unterfach Algebra) und Fach Deutsch, SPA-Klasse, eine Lehrkraft', async () => {
  await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sj = db().prepare('SELECT id FROM schuljahre').get().id;
  await form(admin, '/admin/einladungen/neu', { display_name: 'lehrer', ttl_days: '14' });
  const inv = db().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
  await form(lehrer, `/einladung/${inv.token}`, { username: 'lehrer', display_name: 'lehrer', password: 'passwort123', password2: 'passwort123' });
  lehrerId = db().prepare("SELECT id FROM users WHERE username = 'lehrer'").get().id;
  await form(admin, '/teacher/klassen/neu', { schuljahr_id: String(sj), name: '11A', notenschluessel: 'IHK', einschulung_jahr: '2023' });
  klasseId = db().prepare("SELECT id FROM klassen WHERE name = '11A'").get().id;
  await form(admin, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Mathe' });
  await form(admin, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Deutsch' });
  matheId = db().prepare("SELECT id FROM faecher WHERE name = 'Mathe'").get().id;
  deutschId = db().prepare("SELECT id FROM faecher WHERE name = 'Deutsch'").get().id;
  await form(admin, '/teacher/klassen/neu', { schuljahr_id: String(sj), name: '13SPA', notenschluessel: 'SPA', spa_bildungsgang: 'SPA_REGULAR' });
  spaKlasseId = db().prepare("SELECT id FROM klassen WHERE name = '13SPA'").get().id;
  lf3Id = db().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND spa_fach_key = 'LF3'").get(spaKlasseId).id;
});

test('Hauptansicht: je Fach nur das Zahnrad -- kein ✎, 👥, 🎓-Knopf, 🗑 oder ✕ mehr', async () => {
  db().prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)').run(lehrerId, deutschId);
  for (const id of [klasseId, spaKlasseId]) {
    const html = await text(admin, `/teacher/klassen/${id}`);
    assert.doesNotMatch(html, /class="hj-bearbeiten"|summary title="Halbjahre/, 'kein ✎');
    assert.doesNotMatch(html, /\/(faecher|zuweisungen)\/\d+\/loeschen"/, 'kein 🗑 / ✕ in der Hauptansicht');
    assert.doesNotMatch(html, /data-lehrkraft-dialog|\/teilnehmer"/);
    assert.equal((html.match(/<span class="aktion-platz">/g) || []).length, id === klasseId ? 2 : (html.match(/aria-label="Fach einstellen/g) || []).length);
  }
  const html = await text(admin, `/teacher/klassen/${klasseId}`);
  assert.match(html, new RegExp(`/teacher/faecher/${matheId}/einstellungen`));
  assert.match(html, /🎓 lehrer/, 'zugeordnete Lehrkraft wird weiter angezeigt');
});

test('Reiter Lehrkräfte: zuordnen, Halbjahre ändern, entfernen -- jeweils zurück auf den Reiter', async () => {
  const seite = await text(admin, `/teacher/faecher/${matheId}/lehrkraefte`);
  assert.match(seite, /class="fach-reiter"/);
  assert.match(seite, /Lehrkraft hinzufügen/);
  assert.doesNotMatch(seite, /📖 Unterfächer/, 'ohne Unterfächer kein Unterfächer-Reiter');

  let r = await form(admin, `/teacher/klassen/${klasseId}/zuweisungen/neu`, { fach_id: String(matheId), user_id: String(lehrerId), halbjahre: ['5', '6'], zurueck: `lehrkraefte:${matheId}` });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `/teacher/faecher/${matheId}/lehrkraefte`);
  const z = db().prepare('SELECT * FROM fach_zuweisungen WHERE fach_id = ? AND user_id = ?').get(matheId, lehrerId);
  assert.ok(z);
  assert.match(await text(admin, `/teacher/faecher/${matheId}/lehrkraefte`), /🎓 lehrer/);

  r = await form(admin, `/teacher/zuweisungen/${z.id}/halbjahre`, { halbjahre: ['5'], zurueck: `lehrkraefte:${matheId}` });
  assert.equal(r.headers.get('location'), `/teacher/faecher/${matheId}/lehrkraefte`);

  // Fremdes Ziel (Fach einer anderen Klasse) wird ignoriert
  r = await form(admin, `/teacher/zuweisungen/${z.id}/halbjahre`, { halbjahre: ['5'], zurueck: `lehrkraefte:${lf3Id}` });
  assert.equal(r.headers.get('location'), `/teacher/klassen/${klasseId}#faecher-lehrkraefte`);

  r = await form(admin, `/teacher/zuweisungen/${z.id}/loeschen`, { zurueck: `lehrkraefte:${matheId}` });
  assert.equal(r.headers.get('location'), `/teacher/faecher/${matheId}/lehrkraefte`);
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM fach_zuweisungen WHERE id = ?').get(z.id).c, 0);
});

test('Nur die Klassenleitung sieht Lehrkräfte-Reiter und darf zuordnen', async () => {
  assert.equal((await lehrer(`/teacher/faecher/${matheId}/lehrkraefte`)).status, 403);
  assert.equal((await lehrer(`/teacher/faecher/${matheId}/unterfaecher`)).status, 403);
  assert.equal((await lehrer(`/teacher/faecher/${lf3Id}/spa-schema`)).status, 403);
});

test('Unterfächer-Reiter entsteht automatisch, sobald das Fach Unterfächer hat; dort Lehrkräfte je Unterfach', async () => {
  assert.equal((await admin(`/teacher/faecher/${matheId}/unterfaecher`)).headers.get('location'), `/teacher/faecher/${matheId}/lehrkraefte`);
  const r = await form(admin, `/teacher/faecher/${matheId}/einstellungen`, { name: 'Mathe', halbjahre: ['1', '2', '3', '4', '5', '6'], unterfaecher: 'Algebra; 2; alle\nGeometrie' });
  assert.equal(r.status, 302);
  for (const url of [`einstellungen`, `lehrkraefte`]) {
    assert.match(await text(admin, `/teacher/faecher/${matheId}/${url}`), new RegExp(`href="/teacher/faecher/${matheId}/unterfaecher"`), `Reiter in ${url}`);
  }
  const seite = await text(admin, `/teacher/faecher/${matheId}/unterfaecher`);
  assert.match(seite, /Algebra/);
  assert.match(seite, /Geometrie/);
  const algebra = db().prepare("SELECT id FROM faecher WHERE parent_fach_id = ? AND name LIKE '%Algebra'").get(matheId).id;
  const zu = await form(admin, `/teacher/klassen/${klasseId}/zuweisungen/neu`, { fach_id: String(algebra), user_id: String(lehrerId), halbjahre: ['5'], zurueck: `unterfaecher:${matheId}` });
  assert.equal(zu.headers.get('location'), `/teacher/faecher/${matheId}/unterfaecher`);
  assert.ok(db().prepare('SELECT 1 FROM fach_zuweisungen WHERE fach_id = ? AND user_id = ?').get(algebra, lehrerId));
  assert.match(await text(admin, `/teacher/faecher/${matheId}/unterfaecher`), /🎓 lehrer/);
});

test('Reiter Teilnehmer und Löschen: Teilnehmer-Seite trägt die Reiter, Löschen steht unter Allgemein', async () => {
  const teilnehmer = await text(admin, `/teacher/fach/${deutschId}/teilnehmer`);
  assert.match(teilnehmer, /class="fach-reiter"/);
  const allgemein = await text(admin, `/teacher/faecher/${deutschId}/einstellungen`);
  assert.match(allgemein, new RegExp(`action="/teacher/faecher/${deutschId}/loeschen"`));
  assert.match(allgemein, new RegExp(`href="/teacher/fach/${deutschId}/teilnehmer"`));
  const r = await form(admin, `/teacher/faecher/${deutschId}/loeschen`);
  assert.equal(r.status, 302);
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM faecher WHERE id = ?').get(deutschId).c, 0);
});

test('SPA: Zahnrad führt zu den Reitern; Halbjahre des Fachs, Unterfächer (Komponenten) und Löschen dort', async () => {
  const seite = await text(admin, `/teacher/faecher/${lf3Id}/spa-schema`);
  assert.match(seite, /class="fach-reiter"/);
  assert.match(seite, new RegExp(`href="/teacher/faecher/${lf3Id}/unterfaecher"`), 'Unterfächer-Reiter automatisch (Komponenten)');
  assert.match(seite, new RegExp(`action="/teacher/faecher/${lf3Id}/halbjahre"`), 'Halbjahre des Fachs');
  assert.match(seite, new RegExp(`action="/teacher/faecher/${lf3Id}/loeschen"`));
  assert.doesNotMatch(seite, /👥 Teilnehmer/);

  const hj = await form(admin, `/teacher/faecher/${lf3Id}/halbjahre`, { halbjahre: ['1', '2', '3', '4'], zurueck: `einstellungen:${lf3Id}` });
  assert.equal(hj.headers.get('location'), `/teacher/faecher/${lf3Id}/spa-schema`);

  const unter = await text(admin, `/teacher/faecher/${lf3Id}/unterfaecher`);
  assert.match(unter, /Zusammensetzung speichern/);
  const musik = db().prepare("SELECT id FROM faecher WHERE parent_fach_id = ? AND spa_komponente = 'musik'").get(lf3Id).id;
  const r = await form(admin, `/teacher/faecher/${musik}/halbjahre`, { halbjahre: ['2', '3', '4'], zurueck: `unterfaecher:${lf3Id}` });
  assert.equal(r.headers.get('location'), `/teacher/faecher/${lf3Id}/unterfaecher`);
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
