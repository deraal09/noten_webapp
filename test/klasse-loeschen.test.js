/**
 * Klasse löschen (POST /teacher/klassen/:id/loeschen): bisher durfte das nur
 * die erstellende Lehrkraft oder der Admin -- eine eingetragene
 * Klassenleitung, die die Klasse NICHT selbst angelegt hat (z. B. weil eine
 * andere Lehrkraft sie ursprünglich erstellt und sie dann als
 * Co-Klassenleitung eingetragen hat), lief bisher auf 403. Jetzt gilt
 * dieselbe Regel wie überall sonst bei "Klasse verwalten"
 * (userDarfKlasseVerwalten): Ersteller/in, jede eingetragene Klassenleitung,
 * oder der Admin.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-klasse-loeschen-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-klasse-loeschen-test-bitte-lang-genug';
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
const lehrerFremd = client();
let sjId;

test('Vorbereitung: Admin, drei Lehrkräfte, Klasse von Lehrer A angelegt, Lehrer B als Co-Klassenleitung eingetragen', async () => {
  let r = await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
  });
  assert.equal(r.status, 302);
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;

  for (const name of ['Lehrer A', 'Lehrer B', 'Lehrer Fremd']) {
    await form(admin, '/admin/einladungen/neu', { display_name: name, ttl_days: '14' });
  }
  const invs = getDb().prepare('SELECT token FROM invitations ORDER BY id').all();
  await form(lehrerA, `/einladung/${invs[0].token}`, {
    username: 'lehrera', display_name: 'Lehrer A', password: 'passwortA1', password2: 'passwortA1',
  });
  await form(lehrerB, `/einladung/${invs[1].token}`, {
    username: 'lehrerb', display_name: 'Lehrer B', password: 'passwortB1', password2: 'passwortB1',
  });
  await form(lehrerFremd, `/einladung/${invs[2].token}`, {
    username: 'lehrerfremd', display_name: 'Lehrer Fremd', password: 'passwortF1', password2: 'passwortF1',
  });
  getDb().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'lehrera'").run();

  await form(lehrerA, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '9A', notenschluessel: 'IHK' });
  const klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '9A'").get().id;
  await form(lehrerA, `/teacher/klassen/${klasseId}/klassenlehrer/eintragen`, {});

  const lehrerBId = getDb().prepare("SELECT id FROM users WHERE username = 'lehrerb'").get().id;
  const r2 = await form(lehrerA, `/teacher/klassen/${klasseId}/klassenleitung/hinzufuegen`, { user_id: String(lehrerBId) });
  assert.equal(r2.status, 302);
  assert.ok(getDb().prepare('SELECT 1 FROM klassenleitung WHERE klasse_id = ? AND user_id = ?').get(klasseId, lehrerBId));
});

test('Eine fachfremde Lehrkraft ohne Klassenleitung darf die Klasse nicht löschen', async () => {
  const klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '9A'").get().id;
  const r = await form(lehrerFremd, `/teacher/klassen/${klasseId}/loeschen`, {});
  assert.equal(r.status, 403);
  assert.ok(getDb().prepare('SELECT 1 FROM klassen WHERE id = ?').get(klasseId));
});

test('Co-Klassenleitung (Lehrer B, NICHT Ersteller/in der Klasse) darf die Klasse jetzt löschen', async () => {
  const klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '9A'").get().id;
  await form(lehrerA, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Mathematik' });
  const mathId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Mathematik'").get(klasseId).id;
  await form(lehrerA, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });

  const r = await form(lehrerB, `/teacher/klassen/${klasseId}/loeschen`, {});
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare('SELECT 1 FROM klassen WHERE id = ?').get(klasseId), undefined, 'Klasse wurde gelöscht');
  assert.equal(getDb().prepare('SELECT 1 FROM faecher WHERE id = ?').get(mathId), undefined, 'Fächer der Klasse verschwinden per Cascade mit');
  assert.equal(getDb().prepare("SELECT 1 FROM schueler WHERE klasse_id = ?").get(klasseId), undefined, 'Schüler/innen sind nicht mehr in der gelöschten Klasse');
  assert.equal(getDb().prepare("SELECT COUNT(*) AS c FROM schueler WHERE nachname = 'Adler'").get().c, 1, 'sondern als Person in der Sammelklasse erhalten (siehe schueler-versetzen.test.js)');
});

test('Der Admin darf jede Klasse löschen, auch ohne eigene Zuweisung', async () => {
  await form(lehrerA, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '9B', notenschluessel: 'IHK' });
  const klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '9B'").get().id;

  const r = await form(admin, `/teacher/klassen/${klasseId}/loeschen`, {});
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare('SELECT 1 FROM klassen WHERE id = ?').get(klasseId), undefined);
});

test.after(async () => {
  await fastify.close();
});
