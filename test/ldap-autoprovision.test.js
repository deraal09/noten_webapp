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

const admin = client();

test('Vorbereitung: ersten Admin anlegen', async () => {
  const r = await admin('/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
    }),
  });
  assert.equal(r.status, 302);
});

test('Regression: Auto-Provisioning-Haken ist bei noch nicht gespeicherter LDAP-Konfiguration NICHT vorausgewählt', async () => {
  const r = await admin('/admin/ldap/einstellungen');
  assert.equal(r.status, 200);
  const html = await r.text();
  const checkboxMatch = html.match(/name="auto_provision"[^>]*>/);
  assert.ok(checkboxMatch, 'Checkbox auto_provision nicht gefunden');
  assert.doesNotMatch(checkboxMatch[0], /checked/,
    'Auto-Provisioning darf bei einer frischen, noch nicht gespeicherten Konfiguration nicht automatisch aktiviert sein');
});

test('Auto-Provisioning: unbekannter Nutzername + gültige LDAP-Zugangsdaten legt Konto an', async (t) => {
  saveLdapSettings({
    url: 'ldaps://dc01.schule.local:636',
    base_dn: 'DC=schule,DC=local',
    bind_user_template: 'SCHULE\\{{username}}',
    auto_provision: true,
  });

  const vorher = getDb().prepare("SELECT COUNT(*) AS c FROM users WHERE username = 'neu123'").get().c;
  assert.equal(vorher, 0);

  const req2 = client();
  let r = await req2('/login', {
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

test('Regression: LDAP-Login ist nicht case-sensitiv (bereits angelegtes Konto, abweichende Groß-/Kleinschreibung)', async () => {
  // "neu123" wurde im vorigen Test per Auto-Provisioning angelegt. Ein
  // erneuter Login mit abweichender Schreibweise darf nicht an unserer
  // eigenen (bisher case-sensitiven) Benutzernamens-Suche scheitern — das AD
  // selbst ist bei sAMAccountName ohnehin nicht case-sensitiv.
  const req = client();
  const r = await req('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'NEU123', password: 'geheim123' }),
  });
  assert.equal(r.status, 302, 'Login mit abweichender Groß-/Kleinschreibung muss trotzdem erfolgreich sein');
  assert.equal(r.headers.get('location'), '/');

  // Es darf dabei KEIN zweites Konto entstehen.
  const anzahl = getDb().prepare("SELECT COUNT(*) AS c FROM users WHERE username = 'neu123' COLLATE NOCASE").get().c;
  assert.equal(anzahl, 1, 'Case-insensitiver Login darf kein doppeltes Konto anlegen');
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

test('Regression: technischer LDAP-Fehler beim Auto-Provisioning zeigt "nicht verfügbar", nicht "falsches Passwort"', async () => {
  const kaputterAuthenticator = {
    authenticate: async () => {
      throw new Error('Service-Account-Bind fehlgeschlagen (simuliert)');
    },
  };
  setLdapAuthenticatorForTests(kaputterAuthenticator);
  try {
    const req = client();
    const r = await req('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'nochNieGesehen', password: 'irgendwas' }),
    });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /LDAP-Anmeldung ist gerade nicht verfügbar/);
    assert.doesNotMatch(html, /Benutzername oder Passwort ist falsch/);
    const row = getDb().prepare("SELECT COUNT(*) AS c FROM users WHERE username = 'nochNieGesehen'").get().c;
    assert.equal(row, 0);
  } finally {
    setLdapAuthenticatorForTests(new FakeAuthenticator({
      neu123: { passwort: 'geheim123', name: 'Neue Lehrkraft' },
    }));
  }
});

test('Regression: Auto-Provisioning greift auch, wenn die LDAP-URL nur per ENV gesetzt ist (nicht in der DB)', async () => {
  // Reine Plesk-ENV-Installation: LDAP_URL kommt aus der Umgebung, in der
  // DB-Zeile steht keine URL — nur der Haken "auto_provision". Vorher wurde
  // isAutoProvisionEnabled() zusätzlich eine in der DB gespeicherte URL
  // verlangt, wodurch der Haken hier wirkungslos blieb.
  process.env.LDAP_URL = 'ldaps://dc01.schule.local:636';
  try {
    saveLdapSettings({ auto_provision: true }); // bewusst keine url -> DB-Zeile bleibt ohne URL
    const row = getDb().prepare('SELECT url FROM ldap_settings WHERE id = 1').get();
    assert.equal(row.url, null, 'Testannahme: keine URL in der DB gespeichert');

    setLdapAuthenticatorForTests(new FakeAuthenticator({
      envkonto: { passwort: 'geheim456', name: 'ENV-Konto' },
    }));

    const req = client();
    const r = await req('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'envkonto', password: 'geheim456' }),
    });
    assert.equal(r.status, 302, 'Auto-Provisioning muss auch bei reiner ENV-Konfiguration greifen');
    assert.equal(r.headers.get('location'), '/');

    const angelegt = getDb().prepare('SELECT * FROM users WHERE username = ?').get('envkonto');
    assert.ok(angelegt);
    assert.equal(angelegt.auth_source, 'ldap');
  } finally {
    delete process.env.LDAP_URL;
    setLdapAuthenticatorForTests(new FakeAuthenticator({
      neu123: { passwort: 'geheim123', name: 'Neue Lehrkraft' },
    }));
  }
});

test.after(async () => {
  setLdapAuthenticatorForTests(undefined);
  await fastify.close();
});
