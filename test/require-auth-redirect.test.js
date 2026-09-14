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

async function ohneSitzung(url) {
  return fetch(base + url, { redirect: 'manual' });
}

for (const url of ['/start', '/teacher', '/teacher/klassen', '/klassenlehrer', '/export/klasse/1.csv']) {
  test(`Unangemeldeter Zugriff auf ${url} -> 302 zum Login (nicht 401)`, async () => {
    const r = await ohneSitzung(url);
    assert.equal(r.status, 302, `erwartet 302, war ${r.status} -- ein Browser würde das Location-Ziel sonst nicht automatisch laden`);
    assert.match(r.headers.get('location'), /^\/login\?next=/);
  });
}

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
