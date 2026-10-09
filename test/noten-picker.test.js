/**
 * Touch-Notenauswahl: Die Noteneingabefelder tragen data-note-picker (Notenschlüssel) und data-picker-na/-ntg, das
 * Skript static/js/noten-picker.js wird auf allen Seiten geladen und tut nur auf Touch-Geräten (pointer: coarse) etwas.
 * Das Verhalten im Browser ist in test/noten-picker.test.js nicht abgedeckt (kein Browser im Testlauf).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-picker-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-noten-picker-bitte-lang-genug-xxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });

const cookies = new Map();
async function req(url, body) {
  const headers = {};
  if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  const opts = { headers, redirect: 'manual' };
  if (body) {
    opts.method = 'POST';
    headers['content-type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(body);
  }
  const r = await fetch(base + url, opts);
  for (const raw of r.headers.getSetCookie?.() ?? []) {
    const [k, ...v] = raw.split(';')[0].split('=');
    cookies.set(k.trim(), v.join('=').trim());
  }
  return r;
}
const db = () => getDb();
const fachIds = {};

test('Vorbereitung: IHK- und BG-Klasse mit je einem Fach, einer Person und einem Termin', async () => {
  await req('/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await req('/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sj = db().prepare('SELECT id FROM schuljahre').get().id;
  for (const ns of ['IHK', 'BG']) {
    await req('/teacher/klassen/neu', { schuljahr_id: String(sj), name: `11${ns}`, notenschluessel: ns, einschulung_jahr: '2025' });
    const k = db().prepare('SELECT id FROM klassen WHERE name = ?').get(`11${ns}`).id;
    await req(`/teacher/klassen/${k}/faecher/neu`, { name: `Fach ${ns}` });
    fachIds[ns] = db().prepare('SELECT id FROM faecher WHERE klasse_id = ?').get(k).id;
    await req(`/teacher/klassen/${k}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
    await req(`/teacher/fach/${fachIds[ns]}/unterricht/termine/neu`, { datum: '2025-10-01', halbjahr: '5. Halbjahr' });
  }
});

test('Datumstabelle und Endnoten-Direkteingabe tragen die Picker-Attribute je Notenschlüssel', async () => {
  for (const ns of ['IHK', 'BG']) {
    const html = await (await req(`/teacher/fach/${fachIds[ns]}?hj=${encodeURIComponent('5. Halbjahr')}`)).text();
    assert.match(html, new RegExp(`class="note-datum[^"]*"[^>]*data-note-picker="${ns}" data-picker-na="1"`), `Datumstabelle ${ns}`);
    assert.match(html, new RegExp(`class="endnote-eingabe"[\\s\\S]*?data-note-picker="${ns}" data-picker-ntg="1"`), `Endnote ${ns}`);
    assert.match(html, /\/static\/js\/noten-picker\.js\?v=/, 'Skript eingebunden');
  }
});

test('Das Skript wird ausgeliefert, aktiviert sich nur bei pointer: coarse und bietet n.a. zuerst an', async () => {
  const r = await fetch(`${base}/static/js/noten-picker.js`);
  assert.equal(r.status, 200);
  const js = await r.text();
  assert.match(js, /\(pointer: coarse\)/);
  assert.ok(js.indexOf("dataset.pickerNa") < js.indexOf("werte(aktiv.dataset.notePicker)"), 'n.a. steht vor den Noten');
  assert.match(js, /i <= 15/, 'BG: 0 bis 15');
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
