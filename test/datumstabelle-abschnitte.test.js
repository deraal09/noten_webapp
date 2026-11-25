/**
 * Datumstabelle: Fehlstatus e (entschuldigt) / ne (nicht entschuldigt), optionale Abschnitte
 * (Notiz, Zwischennote, Gewichtung) und frei wählbares Datum der Unterrichtsnotizen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-abschnitte-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-abschnitte-bitte-lang-genug-1234';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { HALBJAHRE, neWert, abschnittsDurchschnitt } = await import('../src/grade-calc.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
const HJ = HALBJAHRE[0];
const q = encodeURIComponent(HJ);

function client() {
  const cookies = new Map();
  return async function req(url, opts = {}) {
    const headers = { ...opts.headers };
    if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(base + url, { ...opts, headers, redirect: 'manual' });
    for (const raw of r.headers.getSetCookie ? r.headers.getSetCookie() : []) {
      const [k, ...v] = raw.split(';')[0].split('=');
      cookies.set(k.trim(), v.join('=').trim());
    }
    return r;
  };
}
const form = (req, url, body) => req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
const post = (req, url, body) => req(url, { method: 'POST', body: new URLSearchParams(body) });

const lehrer = client();
const anonym = client();
let ihk, bg, s1, s2, sBg, ts;

async function noten(fachId) {
  return (await (await lehrer(`/teacher/fach/${fachId}/noten?hj=${q}`)).json()).schueler;
}
const zeile = (liste, id) => liste.find((s) => s.schueler_id === id);

test('Vorbereitung: IHK-Klasse mit Fach und zwei Personen, BG-Klasse mit Fach und einer Person', async () => {
  await form(lehrer, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  getDb().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'admin'").run();
  await form(lehrer, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sj = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;
  const db = getDb();
  const anlegen = async (name, ns, schueler) => {
    await form(lehrer, '/teacher/klassen/neu', { schuljahr_id: String(sj), name, notenschluessel: ns });
    const kid = db.prepare('SELECT id FROM klassen WHERE name = ?').get(name).id;
    await form(lehrer, `/teacher/klassen/${kid}/klassenlehrer/eintragen`, {});
    await form(lehrer, `/teacher/klassen/${kid}/faecher/neu`, { name: 'Deutsch' });
    const fid = db.prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Deutsch'").get(kid).id;
    const ids = [];
    for (const [nach, vor] of schueler) {
      await form(lehrer, `/teacher/klassen/${kid}/schueler/neu`, { nachname: nach, vorname: vor });
      ids.push(db.prepare('SELECT id FROM schueler WHERE klasse_id = ? AND nachname = ?').get(kid, nach).id);
    }
    return { fid, ids };
  };
  const a = await anlegen('9B', 'IHK', [['Adler', 'Anna'], ['Berger', 'Ben']]);
  ihk = a.fid; [s1, s2] = a.ids;
  const b = await anlegen('11B', 'BG', [['Claus', 'Cora']]);
  bg = b.fid; [sBg] = b.ids;
});

test('e zählt nicht, ne zählt als 6 (IHK): Durchschnitt, Zähler und Eingabevarianten', async () => {
  ts = [];
  for (const d of ['2025-09-01', '2025-09-08', '2025-09-15', '2025-09-22']) {
    await form(lehrer, `/teacher/fach/${ihk}/unterricht/termine/neu`, { datum: d, halbjahr: HJ });
  }
  ts = getDb().prepare('SELECT id FROM unterricht_termine WHERE fach_id = ? ORDER BY datum').all(ihk).map((t) => t.id);
  const setze = async (tid, wert) => (await (await post(lehrer, `/teacher/unterricht/termine/${tid}/note`, { schueler_id: String(s1), wert })).json());
  assert.equal((await setze(ts[0], '2')).wert, 2);
  const ne = await setze(ts[1], 'ne');
  assert.deepEqual([ne.ok, ne.status, ne.na, ne.wert], [true, 'ne', false, null]);
  assert.equal((await setze(ts[2], 'E')).status, 'e');
  assert.equal((await setze(ts[3], 'n.a.')).status, 'na');
  let z = zeile(await noten(ihk), s1);
  assert.equal(z.datumsDurchschnitt, 4, '(2 + 6) / 2: e und n.a. zählen nicht, ne zählt als 6');
  assert.equal(z.muendlicheNote, 4);
  assert.deepEqual([z.naAnzahl, z.eAnzahl, z.neAnzahl], [1, 1, 1]);
  assert.deepEqual(z.terminNoten.map((t) => t.status), ['', 'ne', 'e', 'na']);
  // andere Schreibweisen
  assert.equal((await setze(ts[2], 'n.e.')).status, 'ne');
  assert.equal((await setze(ts[2], 'e.')).status, 'e');
  // eine Note ersetzt den Status, leer löscht ihn
  assert.deepEqual([(await setze(ts[1], '3')).status, (await setze(ts[1], '3')).wert], ['', 3]);
  z = zeile(await noten(ihk), s1);
  assert.equal(z.datumsDurchschnitt, 2.5);
  assert.equal(z.neAnzahl, 0);
  await setze(ts[1], '');
  assert.equal(getDb().prepare('SELECT status FROM unterricht_noten WHERE termin_id = ? AND schueler_id = ?').get(ts[1], s1).status, '');
});

test('Datumstabelle zeigt e und ne mit eigener Darstellung und die Spalte e / ne', async () => {
  await post(lehrer, `/teacher/unterricht/termine/${ts[1]}/note`, { schueler_id: String(s1), wert: 'ne' });
  const html = await (await lehrer(`/teacher/fach/${ihk}?hj=${q}`)).text();
  assert.match(html, /class="note-datum ist-ne"[^>]*value="ne"/);
  assert.match(html, /class="note-datum ist-na"[^>]*value="e"/);
  assert.match(html, /class="note-datum ist-na"[^>]*value="n\.a\."/);
  assert.match(html, /<th title="Anzahl der Termine mit e \(entschuldigt\) und ne \(nicht entschuldigt\)">e \/ ne<\/th>/);
  assert.match(html, new RegExp(`<td class="note-cell fehl-summe" data-sid="${s1}">e 1 · ne 1</td>`));
  assert.match(html, new RegExp(`<td class="note-cell fehl-summe" data-sid="${s2}">–</td>`));
  const bes = await (await lehrer(`/teacher/fach/${ihk}/besprechung/${s1}?hj=${q}`)).text();
  assert.match(bes, /08\.09\.2025: ne/);
  assert.match(bes, /entschuldigt \(e\): <strong>1<\/strong>/);
});

test('BG: ne zählt als 0 Punkte', async () => {
  for (const d of ['2025-09-01', '2025-09-08']) await form(lehrer, `/teacher/fach/${bg}/unterricht/termine/neu`, { datum: d, halbjahr: HJ });
  const [t1, t2] = getDb().prepare('SELECT id FROM unterricht_termine WHERE fach_id = ? ORDER BY datum').all(bg).map((t) => t.id);
  await post(lehrer, `/teacher/unterricht/termine/${t1}/note`, { schueler_id: String(sBg), wert: '10' });
  await post(lehrer, `/teacher/unterricht/termine/${t2}/note`, { schueler_id: String(sBg), wert: 'ne' });
  const z = zeile(await noten(bg), sBg);
  assert.equal(z.datumsDurchschnitt, 5, '(10 + 0) / 2');
  assert.equal(neWert('BG'), 0);
  assert.equal(neWert('IHK'), 6);
});

test('Rechenkern: Abschnitte werden mit ihrer Gewichtung zu einem Durchschnitt verbunden', () => {
  const r = abschnittsDurchschnitt([{ werte: [2, 4], gewichtung: 1 }, { werte: [1], gewichtung: 2 }, { werte: [], gewichtung: 5 }]);
  assert.deepEqual(r.noten, [3, 1, null]);
  assert.equal(r.durchschnitt, 1.67, '(3*1 + 1*2) / 3; Abschnitt ohne Wert zählt nicht');
  assert.equal(abschnittsDurchschnitt([{ werte: [], gewichtung: 1 }]).durchschnitt, null);
});

let abA, abB;
test('Abschnitte: anlegen, Zwischennoten und gewichteter Durchschnitt, Titel/Notiz/Gewicht ändern', async () => {
  // Ausgangslage Person s2: 3 Termine mit Noten 2, 4 und 1
  for (const d of ['2025-10-06', '2025-10-27']) await form(lehrer, `/teacher/fach/${ihk}/unterricht/termine/neu`, { datum: d, halbjahr: HJ });
  const alle = getDb().prepare('SELECT id, datum FROM unterricht_termine WHERE fach_id = ? ORDER BY datum').all(ihk);
  assert.equal(alle.length, 6);
  // s2 bekommt: 01.09. = 2, 08.09. = 4, 27.10. = 1
  const t = (d) => alle.find((x) => x.datum === d).id;
  await post(lehrer, `/teacher/unterricht/termine/${t('2025-09-01')}/note`, { schueler_id: String(s2), wert: '2' });
  await post(lehrer, `/teacher/unterricht/termine/${t('2025-09-08')}/note`, { schueler_id: String(s2), wert: '4' });
  await post(lehrer, `/teacher/unterricht/termine/${t('2025-10-27')}/note`, { schueler_id: String(s2), wert: '1' });
  assert.equal(zeile(await noten(ihk), s2).datumsDurchschnitt, 2.33, 'ohne Abschnitte: einfacher Schnitt (2+4+1)/3');
  assert.deepEqual(zeile(await noten(ihk), s2).datumsAbschnitte, []);

  let r = await form(lehrer, `/teacher/fach/${ihk}/unterricht/abschnitte/neu`, { datum: '2025-09-01', titel: 'Herbst', halbjahr: HJ });
  assert.equal(r.status, 302);
  r = await form(lehrer, `/teacher/fach/${ihk}/unterricht/abschnitte/neu`, { datum: '2025-10-01', titel: '  Projekt  ', halbjahr: HJ });
  assert.equal(r.status, 302);
  const abs = getDb().prepare('SELECT * FROM unterricht_abschnitte WHERE fach_id = ? ORDER BY ab_datum').all(ihk);
  assert.deepEqual(abs.map((a) => [a.ab_datum, a.titel, a.gewichtung]), [['2025-09-01', 'Herbst', 1], ['2025-10-01', 'Projekt', 1]]);
  [abA, abB] = abs.map((a) => a.id);

  let z = zeile(await noten(ihk), s2);
  assert.deepEqual(z.datumsAbschnitte.map((a) => [a.id, a.note, a.anzahl]), [[abA, 3, 2], [abB, 1, 1]]);
  assert.equal(z.datumsDurchschnitt, 2, 'gleich gewichtet: (3 + 1) / 2 statt einfachem Schnitt 2,33');
  assert.equal(z.muendlicheNote, 2);

  // Gewichtung ändern
  r = await post(lehrer, `/teacher/unterricht/abschnitte/${abB}`, { gewichtung: '2' });
  const j = await r.json();
  assert.deepEqual([j.ok, j.gewichtung], [true, 2]);
  z = zeile(await noten(ihk), s2);
  assert.equal(z.datumsDurchschnitt, 1.67, '(3*1 + 1*2) / 3');
  assert.equal(z.muendlicheNote, 1.67);

  // Titel, Notiz, Kommagewicht
  r = await post(lehrer, `/teacher/unterricht/abschnitte/${abA}`, { titel: 'Herbst  2025 ', notiz: ' Themenblock Lyrik\nmit Gedichtvergleich ', gewichtung: '0,5' });
  const k = await r.json();
  assert.deepEqual([k.titel, k.notiz, k.gewichtung], ['Herbst 2025', 'Themenblock Lyrik\nmit Gedichtvergleich', 0.5]);
  assert.equal(zeile(await noten(ihk), s2).datumsDurchschnitt, 1.4, '(3*0,5 + 1*2) / 2,5');

  // Ungültiges wird abgelehnt und ändert nichts
  assert.equal((await post(lehrer, `/teacher/unterricht/abschnitte/${abA}`, { gewichtung: '-1' })).status, 400);
  assert.equal((await post(lehrer, `/teacher/unterricht/abschnitte/${abA}`, { gewichtung: 'viel' })).status, 400);
  assert.equal((await post(lehrer, `/teacher/unterricht/abschnitte/${abA}`, { notiz: 'x'.repeat(1001) })).status, 400);
  assert.equal((await post(lehrer, `/teacher/unterricht/abschnitte/${abA}`, { ab_datum: 'gestern' })).status, 400);
  assert.equal((await post(lehrer, '/teacher/unterricht/abschnitte/99999', { titel: 'x' })).status, 404);
  assert.equal(getDb().prepare('SELECT gewichtung FROM unterricht_abschnitte WHERE id = ?').get(abA).gewichtung, 0.5);
  // ohne Anmeldung: kein Zugriff
  assert.equal((await post(anonym, `/teacher/unterricht/abschnitte/${abA}`, { titel: 'x' })).status, 401);
  // ungültiges Datum beim Anlegen: kein Abschnitt
  const vorher = getDb().prepare('SELECT COUNT(*) AS c FROM unterricht_abschnitte').get().c;
  await form(lehrer, `/teacher/fach/${ihk}/unterricht/abschnitte/neu`, { datum: 'kein-datum', halbjahr: HJ });
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM unterricht_abschnitte').get().c, vorher);
});

test('Abschnitte: ne und e wirken je Abschnitt; Abschnitt ohne Wert zählt nicht', async () => {
  // s1: 01.09. = 2, 08.09. = ne (6), 15.09. = e, 22.09. = n.a. -> Herbst-Abschnitt (ab 01.09.) Ø 4; Projekt hat keinen Wert
  const z = zeile(await noten(ihk), s1);
  assert.deepEqual(z.datumsAbschnitte.map((a) => [a.note, a.anzahl]), [[4, 2], [null, 0]]);
  assert.equal(z.datumsDurchschnitt, 4, 'der leere Abschnitt zählt nicht mit');
});

test('Abschnitte in der Fachansicht: Kopf mit Titel, Notiz, Gewicht, Zwischennote je Person', async () => {
  const html = await (await lehrer(`/teacher/fach/${ihk}?hj=${q}`)).text();
  assert.match(html, /class="abschnitt-titel"[^>]*value="Herbst 2025"/);
  assert.match(html, /<textarea class="abschnitt-notiz"[^>]*>Themenblock Lyrik\nmit Gedichtvergleich<\/textarea>/);
  assert.match(html, /<details class="abschnitt-notiz-box" data-abschnitt="\d+">\s*<summary>📝 Notiz zum Abschnitt<span class="abschnitt-notiz-vorschau"> – Themenblock Lyrik mit Gedichtvergleich<\/span><\/summary>/, 'Notiz ist aufklappbar, Vorschau in der Überschrift');
  assert.match(html, /class="abschnitt-gewicht"[^>]*value="0\.5"/);
  assert.match(html, /Ø Abschn\./);
  assert.match(html, new RegExp(`<td class="note-cell abschnitt-note" data-sid="${s2}" data-abschnitt="${abA}">3,0</td>`));
  assert.match(html, new RegExp(`<td class="note-cell abschnitt-note" data-sid="${s2}" data-abschnitt="${abB}">1,0</td>`));
  assert.match(html, /\+ Abschnitt beginnen/);
});

test('Abschnitt-Beginn ändern ordnet die Termine neu zu; Löschen erhält Termine und Noten', async () => {
  // Beginn des zweiten Abschnitts auf 08.09.: dann gehören 08.09. (4), 15.09., 22.09., 06.10., 27.10. (1) zu "Projekt"
  const r = await post(lehrer, `/teacher/unterricht/abschnitte/${abB}`, { ab_datum: '2025-09-08' });
  assert.equal((await r.json()).ab_datum, '2025-09-08');
  let z = zeile(await noten(ihk), s2);
  assert.deepEqual(z.datumsAbschnitte.map((a) => [a.note, a.anzahl]), [[2, 1], [2.5, 2]]);
  // Abschnitt löschen: Termine bleiben, es gilt wieder der einfache Schnitt
  const termineVorher = getDb().prepare('SELECT COUNT(*) AS c FROM unterricht_termine WHERE fach_id = ?').get(ihk).c;
  await post(lehrer, `/teacher/unterricht/abschnitte/${abA}/loeschen`, {});
  await post(lehrer, `/teacher/unterricht/abschnitte/${abB}/loeschen`, {});
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM unterricht_abschnitte WHERE fach_id = ?').get(ihk).c, 0);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM unterricht_termine WHERE fach_id = ?').get(ihk).c, termineVorher);
  z = zeile(await noten(ihk), s2);
  assert.equal(z.datumsDurchschnitt, 2.33);
  assert.deepEqual(z.datumsAbschnitte, []);
});

test('Unterrichtsnotizen: Datum frei wählbar (auch nachträglich), Sortierung nach Datum', async () => {
  const url = `/teacher/fach/${ihk}/unterricht/notizen/${s1}?hj=${q}`;
  let r = await post(lehrer, url, { text: 'Stark im Gespräch', halbjahr: HJ, datum: '2025-09-03' });
  let d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.notizen[0].datum, '2025-09-03');
  await post(lehrer, url, { text: 'Neuere Notiz', halbjahr: HJ, datum: '2025-10-20' });
  r = await post(lehrer, url, { text: 'Ohne Datum', halbjahr: HJ });
  d = await r.json();
  assert.match(d.notizen[0].datum, /^\d{4}-\d{2}-\d{2}$/, 'ohne Angabe gilt der Tag des Anlegens');
  assert.equal(d.notizen[0].text, 'Ohne Datum', 'neueste Bezugsdatum zuerst');
  assert.deepEqual(d.notizen.slice(1).map((n) => n.datum), ['2025-10-20', '2025-09-03']);
  // ungültiges Datum -> Tag des Anlegens statt Fehler
  r = await post(lehrer, url, { text: 'Kaputtes Datum', halbjahr: HJ, datum: '31.02.2025' });
  assert.match((await r.json()).notizen[0].datum, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(getDb().prepare("SELECT datum FROM notenbesprechung_notizen WHERE text = 'Kaputtes Datum'").get().datum, null);
  // Datumsfeld im Dialog und Anzeige in der Notenbesprechung
  const html = await (await lehrer(`/teacher/fach/${ihk}?hj=${q}`)).text();
  assert.match(html, /<input type="date" id="unterricht-notiz-datum" value="\d{4}-\d{2}-\d{2}"/);
  const bes = await (await lehrer(`/teacher/fach/${ihk}/besprechung/${s1}?hj=${q}`)).text();
  assert.match(bes, /<strong>03\.09\.2025<\/strong> · /);
});

test('Alte Zeilen mit nicht_anwesend = 1 und leerem Status gelten weiter als n.a.', async () => {
  const db = getDb();
  const tid = db.prepare('SELECT id FROM unterricht_termine WHERE fach_id = ? ORDER BY datum LIMIT 1').get(ihk).id;
  db.prepare("INSERT OR REPLACE INTO unterricht_noten (termin_id, schueler_id, wert, nicht_anwesend, status) VALUES (?, ?, NULL, 1, '')").run(tid, s2);
  const z = zeile(await noten(ihk), s2);
  assert.equal(z.naAnzahl, 1);
  assert.equal(z.terminNoten[0].status, 'na');
});

test('Touch-Auswahl bietet n.a., e und ne an; Hilfe erklärt Abschnitte und Fehlstatus', async () => {
  const js = await (await lehrer('/static/js/noten-picker.js')).text();
  assert.match(js, /wert: 'e'/);
  assert.match(js, /wert: 'ne'/);
  const hilfe = await (await lehrer('/hilfe/unterrichtsleistung')).text();
  assert.match(hilfe, /Abschnitte \(optional\)/);
  assert.match(hilfe, /nicht entschuldigt/);
});

test('Fachseite setzt den Merkzettel der Reiter auf den vorgegebenen Reiter (kein Sprung auf alten Unter-Reiter nach dem Neuladen)', async () => {
  const html = await (await lehrer(`/teacher/fach/${ihk}?hj=${q}`)).text();
  assert.match(html, /localStorage\.setItem\(storageKey, vorgabe\.dataset\.target\)/);
});

test.after(async () => {
  await fastify.close();
});
