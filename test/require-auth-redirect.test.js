/**
 * requireAuth (src/auth.js): eine unangemeldete Anfrage an eine geschützte
 * Route muss mit Statuscode 302 (nicht 401!) zum Login weiterleiten.
 *
 * reply.code(401).redirect(url) lässt Fastify den zuvor gesetzten Code (401)
 * für die Antwort stehen (redirect() setzt nur dann 302, wenn noch KEIN Code
 * gesetzt wurde) -- eine Antwort mit Status 401 UND Location-Header wird von
 * Browsern bei normaler Navigation aber nicht automatisch verfolgt (das gilt
 * nur für 3xx-Codes). Sichtbar wurde das in der Praxis als "HTTP ERROR 401"
 * statt der erwarteten Login-Seite, sobald die Sitzung nicht mehr erkannt
 * wurde (z. B. nach einem Deploy/Neustart), während noch eine
 * /teacher/…-Seite offen war.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-require-auth-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-require-auth-test-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });

// So sieht ein Seitenaufruf des Browsers aus (Link, Adresszeile, Formular).
// Sec-Fetch-Mode ist laut Fetch-Standard ein geschützter Header: kein
// Skript kann ihn setzen, auch Node-fetch überschreibt ihn immer mit "cors".
// Seitenaufrufe werden deshalb per fastify.inject() nachgestellt, das die
// Header unverändert durchreicht.
const SEITENAUFRUF = {
  'sec-fetch-mode': 'navigate',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

function seitenaufruf(url, headers = SEITENAUFRUF) {
  return fastify.inject({ method: 'GET', url, headers });
}

for (const url of ['/start', '/teacher', '/teacher/klassen', '/klassenlehrer', '/export/klasse/1.csv']) {
  test(`Unangemeldeter Seitenaufruf ${url} -> 302 zum Login (nicht 401)`, async () => {
    const r = await seitenaufruf(url);
    assert.equal(r.statusCode, 302, `erwartet 302, war ${r.statusCode} -- ein Browser würde das Location-Ziel sonst nicht automatisch laden`);
    assert.match(r.headers.location, /^\/login\?next=/);
  });
}

test('Ältere Browser ohne Sec-Fetch-Mode: Seitenaufruf an Accept: text/html erkannt -> 302', async () => {
  const r = await seitenaufruf('/teacher', { accept: SEITENAUFRUF.accept });
  assert.equal(r.statusCode, 302);
  assert.match(r.headers.location, /^\/login\?next=/);
});

// Hintergrund-Aufrufe per fetch() dürfen NICHT umgeleitet werden: fetch()
// folgt einer 302 stillschweigend, bekommt die Login-Seite mit Status 200,
// und das Skript hält r.ok für ein gelungenes Speichern. Genau so zeigte der
// Sitzplan nach Ablauf der Sitzung "gespeichert ✓", obwohl nichts ankam.
for (const [methode, url] of [
  ['POST', '/teacher/klassen/1/sitzplan/speichern'],
  ['POST', '/teacher/fach/1/spa/eingabe'],
  ['POST', '/teacher/klausuren/1/punkte'],
  ['GET', '/teacher/fach/1/noten'],
]) {
  test(`Unangemeldeter fetch-Aufruf ${methode} ${url} -> 401, keine Umleitung`, async () => {
    const r = await fetch(base + url, {
      method: methode,
      redirect: 'manual',
      headers: { 'sec-fetch-mode': 'cors', accept: '*/*' },
      ...(methode === 'POST' ? { body: new URLSearchParams({ schueler_id: '1', wert: '5' }) } : {}),
    });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('location'), null, 'eine Umleitung würde fetch() stillschweigend folgen');
    assert.deepEqual(await r.json(), { ok: false, error: 'nicht angemeldet' });
  });
}

test('Auch ohne Fetch-Metadata (Accept: */*) gilt ein Aufruf als Hintergrund-Aufruf -> 401', async () => {
  const r = await seitenaufruf('/teacher/fach/1/noten', { accept: '*/*' });
  assert.equal(r.statusCode, 401);
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
