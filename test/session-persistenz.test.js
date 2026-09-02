/**
 * Sitzungen liegen jetzt in SQLite statt im Arbeitsspeicher des Node-Prozesses
 * (src/auth/sqlite-session-store.js) — Ziel: eine Anmeldung übersteht einen
 * Neustart des Prozesses (z. B. jedes Plesk-Deploy: "Git Pull" + "App neu
 * starten"), statt dass alle angemeldeten Personen dabei ohne Vorwarnung
 * ausgeloggt werden.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-session-persistenz-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-session-persistenz-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { closeDb } = await import('../src/db.js');

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
  return {
    async req(base, url, opts = {}) {
      const headers = { ...opts.headers };
      if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
      const r = await fetch(base + url, { ...opts, headers, redirect: 'manual' });
      const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : r.headers.get('set-cookie');
      if (sc) setCookie(sc);
      return r;
    },
  };
}

async function form(c, base, url, body) {
  return c.req(base, url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
}

test('Eine Anmeldung übersteht einen simulierten App-Neustart (neuer Prozess, gleiche DB-Datei)', async () => {
  const app1 = await buildApp({ logger: false });
  const base1 = await app1.listen({ port: 0, host: '127.0.0.1' });

  const c = client();
  let r = await form(c, base1, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
  });
  assert.equal(r.status, 302, 'Setup muss erfolgreich sein und direkt anmelden');

  r = await c.req(base1, '/admin');
  assert.equal(r.status, 200, 'vor dem Neustart ist die Session gültig');

  // "Neustart" simulieren: App und DB-Verbindung schließen (beim nächsten
  // getDb()-Aufruf entsteht eine frische Verbindung, genau wie nach einem
  // echten Prozess-Neustart), danach eine neue App auf derselben DB-Datei
  // aufbauen — der Browser/die Cookies bleiben unverändert (derselbe Client).
  await app1.close();
  closeDb();

  const app2 = await buildApp({ logger: false });
  const base2 = await app2.listen({ port: 0, host: '127.0.0.1' });
  try {
    r = await c.req(base2, '/admin');
    assert.equal(r.status, 200, 'nach dem simulierten Neustart muss die Session noch gültig sein');
    assert.match(await r.text(), /Admin-Dashboard/);
  } finally {
    await app2.close();
    closeDb();
  }
});

test('Der Haken "Angemeldet bleiben" verlängert die Cookie-Gültigkeit deutlich über die Standard-12h hinaus', async () => {
  process.env.DB_PFAD = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-session-maxage-')), 'test.sqlite3');
  const app = await buildApp({ logger: false });
  const base = await app.listen({ port: 0, host: '127.0.0.1' });

  function maxAgeAus(response) {
    const raw = response.headers.getSetCookie
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')];
    const sessionCookie = raw.find((h) => h && h.startsWith('noten_session='));
    assert.ok(sessionCookie, 'Login-Antwort muss die Session-Cookie setzen');
    // @fastify/session setzt statt Max-Age ein Expires-Datum (session.cookie.toJSON()).
    const match = sessionCookie.match(/Expires=([^;]+)/i);
    assert.ok(match, 'Set-Cookie muss ein Expires-Attribut enthalten');
    return (new Date(match[1]).getTime() - Date.now()) / 1000;
  }

  try {
    await form(client(), base, '/setup', {
      username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
    });

    const rOhne = await form(client(), base, '/login', { username: 'admin', password: 'adminpass123' });
    assert.equal(rOhne.status, 302);
    const maxAgeOhne = maxAgeAus(rOhne);
    assert.ok(maxAgeOhne > 0 && maxAgeOhne <= 12 * 60 * 60 + 5,
      'ohne Haken gilt weiterhin die Standarddauer von 12 Stunden');

    const rMit = await form(client(), base, '/login', {
      username: 'admin', password: 'adminpass123', angemeldet_bleiben: '1',
    });
    assert.equal(rMit.status, 302);
    const maxAgeMit = maxAgeAus(rMit);
    assert.ok(maxAgeMit > 25 * 24 * 60 * 60,
      'mit gesetztem Haken muss die Gültigkeit auf mehrere Wochen ausgedehnt sein');
    assert.ok(maxAgeMit > maxAgeOhne);
  } finally {
    await app.close();
    closeDb();
  }
});
