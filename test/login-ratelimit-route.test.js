/**
 * Ratelimit für /login end-to-end: nach drei falschen Passwörtern in Folge
 * wird die Anmeldung gesperrt (auch mit korrektem Passwort), nach Ablauf der
 * Sperre (hier simuliert statt real abgewartet) klappt die Anmeldung wieder.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-ratelimit-route-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-ratelimit-route-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });

function client() {
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
  return async function req(url, opts = {}) {
    const headers = { ...opts.headers };
    if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(base + url, { ...opts, headers, redirect: 'manual' });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : r.headers.get('set-cookie');
    if (sc) setCookie(sc);
    return r;
  };
}

async function form(req, url, body) {
  return req(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
}

const admin = client();

test('Vorbereitung: Admin anlegen', async () => {
  const r = await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
  });
  assert.equal(r.status, 302);
});

test('Erste beiden falschen Passwörter zeigen die normale Fehlermeldung, keine Sperre', async () => {
  for (let i = 0; i < 2; i++) {
    const r = await form(client(), '/login', { username: 'admin', password: 'falsch' });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Benutzername oder Passwort ist falsch/);
  }
});

test('Der 3. falsche Versuch in Folge löst die Sperre aus -- ab dem nächsten Versuch greift sie, selbst mit korrektem Passwort', async () => {
  // Die Sperre wird durch den 3. Fehlversuch selbst ausgelöst (für zukünftige
  // Versuche) -- die Antwort AUF diesen 3. Versuch zeigt daher noch die
  // normale Fehlermeldung, kein Widerspruch zu "ab dem 3. Fehlversuch gesperrt".
  const r3 = await form(client(), '/login', { username: 'admin', password: 'falsch' });
  assert.match(await r3.text(), /Benutzername oder Passwort ist falsch/);

  const rRichtig = await form(client(), '/login', { username: 'admin', password: 'adminpass123' });
  assert.equal(rRichtig.status, 200, 'darf NICHT redirecten -- die Sperre muss auch das korrekte Passwort blockieren');
  assert.match(await rRichtig.text(), /Zu viele Fehlversuche/);
});

test('Groß-/Kleinschreibung des Benutzernamens trifft dieselbe Sperre', async () => {
  const r = await form(client(), '/login', { username: 'ADMIN', password: 'adminpass123' });
  assert.match(await r.text(), /Zu viele Fehlversuche/);
});

test('Ein anderes Konto ist von der Sperre auf "admin" nicht betroffen', async () => {
  await form(admin, '/admin/einladungen/neu', { display_name: 'Externe Lehrkraft', ttl_days: '14' });
  const token = getDb().prepare('SELECT token FROM invitations ORDER BY id DESC LIMIT 1').get().token;
  await form(client(), `/einladung/${token}`, {
    username: 'externa', display_name: 'Externe Lehrkraft', password: 'externpass1', password2: 'externpass1',
  });

  const r = await form(client(), '/login', { username: 'externa', password: 'falsch-aber-nur-einmal' });
  assert.match(await r.text(), /Benutzername oder Passwort ist falsch/);
  assert.doesNotMatch(await (await form(client(), '/login', { username: 'externa', password: 'externpass1' })).text(), /Zu viele Fehlversuche/);
});

test('Nach Ablauf der Sperre (hier simuliert) klappt die Anmeldung mit dem korrekten Passwort wieder', async () => {
  getDb().prepare("UPDATE login_ratelimit SET gesperrt_bis = ? WHERE schluessel = 'admin'").run(Date.now() - 1000);
  const r = await form(client(), '/login', { username: 'admin', password: 'adminpass123' });
  assert.equal(r.status, 302, 'nach Ablauf der Sperre muss die Anmeldung mit richtigem Passwort wieder klappen');
});

test('Regression: eine erfolgreiche Anmeldung setzt den Fehlversuchs-Zähler zurück', async () => {
  for (let i = 0; i < 2; i++) {
    await form(client(), '/login', { username: 'admin', password: 'falsch' });
  }
  const rErfolg = await form(client(), '/login', { username: 'admin', password: 'adminpass123' });
  assert.equal(rErfolg.status, 302);

  // Direkt danach müssten wieder zwei Fehlversuche ohne Sperre möglich sein.
  const r1 = await form(client(), '/login', { username: 'admin', password: 'falsch' });
  assert.doesNotMatch(await r1.text(), /Zu viele Fehlversuche/);
  const r2 = await form(client(), '/login', { username: 'admin', password: 'falsch' });
  assert.doesNotMatch(await r2.text(), /Zu viele Fehlversuche/);
});

test.after(async () => {
  await fastify.close();
});
