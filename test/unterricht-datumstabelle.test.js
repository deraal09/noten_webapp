/**
 * Datumstabelle für die Unterrichtsleistung: eine Spalte je Unterrichtstermin,
 * eine Note je Schüler/in ohne Einzelgewichtung. Der Durchschnitt bildet die
 * Basis der Unterrichtsleistungsnote; Zusatzleistungen (ehem.
 * "Unterrichtsleistungen") wirken mit ihrer eigenen Gewichtung als Anteil
 * INNERHALB der Unterrichtsleistung -- der Rest bis 100 % entfällt
 * automatisch auf die Datumstabelle (siehe grade-calc.js,
 * unterrichtsleistungNote()).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-datumstabelle-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-datumstabelle-bitte-lang-genug';
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

async function jsonPost(req, url, body) {
  return req(url, { method: 'POST', body: new URLSearchParams(body) });
}

const lehrerA = client();
const lehrerB = client();
let klasseId, fachId, s1, s2, termin1, termin2;

test('Vorbereitung: Admin, Klasse, Fach, zwei Schüler/innen', async () => {
  await form(lehrerA, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
  });
  getDb().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'admin'").run();
  await form(lehrerA, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;

  await form(lehrerA, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '9B', notenschluessel: 'IHK' });
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '9B'").get().id;
  await form(lehrerA, `/teacher/klassen/${klasseId}/klassenlehrer/eintragen`, {});
  await form(lehrerA, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Deutsch' });
  fachId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Deutsch'").get(klasseId).id;

  await form(lehrerA, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
  await form(lehrerA, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Berger', vorname: 'Ben' });
  const schueler = getDb().prepare('SELECT id, nachname FROM schueler WHERE klasse_id = ? ORDER BY nachname').all(klasseId);
  s1 = schueler[0].id; // Adler
  s2 = schueler[1].id; // Berger
});

test('Termin anlegen: erscheint als Spalte, noch ohne Noten', async () => {
  let r = await form(lehrerA, `/teacher/fach/${fachId}/unterricht/termine/neu`, { datum: '2025-09-01', halbjahr: HJ });
  assert.equal(r.status, 302);
  termin1 = getDb().prepare('SELECT id FROM unterricht_termine WHERE fach_id = ?').get(fachId).id;

  const html = await (await lehrerA(`/teacher/fach/${fachId}?hj=${encodeURIComponent(HJ)}`)).text();
  assert.match(html, /01\.09\.2025/);
  assert.match(html, /Datumstabelle/);
});

test('Ungültiges Datum wird abgelehnt, kein Termin angelegt', async () => {
  const vorher = getDb().prepare('SELECT COUNT(*) AS c FROM unterricht_termine WHERE fach_id = ?').get(fachId).c;
  await form(lehrerA, `/teacher/fach/${fachId}/unterricht/termine/neu`, { datum: 'kein-datum', halbjahr: HJ });
  const nachher = getDb().prepare('SELECT COUNT(*) AS c FROM unterricht_termine WHERE fach_id = ?').get(fachId).c;
  assert.equal(nachher, vorher);
});

test('Note für einen Termin eintragen (AJAX), erscheint in der Übersicht als Datumsdurchschnitt', async () => {
  let r = await jsonPost(lehrerA, `/teacher/unterricht/termine/${termin1}/note`, {
    schueler_id: String(s1), wert: '2',
  });
  assert.equal(r.status, 200);

  r = await lehrerA(`/teacher/fach/${fachId}/noten?hj=${encodeURIComponent(HJ)}`);
  const data = await r.json();
  const zeile = data.schueler.find((s) => s.schueler_id === s1);
  assert.equal(zeile.datumsDurchschnitt, 2);
  assert.equal(zeile.muendlicheNote, 2, 'ohne Zusatzleistungen zählt die Datumstabelle zu 100 %');

  const zeileS2 = data.schueler.find((s) => s.schueler_id === s2);
  assert.equal(zeileS2.datumsDurchschnitt, null, 'kein Eintrag für s2 -> kein Durchschnitt');
});

test('Notenwert außerhalb des Bereichs wird abgelehnt', async () => {
  const r = await jsonPost(lehrerA, `/teacher/unterricht/termine/${termin1}/note`, {
    schueler_id: String(s1), wert: '7', // IHK: 1-6
  });
  assert.equal(r.status, 400);
  const row = getDb().prepare('SELECT wert FROM unterricht_noten WHERE termin_id = ? AND schueler_id = ?').get(termin1, s1);
  assert.equal(row.wert, 2, 'ungültiger Wert darf den bestehenden nicht überschreiben');
});

test('Zweiter Termin + zweite Note -> Durchschnitt über beide Termine', async () => {
  await form(lehrerA, `/teacher/fach/${fachId}/unterricht/termine/neu`, { datum: '2025-09-08', halbjahr: HJ });
  const termine = getDb().prepare('SELECT id FROM unterricht_termine WHERE fach_id = ? ORDER BY datum').all(fachId);
  termin2 = termine[1].id;

  await jsonPost(lehrerA, `/teacher/unterricht/termine/${termin2}/note`, { schueler_id: String(s1), wert: '4' });

  const r = await lehrerA(`/teacher/fach/${fachId}/noten?hj=${encodeURIComponent(HJ)}`);
  const data = await r.json();
  const zeile = data.schueler.find((s) => s.schueler_id === s1);
  assert.equal(zeile.datumsDurchschnitt, 3, '(2+4)/2 = 3');
  assert.equal(zeile.muendlicheNote, 3);
});

test('Zusatzleistung mit 10% Gewichtung: Rest (90%) entfällt auf die Datumstabelle', async () => {
  await form(lehrerA, `/teacher/fach/${fachId}/uls/neu`, { name: 'Präsentation', aufgaben: '1', halbjahr: HJ });
  const ul = getDb().prepare('SELECT id FROM unterrichtsleistungen WHERE fach_id = ?').get(fachId);
  assert.equal(getDb().prepare('SELECT gewichtung FROM unterrichtsleistungen WHERE id = ?').get(ul.id).gewichtung, 0,
    'neu angelegte Zusatzleistung startet ungewichtet');

  await form(lehrerA, `/teacher/uls/${ul.id}/gewichtung`, { gewichtung: '10', halbjahr: HJ });
  await form(lehrerA, `/teacher/uls/${ul.id}/maxpunkte`, { anzahl_aufgaben: '1', mp_0: '10', halbjahr: HJ });
  await lehrerA(`/teacher/uls/${ul.id}/punkte`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ schueler_id: String(s1), aufgabe_idx: '0', wert: '10' }), // 100% -> Note 1
  });

  const r = await lehrerA(`/teacher/fach/${fachId}/noten?hj=${encodeURIComponent(HJ)}`);
  const data = await r.json();
  const zeile = data.schueler.find((s) => s.schueler_id === s1);
  // Datumstabelle-Ø 3 (90%) + Präsentation-Note 1 (10%) = 3*0.9 + 1*0.1 = 2.8
  assert.equal(zeile.datumsDurchschnitt, 3);
  assert.equal(zeile.muendlicheNote, 2.8);
});

test('Termin löschen: verschwindet aus der Datumstabelle und aus der Durchschnittsberechnung', async () => {
  let r = await form(lehrerA, `/teacher/unterricht/termine/${termin2}/loeschen`, {});
  assert.equal(r.status, 302);

  const html = await (await lehrerA(`/teacher/fach/${fachId}?hj=${encodeURIComponent(HJ)}`)).text();
  assert.doesNotMatch(html, /08\.09\.2025/);

  r = await lehrerA(`/teacher/fach/${fachId}/noten?hj=${encodeURIComponent(HJ)}`);
  const data = await r.json();
  const zeile = data.schueler.find((s) => s.schueler_id === s1);
  assert.equal(zeile.datumsDurchschnitt, 2, 'nur noch Termin 1 (Note 2) übrig');
});

test('Zugriffsschutz: fremde Lehrkraft ohne Fach-Zugriff darf keine Termine/Noten anlegen', async () => {
  await form(lehrerB, '/einladung/' + (await (async () => {
    await form(lehrerA, '/admin/einladungen/neu', { display_name: 'Lehrer B', ttl_days: '14' });
    return getDb().prepare('SELECT token FROM invitations ORDER BY id DESC LIMIT 1').get().token;
  })()), {
    username: 'lehrerb', display_name: 'Lehrer B', password: 'passwortB1', password2: 'passwortB1',
  });

  let r = await form(lehrerB, `/teacher/fach/${fachId}/unterricht/termine/neu`, { datum: '2025-09-15', halbjahr: HJ });
  assert.equal(r.status, 403);

  r = await jsonPost(lehrerB, `/teacher/unterricht/termine/${termin1}/note`, { schueler_id: String(s1), wert: '2' });
  assert.equal(r.status, 403);

  r = await form(lehrerB, `/teacher/unterricht/termine/${termin1}/loeschen`, {});
  assert.equal(r.status, 403);
});

test('Notensperre blockiert auch das Eintragen in die Datumstabelle', async () => {
  let r = await form(lehrerA, `/teacher/klassen/${klasseId}/konferenz/${s1}/sperren`, { halbjahr: HJ });
  assert.equal(r.status, 302);

  r = await jsonPost(lehrerA, `/teacher/unterricht/termine/${termin1}/note`, { schueler_id: String(s1), wert: '5' });
  assert.equal(r.status, 403);
  const row = getDb().prepare('SELECT wert FROM unterricht_noten WHERE termin_id = ? AND schueler_id = ?').get(termin1, s1);
  assert.equal(row.wert, 2, 'gesperrter Wert darf nicht überschrieben werden');

  // s2 ist nicht gesperrt und bleibt normal bearbeitbar.
  r = await jsonPost(lehrerA, `/teacher/unterricht/termine/${termin1}/note`, { schueler_id: String(s2), wert: '5' });
  assert.equal(r.status, 200);
});

test.after(async () => {
  await fastify.close();
});
