/**
 * Erweiterung von /admin/klassen/:id/notenschluessel um SPA (siehe auch
 * klasse-notenschluessel-aendern.test.js für den unveränderten IHK/BG-Teil):
 *
 * - Der Admin kann eine noch fächerlose IHK/BG-Klasse auf SPA umstellen,
 *   inklusive Pflicht-Bildungsgang -- die festen Fächer werden dabei
 *   automatisch angelegt (siehe src/spa-noten-service.js, seedeSpaFaecher).
 * - Sobald die Klasse eigene Fächer hat, steht SPA nicht mehr zur Wahl.
 * - Eine bereits-SPA-Klasse lässt sich gar nicht mehr umstellen (weder der
 *   Notenschlüssel noch der Bildungsgang) -- konsistent mit der beim
 *   Anlegen kommunizierten Unveränderlichkeit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-admin-ns-spa-test-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-admin-ns-spa-test-bitte-lang-genug';
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
let sjId;
let leereKlasseId;
let belegteKlasseId;

test('Vorbereitung: Admin, Schuljahr, zwei IHK-Klassen (eine mit, eine ohne Fach)', async () => {
  let r = await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  assert.equal(r.status, 302);
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2026/27' });
  sjId = getDb().prepare('SELECT id FROM schuljahre').get().id;

  await form(admin, `/admin/schuljahre/${sjId}/klassen/neu`, { name: '13LEER', notenschluessel: 'IHK' });
  leereKlasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '13LEER'").get().id;

  await form(admin, `/admin/schuljahre/${sjId}/klassen/neu`, { name: '13BELEGT', notenschluessel: 'IHK' });
  belegteKlasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '13BELEGT'").get().id;
  await form(admin, `/admin/klassen/${belegteKlasseId}/faecher/neu`, { name: 'Deutsch' });
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM faecher WHERE klasse_id = ?').get(belegteKlasseId).c, 1);
});

test('GET /admin/klassen/:id/notenschluessel bietet SPA nur für die fächerlose Klasse an', async () => {
  let html = await (await admin(`/admin/klassen/${leereKlasseId}/notenschluessel`)).text();
  assert.ok(html.includes('SPA (Sozialpädagogische Assistenz)'));

  html = await (await admin(`/admin/klassen/${belegteKlasseId}/notenschluessel`)).text();
  assert.ok(!html.includes('value="SPA"'));
  assert.ok(html.includes('steht hier nicht zur Wahl'));
});

test('POST auf SPA ohne Bildungsgang wird abgelehnt, Klasse bleibt unverändert', async () => {
  const r = await form(admin, `/admin/klassen/${leereKlasseId}/notenschluessel`, { notenschluessel: 'SPA', csv: '' });
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare('SELECT notenschluessel FROM klassen WHERE id = ?').get(leereKlasseId).notenschluessel, 'IHK');
});

test('POST auf SPA mit Bildungsgang stellt die fächerlose Klasse um und seedet die festen Fächer', async () => {
  const r = await form(admin, `/admin/klassen/${leereKlasseId}/notenschluessel`, {
    notenschluessel: 'SPA', spa_bildungsgang: 'SPA_REGULAR', csv: '',
  });
  assert.equal(r.status, 302);
  const klasse = getDb().prepare('SELECT * FROM klassen WHERE id = ?').get(leereKlasseId);
  assert.equal(klasse.notenschluessel, 'SPA');
  assert.equal(klasse.spa_bildungsgang, 'SPA_REGULAR');

  const faecher = getDb().prepare("SELECT spa_fach_key FROM faecher WHERE klasse_id = ?").all(leereKlasseId);
  assert.equal(faecher.length, 11); // SPA_REGULAR ohne Blockpraxis
  assert.ok(!faecher.some((f) => f.spa_fach_key === 'BLOCKPRAXIS'));
});

test('Bereits vorhandene Schüler/innen werden bei der Umstellung sofort Teilnehmer/innen der neuen SPA-Fächer', async () => {
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2027/28' });
  const sj2 = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2027/28'").get().id;
  await form(admin, `/admin/schuljahre/${sj2}/klassen/neu`, { name: 'MITSCHUELERN', notenschluessel: 'IHK' });
  const klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = 'MITSCHUELERN'").get().id;
  await form(admin, `/admin/klassen/${klasseId}/schueler/neu`, { nachname: 'Vorher', vorname: 'Schon Da' });
  const schuelerId = getDb().prepare("SELECT id FROM schueler WHERE nachname = 'Vorher'").get().id;

  await form(admin, `/admin/klassen/${klasseId}/notenschluessel`, { notenschluessel: 'SPA', spa_bildungsgang: 'SPA_PIA', csv: '' });

  const lf1Id = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND spa_fach_key = 'LF1'").get(klasseId).id;
  assert.ok(getDb().prepare('SELECT 1 FROM fach_teilnehmer WHERE fach_id = ? AND schueler_id = ?').get(lf1Id, schuelerId));
});

test('Notenschlüssel einer SPA-Klasse ist gesperrt: GET zeigt Info statt Formular, POST wird abgelehnt', async () => {
  let html = await (await admin(`/admin/klassen/${leereKlasseId}/notenschluessel`)).text();
  assert.ok(html.includes('Notenschlüssel und Bildungsgang lassen sich'));
  assert.ok(!html.includes('<form'));

  const r = await form(admin, `/admin/klassen/${leereKlasseId}/notenschluessel`, { notenschluessel: 'IHK', csv: '' });
  assert.equal(r.status, 302);
  const klasse = getDb().prepare('SELECT notenschluessel, spa_bildungsgang FROM klassen WHERE id = ?').get(leereKlasseId);
  assert.equal(klasse.notenschluessel, 'SPA');
  assert.equal(klasse.spa_bildungsgang, 'SPA_REGULAR');
});

test.after(async () => {
  await fastify.close();
});
