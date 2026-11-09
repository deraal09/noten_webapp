/**
 * Notenübersicht: Haken "Gesamtnote auf ganze Note runden" -- nur die Anzeige; der genaue Wert steht in data-roh.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-runden-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-runden-bitte-lang-genug-xxxxxxxxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { HALBJAHRE } = await import('../src/grade-calc.js');
const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
test.after(() => fastify.close());
const HJ = HALBJAHRE[0];

const cookies = new Map();
async function req(url, body) {
  const headers = {};
  if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  const opts = { headers, redirect: 'manual' };
  if (body) { opts.method = 'POST'; headers['content-type'] = 'application/x-www-form-urlencoded'; opts.body = new URLSearchParams(body); }
  const r = await fetch(base + url, opts);
  for (const raw of r.headers.getSetCookie?.() ?? []) { const [k, ...v] = raw.split(';')[0].split('='); cookies.set(k.trim(), v.join('=').trim()); }
  return r;
}
let fachId;

test('Vorbereitung: Klasse, Fach, Person mit Klausur 25/30 (IHK 2,2)', async () => {
  await req('/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await req('/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sj = getDb().prepare('SELECT id FROM schuljahre').get().id;
  await req('/teacher/klassen/neu', { schuljahr_id: String(sj), name: '11A', notenschluessel: 'IHK' });
  const k = getDb().prepare('SELECT id FROM klassen').get().id;
  await req(`/teacher/klassen/${k}/faecher/neu`, { name: 'Physik' });
  fachId = getDb().prepare('SELECT id FROM faecher').get().id;
  await req(`/teacher/klassen/${k}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
  const sid = getDb().prepare('SELECT id FROM schueler').get().id;
  await req(`/teacher/fach/${fachId}/klausuren/neu`, { name: 'K1', aufgaben: '3', halbjahr: HJ });
  const kid = getDb().prepare('SELECT id FROM klausuren').get().id;
  await req(`/teacher/klausuren/${kid}/gewichtung`, { gewichtung: '100', halbjahr: HJ });
  await req(`/teacher/klausuren/${kid}/maxpunkte`, { anzahl_aufgaben: '3', mp_0: '10', mp_1: '10', mp_2: '10', halbjahr: HJ });
  for (const [i, w] of [[0, 10], [1, 10], [2, 5]]) await req(`/teacher/klausuren/${kid}/punkte`, { schueler_id: String(sid), aufgabe_idx: String(i), wert: String(w) });
});

test('Notenübersicht hat den Haken; die Zelle trägt den genauen Wert, angezeigt wird er ungerundet', async () => {
  const html = await (await req(`/teacher/fach/${fachId}?hj=${encodeURIComponent(HJ)}`)).text();
  assert.match(html, /<input type="checkbox" id="gesamt-runden" data-key="fach-\d+"> Gesamtnote auf ganze Note runden/);
  assert.match(html, /class="gesamt-cell" data-roh="2\.2">2,2<\/td>/);
  assert.match(html, /window\.gesamtRundenAnwenden = anwenden/);
  assert.doesNotMatch(html, /id="gesamt-runden"[^>]* checked/, 'standardmäßig nicht gerundet');
});

test('Das Skript wendet die gemerkte Wahl erst nach dem Laden der Tabelle an (DOMContentLoaded)', async () => {
  const html = await (await req(`/teacher/fach/${fachId}?hj=${encodeURIComponent(HJ)}`)).text();
  assert.match(html, /addEventListener\('DOMContentLoaded', anwenden\)/);
});
