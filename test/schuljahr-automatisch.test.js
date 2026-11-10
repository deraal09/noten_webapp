/**
 * Schuljahre laufen automatisch weiter (neues Schuljahr am 1. August, ohne dass die Administration es anlegt), und das aktuelle
 * Schuljahr ist in der Auswahl mit "(aktuell)" gekennzeichnet.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-schuljahr-auto-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-schuljahr-auto-bitte-lang-genug-x';
process.env.NODE_ENV = 'test';
process.env.NOTEN_SCHULJAHR_AUTO = '1';
process.env.NOTEN_HEUTE = '2026-07-31T12:00:00'; // letzter Tag des Schuljahres 2025/26
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { aktuellesSchuljahrBezeichnung, sorgeFuerAktuellesSchuljahr, pruefeSchuljahrEinmalProTag } = await import('../src/schuljahre-auto.js');
const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
test.after(() => fastify.close());

const schuljahre = () => getDb().prepare('SELECT bezeichnung FROM schuljahre ORDER BY bezeichnung').all().map((r) => r.bezeichnung);

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
const lehrer = client();

test('Beim Start wird das aktuelle Schuljahr angelegt (31.07.2026 -> 2025/26)', () => {
  assert.equal(aktuellesSchuljahrBezeichnung(), '2025/26');
  assert.deepEqual(schuljahre(), ['2025/26']);
});

test('Am 1. August beginnt das neue Schuljahr: wird automatisch angelegt, bestehende bleiben, mehrfaches Prüfen legt nichts doppelt an', () => {
  assert.equal(aktuellesSchuljahrBezeichnung(new Date('2026-07-31T23:59:00')), '2025/26');
  assert.equal(aktuellesSchuljahrBezeichnung(new Date('2026-08-01T00:00:00')), '2026/27');
  assert.equal(pruefeSchuljahrEinmalProTag(new Date('2026-08-01T08:00:00')), true);
  assert.deepEqual(schuljahre(), ['2025/26', '2026/27']);
  assert.equal(pruefeSchuljahrEinmalProTag(new Date('2026-08-01T20:00:00')), false, 'am selben Tag nicht erneut');
  assert.equal(sorgeFuerAktuellesSchuljahr(new Date('2026-09-01T12:00:00')), false, 'schon vorhanden');
  assert.deepEqual(schuljahre(), ['2025/26', '2026/27']);
  assert.equal(sorgeFuerAktuellesSchuljahr(new Date('2027-08-02T12:00:00')), true, 'ein Jahr später: 2027/28');
  assert.deepEqual(schuljahre(), ['2025/26', '2026/27', '2027/28']);
});

test('Noteneingabe: in der Schuljahr-Auswahl steht das aktuelle Schuljahr mit "(aktuell)"; Klassenanlage wählt es vor', async () => {
  await admin('/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await admin('/admin/einladungen/neu', { display_name: 'Lehrer', ttl_days: '14' });
  const inv = getDb().prepare('SELECT token FROM invitations').get();
  await lehrer(`/einladung/${inv.token}`, { username: 'lehrer', display_name: 'Lehrer', password: 'passwort123', password2: 'passwort123' });
  getDb().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'lehrer'").run();
  const sj = Object.fromEntries(getDb().prepare('SELECT id, bezeichnung FROM schuljahre').all().map((r) => [r.bezeichnung, r.id]));
  for (const [name, bez] of [['10A', '2025/26'], ['11B', '2026/27']]) {
    await lehrer('/teacher/klassen/neu', { schuljahr_id: String(sj[bez]), name, notenschluessel: 'IHK', einschulung_jahr: bez.slice(0, 4) });
    const k = getDb().prepare('SELECT id FROM klassen WHERE name = ?').get(name).id;
    await lehrer(`/teacher/klassen/${k}/faecher/neu`, { name: 'Mathe' });
  }
  // Aktuell ist (NOTEN_HEUTE) 2025/26
  const dashboard = await (await lehrer('/teacher')).text();
  assert.match(dashboard, /<option value="2025\/26">2025\/26 \(aktuell\)<\/option>/);
  assert.match(dashboard, /<option value="2026\/27">2026\/27<\/option>/);
  const liste = await (await lehrer('/teacher/klassen')).text();
  assert.match(liste, new RegExp(`<option value="${sj['2025/26']}" selected>2025/26 \\(aktuell\\)</option>`));
  const adminSeite = await (await admin('/admin')).text();
  assert.match(adminSeite, /2025\/26 \(aktuell\)/);
});
