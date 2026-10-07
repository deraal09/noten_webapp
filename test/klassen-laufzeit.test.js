/**
 * Laufzeit einer Klasse über mehrere Schuljahre: Einschulungs-/Abschluss-
 * schuljahr, Halbjahre 1..N, Standarddauer (BG/IHK 3, SPA 2 Jahre).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-laufzeit-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-laufzeit-test-bitte-lang-genug-xxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const J = await import('../src/klassen-jahre.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });

// ---------- Routen / Oberfläche ----------
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
  return req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
}
// Wiederholte Felder (teil_name, teil_aufgaben, ...) wie ein Browser senden.
async function formListe(req, url, paare) {
  const body = new URLSearchParams();
  for (const [k, v] of paare) body.append(k, v);
  return req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
}


const admin = client();
let sj1, sj2, ihkId, spaId, ihkFachId;

test('Vorbereitung: zwei Schuljahre, eine IHK- und eine SPA-Klasse ohne Laufzeit-Angabe', async () => {
  await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2026/27' });
  sj1 = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;
  sj2 = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2026/27'").get().id;
  await form(admin, '/teacher/klassen/neu', { schuljahr_id: String(sj1), name: '11A', notenschluessel: 'IHK' });
  await form(admin, '/teacher/klassen/neu', { schuljahr_id: String(sj1), name: '13SPA', notenschluessel: 'SPA', spa_bildungsgang: 'SPA_REGULAR' });
  ihkId = getDb().prepare("SELECT id FROM klassen WHERE name = '11A'").get().id;
  spaId = getDb().prepare("SELECT id FROM klassen WHERE name = '13SPA'").get().id;
  await form(admin, `/teacher/klassen/${ihkId}/faecher/neu`, { name: 'Englisch' });
  ihkFachId = getDb().prepare('SELECT id FROM faecher WHERE klasse_id = ?').get(ihkId).id;
});

test('Standarddauer: IHK/BG drei Jahre (6 Halbjahre), SPA zwei Jahre (4 Halbjahre); Einschulung = Schuljahr der Klasse', () => {
  const ihk = J.klassenLaufzeit(ihkId);
  assert.equal(ihk.einschulungJahr, 2025);
  assert.equal(ihk.abschlussJahr, 2027);
  assert.equal(ihk.abschlussIstStandard, true);
  assert.deepEqual(ihk.halbjahre, ['1. Halbjahr', '2. Halbjahr', '3. Halbjahr', '4. Halbjahr', '5. Halbjahr', '6. Halbjahr']);
  assert.deepEqual(ihk.schuljahre.map((s) => s.bezeichnung), ['2025/26', '2026/27', '2027/28']);
  const spa = J.klassenLaufzeit(spaId);
  assert.equal(spa.anzahlHalbjahre, 4);
  assert.equal(spa.abschlussJahr, 2026);
});

test('Hilfsfunktionen: Schuljahr des Halbjahres, aktuelles Halbjahr, Eingabe-Parsing', () => {
  const l = J.klassenLaufzeit(ihkId);
  assert.equal(J.schuljahrDesHalbjahrs(l, 1), '2025/26');
  assert.equal(J.schuljahrDesHalbjahrs(l, 2), '2025/26');
  assert.equal(J.schuljahrDesHalbjahrs(l, 3), '2026/27');
  assert.equal(J.schuljahrDesHalbjahrs(l, 6), '2027/28');
  assert.equal(J.aktuellesHalbjahrDerKlasse(l, new Date('2025-10-01')), '1. Halbjahr');
  assert.equal(J.aktuellesHalbjahrDerKlasse(l, new Date('2026-03-01')), '2. Halbjahr');
  assert.equal(J.aktuellesHalbjahrDerKlasse(l, new Date('2026-10-01')), '3. Halbjahr');
  assert.equal(J.aktuellesHalbjahrDerKlasse(l, new Date('2024-10-01')), '1. Halbjahr', 'vor Beginn');
  assert.equal(J.aktuellesHalbjahrDerKlasse(l, new Date('2031-10-01')), '6. Halbjahr', 'nach Ende');
  assert.equal(J.istHalbjahrVergangen(l, 2, new Date('2026-10-01')), true);
  assert.equal(J.istHalbjahrVergangen(l, 3, new Date('2026-10-01')), false);
  assert.equal(J.halbjahrNr('3. Halbjahr'), 3);
  assert.equal(J.halbjahrNr('x'), null);
  assert.equal(J.halbjahrAusEingabe(ihkId, '5'), '5. Halbjahr');
  assert.equal(J.halbjahrAusEingabe(ihkId, '5. Halbjahr'), '5. Halbjahr');
  assert.equal(J.halbjahrAusEingabe(ihkId, '7. Halbjahr'), '1. Halbjahr', 'ungültig -> aktuelles Halbjahr (Test-Datum 1.10.2025)');
  assert.equal(J.halbjahrAusEingabe(spaId, '5'), '1. Halbjahr', 'SPA hat nur vier Halbjahre');
  process.env.NOTEN_HEUTE = '2026-10-01';
  assert.equal(J.halbjahrAusEingabe(ihkId, 'x'), '3. Halbjahr', 'Standard = aktuelles Halbjahr');
  assert.equal(J.halbjahrAusEingabe(ihkId, '2'), '2. Halbjahr');
  delete process.env.NOTEN_HEUTE;
});

test('Fachseite akzeptiert alle Halbjahre der Laufzeit und zeigt sie als Reiter', async () => {
  const html = await (await admin(`/teacher/fach/${ihkFachId}?hj=${encodeURIComponent('5. Halbjahr')}`)).text();
  assert.match(html, /class="hj-tab active"[^>]*>5\. Halbjahr</);
  assert.match(html, />6\. Halbjahr</);
  const spaFach = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND spa_fach_key = 'LF2'").get(spaId).id;
  const spaHtml = await (await admin(`/teacher/fach/${spaFach}?ansicht=leistungen&hj=3`)).text();
  assert.match(spaHtml, />4\. Halbjahr</);
  assert.doesNotMatch(spaHtml, />5\. Halbjahr</);
});

test('Laufzeit ändern: Abschlussschuljahr wählbar, Standard wiederherstellbar, ungültig abgelehnt', async () => {
  let r = await form(admin, `/teacher/klassen/${ihkId}/laufzeit`, { einschulung_jahr: '2025', abschluss_jahr: '2025' });
  assert.equal(r.status, 302);
  assert.equal(J.klassenLaufzeit(ihkId).anzahlHalbjahre, 2, 'ein Jahr');
  r = await form(admin, `/teacher/klassen/${ihkId}/laufzeit`, { einschulung_jahr: '2025', abschluss_jahr: '2028' });
  assert.equal(J.klassenLaufzeit(ihkId).anzahlHalbjahre, 8, 'vier Jahre');
  await form(admin, `/teacher/klassen/${ihkId}/laufzeit`, { einschulung_jahr: '2025', abschluss_jahr: '2020' });
  assert.equal(J.klassenLaufzeit(ihkId).abschlussJahr, 2028, 'Abschluss vor Einschulung wird abgelehnt');
  await form(admin, `/teacher/klassen/${ihkId}/laufzeit`, { einschulung_jahr: '2025', abschluss_jahr: '' });
  assert.equal(J.klassenLaufzeit(ihkId).anzahlHalbjahre, 6, 'Standard');
  assert.equal(J.klassenLaufzeit(ihkId).abschlussIstStandard, true);
});

test('Einschulung kann verschoben werden; Halbjahre zählen ab dort', async () => {
  await form(admin, `/teacher/klassen/${ihkId}/laufzeit`, { einschulung_jahr: '2024', abschluss_jahr: '' });
  const l = J.klassenLaufzeit(ihkId);
  assert.deepEqual(l.schuljahre.map((s) => s.bezeichnung), ['2024/25', '2025/26', '2026/27']);
  assert.equal(J.schuljahrDesHalbjahrs(l, 3), '2025/26');
  await form(admin, `/teacher/klassen/${ihkId}/laufzeit`, { einschulung_jahr: '2025', abschluss_jahr: '' });
});

test('Kürzen verweigert, wenn in wegfallenden Halbjahren schon Leistungen stehen', async () => {
  await form(admin, `/teacher/fach/${ihkFachId}/klausuren/neu`, { name: 'K5', aufgaben: '1', halbjahr: '5. Halbjahr' });
  const r = await form(admin, `/teacher/klassen/${ihkId}/laufzeit`, { einschulung_jahr: '2025', abschluss_jahr: '2026' });
  assert.equal(r.status, 302);
  assert.equal(J.klassenLaufzeit(ihkId).anzahlHalbjahre, 6, 'unverändert');
  await form(admin, `/teacher/klassen/${ihkId}/laufzeit`, { einschulung_jahr: '2025', abschluss_jahr: '2027' });
  assert.equal(J.klassenLaufzeit(ihkId).anzahlHalbjahre, 6);
});

test('Klasse erscheint in den Reitern aller Schuljahre ihrer Laufzeit; Anlegen mit Laufzeit-Angabe', async () => {
  const html = await (await admin('/teacher/klassen')).text();
  const vorkommen = (html.match(/11A/g) || []).length;
  assert.ok(vorkommen >= 2, 'in 2025/26 und 2026/27 gelistet');
  await form(admin, '/teacher/klassen/neu', { schuljahr_id: String(sj2), name: '12X', notenschluessel: 'BG', einschulung_jahr: '2026', abschluss_jahr: '2027' });
  const k = getDb().prepare("SELECT id, einschulung_jahr, abschluss_jahr FROM klassen WHERE name = '12X'").get();
  assert.deepEqual([k.einschulung_jahr, k.abschluss_jahr], [2026, 2027]);
  assert.equal(J.klassenLaufzeit(k.id).anzahlHalbjahre, 4);
});

test('Mündlich-Anteil richtet sich nach dem Schuljahr des Halbjahres', async () => {
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2027/28' });
  getDb().prepare("UPDATE schuljahre SET gewichtung_muendlich = 70 WHERE bezeichnung = '2026/27'").run();
  assert.equal(J.muendlichProzentFuerHalbjahr(ihkId, '1. Halbjahr'), 60);
  assert.equal(J.muendlichProzentFuerHalbjahr(ihkId, '3. Halbjahr'), 70);
  assert.equal(J.muendlichProzentFuerHalbjahr(ihkId, '6. Halbjahr'), 60);
});

test('Klassenseite zeigt das Laufzeit-Formular (Einschulungsjahr festlegen) und alle Halbjahre', async () => {
  const html = await (await admin(`/teacher/klassen/${ihkId}`)).text();
  assert.match(html, /Einschulungsjahr festlegen/);
  assert.match(html, /6 Halbjahre/);
  assert.match(html, /name="einschulung_jahr"/);
  assert.match(html, /name="anzahl_jahre"/);
  const kl = await (await admin(`/klassenlehrer/klasse/${ihkId}?tab=klassenleitung`)).text();
  assert.doesNotMatch(kl, /Laufzeit der Klasse/);
});

test('Buttons zur Noteneingabe: auf "Meine Klassen" (oben und je Klasse) und auf der Klassenseite', async () => {
  const liste = await (await admin('/teacher/klassen')).text();
  assert.match(liste, /<a class="btn" href="\/teacher">📝 Zur Noteneingabe<\/a>/);
  assert.match(liste, new RegExp(`<a href="/teacher#klasse-${ihkId}">📝 Noteneingabe</a>`));
  const klasse = await (await admin(`/teacher/klassen/${ihkId}`)).text();
  assert.match(klasse, new RegExp(`<a class="btn" href="/teacher#klasse-${ihkId}">📝 Noteneingabe</a>`));
});

test('Einschulungsjahr festlegen (Klassenseite): Anzahl Jahre 2 oder 3 einstellbar, Standard wiederherstellbar, Rücksprung zur Klasse', async () => {
  const xId = getDb().prepare("SELECT id FROM klassen WHERE name = '12X'").get().id; // ohne eingetragene Leistungen
  const html = await (await admin(`/teacher/klassen/${xId}`)).text();
  assert.match(html, /<summary>Einschulungsjahr festlegen/);
  assert.doesNotMatch(html, /Klasse ins nächste Schuljahr übertragen/);
  assert.match(html, /name="anzahl_jahre"/);
  let r = await form(admin, `/teacher/klassen/${xId}/laufzeit`, { einschulung_jahr: '2025', anzahl_jahre: '2', zurueck: 'klasse' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `/teacher/klassen/${xId}`);
  let l = J.klassenLaufzeit(xId);
  assert.deepEqual([l.jahre, l.anzahlHalbjahre, l.abschlussJahr, l.abschlussIstStandard], [2, 4, 2026, false]);
  const nach2 = await (await admin(`/teacher/klassen/${xId}`)).text();
  assert.match(nach2, /<option value="2" selected>2 Jahre<\/option>/);
  await form(admin, `/teacher/klassen/${xId}/laufzeit`, { einschulung_jahr: '2025', anzahl_jahre: '3' });
  assert.equal(J.klassenLaufzeit(xId).anzahlHalbjahre, 6);
  await form(admin, `/teacher/klassen/${xId}/laufzeit`, { einschulung_jahr: '2025', anzahl_jahre: '' });
  l = J.klassenLaufzeit(xId);
  assert.deepEqual([l.jahre, l.abschlussIstStandard], [3, true], 'leer = Standard');
  // Anzahl Jahre gilt ab dem gewählten Einschulungsjahr
  await form(admin, `/teacher/klassen/${xId}/laufzeit`, { einschulung_jahr: '2024', anzahl_jahre: '2' });
  assert.deepEqual(J.klassenLaufzeit(xId).schuljahre.map((x) => x.bezeichnung), ['2024/25', '2025/26']);
  await form(admin, `/teacher/klassen/${xId}/laufzeit`, { einschulung_jahr: '2025', anzahl_jahre: '' });
});

test('Anlegen mit Anzahl Jahre', async () => {
  await form(admin, '/teacher/klassen/neu', { schuljahr_id: String(sj1), name: '12Y', notenschluessel: 'BG', anzahl_jahre: '2' });
  const k = getDb().prepare("SELECT id, einschulung_jahr, abschluss_jahr FROM klassen WHERE name = '12Y'").get();
  assert.deepEqual([k.einschulung_jahr, k.abschluss_jahr], [2025, 2026]);
  assert.equal(J.klassenLaufzeit(k.id).anzahlHalbjahre, 4);
});

test.after(async () => {
  await fastify.close();
});
