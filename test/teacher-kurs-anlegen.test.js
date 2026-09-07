/**
 * Neuen Kurs anlegen (POST /teacher/kurse/neu, src/routes/teacher.js): ein
 * eigener Einstiegspunkt neben "Neue Klasse anlegen" auf /teacher/klassen,
 * der -- ohne eine eigene Klasse dafür anzulegen -- ein Fach auf Basis einer
 * bestehenden Klasse der Lehrkraft erzeugt (technisch identisch zu POST
 * /teacher/klassen/:id/faecher/neu) und direkt auf den Reiter
 * "Teilnehmer/innen" der Fach-Seite weiterleitet, wo sich die Teilnehmerliste
 * um Schüler/innen aus anderen Klassen ergänzen lässt.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-kurs-anlegen-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-kurs-anlegen-test-bitte-lang-genug';
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
const lehrerFremd = client();
let klasseAId, schuelerA1, schuelerA2;

test('Vorbereitung: Klasse 10A mit zwei Schüler:innen, Lehrer A als Klassenleitung', async () => {
  await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
  });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;
  await form(admin, `/admin/schuljahre/${sjId}/klassen/neu`, { name: '10A' });
  klasseAId = getDb().prepare("SELECT id FROM klassen WHERE name = '10A'").get().id;
  await form(admin, `/admin/klassen/${klasseAId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
  await form(admin, `/admin/klassen/${klasseAId}/schueler/neu`, { nachname: 'Berg', vorname: 'Ben' });
  schuelerA1 = getDb().prepare("SELECT id FROM schueler WHERE nachname = 'Adler'").get().id;
  schuelerA2 = getDb().prepare("SELECT id FROM schueler WHERE nachname = 'Berg'").get().id;

  for (const [name, uname] of [['Lehrer A', 'lehrera'], ['Lehrer Fremd', 'lehrerfremd']]) {
    await form(admin, '/admin/einladungen/neu', { display_name: name, ttl_days: '14' });
  }
  const invs = getDb().prepare('SELECT token, display_name FROM invitations ORDER BY id').all();
  for (const inv of invs) {
    const client_ = inv.display_name === 'Lehrer A' ? lehrerA : lehrerFremd;
    const uname = inv.display_name === 'Lehrer A' ? 'lehrera' : 'lehrerfremd';
    await form(client_, `/einladung/${inv.token}`, {
      username: uname, password: 'lehrerpass123', password2: 'lehrerpass123',
    });
  }
  await getDb().prepare('INSERT INTO klassenleitung (klasse_id, user_id) VALUES (?, (SELECT id FROM users WHERE username = ?))')
    .run(klasseAId, 'lehrera');
});

test('Fremde Lehrkraft ohne Klassenzugriff darf keinen Kurs auf dieser Klasse anlegen', async () => {
  const r = await form(lehrerFremd, '/teacher/kurse/neu', { klasse_id: String(klasseAId), name: 'Fremdkurs' });
  assert.equal(r.status, 403);
  const fach = getDb().prepare("SELECT id FROM faecher WHERE name = 'Fremdkurs'").get();
  assert.equal(fach, undefined);
});

test('Klassenleitung legt über /teacher/kurse/neu einen Kurs an -- Teilnehmerliste sofort befüllt, Redirect auf Teilnehmer-Reiter', async () => {
  const r = await form(lehrerA, '/teacher/kurse/neu', { klasse_id: String(klasseAId), name: 'Spanisch AG' });
  assert.equal(r.status, 302);
  const location = r.headers.get('location');
  const fach = getDb().prepare("SELECT id, klasse_id FROM faecher WHERE name = 'Spanisch AG'").get();
  assert.ok(fach, 'Fach wurde angelegt');
  assert.equal(fach.klasse_id, klasseAId);
  assert.equal(location, `/teacher/fach/${fach.id}?tab=teilnehmer`);

  const teilnehmer = getDb().prepare('SELECT schueler_id FROM fach_teilnehmer WHERE fach_id = ?').all(fach.id)
    .map((r2) => r2.schueler_id).sort();
  assert.deepEqual(teilnehmer, [schuelerA1, schuelerA2].sort());

  const zuweisung = getDb().prepare('SELECT * FROM fach_zuweisungen WHERE fach_id = ? AND user_id = (SELECT id FROM users WHERE username = ?)')
    .get(fach.id, 'lehrera');
  assert.ok(zuweisung, 'Ersteller/in wird automatisch dem Kurs zugewiesen');
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
