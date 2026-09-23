/**
 * End-to-End-Test der SPA-Zeugnisübersicht (routes/teacher.js
 * GET /teacher/klassen/:id/zeugnis -> klasse_zeugnis_spa.ejs): SPA_PIA-Klasse
 * anlegen, ein paar Noten über die echte Eingabemaske eintragen, dann prüfen,
 * dass die Übersicht sowohl das normale Halbjahr als auch das
 * Abschlusszeugnis (4. Hj., mit Mehrfachpositionen + Prüfungsblock) korrekt
 * live berechnet anzeigt -- sowie die Zugriffsbeschränkungen (nur
 * Klassenleitung/Admin, nur für SPA-Klassen).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-spa-zeugnis-test-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-spa-zeugnis-test-bitte-lang-genug';
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
let spaKlasseId;
let ihkKlasseId;
let schuelerId;
let lf1Id;

test('Vorbereitung: SPA_PIA-Klasse + eine IHK-Klasse, eine Person, ein paar Noten über die Eingabemaske', async () => {
  let r = await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  assert.equal(r.status, 302);
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2026/27' });
  const sj = getDb().prepare('SELECT id FROM schuljahre').get();

  r = await form(admin, '/teacher/klassen/neu', {
    schuljahr_id: String(sj.id), name: '13SPA1', notenschluessel: 'SPA', spa_bildungsgang: 'SPA_PIA', offen_fuer_beitritt: '1',
  });
  assert.equal(r.status, 302);
  spaKlasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '13SPA1'").get().id;

  r = await form(admin, '/teacher/klassen/neu', {
    schuljahr_id: String(sj.id), name: '13BFI1', notenschluessel: 'IHK', offen_fuer_beitritt: '1',
  });
  assert.equal(r.status, 302);
  ihkKlasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '13BFI1'").get().id;

  lf1Id = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND spa_fach_key = 'LF1'").get(spaKlasseId).id;
  const praxisId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND spa_fach_key = 'PRAXIS'").get(spaKlasseId).id;
  const blockpraxisId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND spa_fach_key = 'BLOCKPRAXIS'").get(spaKlasseId).id;

  r = await form(admin, `/teacher/klassen/${spaKlasseId}/schueler/neu`, { nachname: 'Musterfrau', vorname: 'Maxi' });
  assert.equal(r.status, 302);
  schuelerId = getDb().prepare('SELECT id FROM schueler WHERE nachname = ?').get('Musterfrau').id;

  await form(admin, `/teacher/fach/${lf1Id}/spa/eingabe`, { schueler_id: String(schuelerId), halbjahr: '1', feld: 'direktwert', wert: '10' });
  await form(admin, `/teacher/fach/${lf1Id}/spa/eingabe`, { schueler_id: String(schuelerId), halbjahr: '2', feld: 'direktwert', wert: '12' });
  await form(admin, `/teacher/fach/${praxisId}/spa/eingabe`, { schueler_id: String(schuelerId), halbjahr: '2', feld: 'direktwert', wert: '12' });
  await form(admin, `/teacher/fach/${praxisId}/spa/eingabe`, { schueler_id: String(schuelerId), halbjahr: '4', feld: 'direktwert', wert: '13' });
  await form(admin, `/teacher/fach/${blockpraxisId}/spa/eingabe`, { schueler_id: String(schuelerId), halbjahr: '3', feld: 'direktwert', wert: '9' });
});

test('GET /teacher/klassen/:id/zeugnis (2. Hj.) zeigt live berechnete Endnoten je Fach', async () => {
  const r = await admin(`/teacher/klassen/${spaKlasseId}/zeugnis?hj=2`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('Musterfrau'));
  assert.ok(html.includes('Lernfeld 1'));
  assert.ok(html.includes('11.00')); // LF1 2. Hj.: 0,5*10 + 0,5*12
  assert.ok(html.includes('12.00')); // Praxis 2. Hj.
});

test('GET /teacher/klassen/:id/zeugnis (4. Hj.) zeigt das Abschlusszeugnis mit zwei Praxis-Positionen', async () => {
  const r = await admin(`/teacher/klassen/${spaKlasseId}/zeugnis?hj=4`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('Praxis (2. Hj.)'));
  assert.ok(html.includes('Praxis (4. Hj.)'));
  // Praxis 4. Hj.: 0,7*13 + 0,3*9 = 11.80
  assert.ok(html.includes('11.80'));
  assert.ok(html.includes('Abschlusszeugnis'));
});

test('GET /teacher/klassen/:id/zeugnis liefert 404 für eine IHK-Klasse', async () => {
  const r = await admin(`/teacher/klassen/${ihkKlasseId}/zeugnis`);
  assert.equal(r.status, 404);
});

test('Zugriffsschutz: Lehrkraft ohne Klassenleitung darf die Zeugnisübersicht nicht sehen', async () => {
  await form(admin, '/admin/einladungen/neu', { display_name: 'Lehrer C', ttl_days: '14' });
  const inv = getDb().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
  const lehrerC = client();
  await form(lehrerC, `/einladung/${inv.token}`, { username: 'lehrerc', display_name: 'Lehrer C', password: 'passwortC1', password2: 'passwortC1' });
  const r = await lehrerC(`/teacher/klassen/${spaKlasseId}/zeugnis`);
  assert.equal(r.status, 403);
});

test.after(async () => {
  await fastify.close();
});
