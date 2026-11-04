/**
 * Datumstabelle: kurze Notiz zum Unterrichtsinhalt je Termin.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-termin-inhalt-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-termin-inhalt-bitte-lang-genug-xx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { HALBJAHRE } = await import('../src/grade-calc.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
const HJ = HALBJAHRE[0];

function client() {
  const cookies = new Map();
  return async function req(url, body) {
    const headers = {};
    if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    const opts = { headers, redirect: 'manual' };
    if (body) { opts.method = 'POST'; headers['content-type'] = 'application/x-www-form-urlencoded'; opts.body = new URLSearchParams(body); }
    const r = await fetch(base + url, opts);
    for (const raw of r.headers.getSetCookie?.() ?? []) { const [k, ...v] = raw.split(';')[0].split('='); cookies.set(k.trim(), v.join('=').trim()); }
    return r;
  };
}
const admin = client();
const fremd = client();
const db = () => getDb();
let fachId, termin1, termin2, anna;

const inhalt = (id, text, c = admin) => c(`/teacher/unterricht/termine/${id}/inhalt`, { text });
const fachSeite = async () => (await admin(`/teacher/fach/${fachId}?hj=${encodeURIComponent(HJ)}`)).text();

test('Vorbereitung: Fach mit zwei Terminen', async () => {
  await admin('/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await admin('/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sj = db().prepare('SELECT id FROM schuljahre').get().id;
  await admin('/admin/einladungen/neu', { display_name: 'fremd', ttl_days: '14' });
  const inv = db().prepare('SELECT token FROM invitations').get();
  await fremd(`/einladung/${inv.token}`, { username: 'fremd', display_name: 'fremd', password: 'passwort123', password2: 'passwort123' });
  await admin('/teacher/klassen/neu', { schuljahr_id: String(sj), name: '11A', notenschluessel: 'IHK', einschulung_jahr: '2025' });
  const k = db().prepare('SELECT id FROM klassen').get().id;
  await admin(`/teacher/klassen/${k}/faecher/neu`, { name: 'Physik' });
  fachId = db().prepare('SELECT id FROM faecher').get().id;
  await admin(`/teacher/klassen/${k}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
  anna = db().prepare('SELECT id FROM schueler').get().id;
  for (const d of ['2025-09-01', '2025-09-08']) await admin(`/teacher/fach/${fachId}/unterricht/termine/neu`, { datum: d, halbjahr: HJ });
  [termin1, termin2] = db().prepare('SELECT id FROM unterricht_termine ORDER BY datum').all().map((r) => r.id);
});

test('Jeder Termin hat ein Notizfeld im Spaltenkopf; leer bis etwas eingetragen ist', async () => {
  const html = await fachSeite();
  for (const t of [termin1, termin2]) {
    assert.match(html, new RegExp(`<textarea class="termin-inhalt" data-termin="${t}"[^>]*placeholder="Unterrichtsinhalt"[^>]*></textarea>`));
  }
});

test('Unterrichtsinhalt speichern, anzeigen (HTML-sicher), ändern und entfernen', async () => {
  let r = await inhalt(termin1, '  Bruchrechnung:\n  <b>Kürzen</b> & Erweitern  ');
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.text, 'Bruchrechnung: <b>Kürzen</b> & Erweitern', 'Leerraum wird zusammengefasst');
  assert.equal(db().prepare('SELECT inhalt FROM unterricht_termine WHERE id = ?').get(termin1).inhalt, d.text);
  let html = await fachSeite();
  assert.match(html, new RegExp(`data-termin="${termin1}"[^>]*>Bruchrechnung: &lt;b&gt;Kürzen&lt;/b&gt; &amp; Erweitern</textarea>`));
  assert.doesNotMatch(html, /<b>Kürzen<\/b>/);
  // der zweite Termin bleibt unberührt
  assert.equal(db().prepare('SELECT inhalt FROM unterricht_termine WHERE id = ?').get(termin2).inhalt, '');
  // ändern
  await inhalt(termin1, 'Dezimalzahlen');
  assert.equal(db().prepare('SELECT inhalt FROM unterricht_termine WHERE id = ?').get(termin1).inhalt, 'Dezimalzahlen');
  // entfernen
  r = await inhalt(termin1, '   ');
  assert.equal((await r.json()).text, '');
  assert.equal(db().prepare('SELECT inhalt FROM unterricht_termine WHERE id = ?').get(termin1).inhalt, '');
});

test('Längenlimit, fremde Lehrkraft und unbekannter Termin werden abgewiesen', async () => {
  let r = await inhalt(termin1, 'x'.repeat(301));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /zu lang/);
  assert.equal((await inhalt(termin1, 'x'.repeat(300))).status, 200);
  await inhalt(termin1, 'Vektoren');
  assert.equal((await inhalt(termin1, 'Eindringling', fremd)).status, 403);
  assert.equal(db().prepare('SELECT inhalt FROM unterricht_termine WHERE id = ?').get(termin1).inhalt, 'Vektoren');
  assert.equal((await inhalt(99999, 'x')).status, 404);
});

test('Notenbesprechung zeigt die Unterrichtsinhalte der Termine', async () => {
  await inhalt(termin2, 'Kräfte');
  await admin(`/teacher/unterricht/termine/${termin1}/note`, { schueler_id: String(anna), wert: '2' });
  const html = await (await admin(`/teacher/fach/${fachId}/besprechung/${anna}?hj=${encodeURIComponent(HJ)}`)).text();
  assert.match(html, /Unterrichtsinhalte:<\/strong>\s*01\.09\.2025: Vektoren · 08\.09\.2025: Kräfte/);
  assert.match(html, /title=" 2025-09-01 – Vektoren"/);
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
