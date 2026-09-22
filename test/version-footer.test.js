/**
 * Versionsnummer in der Fußzeile (app.js: appVersion aus package.json,
 * views/partials/layout.ejs). Einzige Quelle ist package.json -- kein
 * Automatismus aus der Commit-Historie, siehe dortiger Kommentar.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-version-footer-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-version-footer-test-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });

test('Fußzeile zeigt die Version aus package.json', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));
  const html = await (await fetch(base + '/login')).text();
  assert.match(html, new RegExp(`Notenverwaltung · \\d{4} · v${pkg.version.replace(/\./g, '\\.')}`));
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
