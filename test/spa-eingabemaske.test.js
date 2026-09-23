/**
 * End-to-End-Test der SPA-Eingabemaske (routes/teacher.js /fach/:id ->
 * fach_detail_spa.ejs + /fach/:id/spa/eingabe + /fach/:id/spa/daten):
 * Klasse mit Bildungsgang SPA_PIA anlegen (seedet automatisch alle SPA-
 * Fächer, siehe klassen-liste-reiter.test.js für die Klassenanlage selbst),
 * dann für ein Direktwert-Fach (LF1) und ein Komponenten-Fach (LF2) Werte
 * über den echten HTTP-Endpunkt eintragen und prüfen, dass sowohl die
 * serverseitig gerenderte Seite als auch der JSON-Refresh-Endpunkt die
 * korrekt berechnete Zwischennote/Endpunkte/Tendenz zeigen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-spa-eingabemaske-test-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-spa-eingabemaske-test-bitte-lang-genug';
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
let klasseId;
let lf1Id;
let lf2Id;
let schuelerId;

test('Vorbereitung: Admin, Schuljahr, SPA_PIA-Klasse (auto-geseedete Fächer), eine Person', async () => {
  let r = await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  assert.equal(r.status, 302);
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2026/27' });
  const sj = getDb().prepare('SELECT id FROM schuljahre').get();

  r = await form(admin, '/teacher/klassen/neu', {
    schuljahr_id: String(sj.id), name: '13SPA1', notenschluessel: 'SPA', spa_bildungsgang: 'SPA_PIA', offen_fuer_beitritt: '1',
  });
  assert.equal(r.status, 302);
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '13SPA1'").get().id;
  lf1Id = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND spa_fach_key = 'LF1'").get(klasseId).id;
  lf2Id = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND spa_fach_key = 'LF2'").get(klasseId).id;

  r = await form(admin, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Musterfrau', vorname: 'Maxi' });
  assert.equal(r.status, 302);
  schuelerId = getDb().prepare('SELECT id FROM schueler WHERE nachname = ?').get('Musterfrau').id;
  // Neu angelegte Person muss automatisch Teilnehmerin der schon vorhandenen SPA-Fächer sein.
  assert.ok(getDb().prepare('SELECT 1 FROM fach_teilnehmer WHERE fach_id = ? AND schueler_id = ?').get(lf1Id, schuelerId));
});

test('GET /teacher/fach/:id zeigt für ein SPA-Fach die eigene Eingabemaske (nicht die normale Notentafel)', async () => {
  const r = await admin(`/teacher/fach/${lf1Id}`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('SPA-Fach mit festem Bewertungsschema'));
  assert.ok(html.includes('Musterfrau'));
  assert.ok(html.includes('data-feld="direktwert"'));
});

test('LF1 (Direktwert): Eintragen über /spa/eingabe berechnet sofort Zwischennote/Endpunkte/Tendenz', async () => {
  let r = await form(admin, `/teacher/fach/${lf1Id}/spa/eingabe`, {
    schueler_id: String(schuelerId), halbjahr: '1', feld: 'direktwert', wert: '12',
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });

  r = await admin(`/teacher/fach/${lf1Id}/spa/daten?hj=1`);
  const data = await r.json();
  const zeile = data.schueler.find((s) => s.schueler_id === schuelerId);
  assert.equal(zeile.zwischennote, 12);
  assert.equal(zeile.endpunkte, 12);
  assert.equal(zeile.tendenz, '2+');

  // Auch serverseitig gerendert korrekt.
  r = await admin(`/teacher/fach/${lf1Id}?hj=1`);
  const html = await r.text();
  assert.ok(html.includes('12.00') || html.includes('12,00') || /class="endpunkte-cell"[^>]*>\s*12\.00/.test(html));
});

test('LF1 2. Hj.: fortlaufend_50_50-Kumulation berücksichtigt das 1. Hj.', async () => {
  await form(admin, `/teacher/fach/${lf1Id}/spa/eingabe`, {
    schueler_id: String(schuelerId), halbjahr: '2', feld: 'direktwert', wert: '10',
  });
  const r = await admin(`/teacher/fach/${lf1Id}/spa/daten?hj=2`);
  const data = await r.json();
  const zeile = data.schueler.find((s) => s.schueler_id === schuelerId);
  assert.equal(zeile.endpunkte, 0.5 * 12 + 0.5 * 10);
  assert.ok(zeile.vorwert && zeile.vorwert.endpunkte === 12, 'Vorwert sollte die 1.-Hj.-Endnote von LF1 zeigen');
  assert.equal(data.vorwertLabel, 'Endnote 1. Hj. — fließt zu 50 % ein');
});

test('LF2 (Komponenten): einzelne Komponentenwerte eintragen ergibt korrekt gewichtete Zwischennote', async () => {
  const eintraege = [
    ['gesundheit', '15'], ['erziehung', '10'], ['entwicklung', '10'],
  ];
  for (const [schluessel, wert] of eintraege) {
    const r = await form(admin, `/teacher/fach/${lf2Id}/spa/eingabe`, {
      schueler_id: String(schuelerId), halbjahr: '1', feld: `komponente:${schluessel}`, wert,
    });
    assert.equal(r.status, 200);
  }
  const r = await admin(`/teacher/fach/${lf2Id}/spa/daten?hj=1`);
  const data = await r.json();
  const zeile = data.schueler.find((s) => s.schueler_id === schuelerId);
  assert.equal(zeile.zwischennote, 0.4 * 15 + 0.3 * 10 + 0.3 * 10);
});

test('Ungültiger Punktwert (außerhalb 0–15) wird abgelehnt, keine Zeile angelegt/verändert', async () => {
  const r = await form(admin, `/teacher/fach/${lf1Id}/spa/eingabe`, {
    schueler_id: String(schuelerId), halbjahr: '3', feld: 'direktwert', wert: '99',
  });
  assert.equal(r.status, 400);
  assert.equal(getDb().prepare('SELECT direktwert FROM spa_eingaben WHERE fach_id = ? AND schueler_id = ? AND halbjahr = 3')
    .get(lf1Id, schuelerId), undefined);
});

test('Zugriffsschutz: fremde Lehrkraft ohne Fach-Zugriff darf keine SPA-Eingaben speichern', async () => {
  await form(admin, '/admin/einladungen/neu', { display_name: 'Lehrer B', ttl_days: '14' });
  const inv = getDb().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
  const lehrerB = client();
  await form(lehrerB, `/einladung/${inv.token}`, { username: 'lehrerb', display_name: 'Lehrer B', password: 'passwortB1', password2: 'passwortB1' });
  const r = await form(lehrerB, `/teacher/fach/${lf1Id}/spa/eingabe`, {
    schueler_id: String(schuelerId), halbjahr: '1', feld: 'direktwert', wert: '5',
  });
  assert.equal(r.status, 403);
});

test('WPK-Kursname lässt sich am Fach speichern', async () => {
  const wpkId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND spa_fach_key = 'WPK'").get(klasseId).id;
  const r = await form(admin, `/teacher/fach/${wpkId}/spa/wpk-kurs`, { kurs: 'Krippe (U3)' });
  assert.equal(r.status, 200);
  assert.equal(getDb().prepare('SELECT spa_wpk_kurs FROM faecher WHERE id = ?').get(wpkId).spa_wpk_kurs, 'Krippe (U3)');
});

test.after(async () => {
  await fastify.close();
});
