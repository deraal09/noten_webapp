/**
 * Der Notenschlüssel einer Klasse wird beim Anlegen festgelegt und bleibt
 * für Lehrkräfte (Klassenleitung) danach unveränderbar -- nur der Admin
 * kann ihn über eine eigene Seite (/admin/klassen/:id/notenschluessel)
 * nachträglich korrigieren. Dabei gilt die Absicherung gegen einen
 * Notenschlüssel-Mix bei klassenübergreifenden Kursen (fach_teilnehmer,
 * src/fach-teilnehmer.js) auch für den Admin.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-ns-aendern-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-ns-aendern-test-bitte-lang-genug';
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
let sjId, klasseAId, klasseBId, fachId;

test('Vorbereitung: zwei Klassen, ein Fach in A mit Teilnehmerin aus B', async () => {
  await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
  });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;

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
  getDb().prepare("UPDATE users SET auth_source = 'ldap' WHERE username IN ('lehrera', 'lehrerb')").run();

  await form(lehrerA, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '10A', notenschluessel: 'IHK' });
  klasseAId = getDb().prepare("SELECT id FROM klassen WHERE name = '10A'").get().id;
  await form(lehrerA, `/teacher/klassen/${klasseAId}/klassenlehrer/eintragen`, {});

  await form(lehrerB, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '10B', notenschluessel: 'IHK' });
  klasseBId = getDb().prepare("SELECT id FROM klassen WHERE name = '10B'").get().id;
  await form(lehrerB, `/teacher/klassen/${klasseBId}/klassenlehrer/eintragen`, {});

  await form(lehrerA, `/teacher/klassen/${klasseAId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
  await form(lehrerB, `/teacher/klassen/${klasseBId}/schueler/neu`, { nachname: 'Chor', vorname: 'Cara' });

  await form(lehrerA, `/teacher/klassen/${klasseAId}/faecher/neu`, { name: 'Kurs' });
  fachId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Kurs'").get(klasseAId).id;
});

test('Der Notenschlüssel steht bei Anlage fest -- keine Selbstbedienungs-Route für die Klassenleitung', async () => {
  const r = await form(lehrerA, `/teacher/klassen/${klasseAId}/notenschluessel`, { notenschluessel: 'BG' });
  assert.equal(r.status, 404, 'diese Route gibt es für Lehrkräfte nicht (mehr)');
  assert.equal(getDb().prepare('SELECT notenschluessel FROM klassen WHERE id = ?').get(klasseAId).notenschluessel, 'IHK');

  const seite = await (await lehrerA(`/teacher/klassen/${klasseAId}`)).text();
  assert.doesNotMatch(seite, /Notenschlüssel ändern/, 'auf der Klassenseite gibt es keine Bearbeitungsmöglichkeit mehr');
});

test('Admin kann den Notenschlüssel einer unbeteiligten Klasse nachträglich korrigieren', async () => {
  const csvBg = '100,15;85,13;50,6;33,3;20,1;0,0';
  const r = await form(admin, `/admin/klassen/${klasseBId}/notenschluessel`, { notenschluessel: 'BG', csv: csvBg });
  assert.equal(r.status, 302);
  const klasse = getDb().prepare('SELECT notenschluessel, notenschluessel_csv FROM klassen WHERE id = ?').get(klasseBId);
  assert.equal(klasse.notenschluessel, 'BG');
  assert.equal(klasse.notenschluessel_csv, csvBg);

  // Zurücksetzen für die nachfolgenden Tests.
  const r2 = await form(admin, `/admin/klassen/${klasseBId}/notenschluessel`, { notenschluessel: 'IHK', csv: '100,1;95,1.3;90,1.6;50,4;0,6' });
  assert.equal(r2.status, 302);
  assert.equal(getDb().prepare('SELECT notenschluessel FROM klassen WHERE id = ?').get(klasseBId).notenschluessel, 'IHK');
});

test('Sobald ein klassenübergreifender Kurs existiert, wird ein inkompatibler Admin-Wechsel abgelehnt', async () => {
  const cara = getDb().prepare('SELECT id FROM schueler WHERE klasse_id = ?').get(klasseBId).id;
  await form(lehrerA, `/teacher/fach/${fachId}/teilnehmer/hinzufuegen`, { schueler_id: String(cara), halbjahr: '1. Halbjahr' });
  assert.ok(getDb().prepare('SELECT 1 FROM fach_teilnehmer WHERE fach_id = ? AND schueler_id = ?').get(fachId, cara));

  // Klasse A (Heimat-Klasse des Kurses) auf BG umstellen -> Cara (10B, IHK) würde inkompatibel.
  let r = await form(admin, `/admin/klassen/${klasseAId}/notenschluessel`, { notenschluessel: 'BG' });
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare('SELECT notenschluessel FROM klassen WHERE id = ?').get(klasseAId).notenschluessel, 'IHK',
    'Wechsel darf nicht angewendet werden, solange der Kurs eine fremde Teilnehmerin mit anderem Schlüssel hat');
  const seite = await (await admin(`/admin/klassen/${klasseAId}/notenschluessel`)).text();
  assert.match(seite, /Notenschlüssel-Wechsel nicht möglich/);

  // Umgekehrte Richtung: Klasse B (Caras eigene Klasse) auf BG umstellen -> ebenfalls inkompatibel,
  // weil Cara an einem fremden (IHK-)Kurs teilnimmt.
  r = await form(admin, `/admin/klassen/${klasseBId}/notenschluessel`, { notenschluessel: 'BG' });
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare('SELECT notenschluessel FROM klassen WHERE id = ?').get(klasseBId).notenschluessel, 'IHK',
    'Wechsel darf nicht angewendet werden, solange eigene Schüler/innen an einem fremden Kurs mit anderem Schlüssel teilnehmen');
});

test('Nach Entfernen aus dem Kurs ist der Admin-Wechsel wieder möglich', async () => {
  const cara = getDb().prepare('SELECT id FROM schueler WHERE klasse_id = ?').get(klasseBId).id;
  await form(lehrerA, `/teacher/fach/${fachId}/teilnehmer/entfernen`, { schueler_id: String(cara), halbjahr: '1. Halbjahr' });

  const r = await form(admin, `/admin/klassen/${klasseAId}/notenschluessel`, { notenschluessel: 'BG' });
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare('SELECT notenschluessel FROM klassen WHERE id = ?').get(klasseAId).notenschluessel, 'BG');
});

test.after(async () => {
  await fastify.close();
});
