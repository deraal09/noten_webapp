/**
 * Sitzpläne je Raum: Eine Klasse sitzt im Computerraum anders als im
 * Klassenraum — deshalb hat jede Lehrkraft je Klasse UND Raum einen eigenen
 * Entwurf, und geteilt wird ebenfalls je Raum (src/routes/sitzplan.js).
 *
 * Anfragen ohne Raum landen bei raum = '' ("ohne Raumangabe"), wie alle
 * Pläne aus der Zeit vor der Raumangabe — bestehende Aufrufe laufen damit
 * unverändert weiter (siehe test/sitzplan.test.js).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-sitzplan-raeume-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-sitzplan-raeume-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { hashPassword } = await import('../src/auth.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });

function client() {
  const cookies = new Map();
  return async function req(url, opts = {}) {
    const headers = { ...opts.headers };
    if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(base + url, { ...opts, headers, redirect: 'manual' });
    for (const raw of r.headers.getSetCookie()) {
      const [k, ...v] = raw.split(';')[0].split('=');
      cookies.set(k.trim(), v.join('=').trim());
    }
    return r;
  };
}
const form = (req, url, body) => req(url, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body),
});

const db = () => getDb();
const lehrerA = client();
const lehrerB = client();
let klasseId;
let idA;
let idB;
const plan = (text) => JSON.stringify([{ id: 'p1', x: 10, y: 10, text }]);
const url = (raum) => `/teacher/klassen/${klasseId}/sitzplan?raum=${encodeURIComponent(raum)}`;
const entwurf = (userId, raum) => db().prepare('SELECT * FROM sitzplaene WHERE klasse_id = ? AND owner_id = ? AND raum = ?')
  .get(klasseId, userId, raum);
const geteiltFuer = (raum) => db().prepare('SELECT * FROM sitzplan_geteilt WHERE klasse_id = ? AND raum = ?').get(klasseId, raum);

test('Vorbereitung: Klasse mit zwei Lehrkräften', async () => {
  const admin = client();
  let r = await form(admin, '/setup', { username: 'admin', display_name: 'A', password: 'geheim12', password2: 'geheim12' });
  assert.equal(r.status, 302);
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2026/27' });
  const sjId = db().prepare('SELECT id FROM schuljahre').get().id;
  await form(admin, `/admin/schuljahre/${sjId}/klassen/neu`, { name: '10A', notenschluessel: 'IHK' });
  klasseId = db().prepare("SELECT id FROM klassen WHERE name = '10A'").get().id;
  const fachId = db().prepare('INSERT INTO faecher (klasse_id, name) VALUES (?, ?)').run(klasseId, 'Mathe').lastInsertRowid;
  for (const [name, req] of [['lehrer-a', lehrerA], ['lehrer-b', lehrerB]]) {
    const id = db().prepare(`INSERT INTO users (username, display_name, password_hash, role, active)
                             VALUES (?, ?, ?, 'teacher', 1)`).run(name, name, hashPassword('geheim12')).lastInsertRowid;
    db().prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)').run(id, fachId);
    r = await form(req, '/login', { username: name, password: 'geheim12' });
    assert.equal(r.headers.get('location'), '/');
  }
  idA = db().prepare("SELECT id FROM users WHERE username = 'lehrer-a'").get().id;
  idB = db().prepare("SELECT id FROM users WHERE username = 'lehrer-b'").get().id;
});

test('Ohne Raumangabe gespeichert landet der Plan unter raum = \'\' (wie bisher)', async () => {
  const r = await form(lehrerA, `/teacher/klassen/${klasseId}/sitzplan/speichern`, { plaetze: plan('Alt-Plan') });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(entwurf(idA, '').plaetze)[0].text, 'Alt-Plan');
});

test('Mehrere Räume je Klasse: jeder Raum hat seinen eigenen Plan', async () => {
  await form(lehrerA, `/teacher/klassen/${klasseId}/sitzplan/speichern`, { raum: 'A 204', plaetze: plan('Plan-A204') });
  await form(lehrerA, `/teacher/klassen/${klasseId}/sitzplan/speichern`, { raum: 'Computerraum', plaetze: plan('Plan-PC') });
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM sitzplaene WHERE owner_id = ?').get(idA).c, 3);

  const html = await (await lehrerA(url('Computerraum'))).text();
  assert.match(html, /Plan-PC/);
  assert.doesNotMatch(html, /Plan-A204/, 'nur der Plan des gewählten Raums gehört in den Editor');
  // Alle Räume stehen als Reiter zur Auswahl.
  for (const raum of ['A 204', 'Computerraum', 'ohne Raumangabe']) assert.ok(html.includes(`>${raum}<`), `Reiter ${raum}`);
});

test('Gleicher Raum in anderer Schreibweise ist derselbe Plan', async () => {
  await form(lehrerA, `/teacher/klassen/${klasseId}/sitzplan/speichern`, { raum: 'computerraum', plaetze: plan('Plan-PC-2') });
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM sitzplaene WHERE owner_id = ?').get(idA).c, 3);
  assert.equal(JSON.parse(entwurf(idA, 'Computerraum').plaetze)[0].text, 'Plan-PC-2');
  assert.equal(entwurf(idA, 'Computerraum').raum, 'Computerraum', 'die ursprüngliche Schreibweise bleibt');
});

test('Ohne ?raum öffnet die Seite den zuletzt bearbeiteten Raum', async () => {
  db().prepare("UPDATE sitzplaene SET updated_at = '2000-01-01' WHERE owner_id = ?").run(idA);
  db().prepare("UPDATE sitzplaene SET updated_at = datetime('now') WHERE owner_id = ? AND raum = 'A 204'").run(idA);
  const html = await (await lehrerA(`/teacher/klassen/${klasseId}/sitzplan`)).text();
  assert.match(html, /Raum: <strong>A 204<\/strong>/);
});

test('Ein neuer Raum entsteht erst mit dem ersten Speichern', async () => {
  const html = await (await lehrerA(url('Turnhalle'))).text();
  assert.match(html, /Turnhalle <small>\(neu\)<\/small>/);
  assert.equal(entwurf(idA, 'Turnhalle'), undefined);
});

test('Teilen je Raum: übertragen und übernehmen betreffen nur den gewählten Raum', async () => {
  let r = await form(lehrerA, `/teacher/klassen/${klasseId}/sitzplan/uebertragen`, { raum: 'A 204' });
  assert.equal(r.headers.get('location'), url('A 204'));
  assert.equal(JSON.parse(geteiltFuer('A 204').plaetze)[0].text, 'Plan-A204');
  assert.equal(geteiltFuer('Computerraum'), undefined);

  // B sieht den geteilten Plan nur unter "A 204" …
  let html = await (await lehrerB(url('A 204'))).text();
  assert.match(html, /Zuletzt an alle Lehrkräfte übertragen/);
  html = await (await lehrerB(url('Computerraum'))).text();
  assert.match(html, /Noch kein Sitzplan an andere Lehrkräfte dieser Klasse übertragen/);

  // … und übernimmt ihn als eigenen Entwurf für genau diesen Raum.
  r = await form(lehrerB, `/teacher/klassen/${klasseId}/sitzplan/uebernehmen`, { raum: 'A 204' });
  assert.equal(r.status, 302);
  assert.equal(JSON.parse(entwurf(idB, 'A 204').plaetze)[0].text, 'Plan-A204');
  assert.equal(entwurf(idB, ''), undefined);
});

test('Umbenennen: Raumangabe für einen Altplan nachtragen, selbst geteilter Stand zieht mit', async () => {
  await form(lehrerA, `/teacher/klassen/${klasseId}/sitzplan/uebertragen`, { raum: '' });
  const r = await form(lehrerA, `/teacher/klassen/${klasseId}/sitzplan/raum-umbenennen`, { raum: '', neuer_raum: '  Klassenraum   B 1 ' });
  assert.equal(r.headers.get('location'), url('Klassenraum B 1'), 'Leerraum wird zusammengefasst');
  assert.equal(entwurf(idA, ''), undefined);
  assert.equal(JSON.parse(entwurf(idA, 'Klassenraum B 1').plaetze)[0].text, 'Alt-Plan');
  assert.ok(geteiltFuer('Klassenraum B 1'), 'der von A geteilte Stand wandert mit');
  assert.equal(geteiltFuer(''), undefined);
});

test('Umbenennen auf einen schon belegten Raum wird abgelehnt', async () => {
  const r = await form(lehrerA, `/teacher/klassen/${klasseId}/sitzplan/raum-umbenennen`, { raum: 'Computerraum', neuer_raum: 'a 204' });
  assert.equal(r.headers.get('location'), url('Computerraum'));
  assert.ok(entwurf(idA, 'Computerraum'), 'nichts verändert');
  const html = await (await lehrerA(url('Computerraum'))).text();
  assert.match(html, /gibt es schon einen Sitzplan/);
});

test('Umbenennen verschiebt keinen Plan, den eine andere Lehrkraft geteilt hat', async () => {
  // B benennt seinen Entwurf "A 204" um; den von A geteilten Stand darf das nicht mitnehmen.
  await form(lehrerB, `/teacher/klassen/${klasseId}/sitzplan/raum-umbenennen`, { raum: 'A 204', neuer_raum: 'Raum 204' });
  assert.ok(entwurf(idB, 'Raum 204'));
  assert.ok(geteiltFuer('A 204'), 'As geteilter Plan bleibt unter "A 204"');
  assert.equal(geteiltFuer('A 204').geteilt_von_id, idA);
});

test('Löschen: eigener Entwurf und selbst geteilter Stand weg, fremd geteilter Plan bleibt', async () => {
  // B teilt "Computerraum" (leer), A hat dort einen eigenen Entwurf.
  await form(lehrerB, `/teacher/klassen/${klasseId}/sitzplan/uebertragen`, { raum: 'Computerraum' });
  let r = await form(lehrerA, `/teacher/klassen/${klasseId}/sitzplan/raum-loeschen`, { raum: 'Computerraum' });
  assert.equal(r.status, 302);
  assert.equal(entwurf(idA, 'Computerraum'), undefined);
  assert.ok(geteiltFuer('Computerraum'), 'Bs geteilter Plan bleibt');

  // A löscht "A 204": eigener Entwurf und As geteilter Stand verschwinden, Bs Entwurf "Raum 204" nicht.
  r = await form(lehrerA, `/teacher/klassen/${klasseId}/sitzplan/raum-loeschen`, { raum: 'A 204' });
  assert.equal(entwurf(idA, 'A 204'), undefined);
  assert.equal(geteiltFuer('A 204'), undefined);
  assert.ok(entwurf(idB, 'Raum 204'));
});

test('Ungültige Raumangaben werden abgelehnt', async () => {
  const zuLang = 'x'.repeat(41);
  let r = await form(lehrerA, `/teacher/klassen/${klasseId}/sitzplan/speichern`, { raum: zuLang, plaetze: '[]' });
  assert.equal(r.status, 400);
  r = await lehrerA(url(zuLang));
  assert.equal(r.status, 400);
  r = await form(lehrerA, `/teacher/klassen/${klasseId}/sitzplan/raum-umbenennen`, { raum: 'Klassenraum B 1', neuer_raum: '   ' });
  assert.ok(entwurf(idA, 'Klassenraum B 1'), 'leerer neuer Name ändert nichts');
});

test('Raumname mit "</script>" bricht nicht aus dem Skript aus', async () => {
  const boese = '</script><script>x()</script>';
  await form(lehrerA, `/teacher/klassen/${klasseId}/sitzplan/speichern`, { raum: boese, plaetze: '[]' });
  const html = await (await lehrerA(url(boese))).text();
  assert.ok(!html.includes(boese), 'der Raumname darf nirgends unmaskiert im Quelltext stehen');
});

test('Übersicht "Sitzpläne" nennt die Räume je Klasse', async () => {
  const html = await (await lehrerA('/teacher/sitzplaene')).text();
  assert.match(html, /Klassenraum B 1/);
  assert.ok(html.includes(url('Klassenraum B 1')), 'mit Link auf den Raum');
});

test('Ohne Klassenzugriff: auch Umbenennen und Löschen verboten', async () => {
  const fremd = client();
  db().prepare(`INSERT INTO users (username, display_name, password_hash, role, active)
                VALUES ('fremd', 'F', ?, 'teacher', 1)`).run(hashPassword('geheim12'));
  await form(fremd, '/login', { username: 'fremd', password: 'geheim12' });
  assert.equal((await form(fremd, `/teacher/klassen/${klasseId}/sitzplan/raum-umbenennen`, { raum: 'Raum 204', neuer_raum: 'X' })).status, 403);
  assert.equal((await form(fremd, `/teacher/klassen/${klasseId}/sitzplan/raum-loeschen`, { raum: 'Raum 204' })).status, 403);
  assert.ok(entwurf(idB, 'Raum 204'));
});

test('Sitzplatz-Felder: Name wird nicht mehr abgeschnitten (Aufbau von CSS und Skript)', () => {
  // Im Browser nachgestellt: Sobald die Klasse Schüler/innen hat, bekommt
  // das Namensfeld eine Vorschlagsliste, und Chrome blendet dann INNERHALB
  // des Feldes einen Aufklapp-Pfeil ein — der schnitt jeden Namen um rund
  // 16–20 px ab, auch kurze. Außerdem deckelte max-width: 220px den Platz,
  // sodass lange Namen über den Rand liefen. Die Testsuite hat keinen
  // Browser; das hier hält die drei Bausteine der Lösung fest.
  const css = fs.readFileSync(new URL('../static/css/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.platz-name::-webkit-calendar-picker-indicator\s*\{\s*display:\s*none/);
  const platzRegel = /\n\.platz \{([^}]*)\}/.exec(css)[1].replace(/\/\*[\s\S]*?\*\//g, ''); // Kommentare ignorieren
  assert.doesNotMatch(platzRegel, /max-width\s*:/, 'der Platz muss mit dem Namensfeld mitwachsen');
  const vorlage = fs.readFileSync(new URL('../views/teacher/sitzplan.ejs', import.meta.url), 'utf8');
  assert.match(vorlage, /input\.scrollWidth - input\.clientWidth/, 'Nachmessen am echten Feld fängt Browser-Eigenheiten ab');
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
