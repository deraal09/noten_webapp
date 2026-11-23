/**
 * Menü-Button (☰) in der Kopfzeile (views/partials/layout.ejs, static/css/app.css): ALLE Optionen der Leiste
 * (Navigation, Konto mit "Passwort ändern"/Abmelden, App installieren, Farbschema) liegen auf jeder Bildschirmbreite
 * in einem aufklappbaren Menü -- die Leiste selbst zeigt nur noch Name der Anwendung und Menü-Button.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-mobile-nav-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-mobile-nav-test-bitte-lang-genug-123';
process.env.NODE_ENV = 'test';
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
    if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
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

test('Menü-Button vorhanden, standardmäßig zugeklappt (aria-expanded=false)', async () => {
  const html = await (await admin('/start')).text();
  assert.match(html, /<button type="button" class="nav-toggle" aria-label="Menü öffnen" aria-expanded="false" aria-controls="hauptmenue" data-hinweis="Mehr Optionen" data-hinweis-rechts>☰<\/button>/);
  assert.match(html, /<div class="menue" id="hauptmenue" hidden>/);
});

test('Alle Optionen der Leiste stecken im Menü: Navigation, Konto, App installieren, Farbschema', async () => {
  const html = await (await admin('/start')).text();
  const kopf = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>'));
  const menue = kopf.slice(kopf.indexOf('<div class="menue"'));
  const vorMenue = kopf.slice(0, kopf.indexOf('<div class="menue"'));
  for (const teil of ['<nav class="nav">', 'href="/logout"', 'href="/konto/passwort"', 'id="app-install-knopf"', 'class="theme-switch"']) {
    assert.ok(menue.includes(teil), `${teil} im Menü`);
    assert.ok(!vorMenue.includes(teil), `${teil} nicht direkt in der Leiste`);
  }
  // In der Leiste selbst: Name der Anwendung, (ab 900 px sichtbare) Hauptnavigation und Menü-Button.
  assert.deepEqual([...vorMenue.matchAll(/<(a|button)\b[^>]*class="([^"]+)"/g)].map((m) => m[2]), ['brand', 'suche-knopf', 'nav-toggle']);
  assert.match(vorMenue, /<nav class="topnav" aria-label="Hauptnavigation">/);
});

test('Hauptnavigation in der Leiste: wichtigste Ziele, aktuelle Seite markiert, nur ab 900 px sichtbar', async () => {
  const start = await (await admin('/start')).text();
  const leiste = /<nav class="topnav"[\s\S]*?<\/nav>/.exec(start)[0];
  assert.match(leiste, /<a href="\/start" aria-current="page">Start<\/a>/);
  for (const t of ['Dashboard', 'Lehrkräfte', 'Aktivität', 'Zuweisungen', 'Einladungen', 'Hilfe']) assert.ok(leiste.includes(`>${t}</a>`), t);
  const users = await (await admin('/admin/users')).text();
  const l2 = /<nav class="topnav"[\s\S]*?<\/nav>/.exec(users)[0];
  assert.match(l2, /<a href="\/admin\/users" aria-current="page">Lehrkräfte<\/a>/);
  assert.doesNotMatch(l2, /aria-current="page">Start/);
  const dash = /<nav class="topnav"[\s\S]*?<\/nav>/.exec(await (await admin('/admin')).text())[0];
  assert.match(dash, /<a href="\/admin" aria-current="page">Dashboard<\/a>/, 'Dashboard nur auf /admin, nicht auf Unterseiten');
  const css = await (await fetch(base + '/static/css/app.css')).text();
  assert.match(css, /\.topnav \{ display: none;/);
  assert.match(css, /@media \(min-width: 900px\) \{ \.topnav \{ display: flex; \} \}/);
});

test('Ohne Anmeldung (Login-Seite): Menü mit Farbschema, aber ohne Navigation', async () => {
  const html = await (await fetch(base + '/login')).text();
  assert.match(html, /class="nav-toggle"/);
  assert.match(html, /class="theme-switch"/);
  assert.doesNotMatch(html, /<nav class="nav">/);
});

test('Nav-Links und Userbox stehen weiterhin im HTML (nur per CSS je nach Breite ein-/ausgeblendet)', async () => {
  const html = await (await admin('/start')).text();
  assert.match(html, /<nav class="nav">/);
  assert.match(html, /<div class="userbox">/);
  assert.match(html, /href="\/admin\/users">Lehrkräfte<\/a>/);
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
