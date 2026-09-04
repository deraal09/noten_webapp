/**
 * Benutzernamen müssen auch unabhängig von Groß-/Kleinschreibung eindeutig
 * sein.
 *
 * Der Login sucht case-unabhängig (das AD unterscheidet bei sAMAccountName
 * ebenfalls nicht), die Spalte war aber case-sensitiv eindeutig. "mueller"
 * und "Mueller" konnten damit nebeneinander existieren, und die Login-Suche
 * traf eine beliebige der beiden Zeilen — ein per Einladungslink angelegtes
 * Konto "Mueller" sperrte so die LDAP-Lehrkraft "mueller" dauerhaft aus
 * (Login schlug mit "Benutzername oder Passwort ist falsch" fehl, und das
 * Auto-Provisioning griff wegen des vorhandenen Treffers nie).
 *
 * Zwei Ebenen: das Schema verhindert neue Dubletten, und
 * findeBenutzerFuerLogin() macht die Anmeldung auch in einer Altdatenbank
 * eindeutig, in der bereits welche liegen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-benutzername-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-benutzernamen-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { hashPassword, makeToken } = await import('../src/auth.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });

function client() {
  const cookies = new Map();
  return async function req(url, opts = {}) {
    const headers = { ...opts.headers };
    if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(base + url, { ...opts, headers, redirect: 'manual' });
    for (const raw of r.headers.getSetCookie()) {
      const [k, ...v] = raw.split(';')[0].split('=');
      cookies.set(k.trim(), v.join('=').trim());
    }
    return r;
  };
}

const form = (req, url, body) => req(url, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body),
});

const admin = client();

test('Vorbereitung: Admin und eine LDAP-Lehrkraft "mueller"', async () => {
  const r = await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'geheim12', password2: 'geheim12',
  });
  assert.equal(r.status, 302);
  getDb().prepare(`INSERT INTO users (username, display_name, password_hash, role, active, auth_source, login_sub)
                   VALUES ('mueller', 'Echte Lehrkraft', ?, 'teacher', 1, 'ldap', 'mueller')`)
    .run(hashPassword(makeToken()));
});

test('Die Datenbank lehnt eine abweichende Schreibweise direkt ab', () => {
  assert.throws(
    () => getDb().prepare(`INSERT INTO users (username, password_hash, role, active)
                           VALUES ('MUELLER', 'x', 'teacher', 1)`).run(),
    /UNIQUE constraint failed/,
  );
  // Auch der Admin-Name ist geschützt, nicht nur der LDAP-Fall.
  assert.throws(
    () => getDb().prepare(`INSERT INTO users (username, password_hash, role, active)
                           VALUES ('Admin', 'x', 'admin', 1)`).run(),
    /UNIQUE constraint failed/,
  );
});

// ACHTUNG, Grenze dieser Regel: Sie schützt Konten, die in der App bereits
// EXISTIEREN. Hat eine LDAP-Lehrkraft sich noch nie angemeldet (bei
// aktivem Auto-Provisioning gibt es dann noch keine Zeile), kann ein per
// Einladungslink registriertes Konto ihren Namen weiterhin belegen — in
// jeder Schreibweise, auch der exakten. Das ist kein Groß-/Kleinschreibungs-
// Problem mehr, sondern schlichtes Namens-Squatting, und braucht eine
// eigene Entscheidung (Abgleich gegen das Verzeichnis bei der Registrierung
// oder Benutzername in der Einladung fest vorgeben).
test('Einladungslink kann kein bestehendes Konto in anderer Schreibweise übernehmen', async () => {
  let r = await form(admin, '/admin/einladungen/neu', { email: 'extern@example.org', ttl_days: '14' });
  assert.equal(r.status, 302);
  const token = getDb().prepare('SELECT token FROM invitations ORDER BY id DESC LIMIT 1').get().token;

  const squatter = client();
  r = await form(squatter, `/einladung/${token}`, {
    username: 'Mueller', display_name: 'Squatter', password: 'squatter1', password2: 'squatter1',
  });
  assert.equal(r.status, 200, 'kein Redirect — die Registrierung darf nicht durchgehen');
  assert.match(await r.text(), /Benutzername ist bereits vergeben/);

  const namen = getDb().prepare('SELECT username FROM users ORDER BY id').all().map((u) => u.username);
  assert.deepEqual(namen, ['admin', 'mueller'], 'es darf kein zweites Konto entstanden sein');
});

test('Der LDAP-Import des Admins prüft dieselbe Regel', async () => {
  const r = await form(admin, '/admin/ldap/import', {
    login_sub: 'irgendwer', username: 'Mueller', display_name: 'Import', q: '',
  });
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM users').get().c, 2);
});

test('Login findet das Konto weiterhin unabhängig von der Schreibweise', async () => {
  // Die eigentliche Absicht der case-unabhängigen Suche darf nicht verloren
  // gehen: "MUELLER" muss "mueller" finden.
  const { setLdapAuthenticatorForTests } = await import('../src/auth.js');
  const { FakeAuthenticator } = await import('../src/auth/authenticator.js');
  setLdapAuthenticatorForTests(new FakeAuthenticator({ mueller: { passwort: 'echtesADpw', name: 'Echte' } }));

  const req = client();
  const r = await form(req, '/login', { username: 'MUELLER', password: 'echtesADpw' });
  assert.equal(r.headers.get('location'), '/');
  setLdapAuthenticatorForTests(undefined);
});

// Der Fall "Altdatenbank, in der die Dublette schon liegt" braucht eine
// users-Tabelle mit der alten, case-sensitiven Spaltendefinition und
// deshalb eine eigene Datenbank — siehe test/benutzername-altbestand.test.js.

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
