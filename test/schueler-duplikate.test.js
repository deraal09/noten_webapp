/**
 * Doppelte Schüler-Einträge werden verhindert: Nachname+Vorname (ohne
 * Rücksicht auf Groß-/Kleinschreibung oder Leerzeichen am Rand) darf
 * innerhalb derselben Klasse nur einmal vorkommen — egal ob per
 * Einzeleingabe, Sammel-Einfügen oder CSV-Upload angelegt (siehe
 * src/schueler-utils.js, verwendet von routes/teacher.js, routes/admin.js
 * und routes/untis-import.js).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-duplikate-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-duplikate-test-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { schuelerExistiertBereits, fuegeSchuelerHinzuFallsNeu } = await import('../src/schueler-utils.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });

function client() {
  const cookies = new Map();
  function setCookie(setCookieHeader) {
    if (!setCookieHeader) return;
    const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    for (const raw of arr) {
      const [pair] = raw.split(';');
      const [k, ...v] = pair.split('=');
      cookies.set(k.trim(), v.join('=').trim());
    }
  }
  return async function req(url, opts = {}) {
    const headers = { ...opts.headers };
    if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(base + url, { ...opts, headers, redirect: 'manual' });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : r.headers.get('set-cookie');
    if (sc) setCookie(sc);
    return r;
  };
}

async function form(req, url, body) {
  return req(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
}

const lehrerA = client();
let sjId;
let klasseId;

test('Vorbereitung: Admin, Schuljahr, Lehrkraft, Klasse', async () => {
  const admin = client();
  let r = await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
  });
  assert.equal(r.status, 302);
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;

  await form(admin, '/admin/einladungen/neu', { display_name: 'Lehrer A', ttl_days: '14' });
  const inv = getDb().prepare('SELECT token FROM invitations ORDER BY id').get();
  r = await form(lehrerA, `/einladung/${inv.token}`, {
    username: 'lehrera', display_name: 'Lehrer A', password: 'passwortA1', password2: 'passwortA1',
  });
  assert.equal(r.status, 302);

  r = await form(lehrerA, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '9A', notenschluessel: 'IHK' });
  assert.equal(r.status, 302);
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '9A'").get().id;
});

test('schuelerExistiertBereits: erkennt Duplikate unabhängig von Groß-/Kleinschreibung und Leerzeichen', () => {
  fuegeSchuelerHinzuFallsNeu(klasseId, 'Müller', 'Anna');
  assert.equal(schuelerExistiertBereits(klasseId, 'Müller', 'Anna'), true);
  assert.equal(schuelerExistiertBereits(klasseId, '  müller  ', '  ANNA '), true);
  assert.equal(schuelerExistiertBereits(klasseId, 'Müller', 'Bernd'), false);
  assert.equal(schuelerExistiertBereits(klasseId, 'Schmidt', 'Anna'), false);
});

test('fuegeSchuelerHinzuFallsNeu: legt nur beim ersten Mal an, gibt false bei Duplikat zurück', () => {
  const vorher = getDb().prepare('SELECT COUNT(*) AS c FROM schueler WHERE klasse_id = ?').get(klasseId).c;
  const ersterVersuch = fuegeSchuelerHinzuFallsNeu(klasseId, 'Berger', 'Ben');
  const zweiterVersuch = fuegeSchuelerHinzuFallsNeu(klasseId, 'Berger', 'Ben');
  assert.equal(ersterVersuch, true);
  assert.equal(zweiterVersuch, false);
  const nachher = getDb().prepare('SELECT COUNT(*) AS c FROM schueler WHERE klasse_id = ?').get(klasseId).c;
  assert.equal(nachher, vorher + 1);
});

test('Einzeleingabe (Teacher-Route): zweiter Versuch mit gleichem Namen legt niemanden doppelt an', async () => {
  await form(lehrerA, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Cortes', vorname: 'Clara' });
  const vorher = getDb().prepare('SELECT COUNT(*) AS c FROM schueler WHERE klasse_id = ?').get(klasseId).c;
  const r = await form(lehrerA, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Cortes', vorname: 'Clara' });
  assert.equal(r.status, 302);
  const nachher = getDb().prepare('SELECT COUNT(*) AS c FROM schueler WHERE klasse_id = ?').get(klasseId).c;
  assert.equal(nachher, vorher, 'keine zweite Clara Cortes angelegt');
  const html = await (await lehrerA(`/teacher/klassen/${klasseId}`)).text();
  assert.match(html, /bereits vorhanden/);
});

test('Sammel-Einfügen (Teacher-Route): bereits vorhandene Namen werden übersprungen, neue trotzdem angelegt', async () => {
  await form(lehrerA, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Dietz', vorname: 'Dana' });
  const vorher = getDb().prepare('SELECT COUNT(*) AS c FROM schueler WHERE klasse_id = ?').get(klasseId).c;
  const r = await form(lehrerA, `/teacher/klassen/${klasseId}/schueler/bulk`, {
    text: 'Dietz, Dana\nEbert, Erik',
  });
  assert.equal(r.status, 302);
  const nachher = getDb().prepare('SELECT COUNT(*) AS c FROM schueler WHERE klasse_id = ?').get(klasseId).c;
  assert.equal(nachher, vorher + 1, 'nur Erik Ebert ist neu, Dana Dietz war schon da');
  const html = await (await lehrerA(`/teacher/klassen/${klasseId}`)).text();
  assert.match(html, /bereits vorhandene.*übersprungen/);
});

test.after(async () => {
  await fastify.close();
});
