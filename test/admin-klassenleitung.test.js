/**
 * Admin-Oberfläche zeigt, wer als Klassenleitung einer Klasse eingetragen ist
 * (vorher nur auf der Lehrkraft-Seite /teacher/klassen/:id sichtbar, und dort
 * nur für die Klassenleitung selbst) -- und kann sie über
 * POST /admin/klassen/:id/klassenleitung/hinzufuegen bzw.
 * POST /admin/klassenleitung/:id/entfernen jederzeit setzen/ändern, auch ohne
 * dass sich vorher schon jemand selbst eingetragen hat.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-admin-klassenleitung-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-admin-klassenleitung-test-bitte-lang-genug';
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
let klasseId;

test('Vorbereitung: Klasse ohne Klassenleitung, eine Lehrkraft', async () => {
  await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
  });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;
  await form(admin, `/admin/schuljahre/${sjId}/klassen/neu`, { name: '10A' });
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '10A'").get().id;

  await form(admin, '/admin/einladungen/neu', { display_name: 'Lehrer A', ttl_days: '14' });
  const token = getDb().prepare("SELECT token FROM invitations WHERE display_name = 'Lehrer A'").get().token;
  await form(lehrerA, `/einladung/${token}`, {
    username: 'lehrera', password: 'lehrerpass123', password2: 'lehrerpass123',
  });
});

test('Admin-Klassenseite zeigt "noch keine Klassenleitung", solange keine eingetragen ist', async () => {
  const html = await (await admin(`/admin/klassen/${klasseId}`)).text();
  assert.match(html, /Noch keine Klassenleitung eingetragen/);
});

test('Admin trägt eine Lehrkraft als Klassenleitung ein', async () => {
  const lehrerId = getDb().prepare("SELECT id FROM users WHERE username = 'lehrera'").get().id;
  const r = await form(admin, `/admin/klassen/${klasseId}/klassenleitung/hinzufuegen`, { user_id: String(lehrerId) });
  assert.equal(r.status, 302);

  const eintraege = getDb().prepare('SELECT user_id FROM klassenleitung WHERE klasse_id = ?').all(klasseId);
  assert.deepEqual(eintraege.map((e) => e.user_id), [lehrerId]);

  const html = await (await admin(`/admin/klassen/${klasseId}`)).text();
  assert.match(html, /Lehrer A/);
  assert.doesNotMatch(html, /Noch keine Klassenleitung eingetragen/);

  // Die Lehrkraft hat dadurch auch tatsächlich Klassenleitungs-Rechte.
  const klasseHtml = await (await lehrerA(`/teacher/klassen/${klasseId}`)).text();
  assert.match(klasseHtml, /Du bist Klassenleitung dieser Klasse/);
});

test('Admin kann die Klassenleitung wieder entfernen', async () => {
  const eintrag = getDb().prepare('SELECT id FROM klassenleitung WHERE klasse_id = ?').get(klasseId);
  const r = await form(admin, `/admin/klassenleitung/${eintrag.id}/entfernen`, {});
  assert.equal(r.status, 302);

  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM klassenleitung WHERE klasse_id = ?').get(klasseId).c, 0);
  const html = await (await admin(`/admin/klassen/${klasseId}`)).text();
  assert.match(html, /Noch keine Klassenleitung eingetragen/);
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
