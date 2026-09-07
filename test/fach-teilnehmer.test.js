/**
 * Klassenübergreifende Kurse (fach_teilnehmer, src/fach-teilnehmer.js):
 * ein Fach bleibt an eine Heimat-Klasse gebunden, seine Teilnehmerliste
 * kann aber Schüler/innen aus anderen Klassen desselben Schuljahres
 * enthalten. Deckt die Kernanforderungen ab: Notenschlüssel dürfen nicht
 * gemischt werden, Suche über Name+Klasse, manuelles Anlegen (inkl.
 * automatischer Klassen-Anlage), und dass die jeweils EIGENE
 * Klassenleitung die synchronisierten Noten weiterhin sieht.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-fach-teilnehmer-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-fach-teilnehmer-test-bitte-lang-genug';
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
const lehrerA = client(); // Klassenleitung 10A, unterrichtet auch den Kurs
const lehrerB = client(); // Klassenleitung 10B
let sjId, klasseAId, klasseBId, kursFachId;
let schuelerA1, schuelerA2, schuelerB1;

test('Vorbereitung: zwei Klassen (10A, 10B) mit je Klassenleitung, ein Kurs in 10A', async () => {
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
  await form(lehrerA, `/teacher/klassen/${klasseAId}/schueler/neu`, { nachname: 'Berg', vorname: 'Ben' });
  await form(lehrerB, `/teacher/klassen/${klasseBId}/schueler/neu`, { nachname: 'Chor', vorname: 'Cara' });
  const aSchueler = getDb().prepare('SELECT id, nachname FROM schueler WHERE klasse_id = ? ORDER BY nachname').all(klasseAId);
  schuelerA1 = aSchueler[0].id; // Adler
  schuelerA2 = aSchueler[1].id; // Berg
  schuelerB1 = getDb().prepare('SELECT id FROM schueler WHERE klasse_id = ?').get(klasseBId).id;

  // "Kurs" -- ein Fach mit Heimat-Klasse 10A, das später auch Schüler/innen aus 10B aufnimmt.
  await form(lehrerA, `/teacher/klassen/${klasseAId}/faecher/neu`, { name: 'Kurs' });
  kursFachId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Kurs'").get(klasseAId).id;
});

test('Neu angelegtes Fach wird automatisch mit allen Schüler/innen der Heimat-Klasse vorbefüllt', async () => {
  const teilnehmer = getDb().prepare('SELECT schueler_id FROM fach_teilnehmer WHERE fach_id = ?').all(kursFachId)
    .map((r) => r.schueler_id).sort();
  assert.deepEqual(teilnehmer.sort(), [schuelerA1, schuelerA2].sort());
});

test('Ein NACH Fach-Anlage neu hinzugefügter Schüler der Heimat-Klasse wird automatisch Teilnehmer/in (Regression)', async () => {
  await form(lehrerA, `/teacher/klassen/${klasseAId}/schueler/neu`, { nachname: 'Adler', vorname: 'Alex' });
  const neuerSchueler = getDb().prepare("SELECT id FROM schueler WHERE klasse_id = ? AND vorname = 'Alex'").get(klasseAId);
  const istTeilnehmer = getDb().prepare('SELECT 1 FROM fach_teilnehmer WHERE fach_id = ? AND schueler_id = ?')
    .get(kursFachId, neuerSchueler.id);
  assert.ok(istTeilnehmer, 'neu angelegte Schüler/innen der Heimat-Klasse müssen automatisch in bestehenden Fächern der Klasse auftauchen');
});

test('Suche findet Schüler/innen über Name UND Klassenname, schließt bereits Teilnehmende aus', async () => {
  let r = await lehrerA(`/teacher/fach/${kursFachId}/teilnehmer/suche?q=chor`);
  assert.equal(r.status, 200);
  let data = await r.json();
  assert.equal(data.treffer.length, 1);
  assert.equal(data.treffer[0].id, schuelerB1);

  r = await lehrerA(`/teacher/fach/${kursFachId}/teilnehmer/suche?q=10B`);
  data = await r.json();
  assert.equal(data.treffer.length, 1);
  assert.equal(data.treffer[0].klasse_name, '10B');

  // Adler (schuelerA1) ist bereits Teilnehmer -> taucht in der Suche nicht mehr auf.
  r = await lehrerA(`/teacher/fach/${kursFachId}/teilnehmer/suche?q=adler`);
  data = await r.json();
  assert.equal(data.treffer.find((t) => t.id === schuelerA1), undefined);
});

test('Hinzufügen einer Person aus einer anderen Klasse (gleicher Notenschlüssel) funktioniert', async () => {
  const r = await form(lehrerA, `/teacher/fach/${kursFachId}/teilnehmer/hinzufuegen`, {
    schueler_id: String(schuelerB1), halbjahr: HJ,
  });
  assert.equal(r.status, 302);
  const teilnehmer = getDb().prepare('SELECT 1 FROM fach_teilnehmer WHERE fach_id = ? AND schueler_id = ?')
    .get(kursFachId, schuelerB1);
  assert.ok(teilnehmer);
});

test('Gemischter Notenschlüssel wird abgelehnt (Absicherung gegen IHK/BG-Mix)', async () => {
  await form(admin, `/admin/schuljahre/${sjId}/klassen/neu`, { name: '10C-BG', notenschluessel: 'BG' });
  const klasseC = getDb().prepare("SELECT id FROM klassen WHERE name = '10C-BG'").get().id;
  await form(admin, `/admin/klassen/${klasseC}/schueler/neu`, { nachname: 'Dorn', vorname: 'Dana' });
  const schuelerC = getDb().prepare('SELECT id FROM schueler WHERE klasse_id = ?').get(klasseC).id;

  const vorher = getDb().prepare('SELECT COUNT(*) AS c FROM fach_teilnehmer WHERE fach_id = ?').get(kursFachId).c;
  const r = await form(lehrerA, `/teacher/fach/${kursFachId}/teilnehmer/hinzufuegen`, {
    schueler_id: String(schuelerC), halbjahr: HJ,
  });
  assert.equal(r.status, 302);
  const nachher = getDb().prepare('SELECT COUNT(*) AS c FROM fach_teilnehmer WHERE fach_id = ?').get(kursFachId).c;
  assert.equal(nachher, vorher, 'bei Notenschlüssel-Konflikt darf niemand hinzugefügt werden');
});

test('Manuelles Anlegen: unbekannte Klasse wird automatisch (mit passendem Notenschlüssel) erzeugt', async () => {
  const r = await form(lehrerA, `/teacher/fach/${kursFachId}/teilnehmer/manuell`, {
    nachname: 'Ewig', vorname: 'Eva', klasse: '10D', halbjahr: HJ,
  });
  assert.equal(r.status, 302);
  const klasseD = getDb().prepare("SELECT * FROM klassen WHERE schuljahr_id = ? AND name = '10D'").get(sjId);
  assert.ok(klasseD, 'Klasse 10D wurde automatisch angelegt');
  assert.equal(klasseD.notenschluessel, 'IHK', 'übernimmt den Notenschlüssel des Fachs, damit kein Konflikt entstehen kann');
  assert.equal(klasseD.created_by_id, null, 'niemand ist automatisch Ersteller/in -- eine echte Klassenleitung kann sich später eintragen');

  const schuelerEva = getDb().prepare("SELECT id FROM schueler WHERE klasse_id = ? AND vorname = 'Eva'").get(klasseD.id);
  assert.ok(schuelerEva);
  const teilnehmer = getDb().prepare('SELECT 1 FROM fach_teilnehmer WHERE fach_id = ? AND schueler_id = ?')
    .get(kursFachId, schuelerEva.id);
  assert.ok(teilnehmer);
});

test('Manuelles Anlegen: bereits existierende Klasse wird wiederverwendet, kein Duplikat', async () => {
  const r = await form(lehrerA, `/teacher/fach/${kursFachId}/teilnehmer/manuell`, {
    nachname: 'Chor', vorname: 'Curt', klasse: '10B', halbjahr: HJ,
  });
  assert.equal(r.status, 302);
  const klassenMit10B = getDb().prepare("SELECT * FROM klassen WHERE schuljahr_id = ? AND name = '10B'").all(sjId);
  assert.equal(klassenMit10B.length, 1, 'keine zweite Klasse "10B" angelegt');
  const neuerSchueler = getDb().prepare("SELECT id FROM schueler WHERE klasse_id = ? AND vorname = 'Curt'").get(klasseBId);
  assert.ok(neuerSchueler, 'Schüler/in landet in der bestehenden Klasse 10B');
});

test('Sync: BEIDE Klassenleitungen sehen die synchronisierte Note ihres jeweils eigenen Schülers/ihrer Schülerin', async () => {
  await form(lehrerA, `/teacher/fach/${kursFachId}/klausuren/neu`, { name: 'K1', aufgaben: '1', halbjahr: HJ });
  const klausur = getDb().prepare('SELECT * FROM klausuren WHERE fach_id = ?').get(kursFachId);
  await form(lehrerA, `/teacher/klausuren/${klausur.id}/gewichtung`, { gewichtung: '100', halbjahr: HJ });
  await form(lehrerA, `/teacher/klausuren/${klausur.id}/maxpunkte`, { anzahl_aufgaben: '1', mp_0: '10', halbjahr: HJ });
  await lehrerA(`/teacher/klausuren/${klausur.id}/punkte`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ schueler_id: String(schuelerA1), aufgabe_idx: '0', wert: '10' }),
  });
  await lehrerA(`/teacher/klausuren/${klausur.id}/punkte`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ schueler_id: String(schuelerB1), aufgabe_idx: '0', wert: '5' }),
  });

  const syncRes = await form(lehrerA, `/teacher/fach/${kursFachId}/sync`, { halbjahr: HJ });
  assert.equal(syncRes.status, 302);

  // Klassenleitung A sieht den Kurs (Heimat-Klasse) und Anna Adlers Note.
  let html = await (await lehrerA(`/teacher/klassen/${klasseAId}/uebersicht?hj=${encodeURIComponent(HJ)}`)).text();
  assert.match(html, /Kurs<br>/);

  // Klassenleitung B sieht den Kurs EBENFALLS, obwohl seine Heimat-Klasse 10A ist --
  // das ist der eigentliche Kern der Anforderung: die Klassenleitung von Cara Chors
  // eigener Klasse (10B) bekommt die Note trotzdem synchronisiert angezeigt.
  html = await (await lehrerB(`/teacher/klassen/${klasseBId}/uebersicht?hj=${encodeURIComponent(HJ)}`)).text();
  assert.match(html, /Kurs<br>/, 'Klassenleitung B muss den klassenübergreifenden Kurs in ihrer Übersicht sehen');

  // Konferenzmodus für Cara Chor (10B) zeigt den Kurs (mit synchronisierter Note, nicht "–").
  html = await (await lehrerB(`/teacher/klassen/${klasseBId}/konferenz/${schuelerB1}?hj=${encodeURIComponent(HJ)}`)).text();
  assert.match(html, />Kurs</);
  const fachZeile = html.slice(html.indexOf('>Kurs<'), html.indexOf('>Kurs<') + 400);
  assert.doesNotMatch(fachZeile, />–</, 'die Note darf nicht leer sein -- der Sync-Stand muss für Cara ankommen');
});

test.after(async () => {
  await fastify.close();
});
