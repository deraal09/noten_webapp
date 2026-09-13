/**
 * Embed-Modus für die Einbettung im Lehrerkalender (app.js: reply.locals.embed,
 * views/partials/layout.ejs). Erkennung über den Sec-Fetch-Dest-Header, den
 * Browser bei jeder Navigation innerhalb eines <iframe> automatisch mitschicken
 * — kein Query-Parameter, keine Session-Klebrigkeit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-embed-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-embed-test-bitte-lang-genug-12345';
process.env.NODE_ENV = 'test';
process.env.LEHRERKALENDER_URL = 'https://kalender.example.org';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });

function client() {
  const cookies = new Map();
  function setCookie(header) {
    if (!header) return;
    for (const raw of Array.isArray(header) ? header : [header]) {
      const [pair] = raw.split(';');
      const [k, ...v] = pair.split('=');
      cookies.set(k.trim(), v.join('=').trim());
    }
  }
  return async function req(url, opts = {}) {
    const headers = { ...opts.headers };
    if (cookies.size) {
      headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const r = await fetch(base + url, { ...opts, headers, redirect: 'manual' });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : r.headers.get('set-cookie');
    if (sc) setCookie(sc);
    return r;
  };
}
function form(req, url, body) {
  return req(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
}

const admin = client();
await form(admin, '/setup', {
  username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
});

test('normale Anfrage (kein Iframe): Kopf- und Fusszeile sind da', async () => {
  const r = await admin('/start');
  const html = await r.text();
  assert.match(html, /<header class="topbar">/);
  assert.match(html, /<footer class="footer">/);
});

test('Anfrage mit Sec-Fetch-Dest: iframe: Kopf- und Fusszeile fehlen', async () => {
  const r = await admin('/start', { headers: { 'sec-fetch-dest': 'iframe' } });
  const html = await r.text();
  assert.doesNotMatch(html, /<header class="topbar">/);
  assert.doesNotMatch(html, /<footer class="footer">/);
  // Der eigentliche Seiteninhalt bleibt vorhanden, nur die Chrome verschwindet.
  assert.match(html, /<main class="container">/);
});

test('CSP frame-ancestors nennt die konfigurierte Kalender-URL', async () => {
  const r = await admin('/start');
  assert.equal(r.headers.get('content-security-policy'), "frame-ancestors 'self' https://kalender.example.org");
});

test('ohne LEHRERKALENDER_URL bleibt das Verhalten unveraendert (kein CSP-Header)', async () => {
  const original = process.env.LEHRERKALENDER_URL;
  delete process.env.LEHRERKALENDER_URL;
  try {
    const r = await admin('/start');
    assert.equal(r.headers.get('content-security-policy'), null);
  } finally {
    process.env.LEHRERKALENDER_URL = original;
  }
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
