/**
 * Als Klassenleitung eintragen: jede Lehrkraft mit Zugriff auf die Klasse darf das -- auch ohne sie angelegt zu
 * haben --, solange noch niemand eingetragen ist. Danach verwaltet diese Person die Klasse; die erstellende
 * Lehrkraft verliert ihre Sonderrechte.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-kl-eintragen-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-klassenleitung-eintragen-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const auth = await import('../src/auth.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });

function client() {
  const cookies = new Map();
  return async function req(url, opts = {}) {
    const headers = { ...opts.headers };
    if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(base + url, { ...opts, headers, redirect: 'manual' });
    for (const raw of r.headers.getSetCookie?.() ?? []) {
      const [k, ...v] = raw.split(';')[0].split('=');
      cookies.set(k.trim(), v.join('=').trim());
    }
    return r;
  };
}
const form = (req, url, body = {}) => req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });

const admin = client();
const [a, b, c] = [client(), client(), client()];
const db = () => getDb();
let klasseId, fachId;
const user = (n) => ({ ...db().prepare('SELECT id, username FROM users WHERE username = ?').get(n), isAdmin: false });
const leitung = () => db().prepare('SELECT u.username FROM klassenleitung k JOIN users u ON u.id = k.user_id WHERE k.klasse_id = ? ORDER BY k.id').all(klasseId).map((r) => r.username);
const EINTRAGEN = /Als Klassenleitung eintragen/;

test('Vorbereitung: A legt die Klasse an; B hat nur ein Fach; C hat keinen Zugriff', async () => {
  await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sj = db().prepare('SELECT id FROM schuljahre').get().id;
  for (const [client_, name] of [[a, 'anna'], [b, 'bernd'], [c, 'carla']]) {
    await form(admin, '/admin/einladungen/neu', { display_name: name, ttl_days: '14' });
    const inv = db().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
    await form(client_, `/einladung/${inv.token}`, { username: name, display_name: name, password: 'passwort123', password2: 'passwort123' });
    db().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = ?").run(name);
  }
  await form(a, '/teacher/klassen/neu', { schuljahr_id: String(sj), name: '10K', notenschluessel: 'IHK' });
  klasseId = db().prepare("SELECT id FROM klassen WHERE name = '10K'").get().id;
  await form(a, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Mathe' });
  fachId = db().prepare('SELECT id FROM faecher WHERE klasse_id = ?').get(klasseId).id;
  db().prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)').run(user('bernd').id, fachId);
  assert.deepEqual(leitung(), []);
});

test('Ohne Klassenleitung: Lehrkraft mit Zugriff (nicht die Erstellerin) sieht den Knopf und kann sich eintragen; ohne Zugriff nicht', async () => {
  assert.match(await (await b(`/teacher/klassen/${klasseId}`)).text(), EINTRAGEN);
  assert.equal((await form(c, `/teacher/klassen/${klasseId}/klassenlehrer/eintragen`)).status, 403);
  assert.deepEqual(leitung(), []);
  const r = await form(b, `/teacher/klassen/${klasseId}/klassenlehrer/eintragen`);
  assert.equal(r.status, 302);
  assert.deepEqual(leitung(), ['bernd']);
});

test('Danach übernimmt B die Verwaltung: weitere können sich nicht mehr eintragen, die Erstellerin verliert ihre Sonderrechte', async () => {
  // A (Erstellerin) darf sich nicht mehr eintragen, sieht den Knopf nicht
  assert.doesNotMatch(await (await a(`/teacher/klassen/${klasseId}`)).text(), EINTRAGEN);
  await form(a, `/teacher/klassen/${klasseId}/klassenlehrer/eintragen`);
  assert.deepEqual(leitung(), ['bernd']);
  // Verwaltung: nur B (und Admin), nicht mehr A
  assert.equal(auth.userDarfKlasseVerwalten(user('anna'), klasseId), false);
  assert.equal(auth.userDarfKlasseVerwalten(user('bernd'), klasseId), true);
  assert.equal(auth.userDarfKlasseVerwalten({ ...user('anna'), isAdmin: true }, klasseId), true);
  assert.equal((await form(a, `/teacher/faecher/${fachId}/loeschen`)).status, 403);
  // Export der Live-Werte: nur noch mit eigener Fach-Zuweisung (A wurde beim Anlegen des Fachs automatisch zugewiesen)
  assert.equal(auth.userDarfKlasseExportieren(user('anna'), klasseId), true);
  db().prepare('DELETE FROM fach_zuweisungen WHERE user_id = ? AND fach_id = ?').run(user('anna').id, fachId);
  assert.equal(auth.userDarfKlasseExportieren(user('anna'), klasseId), false, 'als Erstellerin ohne Fach kein Export mehr');
  // A behält den normalen Zugriff auf die Klasse
  assert.equal(auth.userHatKlassenZugriff(user('anna'), klasseId), true, 'Erstellerin behält den Zugriff auf die Klasse');
  assert.equal((await a(`/teacher/klassen/${klasseId}`)).status, 200);
  // Die Klassenleitung trägt weitere Personen selbst ein (Co-Klassenleitung)
  assert.equal((await form(a, `/teacher/klassen/${klasseId}/klassenleitung/hinzufuegen`, { user_id: String(user('carla').id) })).status, 403);
  assert.equal((await form(b, `/teacher/klassen/${klasseId}/klassenleitung/hinzufuegen`, { user_id: String(user('anna').id) })).status, 302);
  assert.deepEqual(leitung(), ['bernd', 'anna']);
  assert.equal(auth.userDarfKlasseVerwalten(user('anna'), klasseId), true);
});

test('Solange niemand eingetragen ist, verwaltet die Erstellerin; wird die Klassenleitung entfernt, gilt das wieder', async () => {
  db().prepare('DELETE FROM klassenleitung WHERE klasse_id = ?').run(klasseId);
  assert.equal(auth.userDarfKlasseVerwalten(user('anna'), klasseId), true);
  assert.equal(auth.userDarfKlasseVerwalten(user('bernd'), klasseId), false);
  assert.equal(auth.userDarfKlasseExportieren(user('anna'), klasseId), true);
  assert.equal(auth.userDarfSichAlsKlassenleitungEintragen(user('bernd'), klasseId), true);
  assert.equal(auth.userDarfSichAlsKlassenleitungEintragen(user('carla'), klasseId), false, 'ohne Zugriff nicht');
});

test('Zwei gleichzeitig: nur die erste Eintragung gilt; der Admin darf immer', async () => {
  db().prepare('INSERT OR IGNORE INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)').run(user('carla').id, fachId);
  await Promise.all([form(b, `/teacher/klassen/${klasseId}/klassenlehrer/eintragen`), form(c, `/teacher/klassen/${klasseId}/klassenlehrer/eintragen`)]);
  assert.equal(leitung().length, 1);
  await form(admin, `/teacher/klassen/${klasseId}/klassenlehrer/eintragen`);
  assert.equal(leitung().length, 2);
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
