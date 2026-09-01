/**
 * Klassenleitung-Dashboard (/klassenlehrer): listet jetzt auch Klassen, in
 * denen jemand nur über die klassenleitung-Tabelle (Selbstregistrierung
 * oder Co-Klassenlehrkraft) eingetragen ist — vorher wurde dort nur
 * klassen_lehrkraefte (alte, Admin-basierte Zuweisung je Fach) geprüft,
 * obwohl der Seitenzugriff selbst (userIstKlassenlehrer) beide Tabellen
 * schon immer berücksichtigt hat. Siehe routes/klassenlehrer.js.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-kl-dashboard-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-kl-dashboard-bitte-lang-genug';
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
const lehrerA = client();
const lehrerB = client();

test('Vorbereitung: Admin, Schuljahr, zwei Lehrkräfte, Klasse mit Klassenleitung A + Co-Klassenlehrkraft B', async () => {
  let r = await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
  });
  assert.equal(r.status, 302);
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;

  for (const name of ['Lehrer A', 'Lehrer B']) {
    await form(admin, '/admin/einladungen/neu', { display_name: name, ttl_days: '14' });
  }
  const invs = getDb().prepare('SELECT token FROM invitations ORDER BY id').all();
  await form(lehrerA, `/einladung/${invs[0].token}`, {
    username: 'lehrera', display_name: 'Lehrer A', password: 'passwortA1', password2: 'passwortA1',
  });
  await form(lehrerB, `/einladung/${invs[1].token}`, {
    username: 'lehrerb', display_name: 'Lehrer B', password: 'passwortB1', password2: 'passwortB1',
  });
  getDb().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'lehrera'").run();
  const lehrerBId = getDb().prepare("SELECT id FROM users WHERE username = 'lehrerb'").get().id;

  await form(lehrerA, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '9A', notenschluessel: 'IHK' });
  const klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '9A'").get().id;
  await form(lehrerA, `/teacher/klassen/${klasseId}/klassenlehrer/eintragen`, {});
  await form(lehrerA, `/teacher/klassen/${klasseId}/klassenleitung/hinzufuegen`, { user_id: String(lehrerBId) });
});

test('Klassenleitung-Dashboard zeigt die Klasse für A (klassenleitung-Tabelle) als Kachel', async () => {
  const html = await (await lehrerA('/klassenlehrer')).text();
  assert.match(html, /class="klasse-liste"/);
  assert.match(html, /9A/);
});

test('Regression: Co-Klassenlehrkraft B sieht die Klasse jetzt ebenfalls auf ihrem Dashboard', async () => {
  const html = await (await lehrerB('/klassenlehrer')).text();
  assert.match(html, /9A/, 'B ist nur über die klassenleitung-Tabelle eingetragen und muss trotzdem erscheinen');
});

test.after(async () => {
  await fastify.close();
});
