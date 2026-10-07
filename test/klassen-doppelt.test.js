/**
 * Eine Klasse läuft über mehrere Schuljahre -- sie darf nicht noch einmal
 * parallel unter demselben Namen entstehen (weder beim Anlegen noch beim
 * manuellen Hinzufügen einer Person zu einem Fach), sonst gibt es plötzlich
 * "zweimal dieselbe Klasse" mit unterschiedlichen Fächern.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

process.env.DB_PFAD = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-doppelt-')), 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-doppelt-test-bitte-lang-genug-xxxxxxxxxx';
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
  return req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
}

const admin = client();
const anzahl = (name) => getDb().prepare('SELECT COUNT(*) AS c FROM klassen WHERE name = ? AND ist_kurs_huelle = 0').get(name).c;
let sj24, sj25, sj28;

test('Vorbereitung: Schuljahre 2024/25, 2025/26, 2028/29; Klasse 11A (Einschulung 2024, 3 Jahre)', async () => {
  await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  for (const b of ['2024/25', '2025/26', '2028/29']) await form(admin, '/admin/schuljahre/neu', { bezeichnung: b });
  const id = (b) => getDb().prepare('SELECT id FROM schuljahre WHERE bezeichnung = ?').get(b).id;
  [sj24, sj25, sj28] = [id('2024/25'), id('2025/26'), id('2028/29')];
  await form(admin, '/teacher/klassen/neu', { schuljahr_id: String(sj24), name: '11A', notenschluessel: 'IHK', einschulung_jahr: '2024', anzahl_jahre: '3' });
  assert.equal(anzahl('11A'), 1);
});

test('Dieselbe Klasse wird im laufenden Schuljahr nicht noch einmal angelegt', async () => {
  const r = await form(admin, '/teacher/klassen/neu', { schuljahr_id: String(sj25), name: '11A', notenschluessel: 'IHK' });
  assert.equal(r.status, 302);
  assert.equal(anzahl('11A'), 1, 'keine zweite Klasse 11A');
  const klasse = getDb().prepare("SELECT id FROM klassen WHERE name = '11A'").get().id;
  assert.equal(r.headers.get('location'), `/teacher/klassen/${klasse}`, 'führt zur bestehenden Klasse');
});

test('Nach Ende der Laufzeit darf der Name für einen neuen Jahrgang wieder vergeben werden', async () => {
  await form(admin, '/teacher/klassen/neu', { schuljahr_id: String(sj28), name: '11A', notenschluessel: 'IHK' });
  assert.equal(anzahl('11A'), 2);
});

test('Manuell hinzugefügte Person: eine in dem Schuljahr laufende Klasse wird wiederverwendet, keine Doppelung', async () => {
  await form(admin, '/teacher/klassen/neu', { schuljahr_id: String(sj25), name: '12B', notenschluessel: 'IHK' });
  const b = getDb().prepare("SELECT id FROM klassen WHERE name = '12B'").get().id;
  await form(admin, `/teacher/klassen/${b}/faecher/neu`, { name: 'Mathe' });
  const fach = getDb().prepare('SELECT id FROM faecher WHERE klasse_id = ?').get(b).id;
  const r = await form(admin, `/teacher/fach/${fach}/teilnehmer/manuell`, { nachname: 'Test', vorname: 'Tom', klasse: '11A' });
  assert.equal(r.status, 302);
  assert.equal(anzahl('11A'), 2, 'die laufende 11A (2024/25-2026/27) wird genutzt, keine neue für 2025/26');
  const tom = getDb().prepare("SELECT klasse_id FROM schueler WHERE nachname = 'Test'").get();
  assert.equal(getDb().prepare('SELECT schuljahr_id FROM klassen WHERE id = ?').get(tom.klasse_id).schuljahr_id, sj24);
});

test.after(async () => {
  await fastify.close();
});
