/**
 * Eigenes Passwort ändern (/konto/passwort) -- für lokale Konten, insbesondere den Admin.
 * - Das aktuelle Passwort muss stimmen; Fehlversuche führen zur Sperre.
 * - Neues Passwort: Mindestlänge, zweimal gleich, nicht das alte.
 * - Danach: Anmeldung mit dem neuen Passwort, nicht mehr mit dem alten; andere Sitzungen des Kontos sind beendet,
 *   die eigene bleibt angemeldet.
 * - LDAP-Konten: kein lokales Passwort, die Seite verweist auf das Schulkonto.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-passwort-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-passwort-aendern-lang-genug-xxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { hashPassword, makeToken, setLdapAuthenticatorForTests } = await import('../src/auth.js');
const { FakeAuthenticator } = await import('../src/auth/authenticator.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });

function client() {
  const cookies = new Map();
  return async (url, opts = {}) => {
    const headers = { ...opts.headers };
    if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(base + url, { ...opts, headers, redirect: 'manual' });
    for (const raw of r.headers.getSetCookie()) { const [k, ...v] = raw.split(';')[0].split('='); cookies.set(k.trim(), v.join('=').trim()); }
    return r;
  };
}
const form = (req, url, body = {}) => req(url, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body),
});
const admin = client();
const zweitesGeraet = client();
const angemeldet = async (c) => (await c('/admin')).status === 200;

test('Vorbereitung: Admin auf zwei Geräten angemeldet', async () => {
  await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'altes-passwort1', password2: 'altes-passwort1' });
  await form(zweitesGeraet, '/login', { username: 'admin', password: 'altes-passwort1' });
  assert.ok(await angemeldet(admin));
  assert.ok(await angemeldet(zweitesGeraet));
});

test('Seite und Menüeintrag „Passwort ändern“ für den Admin', async () => {
  const seite = await (await admin('/konto/passwort')).text();
  assert.match(seite, /name="aktuell"/);
  assert.match(seite, /name="neu"/);
  assert.match(seite, /name="neu2"/);
  assert.match(await (await admin('/start')).text(), /href="\/konto\/passwort"/);
  assert.equal((await client()('/konto/passwort')).status !== 200, true, 'ohne Anmeldung nicht erreichbar');
});

test('Falsches aktuelles Passwort, zu kurz, ungleich oder unverändert: abgelehnt', async () => {
  const fall = async (body, text) => {
    const r = await form(admin, '/konto/passwort', body);
    assert.equal(r.status, 400);
    assert.match(await r.text(), text);
  };
  await fall({ aktuell: 'falsch', neu: 'neues-passwort1', neu2: 'neues-passwort1' }, /aktuelle Passwort stimmt nicht/);
  await fall({ aktuell: 'altes-passwort1', neu: 'kurz', neu2: 'kurz' }, /mindestens 8 Zeichen/);
  await fall({ aktuell: 'altes-passwort1', neu: 'neues-passwort1', neu2: 'anderes-passwort' }, /stimmen nicht überein/);
  await fall({ aktuell: 'altes-passwort1', neu: 'altes-passwort1', neu2: 'altes-passwort1' }, /unterscheiden/);
  assert.ok(await angemeldet(admin));
});

test('Ändern: neues Passwort gilt, altes nicht mehr; andere Sitzungen beendet, eigene bleibt', async () => {
  getDb().prepare('DELETE FROM login_ratelimit').run();
  const r = await form(admin, '/konto/passwort', { aktuell: 'altes-passwort1', neu: 'neues-passwort1', neu2: 'neues-passwort1' });
  assert.equal(r.status, 302);
  assert.match(await (await admin(r.headers.get('location'))).text(), /Passwort geändert/);
  assert.ok(await angemeldet(admin), 'eigene Sitzung bleibt angemeldet');
  assert.ok(!(await angemeldet(zweitesGeraet)), 'das andere Gerät muss sich neu anmelden');
  const alt = await form(client(), '/login', { username: 'admin', password: 'altes-passwort1' });
  assert.equal(alt.status, 200, 'altes Passwort: Login-Seite mit Fehler');
  const neu = await form(client(), '/login', { username: 'admin', password: 'neues-passwort1' });
  assert.equal(neu.status, 302);
});

test('Wiederholt falsches aktuelles Passwort führt zur Sperre', async () => {
  for (let i = 0; i < 3; i++) await form(admin, '/konto/passwort', { aktuell: 'falsch', neu: 'x-neues-passwort', neu2: 'x-neues-passwort' });
  const r = await form(admin, '/konto/passwort', { aktuell: 'neues-passwort1', neu: 'x-neues-passwort', neu2: 'x-neues-passwort' });
  assert.equal(r.status, 429);
  assert.match(await r.text(), /Zu viele Fehlversuche/);
  getDb().prepare('DELETE FROM login_ratelimit').run();
});

test('LDAP-Konto: kein lokales Passwort, kein Menüeintrag, Änderung wird abgelehnt', async () => {
  getDb().prepare(`INSERT INTO users (username, display_name, password_hash, role, active, auth_source, login_sub)
    VALUES ('lehrer', 'Lehrer', ?, 'teacher', 1, 'ldap', 'lehrer')`).run(hashPassword(makeToken()));
  setLdapAuthenticatorForTests(new FakeAuthenticator({ lehrer: { passwort: 'pw-lehrer' } }));
  const lehrer = client();
  await form(lehrer, '/login', { username: 'lehrer', password: 'pw-lehrer' });
  assert.doesNotMatch(await (await lehrer('/start')).text(), /href="\/konto\/passwort"/);
  assert.match(await (await lehrer('/konto/passwort')).text(), /Schulkonto \(LDAP\)/);
  assert.equal((await form(lehrer, '/konto/passwort', { aktuell: 'x', neu: 'neues-passwort1', neu2: 'neues-passwort1' })).status, 400);
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
