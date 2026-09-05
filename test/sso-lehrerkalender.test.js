/**
 * Single Sign-on + Lese-Schnittstelle für den Lehrerkalender (src/sso.js,
 * src/routes/sso.js, src/routes/api-extern.js).
 *
 * Geprüft wird der komplette Ablauf: /sso/authorize schickt Unangemeldete zum
 * Login, liefert danach einen Einmal-Code, der genau einmal gegen die
 * Identität getauscht werden kann — und die Klassen-/Schülerschnittstelle
 * gibt nur die Klassen der jeweiligen Lehrkraft heraus.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-sso-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-sso-test-bitte-lang-genug-damit-es-passt';
process.env.NODE_ENV = 'test';
process.env.SSO_CLIENT_ID = 'lehrerkalender';
process.env.SSO_CLIENT_SECRET = 'gemeinsames-test-geheimnis';
process.env.SSO_REDIRECT_URIS = 'https://kalender.example.org/auth/sso/callback';
delete process.env.LDAP_URL;

const REDIRECT = 'https://kalender.example.org/auth/sso/callback';
const GEHEIM = 'gemeinsames-test-geheimnis';

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');

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

function api(pfad, { sub, secret = GEHEIM } = {}) {
  const headers = { authorization: `Bearer ${secret}`, accept: 'application/json' };
  if (sub) headers['x-noten-sub'] = sub;
  return fetch(base + pfad, { headers });
}

function tokenTausch(body) {
  return fetch(base + '/sso/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
}

const authorizeUrl = (extra = {}) => {
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: 'lehrerkalender',
    redirect_uri: REDIRECT,
    state: 'abc123',
    ...extra,
  });
  return '/sso/authorize?' + p.toString();
};

// ---------------------------------------------------------------- Vorbereitung
// Ein Admin (via /setup), eine Lehrkraft mit eigener Klasse, eine zweite ohne.
const admin = client();
await form(admin, '/setup', {
  username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
});

const db = getDb();
const { hashPassword } = await import('../src/auth.js');
db.prepare(
  `INSERT INTO users (username, display_name, password_hash, role, active, auth_source, login_sub)
   VALUES (?, ?, ?, 'teacher', 1, 'ldap', ?)`,
).run('gades', 'T. Gades', hashPassword('egal-ldap'), 'Gades');
db.prepare(
  `INSERT INTO users (username, display_name, password_hash, role, active, auth_source)
   VALUES (?, ?, ?, 'teacher', 1, 'lokal')`,
).run('extern', 'Externe Kraft', hashPassword('externpass123'));

const sjId = db.prepare("INSERT INTO schuljahre (bezeichnung) VALUES ('2026/2027')").run().lastInsertRowid;
const gades = db.prepare('SELECT * FROM users WHERE username = ?').get('gades');
const klasseId = db.prepare(
  'INSERT INTO klassen (schuljahr_id, name, created_by_id) VALUES (?, ?, ?)',
).run(sjId, '11a BIN', gades.id).lastInsertRowid;
const fachId = db.prepare('INSERT INTO faecher (klasse_id, name) VALUES (?, ?)')
  .run(klasseId, 'Berufliche Informatik').lastInsertRowid;
db.prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)').run(gades.id, fachId);
db.prepare('INSERT INTO schueler (klasse_id, nachname, vorname) VALUES (?, ?, ?)')
  .run(klasseId, 'Müller', 'Anna');
db.prepare('INSERT INTO schueler (klasse_id, nachname, vorname) VALUES (?, ?, ?)')
  .run(klasseId, 'Koch', 'Clara');

// ---------------------------------------------------------------------- Tests
test('authorize: ohne Anmeldung führt der Weg zuerst über /login', async () => {
  const anon = client();
  const r = await anon(authorizeUrl());
  assert.equal(r.status, 302);
  const ort = r.headers.get('location');
  assert.ok(ort.startsWith('/login?next='), ort);
  // Nach dem Login geht es zurück zur authorize-Adresse.
  assert.match(decodeURIComponent(ort), /\/sso\/authorize\?/);
});

test('authorize: unbekannte redirect_uri wird NICHT angesprungen', async () => {
  const c = client();
  await form(c, '/login', { username: 'gades', password: 'egal-ldap' }); // LDAP-Konto: Login schlägt fehl
  const r = await c(authorizeUrl({ redirect_uri: 'https://boese.example/klau' }));
  assert.equal(r.status, 400);
  assert.equal(r.headers.get('location'), null);
});

test('kompletter Ablauf: Code einlösen liefert die Kennung des AD-Kontos', async () => {
  // Anmeldung als lokales Konto (LDAP ist im Test nicht erreichbar) …
  const c = client();
  const login = await form(c, '/login', { username: 'extern', password: 'externpass123' });
  assert.equal(login.status, 302);

  const r = await c(authorizeUrl());
  assert.equal(r.status, 302);
  const ziel = new URL(r.headers.get('location'));
  assert.equal(ziel.origin + ziel.pathname, REDIRECT);
  assert.equal(ziel.searchParams.get('state'), 'abc123');
  const code = ziel.searchParams.get('code');
  assert.ok(code && code.length > 20);

  const t = await tokenTausch({
    client_id: 'lehrerkalender', client_secret: GEHEIM, code, redirect_uri: REDIRECT,
  });
  assert.equal(t.status, 200);
  const identitaet = await t.json();
  // Lokales Konto -> "nv:"-Präfix, damit es nie mit einer AD-Kennung kollidiert.
  assert.equal(identitaet.sub, 'nv:extern');
  assert.equal(identitaet.username, 'extern');
  assert.equal(identitaet.name, 'Externe Kraft');

  // Zweiter Versuch mit demselben Code scheitert (single use).
  const nochmal = await tokenTausch({
    client_id: 'lehrerkalender', client_secret: GEHEIM, code, redirect_uri: REDIRECT,
  });
  assert.equal(nochmal.status, 400);
});

test('token: falsches Geheimnis -> 401, Code bleibt unverbraucht', async () => {
  const c = client();
  await form(c, '/login', { username: 'extern', password: 'externpass123' });
  const r = await c(authorizeUrl());
  const code = new URL(r.headers.get('location')).searchParams.get('code');

  const falsch = await tokenTausch({
    client_id: 'lehrerkalender', client_secret: 'falsch-falsch-falsch', code, redirect_uri: REDIRECT,
  });
  assert.equal(falsch.status, 401);

  const richtig = await tokenTausch({
    client_id: 'lehrerkalender', client_secret: GEHEIM, code, redirect_uri: REDIRECT,
  });
  assert.equal(richtig.status, 200);
});

test('token: abweichende redirect_uri wird abgelehnt', async () => {
  const c = client();
  await form(c, '/login', { username: 'extern', password: 'externpass123' });
  const r = await c(authorizeUrl());
  const code = new URL(r.headers.get('location')).searchParams.get('code');
  const t = await tokenTausch({
    client_id: 'lehrerkalender', client_secret: GEHEIM, code,
    redirect_uri: 'https://kalender.example.org/anders',
  });
  assert.equal(t.status, 400);
});

test('api-extern: ohne Geheimnis 401, mit Geheimnis antwortet /ping', async () => {
  const ohne = await fetch(base + '/api/extern/ping', { headers: { accept: 'application/json' } });
  assert.equal(ohne.status, 401);
  const mit = await api('/api/extern/ping');
  assert.equal(mit.status, 200);
  const j = await mit.json();
  assert.equal(j.app, 'notenverwaltung');
  assert.ok(j.version >= 13);
});

test('api-extern: Klassen der Lehrkraft inkl. Fächer (Kennung = sAMAccountName)', async () => {
  // Groß-/Kleinschreibung der Kennung darf keine Rolle spielen.
  const r = await api('/api/extern/klassen', { sub: 'gades' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.klassen.length, 1);
  const k = j.klassen[0];
  assert.equal(k.name, '11a BIN');
  assert.equal(k.schuljahr, '2026/2027');
  assert.equal(k.schuelerAnzahl, 2);
  assert.deepEqual(k.faecher.map((f) => f.name), ['Berufliche Informatik']);
  assert.equal(k.rolle.ersteller, true);
});

test('api-extern: Schülerliste sortiert, nur mit Klassenzugriff', async () => {
  const r = await api(`/api/extern/klassen/${klasseId}`, { sub: 'Gades' });
  assert.equal(r.status, 200);
  const { klasse } = await r.json();
  assert.deepEqual(klasse.schueler.map((s) => s.nachname), ['Koch', 'Müller']);

  // Lokales Konto ohne jede Zuweisung: kein Zugriff.
  const fremd = await api(`/api/extern/klassen/${klasseId}`, { sub: 'nv:extern' });
  assert.equal(fremd.status, 403);

  // Unbekannte Kennung: sauberer 404 statt Datenpreisgabe.
  const unbekannt = await api('/api/extern/klassen', { sub: 'gibtsnicht' });
  assert.equal(unbekannt.status, 404);
});

test('api-extern: Klassenliste einer Lehrkraft ohne Klassen ist leer', async () => {
  const r = await api('/api/extern/klassen', { sub: 'nv:extern' });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).klassen, []);
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
