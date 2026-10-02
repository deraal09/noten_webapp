/**
 * Notizzettel in der Datumstabelle: Notizen zur Unterrichtsleistung je Person,
 * Fach und Halbjahr (Popup, AJAX) -- sichtbar auch in der Notenbesprechung.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-unterricht-notizen-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-unterricht-notizen-test-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
const HJ = '1. Halbjahr';

// ---------- Routen / Oberfläche ----------
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
  return req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
}
// Wiederholte Felder (teil_name, teil_aufgaben, ...) wie ein Browser senden.
async function formListe(req, url, paare) {
  const body = new URLSearchParams();
  for (const [k, v] of paare) body.append(k, v);
  return req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
}

const admin = client();
const lehrerA = client();
const fremd = client();
let fachId, annaId, bertaId, andereKlasseSchuelerId;
const notizUrl = (sid, hj = HJ) => `/teacher/fach/${fachId}/unterricht/notizen/${sid}?hj=${encodeURIComponent(hj)}`;
const notizPost = (req, sid, text, hj = HJ) => req(notizUrl(sid, hj), {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ text, halbjahr: hj }),
});

test('Vorbereitung: Klasse, Fach, zwei Personen, ein Unterrichtstermin', async () => {
  await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;
  for (const [name, pw] of [['Lehrer A', 'passwortA1'], ['Fremd', 'passwortF1']]) {
    await form(admin, '/admin/einladungen/neu', { display_name: name, ttl_days: '14' });
    const inv = getDb().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
    const kunde = name === 'Fremd' ? fremd : lehrerA;
    await form(kunde, `/einladung/${inv.token}`, { username: name === 'Fremd' ? 'fremd' : 'lehrera', display_name: name, password: pw, password2: pw });
  }
  getDb().prepare("UPDATE users SET auth_source = 'ldap' WHERE username IN ('lehrera', 'fremd')").run();
  await form(lehrerA, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '11A', notenschluessel: 'IHK' });
  const klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '11A'").get().id;
  await form(lehrerA, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Englisch' });
  fachId = getDb().prepare('SELECT id FROM faecher WHERE klasse_id = ?').get(klasseId).id;
  await form(lehrerA, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
  await form(lehrerA, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Berger', vorname: 'Berta' });
  annaId = getDb().prepare("SELECT id FROM schueler WHERE nachname = 'Adler'").get().id;
  bertaId = getDb().prepare("SELECT id FROM schueler WHERE nachname = 'Berger'").get().id;
  await form(lehrerA, `/teacher/fach/${fachId}/unterricht/termine/neu`, { datum: '2025-10-01', halbjahr: HJ });
  // Person aus einer anderen Klasse (kein Teilnehmer des Fachs)
  await form(lehrerA, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '11B', notenschluessel: 'IHK' });
  const k2 = getDb().prepare("SELECT id FROM klassen WHERE name = '11B'").get().id;
  await form(lehrerA, `/teacher/klassen/${k2}/schueler/neu`, { nachname: 'Conrad', vorname: 'Carl' });
  andereKlasseSchuelerId = getDb().prepare("SELECT id FROM schueler WHERE nachname = 'Conrad'").get().id;
});

test('Datumstabelle zeigt je Person ein Notizzettel-Symbol und den Dialog', async () => {
  const html = await (await lehrerA(`/teacher/fach/${fachId}?hj=${encodeURIComponent(HJ)}`)).text();
  assert.equal((html.match(/class="notiz-btn"/g) || []).length, 2, 'Symbol je Person, noch ohne Notiz');
  assert.match(html, /<dialog id="unterricht-notiz-dialog" class="notiz-dialog">/);
});

test('Notiz speichern (JSON) und wieder laden, Verlauf neueste zuerst', async () => {
  let r = await notizPost(lehrerA, annaId, '  Sehr aktiv in der Gruppenarbeit.  ');
  assert.equal(r.status, 200);
  let d = await r.json();
  assert.equal(d.ok, true);
  assert.deepEqual(d.notizen.map((n) => n.text), ['Sehr aktiv in der Gruppenarbeit.']);
  assert.equal(d.notizen[0].von, 'Lehrer A');
  assert.equal(d.notizen[0].loeschbar, true);
  await notizPost(lehrerA, annaId, 'Hausaufgaben fehlen.');
  d = await (await lehrerA(notizUrl(annaId))).json();
  assert.deepEqual(d.notizen.map((n) => n.text), ['Hausaufgaben fehlen.', 'Sehr aktiv in der Gruppenarbeit.']);
  // andere Person / anderes Halbjahr sehen sie nicht
  assert.deepEqual((await (await lehrerA(notizUrl(bertaId))).json()).notizen, []);
  assert.deepEqual((await (await lehrerA(notizUrl(annaId, '2. Halbjahr'))).json()).notizen, []);
});

test('Leere Notiz wird abgelehnt; Person ohne Fachteilnahme und fremde Lehrkraft erhalten keinen Zugriff', async () => {
  assert.equal((await notizPost(lehrerA, annaId, '   ')).status, 400);
  assert.equal((await notizPost(lehrerA, andereKlasseSchuelerId, 'x')).status, 404);
  assert.equal((await fremd(notizUrl(annaId))).status, 403);
  assert.equal((await notizPost(fremd, annaId, 'Eindringling')).status, 403);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM notenbesprechung_notizen WHERE text IN ('x', 'Eindringling')").get().n, 0);
});

test('Symbol zeigt die Anzahl, die Notizen sind in der Notenbesprechung sichtbar', async () => {
  const html = await (await lehrerA(`/teacher/fach/${fachId}?hj=${encodeURIComponent(HJ)}`)).text();
  assert.match(html, /class="notiz-btn hat-notiz" data-sid="\d+"\s+data-name="Adler, Anna" data-anzahl="2"/);
  const bes = await (await lehrerA(`/teacher/fach/${fachId}/besprechung/${annaId}?hj=${encodeURIComponent(HJ)}`)).text();
  assert.match(bes, /Notizen zum Unterricht/);
  assert.match(bes, /Sehr aktiv in der Gruppenarbeit\./);
  assert.match(bes, /Hausaufgaben fehlen\./);
  assert.match(bes, /Unterricht \(Datumstabelle\)/);
  const berta = await (await lehrerA(`/teacher/fach/${fachId}/besprechung/${bertaId}?hj=${encodeURIComponent(HJ)}`)).text();
  assert.doesNotMatch(berta, /Hausaufgaben fehlen/);
});

test('Notiz löschen: nur Verfasser/in (oder Admin), nicht fremde Lehrkraft', async () => {
  const eine = getDb().prepare("SELECT id FROM notenbesprechung_notizen WHERE typ = 'unterricht' AND text = 'Hausaufgaben fehlen.'").get().id;
  assert.equal((await fremd(`/teacher/unterricht/notizen/${eine}/loeschen`, { method: 'POST' })).status, 403);
  const r = await lehrerA(`/teacher/unterricht/notizen/${eine}/loeschen`, { method: 'POST' });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).notizen.map((n) => n.text), ['Sehr aktiv in der Gruppenarbeit.']);
  assert.equal((await lehrerA('/teacher/unterricht/notizen/99999/loeschen', { method: 'POST' })).status, 404);
});

test.after(async () => {
  await fastify.close();
});
