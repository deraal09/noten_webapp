/**
 * Selbstbedienung: Lehrkräfte können eigene Klassen anlegen, ohne vorher vom
 * Admin zugewiesen zu werden. Ersteller/in behält automatisch Zugriff;
 * andere Lehrkräfte ohne Zuweisung/Klassenlehrer-Eintrag nicht.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-selfservice-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-selfservice-test-bitte-lang-genug';
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

test('Selbstbedienung: Lehrkraft legt eigene Klasse ohne Zuweisung an', async () => {
  const admin = client();
  let r = await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
  });
  assert.equal(r.status, 302);

  r = await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  assert.equal(r.status, 302);
  const sj = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get();
  assert.ok(sj);

  // Zwei Lehrkräfte per Einladungslink anlegen
  r = await form(admin, '/admin/einladungen/neu', { display_name: 'Lehrer A', ttl_days: '14' });
  assert.equal(r.status, 302);
  r = await form(admin, '/admin/einladungen/neu', { display_name: 'Lehrer B', ttl_days: '14' });
  assert.equal(r.status, 302);
  const [invB, invA] = getDb().prepare('SELECT token FROM invitations ORDER BY id DESC').all();

  const lehrerA = client();
  r = await form(lehrerA, `/einladung/${invA.token}`, {
    username: 'lehrera', display_name: 'Lehrer A', password: 'passwortA1', password2: 'passwortA1',
  });
  assert.equal(r.status, 302);

  const lehrerB = client();
  r = await form(lehrerB, `/einladung/${invB.token}`, {
    username: 'lehrerb', display_name: 'Lehrer B', password: 'passwortB1', password2: 'passwortB1',
  });
  assert.equal(r.status, 302);

  // Lehrer A legt selbst eine Klasse an — ohne jede Admin-Zuweisung
  r = await form(lehrerA, '/teacher/klassen/neu', {
    schuljahr_id: String(sj.id), name: '12BFI1', notenschluessel: 'IHK',
  });
  assert.equal(r.status, 302);
  const klasse = getDb().prepare("SELECT * FROM klassen WHERE name = '12BFI1'").get();
  assert.ok(klasse);
  assert.equal(klasse.created_by_id, getDb().prepare("SELECT id FROM users WHERE username='lehrera'").get().id);

  // Ersteller/in sieht die Klasse
  r = await lehrerA(`/teacher/klassen/${klasse.id}`);
  assert.equal(r.status, 200);

  // Lehrer A legt ein Fach an — wird automatisch zugewiesen
  r = await form(lehrerA, `/teacher/klassen/${klasse.id}/faecher/neu`, { name: 'Mathematik' });
  assert.equal(r.status, 302);
  const fach = getDb().prepare("SELECT * FROM faecher WHERE name = 'Mathematik'").get();
  assert.ok(fach);
  const zuweisung = getDb().prepare('SELECT 1 FROM fach_zuweisungen WHERE fach_id = ? AND user_id = ?')
    .get(fach.id, getDb().prepare("SELECT id FROM users WHERE username='lehrera'").get().id);
  assert.ok(zuweisung, 'Ersteller/in sollte automatisch dem eigenen Fach zugewiesen sein');

  // Lehrer B hat keinen Zugriff auf die Klasse von Lehrer A
  r = await lehrerB(`/teacher/klassen/${klasse.id}`);
  assert.equal(r.status, 403);

  // Admin hat weiterhin Zugriff auf alle Klassen
  r = await admin(`/teacher/klassen/${klasse.id}`);
  assert.equal(r.status, 200);
});

test.after(async () => {
  await fastify.close();
});
