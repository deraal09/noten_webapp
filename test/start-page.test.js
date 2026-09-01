/**
 * Startseite nach dem Anmelden (/start, src/routes/start.js) mit den vier
 * Kacheln Meine Klassen/Sitzpläne/Noteneingabe/Klassenleitung, sowie die
 * neue Sitzpläne-Übersichtsseite (/teacher/sitzplaene), die alle Klassen
 * mit Zugriff auflistet (dieselbe Zugriffsregel wie "Meine Klassen").
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-start-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-start-test-bitte-lang-genug';
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
let sjId;
let klasseId;

test('Vorbereitung: Admin, Schuljahr, Lehrkraft, Klasse', async () => {
  let r = await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
  });
  assert.equal(r.status, 302);
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;

  await form(admin, '/admin/einladungen/neu', { display_name: 'Lehrer A', ttl_days: '14' });
  const inv = getDb().prepare('SELECT token FROM invitations ORDER BY id').get();
  r = await form(lehrerA, `/einladung/${inv.token}`, {
    username: 'lehrera', display_name: 'Lehrer A', password: 'passwortA1', password2: 'passwortA1',
  });
  assert.equal(r.status, 302);

  r = await form(lehrerA, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '9A', notenschluessel: 'IHK' });
  assert.equal(r.status, 302);
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '9A'").get().id;
});

test('Nicht angemeldet: /start verweist auf den Login (wie jede andere geschützte Route)', async () => {
  const r = await client()('/start');
  assert.equal(r.status, 401);
  assert.match(r.headers.get('location'), /\/login/);
});

test('Nach dem Anmelden leitet / eine Lehrkraft auf /start um (nicht mehr direkt auf /teacher)', async () => {
  const r = await lehrerA('/');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/start');
});

test('Admin wird weiterhin auf /admin umgeleitet', async () => {
  const r = await admin('/');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/admin');
});

test('/start zeigt die vier Kacheln mit den richtigen Zielen', async () => {
  const r = await lehrerA('/start');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /href="\/teacher\/klassen"[^>]*>[\s\S]*?Meine Klassen/);
  assert.match(html, /href="\/teacher\/sitzplaene"[^>]*>[\s\S]*?Sitzpläne/);
  assert.match(html, /href="\/teacher"[^>]*>[\s\S]*?Noteneingabe/);
  assert.match(html, /href="\/klassenlehrer"[^>]*>[\s\S]*?Klassenleitung/);
});

test('/teacher/sitzplaene listet die eigenen Klassen mit Link zum jeweiligen Sitzplan', async () => {
  const r = await lehrerA('/teacher/sitzplaene');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /9A/);
  assert.match(html, new RegExp(`/teacher/klassen/${klasseId}/sitzplan`));
});

test('/teacher/sitzplaene zeigt einen Hinweis, wenn (noch) keine Klasse zugänglich ist', async () => {
  const admin2 = client();
  await form(admin2, '/login', { username: 'admin', password: 'adminpass123' });
  await form(admin2, '/admin/einladungen/neu', { display_name: 'Lehrer B', ttl_days: '14' });
  const inv = getDb().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
  const lehrerB = client();
  await form(lehrerB, `/einladung/${inv.token}`, {
    username: 'lehrerb', display_name: 'Lehrer B', password: 'passwortB1', password2: 'passwortB1',
  });
  const r = await lehrerB('/teacher/sitzplaene');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /keine Klassen mit Zugriff/);
});

test.after(async () => {
  await fastify.close();
});
