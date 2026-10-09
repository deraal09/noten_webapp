/**
 * App-Installation (PWA): Manifest, Service Worker, Symbole, Installieren-Knopf mit Anleitung.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-pwa-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-pwa-test-bitte-lang-genug-xxxxxxxxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
const get = (url, opts = {}) => fetch(base + url, { redirect: 'manual', ...opts });

test('Manifest ist ohne Anmeldung abrufbar und installierbar (Name, Start, Symbole, Anzeige)', async () => {
  const r = await get('/manifest.webmanifest');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/manifest\+json/);
  const m = await r.json();
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '/');
  assert.ok(m.name && m.short_name);
  const groessen = m.icons.map((i) => `${i.sizes}:${i.purpose}`);
  assert.ok(groessen.includes('192x192:any') && groessen.includes('512x512:any') && groessen.includes('512x512:maskable'));
  for (const icon of m.icons) assert.equal((await get(icon.src)).status, 200, icon.src);
});

test('Service Worker liegt unter /, hat den fetch-Handler und cacht keine Seiten', async () => {
  const r = await get('/sw.js');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /javascript/);
  assert.equal(r.headers.get('service-worker-allowed'), '/');
  assert.match(r.headers.get('cache-control'), /no-cache/);
  const js = await r.text();
  assert.match(js, /addEventListener\('fetch'/);
  assert.equal((await get('/static/pwa/offline.html')).status, 200);
});

test('Symbole auch unter den festen Pfaden (iOS-Home-Bildschirm, favicon), iOS-Symbol ist 180x180', async () => {
  for (const url of ['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png', '/static/icons/apple-touch-icon.png', '/favicon.ico']) {
    const r = await get(url, { headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' } });
    assert.equal(r.status, 200, url);
    assert.equal(r.headers.get('content-type'), 'image/png', url);
  }
  const png = Buffer.from(await (await get('/apple-touch-icon.png')).arrayBuffer());
  assert.equal(png.readUInt32BE(16), 180);
  assert.equal(png.readUInt32BE(20), 180);
  const m = await (await get('/manifest.webmanifest')).json();
  assert.equal(m.icons.some((i) => i.type === 'image/svg+xml'), false, 'nur PNG-Symbole (iOS kann kein SVG)');
});

test('Seiten verlinken Manifest, iOS-Symbol und bieten den Installieren-Knopf samt Anleitung an', async () => {
  const html = await (await get('/setup')).text();
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(html, /rel="apple-touch-icon" sizes="180x180" href="\/static\/icons\/apple-touch-icon\.png"/);
  assert.match(html, /name="theme-color"/);
  assert.match(html, /id="app-install-knopf"/);
  // Anleitung für iOS-Nutzer/innen (Teilen → Zum Home-Bildschirm) und die anderen Systeme
  assert.match(html, /data-plattform="ios"[\s\S]*Zum Home-Bildschirm/);
  assert.match(html, /data-plattform="chromium"/);
  assert.match(html, /data-plattform="firefox"/);
  assert.match(html, /beforeinstallprompt/);
});

test('Eingebettet (iframe) wird kein Installieren-Knopf ausgeliefert', async () => {
  const html = await (await get('/setup', { headers: { 'sec-fetch-dest': 'iframe' } })).text();
  assert.equal(html.includes('id="app-install-knopf"'), false);
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
