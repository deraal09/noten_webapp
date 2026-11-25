/**
 * Anfragen zu bereits gelöschten Einträgen (Klausur, Zusatzleistung, Termin, Abschnitt) führen zurück auf die Fachseite,
 * von der sie kamen -- nicht auf die Übersicht aller Klassen. Dazu: Auto-Speichern kollidiert nicht mit dem Löschen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-stale-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-stale-eintraege-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { HALBJAHRE } = await import('../src/grade-calc.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
const HJ = HALBJAHRE[0];

const cookies = new Map();
async function req(url, opts = {}) {
  const headers = { ...opts.headers };
  if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  const r = await fetch(base + url, { ...opts, headers, redirect: 'manual' });
  for (const raw of r.headers.getSetCookie()) {
    const [k, ...v] = raw.split(';')[0].split('=');
    cookies.set(k.trim(), v.join('=').trim());
  }
  return r;
}
const post = (url, body, headers = {}) => req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body) });

let fachId;
test('Vorbereitung: Klasse mit Fach', async () => {
  await post('/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  getDb().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'admin'").run();
  await post('/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sj = getDb().prepare('SELECT id FROM schuljahre').get().id;
  await post('/teacher/klassen/neu', { schuljahr_id: String(sj), name: '9B', notenschluessel: 'IHK' });
  const kid = getDb().prepare('SELECT id FROM klassen').get().id;
  await post(`/teacher/klassen/${kid}/klassenlehrer/eintragen`, {});
  await post(`/teacher/klassen/${kid}/faecher/neu`, { name: 'Deutsch' });
  fachId = getDb().prepare('SELECT id FROM faecher').get().id;
  await post(`/teacher/fach/${fachId}/klausuren/neu`, { name: 'K1', aufgaben: '2', halbjahr: HJ });
});

test('Gelöschte Klausur: Löschen führt zur Fachseite; eine verspätete Anfrage danach ebenfalls (nicht zur Klassenübersicht)', async () => {
  const kid = getDb().prepare('SELECT id FROM klausuren').get().id;
  const fachUrl = `/teacher/fach/${fachId}?hj=${encodeURIComponent(HJ)}`;
  let r = await post(`/teacher/klausuren/${kid}/loeschen`, {}, { referer: base + fachUrl });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), fachUrl);
  // verspätete Auto-Speicherung für die gelöschte Klausur
  for (const aktion of ['gewichtung', 'loeschen']) {
    r = await post(`/teacher/klausuren/${kid}/${aktion}`, { gewichtung: '30' }, { referer: base + fachUrl });
    assert.equal(r.status, 302, aktion);
    assert.equal(r.headers.get('location'), fachUrl, `${aktion}: zurück zur Fachseite`);
  }
  // Zusatzleistung, Termin, Abschnitt: dasselbe
  for (const url of ['/teacher/uls/999/loeschen', '/teacher/unterricht/termine/999/loeschen', '/teacher/unterricht/abschnitte/999/loeschen']) {
    r = await post(url, {}, { referer: base + fachUrl });
    assert.equal(r.headers.get('location'), fachUrl, url);
  }
});

test('Ohne Herkunft oder mit fremder bzw. anderer Herkunft bleibt es bei der Übersicht; fremde Hosts werden nicht übernommen', async () => {
  let r = await post('/teacher/klausuren/999/loeschen', {});
  assert.equal(r.headers.get('location'), '/teacher');
  r = await post('/teacher/klausuren/999/loeschen', {}, { referer: 'https://boese.example/teacher/fach/1?x=1' });
  assert.equal(r.headers.get('location'), '/teacher/fach/1?x=1', 'nur Pfad und Query, nie der fremde Host');
  r = await post('/teacher/klausuren/999/loeschen', {}, { referer: base + '/admin/users' });
  assert.equal(r.headers.get('location'), '/teacher');
  r = await post('/teacher/klausuren/999/loeschen', {}, { referer: 'kein url' });
  assert.equal(r.headers.get('location'), '/teacher');
});

test('Fachseite: Auto-Speichern wartet auf den Löschdialog und entfällt nach dem Löschen; Bestätigung sendet nie doppelt', async () => {
  const html = await (await req(`/teacher/fach/${fachId}?hj=${encodeURIComponent(HJ)}`)).text();
  assert.match(html, /function sendeAutoSpeichern\(form\)/);
  assert.match(html, /if \(!loeschtGerade\) form\.submit\(\)/);
  assert.doesNotMatch(html, /merkeAktivesFeld\(\); form\.submit\(\)/);
  const js = await (await req('/static/js/bestaetigen.js')).text();
  assert.match(js, /if \(form\.dataset\.gesendet\) return;/);
});

test.after(async () => { await fastify.close(); });
