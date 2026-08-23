/**
 * Login-Flow für LDAP-Konten: nutzt einen injizierten FakeAuthenticator statt
 * eines echten LDAP-Servers (siehe src/auth/authenticator.js).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-ldap-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-ldap-test-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL; // sicherstellen, dass echte ENV-Konfiguration nicht hineinspielt

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { hashPassword, makeToken, setLdapAuthenticatorForTests } = await import('../src/auth.js');
const { FakeAuthenticator } = await import('../src/auth/authenticator.js');

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

test('LDAP-Login: Setup + importiertes LDAP-Konto', async (t) => {
  const req = client();

  // Ersten Admin anlegen (lokal, wie gehabt)
  let r = await req('/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
    }),
  });
  assert.equal(r.status, 302);

  // LDAP-Konto simulieren, wie es /admin/ldap/import anlegen würde
  getDb().prepare(`INSERT INTO users
    (username, display_name, password_hash, role, active, auth_source, login_sub)
    VALUES ('mmustermann', 'M. Mustermann', ?, 'teacher', 1, 'ldap', 'mmustermann')`)
    .run(hashPassword(makeToken()));

  setLdapAuthenticatorForTests(new FakeAuthenticator({
    mmustermann: { passwort: 'geheim123', name: 'M. Mustermann' },
  }));
  t.after(() => setLdapAuthenticatorForTests(undefined));

  // Falsches Passwort → Fehlermeldung, kein Login
  r = await req('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'mmustermann', password: 'falsch' }),
  });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Benutzername oder Passwort ist falsch/);

  // Richtiges Passwort → Login erfolgreich, Redirect auf /
  const req2 = client();
  r = await req2('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'mmustermann', password: 'geheim123' }),
  });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/');

  r = await req2('/teacher');
  assert.equal(r.status, 200);
});

test('LDAP-Login: nicht konfiguriert → freundliche Fehlermeldung statt Absturz', async () => {
  setLdapAuthenticatorForTests(null); // simuliert isLdapConfigured() === false
  const req = client();
  const r = await req('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'mmustermann', password: 'irrelevant' }),
  });
  setLdapAuthenticatorForTests(undefined);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /LDAP-Anmeldung ist gerade nicht verfügbar/);
});

test.after(async () => {
  await fastify.close();
});
