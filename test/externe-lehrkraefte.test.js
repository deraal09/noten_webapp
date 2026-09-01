/**
 * Externe Lehrkräfte per Einladungslink: jede Klassenleitung (nicht mehr
 * nur der Admin) kann Einladungslinks erzeugen (routes/teacher.js,
 * GET/POST /teacher/einladungen). Über einen solchen Link registrierte
 * Konten (auth_source 'lokal') bekommen bewusst KEIN Selbstbedienungsrecht
 * (userDarfSelbstKlasseAnlegen) — sie können nur in Fächern Noten
 * eintragen, denen sie explizit zugewiesen wurden. LDAP-Konten behalten
 * das volle Selbstbedienungsrecht.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-externe-lehrkraefte-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-externe-lehrkraefte-bitte-lang-genug';
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
const lehrerA = client(); // LDAP-artig, Klassenleitung
const lehrerB = client(); // wird per Link von A eingeladen — extern
let sjId;
let klasseId;
let fachId;

test('Vorbereitung: Admin, Schuljahr, Klassenleitung (LDAP), Klasse mit Fach', async () => {
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
  getDb().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'lehrera'").run();

  r = await form(lehrerA, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '9A', notenschluessel: 'IHK' });
  assert.equal(r.status, 302);
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '9A'").get().id;
  await form(lehrerA, `/teacher/klassen/${klasseId}/klassenlehrer/eintragen`, {});
  await form(lehrerA, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Musik' });
  fachId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Musik'").get(klasseId).id;
});

test('Nur Klassenleitung darf Einladungslinks erzeugen — ein unbeteiligter LDAP-Lehrer nicht', async () => {
  const fremd = client();
  await form(admin, '/admin/einladungen/neu', { display_name: 'Fremd', ttl_days: '14' });
  const inv = getDb().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
  await form(fremd, `/einladung/${inv.token}`, {
    username: 'fremd', display_name: 'Fremd', password: 'passwortF1', password2: 'passwortF1',
  });
  getDb().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'fremd'").run();

  const r = await fremd('/teacher/einladungen');
  assert.equal(r.status, 403);
});

test('Klassenleitung (Lehrer A) erzeugt eine Einladung für eine externe Lehrkraft', async () => {
  const r = await form(lehrerA, '/teacher/einladungen/neu', { display_name: 'Externe Vertretung', ttl_days: '14' });
  assert.equal(r.status, 302);
  const eintrag = getDb().prepare("SELECT * FROM invitations WHERE display_name = 'Externe Vertretung'").get();
  assert.ok(eintrag);
  assert.equal(eintrag.role, 'teacher');
  assert.equal(eintrag.created_by_id, getDb().prepare("SELECT id FROM users WHERE username = 'lehrera'").get().id);
  const html = await (await lehrerA('/teacher/einladungen')).text();
  assert.match(html, /🟢 offen/);
});

test('Lehrer B registriert sich über den Link — Konto ist sofort nutzbar, aber ohne Selbstbedienung', async () => {
  const inv = getDb().prepare("SELECT token FROM invitations WHERE created_by_id = (SELECT id FROM users WHERE username = 'lehrera')").get();
  const r = await form(lehrerB, `/einladung/${inv.token}`, {
    username: 'lehrerb', display_name: 'Lehrer B', password: 'passwortB1', password2: 'passwortB1',
  });
  assert.equal(r.status, 302, 'Konto ist sofort aktiv/eingeloggt, keine Freischaltung nötig');

  const eintrag = getDb().prepare("SELECT auth_source FROM users WHERE username = 'lehrerb'").get();
  assert.equal(eintrag.auth_source, 'lokal');

  // Kein Selbstbedienungsrecht: eigene Klasse anlegen schlägt fehl.
  const r2 = await form(lehrerB, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '10Z', notenschluessel: 'IHK' });
  assert.equal(r2.status, 302);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS c FROM klassen WHERE name = '10Z'").get().c, 0, 'keine Klasse angelegt');
  const html = await (await lehrerB('/teacher/klassen')).text();
  assert.match(html, /Nur Lehrkräfte mit LDAP-Zugang/);
});

test('Lehrer B hat ohne Zuweisung keinen Zugriff auf das Fach', async () => {
  const r = await lehrerB(`/teacher/fach/${fachId}`);
  assert.equal(r.status, 403);
});

test('Klassenleitung weist Lehrer B dem Fach zu — danach kann er dort Noten eintragen', async () => {
  const lehrerBId = getDb().prepare("SELECT id FROM users WHERE username = 'lehrerb'").get().id;
  const r = await form(lehrerA, `/teacher/klassen/${klasseId}/zuweisungen/neu`, {
    user_id: String(lehrerBId), fach_id: String(fachId),
  });
  assert.equal(r.status, 302);

  const r2 = await lehrerB(`/teacher/fach/${fachId}`);
  assert.equal(r2.status, 200);
});

test('Lehrer B kann weiterhin keine eigene, zweite Klasse anlegen oder sich einer fremden Klasse verknüpfen', async () => {
  const r = await form(lehrerB, `/teacher/klassen/${klasseId}/verknuepfen`, { fach: 'Sport' });
  assert.equal(r.status, 403);
});

test('Löschen einer Einladung ist nur der erstellenden Person (oder dem Admin) erlaubt', async () => {
  await form(lehrerA, '/teacher/einladungen/neu', { display_name: 'Noch offen', ttl_days: '14' });
  const inv = getDb().prepare("SELECT id FROM invitations WHERE display_name = 'Noch offen'").get();

  const r = await form(lehrerB, `/teacher/einladungen/${inv.id}/loeschen`, {});
  assert.equal(r.status, 403);
  assert.ok(getDb().prepare('SELECT 1 FROM invitations WHERE id = ?').get(inv.id));

  const r2 = await form(lehrerA, `/teacher/einladungen/${inv.id}/loeschen`, {});
  assert.equal(r2.status, 302);
  assert.equal(getDb().prepare('SELECT 1 FROM invitations WHERE id = ?').get(inv.id), undefined);
});

test.after(async () => {
  await fastify.close();
});
