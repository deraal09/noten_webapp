/**
 * Klassenleitung (Selbstregistrierung), Fach-Zuweisung durch die
 * Klassenleitung statt nur durch den Admin, und Verknüpfungsanfragen bei
 * Namenskollisionen beim Selbst-Anlegen von Klassen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-klassenleitung-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-klassenleitung-test-bitte-lang-genug';
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

function userId(username) {
  return getDb().prepare('SELECT id FROM users WHERE username = ?').get(username).id;
}

const admin = client();
const lehrerA = client();
const lehrerB = client();
const lehrerC = client();
let sjId;
let klasseId;

test('Vorbereitung: Admin, Schuljahr, drei Lehrkräfte', async () => {
  let r = await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
  });
  assert.equal(r.status, 302);

  r = await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  assert.equal(r.status, 302);
  sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;

  for (const [key, name] of [['a', 'Lehrer A'], ['b', 'Lehrer B'], ['c', 'Lehrer C']]) {
    await form(admin, '/admin/einladungen/neu', { display_name: name, ttl_days: '14' });
  }
  const invs = getDb().prepare('SELECT token FROM invitations ORDER BY id').all();
  r = await form(lehrerA, `/einladung/${invs[0].token}`, {
    username: 'lehrera', display_name: 'Lehrer A', password: 'passwortA1', password2: 'passwortA1',
  });
  assert.equal(r.status, 302);
  r = await form(lehrerB, `/einladung/${invs[1].token}`, {
    username: 'lehrerb', display_name: 'Lehrer B', password: 'passwortB1', password2: 'passwortB1',
  });
  assert.equal(r.status, 302);
  r = await form(lehrerC, `/einladung/${invs[2].token}`, {
    username: 'lehrerc', display_name: 'Lehrer C', password: 'passwortC1', password2: 'passwortC1',
  });
  assert.equal(r.status, 302);
});

test('Klassenleitung: Selbstregistrierung nur für Ersteller/in, dann blanket Fach-Zugriff', async () => {
  let r = await form(lehrerA, '/teacher/klassen/neu', {
    schuljahr_id: String(sjId), name: '12BFI1', notenschluessel: 'IHK',
  });
  assert.equal(r.status, 302);
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '12BFI1'").get().id;

  // Lehrer B (nicht Ersteller, nicht bereits Klassenleitung) darf sich nicht eintragen
  r = await form(lehrerB, `/teacher/klassen/${klasseId}/klassenlehrer/eintragen`, {});
  assert.equal(r.status, 403);

  // Lehrer A (Ersteller) darf sich eintragen
  r = await form(lehrerA, `/teacher/klassen/${klasseId}/klassenlehrer/eintragen`, {});
  assert.equal(r.status, 302);
  const eintrag = getDb().prepare('SELECT 1 FROM klassenleitung WHERE klasse_id = ? AND user_id = ?')
    .get(klasseId, userId('lehrera'));
  assert.ok(eintrag);

  // Lehrer A (jetzt Klassenleitung) weist Lehrer B ein neues Fach zu, ohne es selbst angelegt zu haben
  r = await form(lehrerA, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Englisch' });
  assert.equal(r.status, 302);
  const englisch = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Englisch'").get(klasseId);

  // Lehrer B darf NICHT selbst zuweisen (ist keine Klassenleitung)
  r = await form(lehrerB, `/teacher/klassen/${klasseId}/zuweisungen/neu`, {
    user_id: String(userId('lehrerb')), fach_id: String(englisch.id),
  });
  assert.equal(r.status, 403);

  // Lehrer A (Klassenleitung) weist Lehrer B dem Fach Englisch zu
  r = await form(lehrerA, `/teacher/klassen/${klasseId}/zuweisungen/neu`, {
    user_id: String(userId('lehrerb')), fach_id: String(englisch.id),
  });
  assert.equal(r.status, 302);
  const zuweisung = getDb().prepare('SELECT 1 FROM fach_zuweisungen WHERE user_id = ? AND fach_id = ?')
    .get(userId('lehrerb'), englisch.id);
  assert.ok(zuweisung);

  // Lehrer A sieht als Klassenleitung auch das Fach Englisch, obwohl nicht direkt zugewiesen
  r = await lehrerA(`/teacher/fach/${englisch.id}`);
  assert.equal(r.status, 200);

  // Lehrer C (unbeteiligt) sieht es nicht
  r = await lehrerC(`/teacher/fach/${englisch.id}`);
  assert.equal(r.status, 403);
});

test('Verknüpfungsanfrage: Namenskollision löst Anfrage aus, alle Verbundenen müssen zustimmen', async () => {
  // Lehrer C versucht dieselbe Klasse anzulegen → Redirect zur Verknüpfung
  const r = await form(lehrerC, '/teacher/klassen/neu', {
    schuljahr_id: String(sjId), name: '12BFI1', notenschluessel: 'IHK',
  });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `/teacher/klassen/${klasseId}/verknuepfen`);

  // Anfrage stellen
  const r2 = await form(lehrerC, `/teacher/klassen/${klasseId}/verknuepfen`, { fach: 'Sport' });
  assert.equal(r2.status, 302);
  const anfrage = getDb().prepare('SELECT * FROM klassen_verknuepfungsanfragen WHERE ziel_klasse_id = ?').get(klasseId);
  assert.ok(anfrage);
  assert.equal(anfrage.status, 'offen');

  // Beide Verbundenen (A, B) müssen zustimmen — B stimmt zu, Status bleibt offen
  let antwort = await form(lehrerB, `/teacher/verknuepfungen/${anfrage.id}/antwort`, { zustimmung: '1' });
  assert.equal(antwort.status, 302);
  assert.equal(getDb().prepare('SELECT status FROM klassen_verknuepfungsanfragen WHERE id = ?').get(anfrage.id).status, 'offen');

  // A lehnt ab → Anfrage sofort abgelehnt, kein Zugriff für C
  antwort = await form(lehrerA, `/teacher/verknuepfungen/${anfrage.id}/antwort`, { zustimmung: '0' });
  assert.equal(antwort.status, 302);
  assert.equal(getDb().prepare('SELECT status FROM klassen_verknuepfungsanfragen WHERE id = ?').get(anfrage.id).status, 'abgelehnt');
  const sportFach = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Sport'").get(klasseId);
  assert.equal(sportFach, undefined);
  const cZugriff = await lehrerC(`/teacher/klassen/${klasseId}`);
  assert.equal(cZugriff.status, 403);
});

test('Verknüpfung: leere/unverbundene Klasse gewährt direkten Zugriff ohne Zustimmung', async () => {
  // Admin legt eine leere Klasse an (kein created_by_id, keine Zuweisungen)
  await form(admin, `/admin/schuljahre/${sjId}/klassen/neu`, { name: 'Leerklasse', notenschluessel: 'IHK' });
  const leer = getDb().prepare("SELECT id FROM klassen WHERE name = 'Leerklasse'").get();

  const r = await form(lehrerC, '/teacher/klassen/neu', {
    schuljahr_id: String(sjId), name: 'Leerklasse', notenschluessel: 'IHK',
  });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `/teacher/klassen/${leer.id}/verknuepfen`);

  const r2 = await form(lehrerC, `/teacher/klassen/${leer.id}/verknuepfen`, { fach: 'Kunst' });
  assert.equal(r2.status, 302);
  assert.equal(r2.headers.get('location'), `/teacher/klassen/${leer.id}`);

  const fach = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Kunst'").get(leer.id);
  assert.ok(fach);
  const zuweisung = getDb().prepare('SELECT 1 FROM fach_zuweisungen WHERE user_id = ? AND fach_id = ?')
    .get(userId('lehrerc'), fach.id);
  assert.ok(zuweisung);
});

test.after(async () => {
  await fastify.close();
});
