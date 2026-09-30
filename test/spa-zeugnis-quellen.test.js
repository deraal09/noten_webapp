/**
 * SPA-Abschlusszeugnis: pro Person lassen sich die Quellfächer je Position
 * wählen -- auch rein historische Fächer/Fächer früherer Klassen. Ohne
 * Auswahl bleibt alles beim Standard (Fach der aktuellen Klasse); mehrere
 * gewählte Fächer werden gemittelt.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-spa-zeugnis-quellen-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-spa-zeugnis-quellen-test-bitte-lang-genug';
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

// Mehrere Checkboxen gleichen Namens: URLSearchParams mit wiederholtem Schlüssel statt Array-Wert.
async function formQuellen(req, url, quellen) {
  const body = new URLSearchParams();
  for (const q of quellen) body.append('quelle', q);
  return req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
}

const admin = client();
const lehrerC = client();
let klasseId, schuelerId, lf1Id, histFachId;
const zeugnisHtml = async () => (await admin(`/teacher/klassen/${klasseId}/zeugnis?hj=4`)).text();
const quellenUrl = () => `/teacher/klassen/${klasseId}/zeugnis/${schuelerId}/quellen`;

test('Vorbereitung: SPA-Klasse, Person mit LF1-Noten (Halbjahr 1/2) und einem historischen Fach "Lernfeld 1 (alt)" aus 2023/24', async () => {
  let r = await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  assert.equal(r.status, 302);
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2026/27' });
  const sj = getDb().prepare('SELECT id FROM schuljahre').get();
  await form(admin, '/teacher/klassen/neu', {
    schuljahr_id: String(sj.id), name: '13SPA1', notenschluessel: 'SPA', spa_bildungsgang: 'SPA_PIA', offen_fuer_beitritt: '1',
  });
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '13SPA1'").get().id;
  lf1Id = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND spa_fach_key = 'LF1'").get(klasseId).id;

  await form(admin, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Musterfrau', vorname: 'Maxi' });
  schuelerId = getDb().prepare('SELECT id FROM schueler WHERE nachname = ?').get('Musterfrau').id;
  await form(admin, `/teacher/fach/${lf1Id}/spa/eingabe`, { schueler_id: String(schuelerId), halbjahr: '1', feld: 'direktwert', wert: '10' });
  await form(admin, `/teacher/fach/${lf1Id}/spa/eingabe`, { schueler_id: String(schuelerId), halbjahr: '2', feld: 'direktwert', wert: '12' });

  r = await form(admin, `/klassenlehrer/klasse/${klasseId}/vergangenes-schuljahr/neu`, { bezeichnung: '2023/24', faecher: 'Lernfeld 1 (alt)' });
  assert.equal(r.status, 302);
  histFachId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Lernfeld 1 (alt)'").get(klasseId).id;
  const hh1 = getDb().prepare("SELECT id FROM historische_halbjahre WHERE fach_id = ? AND bezeichnung = '1. Halbjahr 2023/24'").get(histFachId);
  const hh2 = getDb().prepare("SELECT id FROM historische_halbjahre WHERE fach_id = ? AND bezeichnung = '2. Halbjahr 2023/24'").get(histFachId);
  await form(admin, `/teacher/historie/${hh1.id}/speichern`, { ['note_' + schuelerId]: '2' });
  await form(admin, `/teacher/historie/${hh2.id}/speichern`, { ['note_' + schuelerId]: '4' });
});

test('Standard: ohne Auswahl zeigt das Abschlusszeugnis das LF1 der aktuellen Klasse (11.00), ohne Markierung', async () => {
  const html = await zeugnisHtml();
  assert.match(html, /11\.00/);
  assert.doesNotMatch(html, /✎/);
  assert.match(html, new RegExp(`${quellenUrl()}`));
});

test('Auswahl-Seite listet alle Fächer der Person -- auch das historische -- je Position', async () => {
  const r = await admin(quellenUrl());
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Lernfeld 1 \(alt\)/);
  assert.match(html, /\(historisch\)/);
  assert.match(html, /Lernfeld 1/);
  assert.match(html, /value="LF1:4\|\d+"/);
  assert.match(html, /8\.00/, 'historisches Fach: Stand 3,0 -> 8 Punkte');
});

test('Mehrere Fächer gewählt: Position wird gemittelt (LF1 11 + historisch 8 = 9.50), Markierung ✎', async () => {
  const r = await formQuellen(admin, quellenUrl(), [`LF1:4|${lf1Id}`, `LF1:4|${histFachId}`]);
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM spa_zeugnis_quellen WHERE schueler_id = ?').get(schuelerId).c, 2);
  const html = await zeugnisHtml();
  assert.match(html, /9\.50/);
  assert.match(html, /\(2-\)/, '9,5 Punkte -> 10 -> 2-');
  assert.match(html, /✎/);
  assert.match(html, /Lernfeld 1 \(alt\) \(13SPA1, 2026\/27\)/, 'Quellen stehen im Tooltip');
});

test('Nur das historische Fach gewählt: Position nutzt ausschließlich dessen Wert (8.00)', async () => {
  await formQuellen(admin, quellenUrl(), [`LF1:4|${histFachId}`]);
  const html = await zeugnisHtml();
  assert.match(html, /8\.00/);
  assert.doesNotMatch(html, /11\.00/);
});

test('Ungültige Positionen/Fächer werden ignoriert', async () => {
  await formQuellen(admin, quellenUrl(), ['UNBEKANNT:4|1', 'LF1:4|999999', `LF1:4|${histFachId}`]);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM spa_zeugnis_quellen WHERE schueler_id = ?').get(schuelerId).c, 1);
});

test('Zugriffsschutz: Lehrkraft ohne Klassenleitung kommt nicht an die Auswahl', async () => {
  await form(admin, '/admin/einladungen/neu', { display_name: 'Lehrer C', ttl_days: '14' });
  const inv = getDb().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
  await form(lehrerC, `/einladung/${inv.token}`, { username: 'lehrerc', display_name: 'Lehrer C', password: 'passwortC1', password2: 'passwortC1' });
  assert.equal((await lehrerC(quellenUrl())).status, 403);
  assert.equal((await form(lehrerC, quellenUrl(), { zuruecksetzen: '1' })).status, 403);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM spa_zeugnis_quellen WHERE schueler_id = ?').get(schuelerId).c, 1);
});

test('Zurücksetzen: zurück zum Standard (11.00, keine Markierung)', async () => {
  const r = await form(admin, quellenUrl(), { zuruecksetzen: '1' });
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM spa_zeugnis_quellen WHERE schueler_id = ?').get(schuelerId).c, 0);
  const html = await zeugnisHtml();
  assert.match(html, /11\.00/);
  assert.doesNotMatch(html, /✎/);
});

test.after(async () => {
  await fastify.close();
});
