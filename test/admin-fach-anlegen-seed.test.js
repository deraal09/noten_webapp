/**
 * Ein über die Admin-Oberfläche angelegtes Fach (POST
 * /admin/klassen/:id/faecher/neu) muss dieselbe Teilnehmerliste bekommen wie
 * eins, das die Lehrkraft selbst anlegt (POST /teacher/klassen/:id/faecher/neu,
 * siehe src/routes/teacher.js) -- sonst bleibt die Notentafel leer, bis der
 * nächste Serverneustart die Lücke über die Migration (fuelleFachTeilnehmerAuf()
 * in src/db.js) nachträglich schließt. Genau dieser Unterschied fiel bislang
 * durch alle Tests, weil der bestehende E2E-Smoketest die Schülerin ERST NACH
 * dem Fach anlegt -- das läuft über den separaten Auto-Beitritt in
 * src/schueler-utils.js, nicht über die Seedung beim Fach-Anlegen selbst.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-admin-fach-seed-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-admin-fach-seed-test-bitte-lang-genug';
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

const admin = client();

test('Admin legt Klasse mit Schüler:innen an, dann ein Fach -- die Notentafel zeigt sie sofort', async () => {
  await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
  });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;
  await form(admin, `/admin/schuljahre/${sjId}/klassen/neu`, { name: '10A', notenschluessel: 'IHK' });
  const klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '10A'").get().id;

  // Schüler:innen VOR dem Fach anlegen -- die Reihenfolge, die den Bug
  // aufgedeckt hat (der bestehende E2E-Smoketest legt sie danach an).
  await form(admin, `/admin/klassen/${klasseId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
  await form(admin, `/admin/klassen/${klasseId}/schueler/neu`, { nachname: 'Berg', vorname: 'Ben' });

  await form(admin, `/admin/klassen/${klasseId}/faecher/neu`, { name: 'Mathe' });
  const fachId = getDb().prepare("SELECT id FROM faecher WHERE name = 'Mathe'").get().id;

  const teilnehmer = getDb().prepare('SELECT schueler_id FROM fach_teilnehmer WHERE fach_id = ?').all(fachId);
  assert.equal(teilnehmer.length, 2, 'beide Schüler:innen der Klasse müssen sofort in fach_teilnehmer stehen');
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
