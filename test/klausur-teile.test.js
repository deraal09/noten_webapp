/**
 * Klausur aus mehreren Teilen: jeder Teil bekommt aus seinen Aufgaben eine
 * eigene Note, die Gesamtnote der Klausur wird prozentual aus den Teilnoten
 * berechnet. Bestimmt ein Teil die BESTE erreichbare Note, können die
 * anderen Teile die Gesamtnote nicht darüber hinaus verbessern, wohl aber
 * immer verschlechtern -- in allen Notenschlüsseln (IHK: kleiner = besser,
 * BG: größer = besser).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-klausur-teile-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-klausur-teile-test-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const {
  HALBJAHRE, DEFAULT_NS_CSV, klausurNote, klausurTeilNoten, parseKlausurTeile, kleinerIstBesser,
} = await import('../src/grade-calc.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
const HJ = HALBJAHRE[0];

// ---------- reine Rechenlogik ----------
const teile = (bestimmend) => parseKlausurTeile({
  teile: [
    { name: 'Teil A', aufgaben: 2, gewichtung: 60 },
    { name: 'Teil B', aufgaben: 1, gewichtung: 40 },
  ],
  bestimmend,
});
const MAX = [10, 10, 10];

test('kleinerIstBesser erkennt die Richtung des Notenschlüssels (IHK kleiner, BG größer)', () => {
  assert.equal(kleinerIstBesser(DEFAULT_NS_CSV.IHK), true);
  assert.equal(kleinerIstBesser(DEFAULT_NS_CSV.BG), false);
});

test('parseKlausurTeile: einteilig bei fehlendem/ungültigem JSON oder nur einem Teil', () => {
  assert.equal(parseKlausurTeile(null), null);
  assert.equal(parseKlausurTeile('kaputt'), null);
  assert.equal(parseKlausurTeile({ teile: [{ name: 'A', aufgaben: 1, gewichtung: 100 }] }), null);
  assert.equal(teile(null).bestimmend, null);
  assert.equal(teile(1).bestimmend, 1);
  assert.equal(teile(7).bestimmend, null, 'ungültiger Index wird verworfen');
});

test('IHK: Teilnoten und prozentual gewichtete Gesamtnote', () => {
  // Teil A: 20/20 = 100 % -> 1,0; Teil B: 5/10 = 50 % -> 4,4; Gesamt 0,6*1 + 0,4*4,4 = 2,36
  assert.deepEqual(klausurTeilNoten([10, 10, 5], MAX, teile(null), DEFAULT_NS_CSV.IHK), [1, 4.4]);
  assert.equal(klausurNote([10, 10, 5], MAX, teile(null), DEFAULT_NS_CSV.IHK), 2.36);
});

test('IHK: bestimmt Teil B die beste Note (4,4), wird die Klausur durch Teil A nicht besser -- aber schlechter geht immer', () => {
  assert.equal(klausurNote([10, 10, 5], MAX, teile(1), DEFAULT_NS_CSV.IHK), 4.4, 'Aufwertung durch Teil A gedeckelt');
  // Teil B 100 % (1,0) und Teil A schlecht (5/20 = 25 % -> 5,6): Mittel 0,6*5,6 + 0,4*1 = 3,76 > 1,0 -> Abwertung zählt
  assert.equal(klausurNote([2, 3, 10], MAX, teile(1), DEFAULT_NS_CSV.IHK), 3.76);
});

test('IHK: bestimmt Teil A die beste Note (1,0), zieht Teil B die Gesamtnote herunter', () => {
  assert.equal(klausurNote([10, 10, 5], MAX, teile(0), DEFAULT_NS_CSV.IHK), 2.36);
});

test('BG (größer = besser): Deckelung wirkt in die andere Richtung', () => {
  // Teil A 100 % -> 15 Punkte, Teil B 50 % -> 6; Mittel 0,6*15 + 0,4*6 = 11,4
  assert.equal(klausurNote([10, 10, 5], MAX, teile(null), DEFAULT_NS_CSV.BG), 11.4);
  assert.equal(klausurNote([10, 10, 5], MAX, teile(1), DEFAULT_NS_CSV.BG), 6, 'Teil B (6) bestimmt die beste Note');
  assert.equal(klausurNote([10, 10, 5], MAX, teile(0), DEFAULT_NS_CSV.BG), 11.4, 'Teil A (15) deckelt nichts, Teil B wertet ab');
});

test('Ohne vollständig bepunkteten Teil gibt es noch keine Gesamtnote; einteilige Klausuren bleiben unverändert', () => {
  assert.equal(klausurNote([10, 10, null], MAX, teile(null), DEFAULT_NS_CSV.IHK), null);
  assert.equal(klausurNote([10, 10], [10, 10], null, DEFAULT_NS_CSV.IHK), 1);
});

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
const lehrerA = client();
let fachId, klausurId, annaId;
const teileFormular = (extra = []) => [
  ['teil_name', 'Hörverstehen'], ['teil_aufgaben', '2'], ['teil_gewichtung', '60'],
  ['teil_name', 'Schreiben'], ['teil_aufgaben', '1'], ['teil_gewichtung', '40'],
  ['teil_name', ''], ['teil_aufgaben', ''], ['teil_gewichtung', ''],
  ...extra,
];
const punkte = (idx, wert) => lehrerA(`/teacher/klausuren/${klausurId}/punkte`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ schueler_id: String(annaId), aufgabe_idx: String(idx), wert: String(wert) }),
});
const klausurDaten = async () => {
  const data = await (await lehrerA(`/teacher/fach/${fachId}/noten?hj=${encodeURIComponent(HJ)}`)).json();
  const zeile = data.schueler.find((s) => s.schueler_id === annaId);
  return { zeile, klausur: zeile.klausuren.find((k) => k.id === klausurId) };
};

test('Vorbereitung: IHK-Klasse, Fach, Person, Klausur mit 100 % Gewichtung', async () => {
  let r = await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  assert.equal(r.status, 302);
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;
  await form(admin, '/admin/einladungen/neu', { display_name: 'Lehrer A', ttl_days: '14' });
  const inv = getDb().prepare('SELECT token FROM invitations ORDER BY id').get();
  await form(lehrerA, `/einladung/${inv.token}`, { username: 'lehrera', display_name: 'Lehrer A', password: 'passwortA1', password2: 'passwortA1' });
  getDb().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'lehrera'").run();

  await form(lehrerA, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '11A', notenschluessel: 'IHK' });
  const klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '11A'").get().id;
  await form(lehrerA, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Englisch' });
  fachId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ?").get(klasseId).id;
  await form(lehrerA, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
  annaId = getDb().prepare("SELECT id FROM schueler WHERE nachname = 'Adler'").get().id;

  await form(lehrerA, `/teacher/fach/${fachId}/klausuren/neu`, { name: 'Klausur 1', aufgaben: '3', halbjahr: HJ });
  klausurId = getDb().prepare('SELECT id FROM klausuren WHERE fach_id = ?').get(fachId).id;
  await form(lehrerA, `/teacher/klausuren/${klausurId}/gewichtung`, { gewichtung: '100', halbjahr: HJ });
  await form(lehrerA, `/teacher/klausuren/${klausurId}/maxpunkte`, { anzahl_aufgaben: '3', mp_0: '10', mp_1: '10', mp_2: '10', halbjahr: HJ });
  for (const [i, w] of [[0, 10], [1, 10], [2, 5]]) await punkte(i, w);
});

test('Einteilig: Gesamtnote wie bisher aus allen Punkten (25/30 = 83 % -> 2,2)', async () => {
  const { klausur } = await klausurDaten();
  assert.equal(klausur.note, 2.2);
  assert.equal(klausur.teilNoten, null);
});

test('Teile einrichten: zwei Teile, Aufgabenzahl ergibt sich aus den Teilen, leere Zeile wird ignoriert', async () => {
  const r = await formListe(lehrerA, `/teacher/klausuren/${klausurId}/teile`, teileFormular([['bestimmend', '']]));
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /tab=klausuren&open=klausur-panel-/);
  const k = getDb().prepare('SELECT teile, max_punkte_pro_aufgabe FROM klausuren WHERE id = ?').get(klausurId);
  assert.deepEqual(parseKlausurTeile(k.teile).teile.map((t) => [t.name, t.aufgaben, t.gewichtung]), [['Hörverstehen', 2, 60], ['Schreiben', 1, 40]]);
  assert.equal(JSON.parse(k.max_punkte_pro_aufgabe).length, 3);

  const { klausur } = await klausurDaten();
  assert.deepEqual(klausur.teilNoten, [1, 4.4]);
  assert.equal(klausur.note, 2.36, '0,6 * 1,0 + 0,4 * 4,4');
});

test('Notenübersicht-Seite zeigt Teile, Teilnoten, Gesamtnote; "Anzahl Aufgaben" entfällt', async () => {
  const html = await (await lehrerA(`/teacher/fach/${fachId}?hj=${encodeURIComponent(HJ)}`)).text();
  assert.match(html, /Hörverstehen <small>\(60%\)<\/small>/);
  assert.match(html, /Schreiben <small>\(40%\)<\/small>/);
  assert.match(html, /class="note-cell k-teilnote"[^>]*data-teil="0">1,0<\/td>/);
  assert.match(html, /class="note-cell k-teilnote"[^>]*data-teil="1">4,4<\/td>/);
  assert.match(html, /Gesamtnote/);
  assert.match(html, /Die Aufgabenzahl ergibt sich aus den Teilen/);
});

test('Ein Teil bestimmt die beste Note: Gesamtnote kann durch die anderen Teile nicht besser werden', async () => {
  await formListe(lehrerA, `/teacher/klausuren/${klausurId}/teile`, teileFormular([['bestimmend', '1']]));
  assert.equal(parseKlausurTeile(getDb().prepare('SELECT teile FROM klausuren WHERE id = ?').get(klausurId).teile).bestimmend, 1);
  assert.equal((await klausurDaten()).klausur.note, 4.4, 'Teil B (4,4) deckelt die Gesamtnote');

  // Teil A verschlechtern: Abwertung geht immer (Mittel 0,6*5,6 + 0,4*4,4 = 5,12 > 4,4)
  await punkte(0, 2); await punkte(1, 3);
  assert.equal((await klausurDaten()).klausur.note, 5.12);
  await punkte(0, 10); await punkte(1, 10);
});

test('Maxpunkte-Route ändert die Aufgabenzahl einer mehrteiligen Klausur nicht; Punkte je Aufgabe lassen sich weiter setzen', async () => {
  await form(lehrerA, `/teacher/klausuren/${klausurId}/maxpunkte`, { anzahl_aufgaben: '7', mp_0: '10', mp_1: '10', mp_2: '20', halbjahr: HJ });
  const k = getDb().prepare('SELECT max_punkte_pro_aufgabe FROM klausuren WHERE id = ?').get(klausurId);
  assert.deepEqual(JSON.parse(k.max_punkte_pro_aufgabe), [10, 10, 20]);
});

test('Ungültige Teile (nur ein Teil / keine Gewichtung) werden abgelehnt, bisherige Teile bleiben', async () => {
  const vorher = getDb().prepare('SELECT teile FROM klausuren WHERE id = ?').get(klausurId).teile;
  await formListe(lehrerA, `/teacher/klausuren/${klausurId}/teile`, [['teil_name', 'Nur einer'], ['teil_aufgaben', '3'], ['teil_gewichtung', '100']]);
  await formListe(lehrerA, `/teacher/klausuren/${klausurId}/teile`, [
    ['teil_name', 'A'], ['teil_aufgaben', '1'], ['teil_gewichtung', '0'], ['teil_name', 'B'], ['teil_aufgaben', '1'], ['teil_gewichtung', '0'],
  ]);
  assert.equal(getDb().prepare('SELECT teile FROM klausuren WHERE id = ?').get(klausurId).teile, vorher);
});

test('Zugriffsschutz: fremde Lehrkraft darf die Teile nicht ändern', async () => {
  const fremd = client();
  await form(admin, '/admin/einladungen/neu', { display_name: 'Fremd', ttl_days: '14' });
  const inv = getDb().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
  await form(fremd, `/einladung/${inv.token}`, { username: 'fremd', display_name: 'Fremd', password: 'passwortF1', password2: 'passwortF1' });
  const r = await formListe(fremd, `/teacher/klausuren/${klausurId}/teile`, [['einteilig', '1']]);
  assert.equal(r.status, 403);
});

test('Wieder einteilig machen: Teile entfallen, Punkte bleiben, Note wie bei einer normalen Klausur', async () => {
  await form(lehrerA, `/teacher/klausuren/${klausurId}/maxpunkte`, { mp_0: '10', mp_1: '10', mp_2: '10', halbjahr: HJ });
  const r = await form(lehrerA, `/teacher/klausuren/${klausurId}/teile`, { einteilig: '1' });
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare('SELECT teile FROM klausuren WHERE id = ?').get(klausurId).teile, null);
  const { klausur } = await klausurDaten();
  assert.equal(klausur.teilNoten, null);
  assert.equal(klausur.note, 2.2);
});

test.after(async () => {
  await fastify.close();
});
