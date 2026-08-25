/**
 * Sync-Mechanismus: Lehrkräfte synchronisieren ihre Noten per Knopfdruck
 * oder automatisch mit der Klassenleitung — die Klassenleitung sieht dabei
 * nie die Live-Notentafel, nur den zuletzt synchronisierten Stand
 * (Halbjahresübersicht).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-sync-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-sync-test-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { HALBJAHRE } = await import('../src/grade-calc.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
const HJ = HALBJAHRE[0];

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
let sjId, klasseId, fachId, schuelerId, ulId;

test('Vorbereitung: Admin, Klasse mit Klassenleitung, Fach, Schüler/in, UL mit Punkten', async () => {
  let r = await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
  });
  assert.equal(r.status, 302);
  r = await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  assert.equal(r.status, 302);
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

  r = await form(lehrerA, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '10A', notenschluessel: 'IHK' });
  assert.equal(r.status, 302);
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '10A'").get().id;
  await form(lehrerA, `/teacher/klassen/${klasseId}/klassenlehrer/eintragen`, {});

  await form(lehrerA, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Deutsch' });
  fachId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Deutsch'").get(klasseId).id;

  await form(lehrerA, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Mustermann', vorname: 'Max' });
  schuelerId = getDb().prepare("SELECT id FROM schueler WHERE klasse_id = ?").get(klasseId).id;

  await form(lehrerA, `/teacher/fach/${fachId}/uls/neu`, { name: 'UL1', aufgaben: '1', halbjahr: HJ });
  ulId = getDb().prepare('SELECT id FROM unterrichtsleistungen WHERE fach_id = ?').get(fachId).id;
  await form(lehrerA, `/teacher/uls/${ulId}/gewichtung`, { gewichtung: '100', halbjahr: HJ });
  await form(lehrerA, `/teacher/uls/${ulId}/maxpunkte`, { anzahl_aufgaben: '1', mp_0: '10', halbjahr: HJ });
  const r2 = await lehrerA(`/teacher/uls/${ulId}/punkte`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ schueler_id: String(schuelerId), aufgabe_idx: '0', wert: '8' }),
  });
  assert.equal(r2.status, 200);
});

test('Ohne Sync: Übersicht zeigt "noch nicht synchronisiert", kein Eintrag in fach_sync_stand', async () => {
  const stand = getDb().prepare('SELECT * FROM fach_sync_stand WHERE fach_id = ? AND halbjahr = ?').get(fachId, HJ);
  assert.equal(stand, undefined);

  const r = await lehrerA(`/teacher/klassen/${klasseId}/uebersicht?hj=${encodeURIComponent(HJ)}`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /noch nie synchronisiert/);
});

test('Manueller Sync: Button überträgt den aktuellen Stand, Berechtigung nur für zugewiesene Lehrkraft', async () => {
  // Lehrer B ist NICHT dem Fach zugewiesen → darf nicht synchronisieren
  let r = await form(lehrerB, `/teacher/fach/${fachId}/sync`, { halbjahr: HJ });
  assert.equal(r.status, 403);

  r = await form(lehrerA, `/teacher/fach/${fachId}/sync`, { halbjahr: HJ });
  assert.equal(r.status, 302);

  const stand = getDb().prepare('SELECT * FROM fach_sync_stand WHERE fach_id = ? AND halbjahr = ? AND schueler_id = ?')
    .get(fachId, HJ, schuelerId);
  assert.ok(stand);
  assert.ok(stand.note !== null);

  const meta = getDb().prepare('SELECT * FROM fach_sync_meta WHERE fach_id = ? AND halbjahr = ?').get(fachId, HJ);
  assert.ok(meta);
  assert.equal(meta.synced_by_id, userId('lehrera'));
});

test('Halbjahresübersicht: nur Klassenleitung/Admin, zeigt synchronisierte Note + Notenschnitt', async () => {
  // Lehrer B ist keine Klassenleitung → kein Zugriff auf die Übersicht
  let r = await lehrerB(`/teacher/klassen/${klasseId}/uebersicht`);
  assert.equal(r.status, 403);

  r = await lehrerA(`/teacher/klassen/${klasseId}/uebersicht?hj=${encodeURIComponent(HJ)}`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.doesNotMatch(html, /noch nie synchronisiert/);
  assert.match(html, /Mustermann/);

  r = await admin(`/teacher/klassen/${klasseId}/uebersicht?hj=${encodeURIComponent(HJ)}`);
  assert.equal(r.status, 200);
});

test('Auto-Sync: aktivieren synct sofort, danach jede Änderung automatisch', async () => {
  let r = await form(lehrerA, `/teacher/fach/${fachId}/auto-sync`, { aktiv: '1', halbjahr: HJ });
  assert.equal(r.status, 302);
  const zuweisung = getDb().prepare('SELECT auto_sync FROM fach_zuweisungen WHERE fach_id = ? AND user_id = ?')
    .get(fachId, userId('lehrera'));
  assert.equal(zuweisung.auto_sync, 1);

  const vorMeta = getDb().prepare('SELECT synced_at FROM fach_sync_meta WHERE fach_id = ? AND halbjahr = ?').get(fachId, HJ);
  assert.ok(vorMeta);
  const standVorher = getDb().prepare('SELECT note FROM fach_sync_stand WHERE fach_id = ? AND halbjahr = ? AND schueler_id = ?')
    .get(fachId, HJ, schuelerId);
  assert.ok(standVorher.note !== null); // Stand von wert=8 (aus dem manuellen Sync zuvor)

  // Punktwert ändern (8 → 10 von 10), ohne den Sync-Button zu drücken
  r = await lehrerA(`/teacher/uls/${ulId}/punkte`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ schueler_id: String(schuelerId), aufgabe_idx: '0', wert: '10' }),
  });
  assert.equal(r.status, 200);

  const standNachher = getDb().prepare('SELECT note FROM fach_sync_stand WHERE fach_id = ? AND halbjahr = ? AND schueler_id = ?')
    .get(fachId, HJ, schuelerId);
  assert.ok(standNachher.note !== null);
  // Volle Punktzahl (10/10) sollte eine mindestens so gute Note ergeben wie 8/10 (IHK: 1 ist die beste Note).
  assert.ok(standNachher.note <= standVorher.note);
  assert.notEqual(standNachher.note, standVorher.note, 'Auto-Sync sollte den neuen Stand übernommen haben');
});

test('Konferenzmodus: Zugriffsschutz (nur Klassenleitung/Admin), Navigation, Sync-Stand sichtbar', async () => {
  let r = await lehrerB(`/teacher/klassen/${klasseId}/konferenz/${schuelerId}`);
  assert.equal(r.status, 403);

  r = await lehrerA(`/teacher/klassen/${klasseId}/konferenz/${schuelerId}?hj=${encodeURIComponent(HJ)}`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Mustermann/);
  assert.match(html, /Deutsch/);
  assert.match(html, /1 \/ 1/); // einziger Schüler der Klasse
});

test('Konferenzmodus: Notenkonferenz-Notiz speichern (klassenweit, fach_id NULL)', async () => {
  let r = await lehrerB(`/teacher/klassen/${klasseId}/konferenz/${schuelerId}/notiz`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ halbjahr: HJ, text: 'darf ich nicht' }),
  });
  assert.equal(r.status, 403);

  r = await form(lehrerA, `/teacher/klassen/${klasseId}/konferenz/${schuelerId}/notiz`, {
    halbjahr: HJ, text: 'Konferenz beschließt: Aufstieg mit Auflagen.',
  });
  assert.equal(r.status, 302);

  const notiz = getDb().prepare(
    "SELECT * FROM notenbesprechung_notizen WHERE schueler_id = ? AND typ = 'konferenz'"
  ).get(schuelerId);
  assert.ok(notiz);
  assert.equal(notiz.fach_id, null);
  assert.equal(notiz.text, 'Konferenz beschließt: Aufstieg mit Auflagen.');

  const html = await (await lehrerA(`/teacher/klassen/${klasseId}/konferenz/${schuelerId}?hj=${encodeURIComponent(HJ)}`)).text();
  assert.match(html, /Aufstieg mit Auflagen/);
});

test('Konferenzmodus: Note überschreiben bleibt auch nach erneutem Sync erhalten', async () => {
  const vorSync = getDb().prepare('SELECT note, konferenz_note FROM fach_sync_stand WHERE fach_id = ? AND halbjahr = ? AND schueler_id = ?')
    .get(fachId, HJ, schuelerId);
  assert.ok(vorSync.note !== null);
  assert.equal(vorSync.konferenz_note, null);

  // Lehrer B ist nicht Klassenleitung → keine Berechtigung
  let r = await lehrerB(`/teacher/klassen/${klasseId}/konferenz/${schuelerId}/note`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ halbjahr: HJ, fach_id: String(fachId), note: '2' }),
  });
  assert.equal(r.status, 403);

  r = await form(lehrerA, `/teacher/klassen/${klasseId}/konferenz/${schuelerId}/note`, {
    halbjahr: HJ, fach_id: String(fachId), note: '2,0',
  });
  assert.equal(r.status, 302);

  let stand = getDb().prepare('SELECT note, konferenz_note, konferenz_note_von_id FROM fach_sync_stand WHERE fach_id = ? AND halbjahr = ? AND schueler_id = ?')
    .get(fachId, HJ, schuelerId);
  assert.equal(stand.konferenz_note, 2);
  assert.equal(stand.konferenz_note_von_id, userId('lehrera'));
  const ursprünglicheNote = stand.note;

  // Übersicht zeigt jetzt die Konferenznote statt des reinen Sync-Stands.
  let html = await (await lehrerA(`/teacher/klassen/${klasseId}/uebersicht?hj=${encodeURIComponent(HJ)}`)).text();
  assert.match(html, /title="Konferenzentscheidung"/);

  // Ein erneuter Sync durch die Fachlehrkraft darf die Konferenznote nicht löschen.
  r = await form(lehrerA, `/teacher/fach/${fachId}/sync`, { halbjahr: HJ });
  assert.equal(r.status, 302);
  stand = getDb().prepare('SELECT note, konferenz_note FROM fach_sync_stand WHERE fach_id = ? AND halbjahr = ? AND schueler_id = ?')
    .get(fachId, HJ, schuelerId);
  assert.equal(stand.note, ursprünglicheNote, 'Der reine Sync-Stand bleibt unverändert');
  assert.equal(stand.konferenz_note, 2, 'Die Konferenznote überlebt einen erneuten Sync');

  // Zurücksetzen (leerer Wert) entfernt die Überschreibung wieder.
  r = await form(lehrerA, `/teacher/klassen/${klasseId}/konferenz/${schuelerId}/note`, {
    halbjahr: HJ, fach_id: String(fachId), note: '',
  });
  assert.equal(r.status, 302);
  stand = getDb().prepare('SELECT konferenz_note FROM fach_sync_stand WHERE fach_id = ? AND halbjahr = ? AND schueler_id = ?')
    .get(fachId, HJ, schuelerId);
  assert.equal(stand.konferenz_note, null);

  html = await (await lehrerA(`/teacher/klassen/${klasseId}/uebersicht?hj=${encodeURIComponent(HJ)}`)).text();
  assert.doesNotMatch(html, /title="Konferenzentscheidung"/);
});

test.after(async () => {
  await fastify.close();
});
