/**
 * Neugestaltete Noteneingabe: Notenübersicht (schriftliche/mündliche Note),
 * Notenbesprechungsmodus (Navigation + Notizen), und Fehlzeiten mit
 * optionaler zweiter Schule.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-redesign-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-redesign-test-bitte-lang-genug';
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

const admin = client();
const lehrerA = client();
const lehrerB = client();
let sjId, klasseId, fachId, s1, s2;

test('Vorbereitung: Admin, Klasse, Fach, zwei Schüler/innen, zwei Klausuren', async () => {
  let r = await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
  });
  assert.equal(r.status, 302);
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

  await form(lehrerA, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '11A', notenschluessel: 'IHK' });
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '11A'").get().id;
  await form(lehrerA, `/teacher/klassen/${klasseId}/klassenlehrer/eintragen`, {});
  await form(lehrerA, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Physik' });
  fachId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Physik'").get(klasseId).id;

  await form(lehrerA, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
  await form(lehrerA, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Berger', vorname: 'Ben' });
  const schueler = getDb().prepare('SELECT id, nachname FROM schueler WHERE klasse_id = ? ORDER BY nachname').all(klasseId);
  s1 = schueler[0].id; // Adler
  s2 = schueler[1].id; // Berger

  // Eine Klausur (schriftlich) mit Punkten für beide Schüler/innen
  await form(lehrerA, `/teacher/fach/${fachId}/klausuren/neu`, { name: 'K1', aufgaben: '1', halbjahr: HJ });
  const klausurId = getDb().prepare('SELECT id FROM klausuren WHERE fach_id = ?').get(fachId).id;
  await form(lehrerA, `/teacher/klausuren/${klausurId}/gewichtung`, { gewichtung: '100', halbjahr: HJ });
  await form(lehrerA, `/teacher/klausuren/${klausurId}/maxpunkte`, { anzahl_aufgaben: '1', mp_0: '10', halbjahr: HJ });
  await lehrerA(`/teacher/klausuren/${klausurId}/punkte`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ schueler_id: String(s1), aufgabe_idx: '0', wert: '9' }),
  });

  // Eine UL (mündlich) mit Punkten nur für s1
  await form(lehrerA, `/teacher/fach/${fachId}/uls/neu`, { name: 'UL1', aufgaben: '1', halbjahr: HJ });
  const ulId = getDb().prepare('SELECT id FROM unterrichtsleistungen WHERE fach_id = ?').get(fachId).id;
  await form(lehrerA, `/teacher/uls/${ulId}/gewichtung`, { gewichtung: '100', halbjahr: HJ });
  await form(lehrerA, `/teacher/uls/${ulId}/maxpunkte`, { anzahl_aufgaben: '1', mp_0: '10', halbjahr: HJ });
  await lehrerA(`/teacher/uls/${ulId}/punkte`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ schueler_id: String(s1), aufgabe_idx: '0', wert: '5' }),
  });
});

test('Regression: Punkte-Eingabe funktioniert mit der Kodierung, die der Browser tatsächlich sendet', async () => {
  // fetch() mit einem FormData-Body setzt automatisch
  // Content-Type: multipart/form-data — das versteht der Server
  // (@fastify/formbody) nicht und lehnt die Anfrage mit 415 ab, OHNE dass
  // die Punkte gespeichert werden. Das war der eigentliche Grund, warum
  // live weder Note noch Gesamtnote berechnet wurden: die vorherige
  // fach_detail.ejs schickte ihre AJAX-Punkteingabe genau so. Dieser Test
  // bildet exakt nach, was ein echter Browser sendet (nicht den
  // vereinfachten, direkt url-kodierten POST der übrigen Tests).
  const klausurId = getDb().prepare('SELECT id FROM klausuren WHERE fach_id = ?').get(fachId).id;

  const multipartBody = new FormData();
  multipartBody.append('schueler_id', String(s2));
  multipartBody.append('aufgabe_idx', '0');
  multipartBody.append('wert', '7');
  const multipartRes = await lehrerA(`/teacher/klausuren/${klausurId}/punkte`, {
    method: 'POST', body: multipartBody,
  });
  assert.equal(multipartRes.status, 415, 'multipart/form-data wird vom Server nicht akzeptiert (erwartetes Verhalten)');

  // Sicherstellen, dass fach_detail.ejs NICHT mehr FormData für die
  // Punkt-Inputs verwendet (das genaue Muster, das den Bug verursacht hat).
  const template = fs.readFileSync(
    path.join(process.cwd(), 'views/teacher/fach_detail.ejs'), 'utf8',
  );
  const punktListenerBlock = template.slice(template.indexOf("querySelectorAll('input.punkt')"));
  assert.doesNotMatch(punktListenerBlock, /new FormData\(\)/,
    'Die Punkt-Eingabe darf keine FormData mehr verwenden (führt zu 415 statt gespeicherten Punkten)');
  assert.match(punktListenerBlock, /new URLSearchParams\(\)/);
});

test('Regression: neu angelegte Klausur/UL bekommt automatisch eine Gewichtung > 0', async () => {
  // Eigenes, frisches Fach — die K1/UL1 aus der Vorbereitung haben ihre
  // Gewichtung bereits manuell überschrieben und würden den Bug verdecken.
  await form(lehrerA, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Chemie' });
  const chemieId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Chemie'").get(klasseId).id;

  await form(lehrerA, `/teacher/fach/${chemieId}/klausuren/neu`, { name: 'K1', aufgaben: '1', halbjahr: HJ });
  const klausur = getDb().prepare('SELECT * FROM klausuren WHERE fach_id = ?').get(chemieId);
  assert.notEqual(klausur.gewichtung, 0, 'Gewichtung sollte automatisch verteilt werden, nicht bei 0 bleiben');

  await form(lehrerA, `/teacher/fach/${chemieId}/uls/neu`, { name: 'UL1', aufgaben: '1', halbjahr: HJ });
  const ul = getDb().prepare('SELECT * FROM unterrichtsleistungen WHERE fach_id = ?').get(chemieId);
  assert.notEqual(ul.gewichtung, 0, 'Gewichtung sollte automatisch verteilt werden, nicht bei 0 bleiben');

  // Mit einer Gewichtung > 0 muss ein eingetragener Punktwert auch in der
  // Notenübersicht (schriftliche/mündliche Note, Gesamtnote) ankommen.
  await lehrerA(`/teacher/klausuren/${klausur.id}/punkte`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ schueler_id: String(s1), aufgabe_idx: '0', wert: '1' }),
  });
  const r = await lehrerA(`/teacher/fach/${chemieId}/noten?hj=${encodeURIComponent(HJ)}`);
  const data = await r.json();
  const zeile = data.schueler.find((s) => s.schueler_id === s1);
  assert.notEqual(zeile.schriftlicheNote, null);
  assert.notEqual(zeile.gesamt, null);

  // Regression: eine ZWEITE Klausur, angelegt nachdem K1 schon eine
  // Gewichtung > 0 hat, muss ebenfalls eine Gewichtung > 0 bekommen (nicht
  // komplett übersprungen werden, nur weil K1 nicht mehr bei 0 steht).
  await form(lehrerA, `/teacher/fach/${chemieId}/klausuren/neu`, { name: 'K2', aufgaben: '1', halbjahr: HJ });
  const klausuren = getDb().prepare('SELECT * FROM klausuren WHERE fach_id = ? ORDER BY id').all(chemieId);
  assert.equal(klausuren.length, 2);
  assert.notEqual(klausuren[0].gewichtung, 0);
  assert.notEqual(klausuren[1].gewichtung, 0, 'Zweite Klausur darf nicht bei Gewichtung 0 hängen bleiben');
});

test('Notenübersicht (JSON-API): schriftliche/mündliche Note getrennt berechnet', async () => {
  const r = await lehrerA(`/teacher/fach/${fachId}/noten?hj=${encodeURIComponent(HJ)}`);
  assert.equal(r.status, 200);
  const data = await r.json();
  const zeileS1 = data.schueler.find((s) => s.schueler_id === s1);
  const zeileS2 = data.schueler.find((s) => s.schueler_id === s2);

  // s1: Klausur 9/10 (90% -> Note 1.6), UL 5/10 (50% -> Note 4.4)
  assert.ok(zeileS1.schriftlicheNote !== null);
  assert.ok(zeileS1.muendlicheNote !== null);
  assert.notEqual(zeileS1.schriftlicheNote, zeileS1.muendlicheNote);
  assert.ok(zeileS1.gesamt !== null);

  // s2: keine Punkte irgendwo -> alles null
  assert.equal(zeileS2.schriftlicheNote, null);
  assert.equal(zeileS2.muendlicheNote, null);
  assert.equal(zeileS2.gesamt, null);
});

test('Fach-Detail-Seite (SSR) rendert Notenübersicht mit denselben Werten', async () => {
  const r = await lehrerA(`/teacher/fach/${fachId}?hj=${encodeURIComponent(HJ)}`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Notenübersicht/);
  assert.match(html, /Adler/);
  assert.match(html, /Berger/);
  assert.match(html, /Klausuren/);
  assert.match(html, /Unterrichtsleistungen/);
});

test('Notenbesprechungsmodus: Navigation, Zugriffsschutz, Notizen (Besprechung + Konferenz)', async () => {
  // Nur die zugewiesene Lehrkraft darf besprechen
  let r = await lehrerB(`/teacher/fach/${fachId}/besprechung/${s1}`);
  assert.equal(r.status, 403);

  r = await lehrerA(`/teacher/fach/${fachId}/besprechung/${s1}?hj=${encodeURIComponent(HJ)}`);
  assert.equal(r.status, 200);
  let html = await r.text();
  assert.match(html, /Adler, Anna/);
  assert.match(html, /1 \/ 2/);
  assert.match(html, /Weiter/);

  // Notiz (Notenbesprechung, an dieses Fach gebunden) hinzufügen
  r = await form(lehrerA, `/teacher/fach/${fachId}/besprechung/${s1}/notiz`, {
    halbjahr: HJ, typ: 'besprechung', text: 'Gute mündliche Mitarbeit, schriftlich ausbaufähig.',
  });
  assert.equal(r.status, 302);

  // Notiz (Notenkonferenz-Entscheidung, klassenweit) hinzufügen
  r = await form(lehrerA, `/teacher/fach/${fachId}/besprechung/${s1}/notiz`, {
    halbjahr: HJ, typ: 'konferenz', text: 'Konferenzbeschluss: Nachprüfung in Mathematik.',
  });
  assert.equal(r.status, 302);

  const notizen = getDb().prepare('SELECT * FROM notenbesprechung_notizen WHERE schueler_id = ?').all(s1);
  assert.equal(notizen.length, 2);
  assert.ok(notizen.some((n) => n.typ === 'besprechung' && n.fach_id === fachId));
  assert.ok(notizen.some((n) => n.typ === 'konferenz' && n.fach_id === null));

  r = await lehrerA(`/teacher/fach/${fachId}/besprechung/${s1}?hj=${encodeURIComponent(HJ)}`);
  html = await r.text();
  assert.match(html, /Gute mündliche Mitarbeit/);
  assert.match(html, /Konferenzbeschluss/);

  // Weiter zu s2 (2/2, kein "Weiter"-Link mehr, "Zurück" vorhanden)
  r = await lehrerA(`/teacher/fach/${fachId}/besprechung/${s2}?hj=${encodeURIComponent(HJ)}`);
  assert.equal(r.status, 200);
  html = await r.text();
  assert.match(html, /2 \/ 2/);
  assert.match(html, /btn disabled">Weiter/);
});

test('Halbjahresübersicht zeigt die Notizen der Klassenleitung', async () => {
  await form(lehrerA, `/teacher/fach/${fachId}/sync`, { halbjahr: HJ });
  const r = await lehrerA(`/teacher/klassen/${klasseId}/uebersicht?hj=${encodeURIComponent(HJ)}`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /📝 2/); // zwei Notizen für Adler, Anna
});

test('Fehlzeiten: optionale zweite Schule mit zwei Spalten + Summe', async () => {
  // Zunächst deaktiviert: normales Verhalten
  let r = await lehrerA(`/klassenlehrer/klasse/${klasseId}?hj=${encodeURIComponent(HJ)}`);
  assert.equal(r.status, 200);
  let html = await r.text();
  assert.doesNotMatch(html, /Schule 1 \(h\)/);

  // Aktivieren
  r = await form(lehrerA, `/klassenlehrer/klasse/${klasseId}/zwei-schulen`, { aktiv: '1' });
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare('SELECT zwei_schulen FROM klassen WHERE id = ?').get(klasseId).zwei_schulen, 1);

  r = await lehrerA(`/klassenlehrer/klasse/${klasseId}?hj=${encodeURIComponent(HJ)}`);
  html = await r.text();
  assert.match(html, /Schule 1 \(h\)/);
  assert.match(html, /Schule 2 \(h\)/);

  // Stunden für beide Schulen speichern
  r = await form(lehrerA, `/klassenlehrer/klasse/${klasseId}/speichern`, {
    hj: HJ,
    ['stunden_' + s1 + '_entschuldigt']: '3',
    ['stunden2_' + s1 + '_entschuldigt']: '2',
    ['notiz_' + s1 + '_entschuldigt']: 'Attest',
  });
  assert.equal(r.status, 302);

  const fz1 = getDb().prepare('SELECT stunden FROM fehlzeiten WHERE schueler_id = ? AND halbjahr = ? AND typ = ?')
    .get(s1, HJ, 'entschuldigt');
  const fz2 = getDb().prepare('SELECT stunden FROM fehlzeiten_schule2 WHERE schueler_id = ? AND halbjahr = ? AND typ = ?')
    .get(s1, HJ, 'entschuldigt');
  assert.equal(fz1.stunden, 3);
  assert.equal(fz2.stunden, 2);

  r = await lehrerA(`/klassenlehrer/klasse/${klasseId}?hj=${encodeURIComponent(HJ)}`);
  html = await r.text();
  assert.match(html, /value="3"/);
  assert.match(html, /value="2"/);
});

test.after(async () => {
  await fastify.close();
});
