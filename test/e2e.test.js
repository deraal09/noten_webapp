/**
 * E2E-Smoketest: Server bauen, Setup → Login → Klassen/Fächer
 * → Schüler → Notentafel-API → CSV-Export.
 *
 * Vor jedem Deploy als Regressionstest ausführen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// TEMP-DB + Secret, BEVOR app.js geladen wird
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-smoketest-bitte-lang-genug';
process.env.NODE_ENV = 'test';

const { buildApp } = await import('../app.js');
const fastify = await buildApp({ logger: false });
const address = await fastify.listen({ port: 0, host: '127.0.0.1' });
const base = address;

test('Smoketest: vollständiger Workflow', async () => {
  // Cookie-Helper
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
  function cookieHeader() {
    return Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async function req(url, opts = {}) {
    const headers = { ...opts.headers };
    if (cookies.size) headers.cookie = cookieHeader();
    const r = await fetch(base + url, { ...opts, headers, redirect: 'manual' });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : r.headers.get('set-cookie');
    if (sc) setCookie(sc);
    return r;
  }

  // 1. / → 302 nach /setup
  let r = await req('/');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/setup');

  // 2. /setup GET
  r = await req('/setup');
  assert.equal(r.status, 200);

  // 3. /setup POST → Admin anlegen
  r = await req('/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=admin&display_name=Admin&password=geheim123&password2=geheim123',
  });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/admin');

  // 4. /admin → Dashboard
  r = await req('/admin');
  assert.equal(r.status, 200);

  // 5. Schuljahr
  r = await req('/admin/schuljahre/neu', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'bezeichnung=2025/26',
  });
  assert.equal(r.status, 302);

  // 6. Klasse
  r = await req('/admin/schuljahre/1/klassen/neu', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=12BFI1&notenschluessel=IHK',
  });
  assert.equal(r.status, 302);

  // 7. Fach
  r = await req('/admin/klassen/1/faecher/neu', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=Mathematik',
  });
  assert.equal(r.status, 302);

  // 8. Schülerin
  r = await req('/admin/klassen/1/schueler/neu', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'nachname=M%C3%BCller&vorname=Anna',
  });
  assert.equal(r.status, 302);

  // 9. Notentafel (HTML)
  r = await req('/teacher/fach/1');
  assert.equal(r.status, 200);

  // 10. Notentafel (JSON-API)
  r = await req('/teacher/fach/1/noten');
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.schueler.length, 1);
  assert.equal(data.schueler[0].nachname, 'Müller');
  assert.equal(data.schueler[0].gesamt, null);
  assert.equal(data.schueler[0].klausuren.length, 0);

  // 11. Klausur (1 Aufgabe)
  r = await req('/teacher/fach/1/klausuren/neu', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=K1&aufgaben=1&halbjahr=' + encodeURIComponent('1. Halbjahr'),
  });
  assert.equal(r.status, 302);

  // 11b. Maximalpunkte der Aufgabe auf 10 setzen (Default ist 1)
  r = await req('/teacher/klausuren/1/maxpunkte', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'anzahl_aufgaben=1&mp_0=10',
  });
  assert.equal(r.status, 302);

  // 12. Punkt eintragen (8 von 10 → 80 %)
  r = await req('/teacher/klausuren/1/punkte', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'schueler_id=1&aufgabe_idx=0&wert=8',
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);

  // 13. JSON-API erneut – Klausurnote sollte berechnet sein
  r = await req('/teacher/fach/1/noten');
  const data2 = await r.json();
  assert.ok(data2.schueler[0].klausuren[0].note > 0, 'Klausurnote berechnet');

  // 14. CSV-Export
  r = await req('/export/klasse/1.csv');
  assert.equal(r.status, 200);
  const bytes = new Uint8Array(await r.arrayBuffer());
  assert.ok(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, 'CSV muss UTF-8-BOM haben');
  const csv = new TextDecoder('utf-8').decode(bytes);
  assert.ok(csv.includes('Schuljahr'));
  assert.ok(csv.includes('Müller'));

  // 15. Logout
  r = await req('/logout');
  assert.equal(r.status, 302);

  // 16. /login GET
  r = await req('/login');
  assert.equal(r.status, 200);
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
