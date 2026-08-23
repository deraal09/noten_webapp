/**
 * Auto-Provisioning: Ist LDAP konfiguriert und auto_provision aktiv, legt eine
 * erfolgreiche LDAP-Anmeldung eines noch unbekannten Benutzernamens
 * automatisch ein Konto an (kein Pflicht-Import durch den Admin mehr).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-autoprov-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-autoprov-test-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { setLdapAuthenticatorForTests } = await import('../src/auth.js');
const { saveLdapSettings } = await import('../src/auth/ldap-settings.js');
const { FakeAuthenticator } = await import('../src/auth/authenticator.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });

// Für die gesamte Testdatei aktiv (statt echter Netzwerkzugriffe auf einen
// nicht existierenden LDAP-Server) — deckt sowohl den Erfolgs- als auch den
// Ablehnungsfall ab, ohne dass ein echter Server erreichbar sein muss.
setLdapAuthenticatorForTests(new FakeAuthenticator({
  neu123: { passwort: 'geheim123', name: 'Neue Lehrkraft' },
}));

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

test('Auto-Provisioning: unbekannter Nutzername + gültige LDAP-Zugangsdaten legt Konto an', async (t) => {
  const req = client();
  let r = await req('/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
    }),
  });
  assert.equal(r.status, 302);

  saveLdapSettings({
    url: 'ldaps://dc01.schule.local:636',
    base_dn: 'DC=schule,DC=local',
    bind_user_template: 'SCHULE\\{{username}}',
    auto_provision: true,
  });

  const vorher = getDb().prepare("SELECT COUNT(*) AS c FROM users WHERE username = 'neu123'").get().c;
  assert.equal(vorher, 0);

  const req2 = client();
  r = await req2('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'neu123', password: 'geheim123' }),
  });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/');

  const angelegt = getDb().prepare('SELECT * FROM users WHERE username = ?').get('neu123');
  assert.ok(angelegt);
  assert.equal(angelegt.auth_source, 'ldap');
  assert.equal(angelegt.role, 'teacher');
  assert.equal(angelegt.display_name, 'Neue Lehrkraft');

  r = await req2('/teacher');
  assert.equal(r.status, 200);
});

test('Auto-Provisioning: falsches Passwort legt kein Konto an', async () => {
  const req = client();
  const r = await req('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'unbekannt', password: 'falsch' }),
  });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Benutzername oder Passwort ist falsch/);
  const row = getDb().prepare("SELECT COUNT(*) AS c FROM users WHERE username = 'unbekannt'").get().c;
  assert.equal(row, 0);
});

test.after(async () => {
  setLdapAuthenticatorForTests(undefined);
  await fastify.close();
});
