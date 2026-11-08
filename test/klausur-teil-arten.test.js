/**
 * Klausur-Teile mit Art: Hörverstehen (eine Aufgabe = Verrechnungspunkte, Note nach Verrechnungstabelle) und
 * Inhalt & Sprache (Mediation/Textaufgabe: zwei Aufgaben mit je eigener Note, meist 50:50 zur Teilnote verrechnet).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-teil-arten-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-teil-arten-bitte-lang-genug-xxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { HALBJAHRE, DEFAULT_NS_CSV, klausurNote, klausurTeilNoten, parseKlausurTeile, verrechnungsTabelle } = await import('../src/grade-calc.js');
const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
test.after(() => fastify.close());
const HJ = HALBJAHRE[0];

// ---------- reine Rechenlogik ----------
const teileInfo = (anteil = 50) => parseKlausurTeile({
  teile: [
    { name: 'Hörverstehen', aufgaben: 7, gewichtung: 40, art: 'hoeren' }, // Aufgabenzahl wird auf 1 gesetzt
    { name: 'Textaufgabe', aufgaben: 5, gewichtung: 60, art: 'inhalt_sprache', inhaltAnteil: anteil }, // auf 2 gesetzt
  ],
  bestimmend: null,
});
const MAX = [15, 20, 20];

test('parseKlausurTeile: Art bestimmt die Aufgabenzahl (Hörverstehen 1, Inhalt & Sprache 2); ohne Art = Standard', () => {
  const info = teileInfo();
  assert.deepEqual(info.teile.map((t) => [t.art, t.aufgaben]), [['hoeren', 1], ['inhalt_sprache', 2]]);
  assert.equal(parseKlausurTeile({ teile: [{ name: 'A', aufgaben: 2, gewichtung: 1 }, { name: 'B', aufgaben: 1, gewichtung: 1 }] }).teile[0].art, 'standard');
  assert.equal(parseKlausurTeile({ teile: [{ name: 'A', aufgaben: 1, gewichtung: 1, art: 'quatsch' }, { name: 'B', aufgaben: 1, gewichtung: 1 }] }).teile[0].art, 'standard');
  assert.equal(teileInfo(250).teile[1].inhaltAnteil, 50, 'ungültiger Anteil -> 50');
});

test('BG: Hörverstehen 12/15 = 80 % -> 12; Textaufgabe Inhalt 15/20 -> 11, Sprache 10/20 -> 6, 50:50 = 8,5; Gesamt 0,4*12 + 0,6*8,5 = 9,9', () => {
  const punkte = [12, 15, 10];
  assert.deepEqual(klausurTeilNoten(punkte, MAX, teileInfo(), DEFAULT_NS_CSV.BG), [12, 8.5]);
  assert.equal(klausurNote(punkte, MAX, teileInfo(), DEFAULT_NS_CSV.BG), 9.9);
});

test('Inhalt : Sprache einstellbar (60:40 -> 11*0,6 + 6*0,4 = 9)', () => {
  assert.deepEqual(klausurTeilNoten([12, 15, 10], MAX, teileInfo(60), DEFAULT_NS_CSV.BG), [12, 9]);
});

test('IHK: Teilnote aus Inhalt und Sprache ist das Mittel der beiden Noten', () => {
  // Inhalt 100 % -> 1,0; Sprache 50 % -> 4,4; Mittel 2,7
  assert.equal(klausurTeilNoten([15, 20, 10], MAX, teileInfo(), DEFAULT_NS_CSV.IHK)[1], 2.7);
});

test('Ohne Inhalt oder Sprache gibt es noch keine Teilnote', () => {
  assert.deepEqual(klausurTeilNoten([12, 15, null], MAX, teileInfo(), DEFAULT_NS_CSV.BG), [12, null]);
  assert.equal(klausurNote([12, 15, null], MAX, teileInfo(), DEFAULT_NS_CSV.BG), null);
});

test('Verrechnungstabelle: bei 15 / 20 / 25 Verrechnungspunkten wie in der Tabelle der Fremdsprachen (BG)', () => {
  const zeile = (max) => Object.fromEntries(verrechnungsTabelle(DEFAULT_NS_CSV.BG, max).map((z) => [z.note, z.abPunkte]));
  const p15 = zeile(15);
  assert.deepEqual([p15[15], p15[14], p15[13], p15[12], p15[11], p15[10], p15[9], p15[8], p15[7], p15[6], p15[5], p15[4], p15[3], p15[2], p15[1], p15[0]],
    [14.25, 13.5, 12.75, 12, 11.25, 10.5, 9.75, 9, 8.25, 7.5, 6.75, 6, 4.95, 4.05, 3, 0]);
  const p20 = zeile(20);
  assert.deepEqual([p20[15], p20[12], p20[8], p20[6], p20[4], p20[3], p20[2], p20[1]], [19, 16, 12, 10, 8, 6.6, 5.4, 4]);
  const p25 = zeile(25);
  assert.deepEqual([p25[15], p25[12], p25[1]], [23.75, 20, 5]);
});

// ---------- Oberfläche ----------
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
const form = (req, url, body) => req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
const formListe = (req, url, paare) => {
  const body = new URLSearchParams();
  for (const [k, v] of paare) body.append(k, v);
  return req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
};
const admin = client();
const lehrer = client();
let fachId, klausurId, annaId;
const punkte = (idx, wert) => form(lehrer, `/teacher/klausuren/${klausurId}/punkte`, { schueler_id: String(annaId), aufgabe_idx: String(idx), wert: String(wert) });
const maxPunkte = () => JSON.parse(getDb().prepare('SELECT max_punkte_pro_aufgabe FROM klausuren WHERE id = ?').get(klausurId).max_punkte_pro_aufgabe);
const teileFormular = (anteil = '50') => [
  ['teil_name', 'Hörverstehen'], ['teil_art', 'hoeren'], ['teil_aufgaben', '1'], ['teil_anteil', '50'], ['teil_gewichtung', '40'],
  ['teil_name', 'Textaufgabe'], ['teil_art', 'inhalt_sprache'], ['teil_aufgaben', '2'], ['teil_anteil', anteil], ['teil_gewichtung', '60'],
  ['bestimmend', ''],
];

test('Vorbereitung: BG-Klasse, Fach, Person, Klausur', async () => {
  await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;
  await form(admin, '/admin/einladungen/neu', { display_name: 'Lehrer', ttl_days: '14' });
  const inv = getDb().prepare('SELECT token FROM invitations ORDER BY id').get();
  await form(lehrer, `/einladung/${inv.token}`, { username: 'lehrer', display_name: 'Lehrer', password: 'passwort123', password2: 'passwort123' });
  getDb().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'lehrer'").run();
  await form(lehrer, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '12E', notenschluessel: 'BG' });
  const klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '12E'").get().id;
  await form(lehrer, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Englisch' });
  fachId = getDb().prepare('SELECT id FROM faecher WHERE klasse_id = ?').get(klasseId).id;
  await form(lehrer, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
  annaId = getDb().prepare("SELECT id FROM schueler WHERE nachname = 'Adler'").get().id;
  await form(lehrer, `/teacher/fach/${fachId}/klausuren/neu`, { name: 'Klausur 1', aufgaben: '3', halbjahr: HJ });
  klausurId = getDb().prepare('SELECT id FROM klausuren WHERE fach_id = ?').get(fachId).id;
  await form(lehrer, `/teacher/klausuren/${klausurId}/gewichtung`, { gewichtung: '100', halbjahr: HJ });
});

test('Teile mit Art einrichten: Hörverstehen = 1 Aufgabe mit 15 Verrechnungspunkten, Textaufgabe = 2 Aufgaben', async () => {
  const r = await formListe(lehrer, `/teacher/klausuren/${klausurId}/teile`, teileFormular());
  assert.equal(r.status, 302);
  const info = parseKlausurTeile(getDb().prepare('SELECT teile FROM klausuren WHERE id = ?').get(klausurId).teile);
  assert.deepEqual(info.teile.map((t) => [t.name, t.art, t.aufgaben, t.inhaltAnteil]), [['Hörverstehen', 'hoeren', 1, 50], ['Textaufgabe', 'inhalt_sprache', 2, 50]]);
  assert.equal(maxPunkte()[0], 15, 'Verrechnungspunkte-Vorgabe 15');
  assert.equal(maxPunkte().length, 3);
  // Max-Punkte für Inhalt und Sprache wie bei jeder Aufgabe einstellbar
  await form(lehrer, `/teacher/klausuren/${klausurId}/maxpunkte`, { anzahl_aufgaben: '3', mp_0: '15', mp_1: '20', mp_2: '20', halbjahr: HJ });
  assert.deepEqual(maxPunkte(), [15, 20, 20]);
});

test('Noten über die Oberfläche: Teilnoten 12 und 8,5, Gesamtnote 9,9; Seite zeigt Art, Spaltenköpfe und Verrechnungstabelle', async () => {
  await punkte(0, 12); await punkte(1, 15); await punkte(2, 10);
  const data = await (await lehrer(`/teacher/fach/${fachId}/noten?hj=${encodeURIComponent(HJ)}`)).json();
  const klausur = data.schueler.find((s) => s.schueler_id === annaId).klausuren.find((k) => k.id === klausurId);
  assert.deepEqual(klausur.teilNoten, [12, 8.5]);
  assert.equal(klausur.note, 9.9);

  const html = await (await lehrer(`/teacher/fach/${fachId}?hj=${encodeURIComponent(HJ)}`)).text();
  assert.match(html, /Hörverstehen <small>\(40%, Hörverstehen\)/);
  assert.match(html, /Textaufgabe <small>\(60%, Inhalt 50 : Sprache 50\)/);
  assert.match(html, /<th class="aufgabe-head">Inhalt<\/th>/);
  assert.match(html, /<th class="aufgabe-head">Sprache<\/th>/);
  assert.match(html, /name="teil_art"/);
  assert.match(html, /Verrechnungstabelle Hörverstehen \(Hörverstehen, 15 Verrechnungspunkte\)/);
  assert.match(html, /<tr><td>14,25<\/td><td>95 %<\/td><td>15<\/td><\/tr>/);
  assert.match(html, /<tr><td>4,95<\/td><td>33 %<\/td><td>3<\/td><\/tr>/);
});

test('Inhalt : Sprache über die Oberfläche ändern (60:40 -> Teilnote 9)', async () => {
  await formListe(lehrer, `/teacher/klausuren/${klausurId}/teile`, teileFormular('60'));
  const data = await (await lehrer(`/teacher/fach/${fachId}/noten?hj=${encodeURIComponent(HJ)}`)).json();
  assert.deepEqual(data.schueler[0].klausuren[0].teilNoten, [12, 9]);
});

test('Art zurück auf Standard und bei Aufgabenzahl 2 behalten', async () => {
  const standard = [
    ['teil_name', 'A'], ['teil_art', 'standard'], ['teil_aufgaben', '1'], ['teil_anteil', '50'], ['teil_gewichtung', '40'],
    ['teil_name', 'B'], ['teil_art', 'standard'], ['teil_aufgaben', '2'], ['teil_anteil', '50'], ['teil_gewichtung', '60'],
  ];
  await formListe(lehrer, `/teacher/klausuren/${klausurId}/teile`, standard);
  const info = parseKlausurTeile(getDb().prepare('SELECT teile FROM klausuren WHERE id = ?').get(klausurId).teile);
  assert.deepEqual(info.teile.map((t) => [t.art, t.aufgaben]), [['standard', 1], ['standard', 2]]);
  assert.deepEqual(maxPunkte(), [15, 20, 20], 'vorhandene Höchstpunkte bleiben');
});

test('Hilfetext unter Klausuren: Kurzanleitung als eingeklappter Abschnitt', async () => {
  const html = await (await lehrer(`/teacher/fach/${fachId}?hj=${encodeURIComponent(HJ)}`)).text();
  assert.match(html, /<details class="klausur-hilfe card" id="klausur-hilfe">/);
  assert.match(html, /Kurzanleitung: Klausur mit mehreren Teilen, Hörverstehen und Inhalt &amp; Sprache/);
  assert.match(html, /Verrechnungstabelle Hörverstehen/);
  assert.doesNotMatch(html, /<details class="klausur-hilfe[^>]* open/, 'standardmäßig eingeklappt');
});
