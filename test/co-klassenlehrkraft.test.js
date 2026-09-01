/**
 * Co-Klassenlehrkraft: Eine bestehende Klassenleitung kann eine zweite
 * Person als gleichberechtigte Klassenleitung eintragen (routes/teacher.js,
 * POST /klassen/:id/klassenleitung/hinzufuegen). Diese Person hat danach
 * dieselben Rechte wie die ursprüngliche Klassenleitung — insbesondere
 * Zugriff auf die Fehlzeiten-Seite (routes/klassenlehrer.js), da beide
 * über dieselbe klassenleitung-Tabelle geprüft werden (userIstKlassenlehrer).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-co-klassenlehrkraft-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-co-klassenlehrkraft-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { HALBJAHRE } = await import('../src/grade-calc.js');

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
const lehrerC = client();
let sjId;
let klasseId;
let lehrerBId;

test('Vorbereitung: Admin, Schuljahr, drei Lehrkräfte, Klasse mit Klassenleitung A', async () => {
  let r = await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
  });
  assert.equal(r.status, 302);
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;

  for (const name of ['Lehrer A', 'Lehrer B', 'Lehrer C']) {
    await form(admin, '/admin/einladungen/neu', { display_name: name, ttl_days: '14' });
  }
  const invs = getDb().prepare('SELECT token FROM invitations ORDER BY id').all();
  await form(lehrerA, `/einladung/${invs[0].token}`, {
    username: 'lehrera', display_name: 'Lehrer A', password: 'passwortA1', password2: 'passwortA1',
  });
  await form(lehrerB, `/einladung/${invs[1].token}`, {
    username: 'lehrerb', display_name: 'Lehrer B', password: 'passwortB1', password2: 'passwortB1',
  });
  await form(lehrerC, `/einladung/${invs[2].token}`, {
    username: 'lehrerc', display_name: 'Lehrer C', password: 'passwortC1', password2: 'passwortC1',
  });
  lehrerBId = getDb().prepare("SELECT id FROM users WHERE username = 'lehrerb'").get().id;
  getDb().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'lehrera'").run();

  r = await form(lehrerA, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '9A', notenschluessel: 'IHK' });
  assert.equal(r.status, 302);
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '9A'").get().id;
  await form(lehrerA, `/teacher/klassen/${klasseId}/klassenlehrer/eintragen`, {});
});

test('Lehrer C (nicht Klassenleitung) darf keine Co-Klassenlehrkraft eintragen', async () => {
  const r = await form(lehrerC, `/teacher/klassen/${klasseId}/klassenleitung/hinzufuegen`, { user_id: String(lehrerBId) });
  assert.equal(r.status, 403);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM klassenleitung WHERE klasse_id = ?').get(klasseId).c, 1);
});

test('Lehrer A (Klassenleitung) trägt Lehrer B als Co-Klassenlehrkraft ein', async () => {
  const r = await form(lehrerA, `/teacher/klassen/${klasseId}/klassenleitung/hinzufuegen`, { user_id: String(lehrerBId) });
  assert.equal(r.status, 302);
  const eintraege = getDb().prepare('SELECT user_id FROM klassenleitung WHERE klasse_id = ? ORDER BY user_id').all(klasseId);
  assert.equal(eintraege.length, 2);

  const html = await (await lehrerA(`/teacher/klassen/${klasseId}`)).text();
  assert.match(html, /Lehrer B/);
});

test('Lehrer B kann jetzt die Fehlzeiten-Seite der Klasse öffnen und Fehlzeiten speichern', async () => {
  const r = await lehrerB(`/klassenlehrer/klasse/${klasseId}`);
  assert.equal(r.status, 200);

  await form(lehrerA, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
  const schuelerId = getDb().prepare('SELECT id FROM schueler WHERE klasse_id = ?').get(klasseId).id;

  const r2 = await form(lehrerB, `/klassenlehrer/klasse/${klasseId}/speichern`, {
    hj: HALBJAHRE[0],
    ['stunden_' + schuelerId + '_entschuldigt']: '4',
  });
  assert.equal(r2.status, 302);
  const fz = getDb().prepare('SELECT stunden FROM fehlzeiten WHERE schueler_id = ? AND typ = ?').get(schuelerId, 'entschuldigt');
  assert.equal(fz.stunden, 4);
});

test('Lehrer C hat weiterhin keinen Zugriff auf die Fehlzeiten-Seite', async () => {
  const r = await lehrerC(`/klassenlehrer/klasse/${klasseId}`);
  assert.equal(r.status, 403);
});

test('Co-Klassenlehrkraft entfernen', async () => {
  const eintrag = getDb().prepare('SELECT id FROM klassenleitung WHERE klasse_id = ? AND user_id = ?').get(klasseId, lehrerBId);
  const r = await form(lehrerA, `/teacher/klassenleitung/${eintrag.id}/entfernen`, {});
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM klassenleitung WHERE klasse_id = ?').get(klasseId).c, 1);
  const r2 = await lehrerB(`/klassenlehrer/klasse/${klasseId}`);
  assert.equal(r2.status, 403);
});

test.after(async () => {
  await fastify.close();
});
