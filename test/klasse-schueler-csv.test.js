/**
 * CSV-Datei-Upload für Schüler/innen einer Klasse (POST
 * /teacher/klassen/:id/schueler/csv) — Alternative zum automatischen
 * Untis-Import für Lehrkraft-Konten ohne die dafür nötigen API-Rechte
 * (siehe routes/untis-import.js). Einziger Endpunkt der App, der
 * multipart/form-data statt application/x-www-form-urlencoded annimmt.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-csv-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-csv-test-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');

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

async function uploadCsv(req, url, dateiInhalt, dateiname = 'schueler.csv') {
  const fd = new FormData();
  fd.append('datei', new Blob([dateiInhalt], { type: 'text/csv' }), dateiname);
  return req(url, { method: 'POST', body: fd });
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
  getDb().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'lehrera'").run();

  r = await form(lehrerA, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '9A', notenschluessel: 'IHK' });
  assert.equal(r.status, 302);
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '9A'").get().id;
});

test('CSV-Upload: Semikolon-getrennt mit Kopfzeile legt Schüler/innen an', async () => {
  const csv = 'Nachname;Vorname\nMüller;Anna\nSchmidt;Bernd\n';
  const r = await uploadCsv(lehrerA, `/teacher/klassen/${klasseId}/schueler/csv`, csv);
  assert.equal(r.status, 302);
  const html = await (await lehrerA(`/teacher/klassen/${klasseId}`)).text();
  assert.match(html, /2 Schüler/);
  const schueler = getDb().prepare('SELECT * FROM schueler WHERE klasse_id = ? ORDER BY nachname').all(klasseId);
  assert.equal(schueler.length, 2);
  assert.equal(schueler[0].nachname, 'Müller');
  assert.equal(schueler[0].vorname, 'Anna');
});

test('CSV-Upload: erneuter Upload derselben Datei legt niemanden doppelt an', async () => {
  const vorher = getDb().prepare('SELECT COUNT(*) AS c FROM schueler WHERE klasse_id = ?').get(klasseId).c;
  const csv = 'Nachname;Vorname\nMüller;Anna\nSchmidt;Bernd\n';
  const r = await uploadCsv(lehrerA, `/teacher/klassen/${klasseId}/schueler/csv`, csv);
  assert.equal(r.status, 302);
  const html = await (await lehrerA(`/teacher/klassen/${klasseId}`)).text();
  assert.match(html, /0 Schüler/);
  assert.match(html, /2 bereits vorhandene\(r\) übersprungen/);
  const nachher = getDb().prepare('SELECT COUNT(*) AS c FROM schueler WHERE klasse_id = ?').get(klasseId).c;
  assert.equal(nachher, vorher, 'kein zweiter Datensatz für Müller/Schmidt');
});

test('CSV-Upload: leere/unlesbare Datei erzeugt Fehlermeldung statt Absturz', async () => {
  const r = await uploadCsv(lehrerA, `/teacher/klassen/${klasseId}/schueler/csv`, '');
  assert.equal(r.status, 302);
  const html = await (await lehrerA(`/teacher/klassen/${klasseId}`)).text();
  assert.match(html, /konnten keine Schüler\/innen gelesen werden/);
});

test('CSV-Upload: ohne Klassen-Zugriff wird abgelehnt', async () => {
  const lehrerB = client();
  await form(client(), '/admin/einladungen/neu', { display_name: 'Lehrer B', ttl_days: '14' }).catch(() => {});
  const admin = client();
  await form(admin, '/login', { username: 'admin', password: 'adminpass123' });
  await form(admin, '/admin/einladungen/neu', { display_name: 'Lehrer B', ttl_days: '14' });
  const inv = getDb().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
  await form(lehrerB, `/einladung/${inv.token}`, {
    username: 'lehrerb', display_name: 'Lehrer B', password: 'passwortB1', password2: 'passwortB1',
  });
  const r = await uploadCsv(lehrerB, `/teacher/klassen/${klasseId}/schueler/csv`, 'Nachname;Vorname\nFremd;Fritz');
  assert.equal(r.status, 403);
});

test.after(async () => {
  await fastify.close();
});
