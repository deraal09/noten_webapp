/**
 * Namen von Schüler/innen korrigieren (POST /teacher/schueler/:id/umbenennen): Es gibt nur einen Datensatz je Person -- die Änderung
 * gilt damit sofort für alle Lehrkräfte der Klasse; jede Lehrkraft mit Klassenzugriff darf sie vornehmen, Fremde nicht.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-umbenennen-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-umbenennen-bitte-lang-genug-xxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
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

const admin = client(); const leitung = client(); const fachlehrer = client(); const fremd = client();
let klasseId, fachId, adler, berger;

test('Vorbereitung: Klasse mit Klassenleitung und einer Fachlehrkraft, eine fremde Lehrkraft', async () => {
  await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;
  const personen = [[leitung, 'leitung'], [fachlehrer, 'fachlehrer'], [fremd, 'fremd']];
  for (const [, n] of personen) await form(admin, '/admin/einladungen/neu', { display_name: n, ttl_days: '14' });
  const invs = getDb().prepare('SELECT token FROM invitations ORDER BY id').all();
  for (const [i, [c, n]] of personen.entries()) {
    await form(c, `/einladung/${invs[i].token}`, { username: n, display_name: n, password: 'passwort1234', password2: 'passwort1234' });
  }
  getDb().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'leitung'").run();
  await form(leitung, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '11A', notenschluessel: 'IHK' });
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '11A'").get().id;
  await form(leitung, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Physik' });
  fachId = getDb().prepare("SELECT id FROM faecher WHERE name = 'Physik'").get().id;
  const uid = getDb().prepare("SELECT id FROM users WHERE username = 'fachlehrer'").get().id;
  getDb().prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)').run(uid, fachId);
  await form(leitung, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Adlr', vorname: 'Anna' });
  await form(leitung, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Berger', vorname: 'Ben' });
  adler = getDb().prepare("SELECT id FROM schueler WHERE nachname = 'Adlr'").get().id;
  berger = getDb().prepare("SELECT id FROM schueler WHERE nachname = 'Berger'").get().id;
  getDb().prepare('INSERT INTO schueler_notizen (schueler_id, text) VALUES (?, ?)').run(adler, 'Notiz bleibt');
});

test('Fachlehrkraft (nicht Klassenleitung) sieht „Name ändern“ und korrigiert den Namen für alle', async () => {
  let html = await (await fachlehrer(`/teacher/klassen/${klasseId}`)).text();
  assert.match(html, new RegExp(`data-umbenennen data-sid="${adler}" data-nachname="Adlr" data-vorname="Anna"`));
  assert.match(html, /id="umbenennen-dialog"/);
  assert.ok(!html.includes('data-versetzen data-sid'), 'Versetzen bleibt der Klassenleitung vorbehalten');

  const r = await form(fachlehrer, `/teacher/schueler/${adler}/umbenennen`, { nachname: '  Adler ', vorname: 'Anna' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `/teacher/klassen/${klasseId}`);
  const row = getDb().prepare('SELECT nachname, vorname, klasse_id FROM schueler WHERE id = ?').get(adler);
  assert.deepEqual({ ...row }, { nachname: 'Adler', vorname: 'Anna', klasse_id: klasseId });

  // Klassenleitung sieht den korrigierten Namen sofort; Notiz/ID unverändert
  html = await (await leitung(`/teacher/klassen/${klasseId}`)).text();
  assert.match(html, /<td>Adler<\/td>/);
  assert.ok(!html.includes('<td>Adlr</td>'));
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM schueler_notizen WHERE schueler_id = ?').get(adler).n, 1);
  const fachSeite = await (await fachlehrer(`/teacher/fach/${fachId}`)).text();
  assert.ok(fachSeite.includes('Adler') && !fachSeite.includes('Adlr'));
});

test('Ablehnungen: leer, doppelter Name, fremde Lehrkraft, unbekannte Person', async () => {
  let r = await form(leitung, `/teacher/schueler/${adler}/umbenennen`, { nachname: '', vorname: 'Anna' });
  assert.equal(r.status, 302);
  r = await form(leitung, `/teacher/schueler/${adler}/umbenennen`, { nachname: 'berger', vorname: ' ben ' });
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare('SELECT nachname FROM schueler WHERE id = ?').get(adler).nachname, 'Adler', 'doppelter Name wird nicht übernommen');
  r = await form(leitung, `/teacher/schueler/${adler}/umbenennen`, { nachname: 'X'.repeat(101), vorname: 'Anna' });
  assert.equal(getDb().prepare('SELECT nachname FROM schueler WHERE id = ?').get(adler).nachname, 'Adler');

  r = await form(fremd, `/teacher/schueler/${adler}/umbenennen`, { nachname: 'Hacker', vorname: 'X' });
  assert.equal(r.status, 403);
  assert.equal(getDb().prepare('SELECT nachname FROM schueler WHERE id = ?').get(adler).nachname, 'Adler');
  const fremdHtml = await (await fremd('/teacher/klassen')).text();
  assert.ok(!fremdHtml.includes('data-umbenennen data-sid'));

  r = await form(leitung, '/teacher/schueler/99999/umbenennen', { nachname: 'A', vorname: 'B' });
  assert.equal(r.status, 302);
});

test('Nur Groß-/Kleinschreibung der eigenen Person ändern ist erlaubt', async () => {
  const r = await form(leitung, `/teacher/schueler/${berger}/umbenennen`, { nachname: 'BERGER', vorname: 'Ben' });
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare('SELECT nachname FROM schueler WHERE id = ?').get(berger).nachname, 'BERGER');
});

test('Admin: Umbenennen auf der Admin-Klassenseite, Rücksprung dorthin', async () => {
  const html = await (await admin(`/admin/klassen/${klasseId}`)).text();
  assert.match(html, new RegExp(`action="/teacher/schueler/${adler}/umbenennen"`));
  const r = await form(admin, `/teacher/schueler/${adler}/umbenennen`, { nachname: 'Adler', vorname: 'Anne', zurueck: 'admin' });
  assert.equal(r.headers.get('location'), `/admin/klassen/${klasseId}`);
  assert.equal(getDb().prepare('SELECT vorname FROM schueler WHERE id = ?').get(adler).vorname, 'Anne');
});
