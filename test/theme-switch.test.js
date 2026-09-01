/**
 * Theme-Umschalter (System/Hell/Dunkel) im Kopfbereich — auf jeder Seite
 * sichtbar, auch ohne Anmeldung (Login/Setup), da die Wahl geräte-/
 * browserbezogen ist, nicht kontobezogen (views/partials/layout.ejs).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-theme-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-theme-test-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });

test('Theme-Umschalter erscheint bereits auf der Setup-Seite (ohne Login)', async () => {
  const r = await fetch(base + '/setup');
  const html = await r.text();
  assert.match(html, /class="theme-switch"/);
  assert.match(html, /data-theme-choice="system"/);
  assert.match(html, /data-theme-choice="light"/);
  assert.match(html, /data-theme-choice="dark"/);
});

test('Anti-Flash-Skript steht vor dem Stylesheet-Link im <head>', async () => {
  const r = await fetch(base + '/setup');
  const html = await r.text();
  const scriptPos = html.indexOf('theme-pref');
  const linkPos = html.indexOf('rel="stylesheet"');
  assert.ok(scriptPos !== -1 && linkPos !== -1);
  assert.ok(scriptPos < linkPos, 'das Skript muss vor dem Stylesheet stehen, um einen Theme-Flash zu vermeiden');
});

test.after(async () => {
  await fastify.close();
});
