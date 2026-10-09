/**
 * Direkte Endnoteneingabe je Fach/Person/Halbjahr (Fachseite und Klassen-
 * leitung) sowie Fächer, die nur in bestimmten Halbjahren gelten.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-endnoten-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-endnoten-test-bitte-lang-genug-xxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const J = await import('../src/klassen-jahre.js');
const { berechneGesamtnoten, berechneGesamtnotenOhneEndnoten } = await import('../src/noten-service.js');
const { parseEndnoteEingabe } = await import('../src/halbjahr-endnoten.js');

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
const fremd = client();
let klasseId, fachId, annaId, bertaId;
const HJ1 = '1. Halbjahr';
const enc = encodeURIComponent;
const endnote = (req, sid, wert, hj = HJ1) => req(`/teacher/fach/${fachId}/endnote`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ schueler_id: String(sid), halbjahr: hj, wert }),
});
const raster = (req, fach, sid, wert, hj = HJ1) => req(`/teacher/klassen/${klasseId}/endnote`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ fach_id: String(fach), schueler_id: String(sid), halbjahr: hj, wert }),
});

test('Vorbereitung: IHK-Klasse mit Einschulung 2023 (1.-4. Halbjahr vergangen), Fach, zwei Personen, Klausur im 1. Halbjahr', async () => {
  await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sj = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;
  await form(admin, '/admin/einladungen/neu', { display_name: 'Fremd', ttl_days: '14' });
  const inv = getDb().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
  await form(fremd, `/einladung/${inv.token}`, { username: 'fremd', display_name: 'Fremd', password: 'passwortF1', password2: 'passwortF1' });
  await form(admin, '/teacher/klassen/neu', { schuljahr_id: String(sj), name: '11A', notenschluessel: 'IHK', einschulung_jahr: '2023' });
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '11A'").get().id;
  await form(admin, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Englisch' });
  fachId = getDb().prepare('SELECT id FROM faecher WHERE klasse_id = ?').get(klasseId).id;
  await form(admin, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
  await form(admin, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Berger', vorname: 'Berta' });
  annaId = getDb().prepare("SELECT id FROM schueler WHERE nachname = 'Adler'").get().id;
  bertaId = getDb().prepare("SELECT id FROM schueler WHERE nachname = 'Berger'").get().id;
  assert.equal(J.klassenLaufzeit(klasseId).einschulungJahr, 2023);
  await form(admin, `/teacher/fach/${fachId}/klausuren/neu`, { name: 'K1', aufgaben: '1', halbjahr: HJ1 });
  const k = getDb().prepare('SELECT id FROM klausuren WHERE fach_id = ?').get(fachId).id;
  await form(admin, `/teacher/klausuren/${k}/gewichtung`, { gewichtung: '100', halbjahr: HJ1 });
  await form(admin, `/teacher/klausuren/${k}/punkte`, { schueler_id: String(annaId), aufgabe_idx: '0', wert: '1' });
});

test('Eingabe-Parser: Zahl (auch mit Komma) im Bereich, ntg, leer; sonst ungültig', () => {
  assert.deepEqual(parseEndnoteEingabe('2,3', [1, 6]), { note: 2.3 });
  assert.deepEqual(parseEndnoteEingabe(' ntg ', [1, 6]), { ntg: true });
  assert.deepEqual(parseEndnoteEingabe('', [1, 6]), { leer: true });
  assert.equal(parseEndnoteEingabe('7', [1, 6]), null);
  assert.equal(parseEndnoteEingabe('abc', [1, 6]), null);
  assert.deepEqual(parseEndnoteEingabe('15', [0, 15]), { note: 15 });
});

test('Direkte Endnote ersetzt die berechnete Halbjahresnote (Fachseite)', async () => {
  const vorher = berechneGesamtnoten(fachId, HJ1).get(annaId);
  assert.notEqual(vorher, null, 'Anna hat eine berechnete Note');
  let r = await endnote(admin, annaId, '3,3');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, note: 3.3, ntg: false });
  assert.equal(berechneGesamtnoten(fachId, HJ1).get(annaId), 3.3);
  assert.equal(berechneGesamtnotenOhneEndnoten(fachId, HJ1).get(annaId), vorher, 'Berechnung bleibt unverändert sichtbar');
  const daten = await (await admin(`/teacher/fach/${fachId}/noten?hj=${enc(HJ1)}`)).json();
  const zeile = daten.schueler.find((s) => s.schueler_id === annaId);
  assert.equal(zeile.gesamt, 3.3);
  assert.equal(zeile.gesamtBerechnet, vorher);
  assert.deepEqual(zeile.endnote, { note: 3.3, ntg: false });
  // Person ohne Leistungen bekommt eine Endnote und damit eine Gesamtnote
  r = await endnote(admin, bertaId, '2');
  assert.equal((await r.json()).note, 2);
  assert.equal(berechneGesamtnoten(fachId, HJ1).get(bertaId), 2);
});

test('Direkte Endnote: ntg, leer löscht, ungültig wird abgelehnt, andere Halbjahre bleiben unberührt', async () => {
  let d = await (await endnote(admin, bertaId, 'ntg')).json();
  assert.deepEqual([d.note, d.ntg], [null, true]);
  assert.equal(berechneGesamtnoten(fachId, HJ1).get(bertaId), null, 'ntg zählt nicht');
  d = await (await endnote(admin, bertaId, '')).json();
  assert.deepEqual([d.note, d.ntg], [null, false]);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM halbjahr_endnoten WHERE schueler_id = ?').get(bertaId).c, 0);
  assert.equal((await endnote(admin, bertaId, '7')).status, 400);
  assert.equal((await endnote(admin, bertaId, 'zwei')).status, 400);
  assert.equal(berechneGesamtnoten(fachId, '2. Halbjahr').get(annaId) ?? null, null);
});

test('Fachseite: Button "Direkte Endnoteneingabe" und Tabelle mit dem eingetragenen Wert', async () => {
  const html = await (await admin(`/teacher/fach/${fachId}?hj=${enc(HJ1)}`)).text();
  assert.match(html, /id="endnoten-toggle"[^>]*>✏️ Direkte Endnoteneingabe/);
  assert.match(html, /id="endnoten-direkt" class="card" hidden/);
  assert.match(html, /class="endnote-eingabe" data-sid="\d+"\s+value="3,3"/);
  assert.match(html, /class="gesamt-cell direkt"/, 'direkt eingetragene Note ist markiert');
});

test('Zugriff: fremde Lehrkraft darf keine Endnote setzen; Person ohne Fachteilnahme wird abgelehnt', async () => {
  assert.equal((await endnote(fremd, annaId, '1')).status, 403);
  assert.equal(berechneGesamtnoten(fachId, HJ1).get(annaId), 3.3);
  await form(admin, '/teacher/klassen/neu', { schuljahr_id: String(getDb().prepare('SELECT id FROM schuljahre').get().id), name: '11B', notenschluessel: 'IHK' });
  const k2 = getDb().prepare("SELECT id FROM klassen WHERE name = '11B'").get().id;
  await form(admin, `/teacher/klassen/${k2}/schueler/neu`, { nachname: 'Conrad', vorname: 'Carl' });
  const carl = getDb().prepare("SELECT id FROM schueler WHERE nachname = 'Conrad'").get().id;
  assert.equal((await endnote(admin, carl, '2')).status, 404);
});

test('Notenkonferenz-Sperre verhindert die Direkteingabe bis zum Entsperren', async () => {
  await form(admin, `/teacher/klassen/${klasseId}/konferenz/${bertaId}/sperren`, { halbjahr: HJ1 });
  const r = await endnote(admin, bertaId, '4');
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /gesperrt/);
  const html = await (await admin(`/teacher/fach/${fachId}?hj=${enc(HJ1)}`)).text();
  assert.match(html, /class="endnote-eingabe" data-sid="\d+"\s+value=""[^>]*disabled/);
  await form(admin, `/teacher/klassen/${klasseId}/konferenz/${bertaId}/entsperren`, { halbjahr: HJ1 });
  assert.equal((await endnote(admin, bertaId, '4')).status, 200);
});

test('Klassenleitung: Raster im Klassenleitungsbereich für vergangene Halbjahre', async () => {
  const html = await (await admin(`/klassenlehrer/klasse/${klasseId}?hj=${enc(HJ1)}&tab=endnoten`)).text();
  assert.match(html, /Endnoten direkt eintragen/);
  assert.match(html, /class="endnote-raster"[^>]*data-fach="\d+"/);
  assert.doesNotMatch(html, /class="endnote-raster"[^>]*disabled/, 'vergangenes Halbjahr: bearbeitbar');
  const r = await raster(admin, fachId, annaId, '1,7');
  assert.equal(r.status, 200);
  assert.equal(berechneGesamtnoten(fachId, HJ1).get(annaId), 1.7);
  // aktuelles Halbjahr (Test-Datum 1.10.2025 = 5. Halbjahr) ist nicht per Raster bearbeitbar
  const hj5 = '5. Halbjahr';
  assert.equal((await raster(admin, fachId, annaId, '2', hj5)).status, 400);
  const html5 = await (await admin(`/klassenlehrer/klasse/${klasseId}?hj=${enc(hj5)}&tab=endnoten`)).text();
  assert.match(html5, /vergangene Halbjahre/);
  assert.equal((await raster(fremd, fachId, annaId, '2')).status, 403);
});

test('Raster: gesperrte Person ist nicht bearbeitbar, Fach außerhalb der Klasse wird abgelehnt', async () => {
  await form(admin, `/teacher/klassen/${klasseId}/konferenz/${annaId}/sperren`, { halbjahr: HJ1 });
  assert.equal((await raster(admin, fachId, annaId, '2')).status, 403);
  const html = await (await admin(`/klassenlehrer/klasse/${klasseId}?hj=${enc(HJ1)}&tab=endnoten`)).text();
  assert.match(html, /🔒/);
  await form(admin, `/teacher/klassen/${klasseId}/konferenz/${annaId}/entsperren`, { halbjahr: HJ1 });
  assert.equal((await raster(admin, 99999, annaId, '2')).status, 404);
});

test('Fächer je Halbjahr: Anlegen mit Halbjahres-Auswahl, Anzeige nur in diesen Halbjahren', async () => {
  await form(admin, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Wirtschaft' });
  const alle = getDb().prepare("SELECT halbjahre FROM faecher WHERE name = 'Wirtschaft'").get();
  assert.equal(alle.halbjahre, null, 'ohne Auswahl: alle Halbjahre');
  const body = new URLSearchParams();
  body.append('name', 'Politik'); body.append('halbjahre', '3'); body.append('halbjahre', '4');
  await admin(`/teacher/klassen/${klasseId}/faecher/neu`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const politik = getDb().prepare("SELECT id, halbjahre FROM faecher WHERE name = 'Politik'").get();
  assert.equal(politik.halbjahre, '[3,4]');

  // Fachseite: Reiter nur für 3. und 4. Halbjahr, Standard = nächstliegendes Halbjahr des Fachs
  const html = await (await admin(`/teacher/fach/${politik.id}`)).text();
  assert.match(html, />3\. Halbjahr</);
  assert.match(html, />4\. Halbjahr</);
  assert.doesNotMatch(html, />1\. Halbjahr</);
  assert.match(html, /class="hj-tab active"[^>]*>4\. Halbjahr</, 'aktuell 5. Hj -> nächstliegend ist das 4.');
  const eins = await (await admin(`/teacher/fach/${politik.id}?hj=1`)).text();
  assert.match(eins, /class="hj-tab active"[^>]*>4\. Halbjahr</, 'ungültiges Halbjahr -> nächstliegendes');

  // Raster des 1. Halbjahres zeigt Politik nicht, das des 3. schon
  const r1 = await (await admin(`/klassenlehrer/klasse/${klasseId}?hj=${enc(HJ1)}&tab=endnoten`)).text();
  assert.doesNotMatch(r1, /<th>Politik<\/th>/);
  const r3 = await (await admin(`/klassenlehrer/klasse/${klasseId}?hj=${enc('3. Halbjahr')}&tab=endnoten`)).text();
  assert.match(r3, /<th>Politik<\/th>/);
});

test('Halbjahre eines Fachs ändern; Entfernen eines Halbjahrs mit Daten wird verweigert', async () => {
  const politik = getDb().prepare("SELECT id FROM faecher WHERE name = 'Politik'").get().id;
  const setze = (nummern) => {
    const body = new URLSearchParams();
    for (const n of nummern) body.append('halbjahre', String(n));
    return admin(`/teacher/faecher/${politik}/halbjahre`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  };
  await setze([2, 3, 4]);
  assert.equal(getDb().prepare('SELECT halbjahre FROM faecher WHERE id = ?').get(politik).halbjahre, '[2,3,4]');
  await setze([1, 2, 3, 4, 5, 6]);
  assert.equal(getDb().prepare('SELECT halbjahre FROM faecher WHERE id = ?').get(politik).halbjahre, null, 'alle gewählt = NULL');
  await setze([3, 4]);
  getDb().prepare("INSERT INTO halbjahr_endnoten (fach_id, schueler_id, halbjahr, note) VALUES (?, ?, '3. Halbjahr', 2)").run(politik, annaId);
  await setze([4]);
  assert.equal(getDb().prepare('SELECT halbjahre FROM faecher WHERE id = ?').get(politik).halbjahre, '[3,4]', 'unverändert wegen Endnote im 3. Halbjahr');
  const r = await fremd(`/teacher/faecher/${politik}/halbjahre`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ halbjahre: '1' }) });
  assert.equal(r.status, 403);
});

test('Klassen-Seite zeigt Halbjahres-Auswahl beim Anlegen und die Halbjahre je Fach', async () => {
  const html = await (await admin(`/teacher/klassen/${klasseId}`)).text();
  assert.match(html, /Gilt in diesen Halbjahren/);
  assert.match(html, /<button type="button" id="fach-neu-knopf">\+ Neues Fach anlegen<\/button>/);
  assert.match(html, /<dialog id="fach-neu-dialog"[\s\S]*?faecher\/neu/);
  assert.doesNotMatch(html, /<form method="post" action="[^"]*faecher\/neu" class="card">/);
  assert.match(html, /name="halbjahre" value="5" checked/);
  assert.match(html, /name="halbjahre" value="1" >/);
  assert.match(html, /<span class="hint fach-hj">3–4\. Hj\.<\/span>[\s\S]*?<a class="icon-knopf" href="\/teacher\/faecher\/\d+\/einstellungen"[^>]*>⚙<\/a>/, 'Halbjahre stellt man über das Zahnrad ein');
  assert.doesNotMatch(html, /Halbjahre des Fachs ändern/, 'kein Stift mehr');
});

test.after(async () => {
  await fastify.close();
});
