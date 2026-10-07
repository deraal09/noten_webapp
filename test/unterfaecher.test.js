/**
 * Unterfächer (Fachnote gewichtet aus Unterfächern) und Lehrkraftzuordnung je
 * Halbjahr: Anlegen, Halbjahre, Berechnung, Zusammensetzungs-Seite, Sync.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-unterfaecher-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-unterfaecher-test-bitte-lang-genug-xxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { berechneGesamtnoten, ladeFaecherFuerKlassenleitung, ladeNotenuebersicht } = await import('../src/noten-service.js');
const U = await import('../src/unterfaecher.js');
const { syncFach } = await import('../src/noten-sync.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });

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
async function form(req, url, body) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) for (const w of Array.isArray(v) ? v : [v]) params.append(k, w);
  return req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params });
}

const admin = client();
const lehrer = client();
const fremd = client();
let klasseId, matheId, annaId, bertaId, lehrerId;
const HJ3 = '3. Halbjahr';
const HJ1 = '1. Halbjahr';
const enc = encodeURIComponent;
const faecherDb = () => getDb().prepare('SELECT * FROM faecher WHERE klasse_id = ? ORDER BY id').all(klasseId);
const unterId = (kurz) => getDb().prepare('SELECT id FROM faecher WHERE parent_fach_id = ? AND kurzname = ?').get(matheId, kurz).id;
const endnote = (req, fachId, sid, wert, hj) => form(req, `/teacher/fach/${fachId}/endnote`, { schueler_id: String(sid), halbjahr: hj, wert });

test('Vorbereitung: Klasse (Einschulung 2023), Fach Mathe, zwei Personen, zwei Lehrkräfte', async () => {
  await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sj = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;
  for (const [client_, name] of [[lehrer, 'lehrer'], [fremd, 'fremd']]) {
    await form(admin, '/admin/einladungen/neu', { display_name: name, ttl_days: '14' });
    const inv = getDb().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
    await form(client_, `/einladung/${inv.token}`, { username: name, display_name: name, password: 'passwort123', password2: 'passwort123' });
  }
  lehrerId = getDb().prepare("SELECT id FROM users WHERE username = 'lehrer'").get().id;
  await form(admin, '/teacher/klassen/neu', { schuljahr_id: String(sj), name: '11A', notenschluessel: 'IHK', einschulung_jahr: '2023' });
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '11A'").get().id;
  await form(admin, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Mathe' });
  matheId = getDb().prepare('SELECT id FROM faecher WHERE klasse_id = ?').get(klasseId).id;
  await form(admin, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
  await form(admin, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Berger', vorname: 'Berta' });
  annaId = getDb().prepare("SELECT id FROM schueler WHERE nachname = 'Adler'").get().id;
  bertaId = getDb().prepare("SELECT id FROM schueler WHERE nachname = 'Berger'").get().id;
});

test('Unterfach anlegen: Name mit Elternfach, Halbjahre, Teilnehmer werden übernommen', async () => {
  await form(admin, `/teacher/faecher/${matheId}/unterfaecher`, { name: 'Algebra', halbjahre: ['3', '4'] });
  await form(admin, `/teacher/faecher/${matheId}/unterfaecher`, { name: 'Geometrie', halbjahre: ['3', '4'] });
  const kinder = U.ladeUnterfaecher(matheId);
  assert.deepEqual(kinder.map((k) => k.name), ['Mathe › Algebra', 'Mathe › Geometrie']);
  assert.equal(kinder[0].halbjahre, '[3,4]');
  const teiln = getDb().prepare('SELECT COUNT(*) AS c FROM fach_teilnehmer WHERE fach_id = ?').get(kinder[0].id).c;
  assert.equal(teiln, 2);
  // Doppelter Name wird abgelehnt, leerer Name ebenfalls
  await form(admin, `/teacher/faecher/${matheId}/unterfaecher`, { name: 'Algebra', halbjahre: ['3'] });
  await form(admin, `/teacher/faecher/${matheId}/unterfaecher`, { name: '  ', halbjahre: ['3'] });
  assert.equal(U.ladeUnterfaecher(matheId).length, 2);
  // Nicht-Klassenleitung darf keine Unterfächer anlegen
  const r = await form(lehrer, `/teacher/faecher/${matheId}/unterfaecher`, { name: 'Verboten', halbjahre: ['3'] });
  assert.equal(r.status, 403);
});

test('Unterfach nicht in einem Halbjahr mit schon eingetragenen Leistungen', async () => {
  await endnote(admin, matheId, annaId, '2', HJ1);
  const res = U.legeUnterfachAn(getDb().prepare('SELECT * FROM faecher WHERE id = ?').get(matheId), 'Statistik', [1]);
  assert.equal(res.ok, false);
  assert.match(res.fehler, /1\. Halbjahr/);
});

test('Lehrkraftzuordnung: Elternfach nur in Halbjahren ohne Unterfächer, Unterfach je Halbjahr', async () => {
  const mathe = getDb().prepare('SELECT * FROM faecher WHERE id = ?').get(matheId);
  assert.deepEqual(U.halbjahreOhneUnterfaecher(mathe), [1, 2, 5, 6]);
  let r = U.weiseLehrkraftZu(mathe, lehrerId, [3]);
  assert.equal(r.ok, false, 'Halbjahr 3 hat Unterfächer');
  r = U.weiseLehrkraftZu(mathe, lehrerId, [1, 2]);
  assert.equal(r.ok, true);
  const alg = getDb().prepare('SELECT * FROM faecher WHERE id = ?').get(unterId('Algebra'));
  const fremdId = getDb().prepare("SELECT id FROM users WHERE username = 'fremd'").get().id;
  await form(admin, `/teacher/klassen/${klasseId}/zuweisungen/neu`, { user_id: String(fremdId), fach_id: String(alg.id), halbjahre: ['3'] });
  const z = getDb().prepare('SELECT * FROM fach_zuweisungen WHERE user_id = ? AND fach_id = ?').get(fremdId, alg.id);
  assert.deepEqual(U.zuweisungsHalbjahre(z, alg), [3]);
  // Halbjahre der Zuordnung ändern, mehrere Lehrkräfte je Unterfach
  await form(admin, `/teacher/zuweisungen/${z.id}/halbjahre`, { halbjahre: ['3', '4'] });
  assert.deepEqual(U.zuweisungsHalbjahre(getDb().prepare('SELECT * FROM fach_zuweisungen WHERE id = ?').get(z.id), alg), [3, 4]);
  await form(admin, `/teacher/klassen/${klasseId}/zuweisungen/neu`, { user_id: String(lehrerId), fach_id: String(alg.id), halbjahre: ['4'] });
  const karte = U.ladeZuweisungenDerKlasse(klasseId, faecherDb());
  assert.equal(karte.get(alg.id).length, 2);
});

test('Fachnote aus Unterfächern: gleichgewichtet, dann mit Gewichten; Endnote des Elternfachs hat Vorrang', async () => {
  const alg = unterId('Algebra'); const geo = unterId('Geometrie');
  await endnote(admin, alg, annaId, '2', HJ3);
  await endnote(admin, geo, annaId, '4', HJ3);
  await endnote(admin, alg, bertaId, '1', HJ3); // Geometrie noch nicht benotet
  let noten = berechneGesamtnoten(matheId, HJ3);
  assert.equal(noten.get(annaId), 3);
  assert.equal(noten.get(bertaId), 1, 'unbenotete Unterfächer zählen nicht mit');
  const r = await form(admin, `/teacher/fach/${matheId}/unterfach-gewichte`, { halbjahr: HJ3, [`gewicht_${alg}`]: '3', [`gewicht_${geo}`]: '1' });
  assert.equal(r.status, 302);
  noten = berechneGesamtnoten(matheId, HJ3);
  assert.equal(noten.get(annaId), 2.5);
  await form(admin, `/teacher/fach/${matheId}/unterfach-gewichte`, { halbjahr: HJ3, [`gewicht_${alg}`]: '-2' });
  assert.equal(getDb().prepare('SELECT gewicht FROM faecher WHERE id = ?').get(alg).gewicht, 3, 'ungültiges Gewicht wird nicht gespeichert');
  // Direkte Endnote auf dem Elternfach ersetzt die Zusammensetzung
  await endnote(admin, matheId, annaId, '5', HJ3);
  assert.equal(berechneGesamtnoten(matheId, HJ3).get(annaId), 5);
});

test('Zusammensetzungs-Seite des Elternfachs und Zugriffsrechte', async () => {
  const html = await (await admin(`/teacher/fach/${matheId}?hj=${enc(HJ3)}`)).text();
  assert.match(html, /Zusammensetzung im 3\. Halbjahr/);
  assert.match(html, /Algebra/);
  assert.match(html, /Geometrie/);
  // Lehrkraft eines Unterfachs darf die Seite sehen, eine unbeteiligte Person nicht
  assert.equal((await fremd(`/teacher/fach/${matheId}?hj=${enc(HJ3)}`)).status, 200);
  const dritter = client();
  await form(admin, '/admin/einladungen/neu', { display_name: 'Dritter', ttl_days: '14' });
  const inv = getDb().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
  await form(dritter, `/einladung/${inv.token}`, { username: 'dritter', display_name: 'Dritter', password: 'passwort123', password2: 'passwort123' });
  assert.equal((await dritter(`/teacher/fach/${matheId}?hj=${enc(HJ3)}`)).status, 403);
  // In einem Halbjahr ohne Unterfächer ist es die normale Fachseite (nur mit Zuordnung)
  assert.equal((await dritter(`/teacher/fach/${matheId}?hj=${enc('5. Halbjahr')}`)).status, 403);
  const normal = await (await admin(`/teacher/fach/${matheId}?hj=${enc('5. Halbjahr')}`)).text();
  assert.doesNotMatch(normal, /Zusammensetzung im/);
  // JSON-Übersicht liefert die Zusammensetzung
  const u = ladeNotenuebersicht(getDb().prepare('SELECT f.*, k.notenschluessel FROM faecher f JOIN klassen k ON k.id = f.klasse_id WHERE f.id = ?').get(matheId), HJ3);
  assert.equal(u.komposition.unterfaecher.length, 2);
  assert.equal(u.komposition.unterfaecher[0].anteil, 75);
});

test('Klassenleitungs-Sichten zeigen nur das Elternfach; Sync eines Unterfachs aktualisiert den Stand des Elternfachs', async () => {
  const namen = ladeFaecherFuerKlassenleitung(klasseId).map((f) => f.name);
  assert.deepEqual(namen, ['Mathe']);
  await form(admin, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Deutsch' });
  syncFach(unterId('Algebra'), HJ3, 1);
  const stand = getDb().prepare('SELECT note FROM fach_sync_stand WHERE fach_id = ? AND halbjahr = ? AND schueler_id = ?').get(matheId, HJ3, bertaId);
  assert.equal(stand.note, 1);
});

test('Halbjahre ändern: Elternfach entfernt Halbjahr auch bei Unterfächern, Halbjahre mit Daten sind geschützt', async () => {
  const mathe = () => getDb().prepare('SELECT * FROM faecher WHERE id = ?').get(matheId);
  let r = U.setzeFachHalbjahre(mathe(), [1, 2, 3, 5, 6]);
  assert.equal(r.ok, true, 'Halbjahr 4 ohne Daten darf wegfallen');
  assert.equal(getDb().prepare('SELECT halbjahre FROM faecher WHERE id = ?').get(unterId('Algebra')).halbjahre, '[3]');
  const alg = getDb().prepare('SELECT * FROM faecher WHERE id = ?').get(unterId('Algebra'));
  const karte = U.ladeZuweisungenDerKlasse(klasseId, faecherDb());
  assert.ok(karte.get(alg.id).every((z) => z.halbjahre.every((n) => n === 3)), 'Zuordnungen nur noch im 3. Halbjahr');
  r = U.setzeFachHalbjahre(mathe(), [1, 2, 5, 6]);
  assert.equal(r.ok, false, 'Halbjahr 3 hat Endnoten');
  assert.match(r.fehler, /3\. Halbjahr/);
  assert.equal(U.setzeFachHalbjahre(mathe(), []).ok, false, 'mindestens ein Halbjahr');
});

test('Zugriff strikt je Halbjahr: nur in den Halbjahren der Zuordnung', async () => {
  const alg = unterId('Algebra');
  // fremd: Algebra nur im 3. Halbjahr
  let r = await fremd(`/teacher/fach/${alg}?hj=${enc(HJ3)}`);
  assert.equal(r.status, 200);
  r = await fremd(`/teacher/fach/${alg}?hj=${enc('4. Halbjahr')}`);
  assert.equal(r.status, 200, 'das 4. Halbjahr gibt es für das Unterfach nicht mehr: die Seite fällt auf das 3. zurück');
  assert.match(await r.text(), /<a class="hj-tab active"[^>]*>3\. Halbjahr<\/a>/);
  // lehrer: Mathe nur im 1. und 2. Halbjahr (Zuordnung [1,2]); 5. Halbjahr gehört zum Fach, ist aber nicht zugeordnet
  r = await lehrer(`/teacher/fach/${matheId}?hj=${enc('5. Halbjahr')}`);
  assert.equal(r.status, 302, 'wird auf ein erlaubtes Halbjahr umgeleitet');
  assert.match(r.headers.get("location"), /hj=2\.\+Halbjahr/);
  r = await lehrer(`/teacher/fach/${matheId}?hj=${enc('1. Halbjahr')}`);
  assert.equal(r.status, 200);
  const tabs = (await r.text()).match(/<a class="hj-tab[^"]*"/g) || [];
  assert.equal(tabs.length, 2, 'nur zwei Reiter (1. und 2. Halbjahr)');
  // Schreibende Routen mit Halbjahr: außerhalb der Zuordnung verboten, innerhalb erlaubt
  r = await form(lehrer, `/teacher/fach/${matheId}/klausuren/neu`, { name: 'K5', aufgaben: '1', halbjahr: '5. Halbjahr' });
  assert.equal(r.status, 403);
  r = await form(lehrer, `/teacher/fach/${matheId}/klausuren/neu`, { name: 'K1', aufgaben: '1', halbjahr: HJ1 });
  assert.equal(r.status, 302);
  const k = getDb().prepare("SELECT id, halbjahr FROM klausuren WHERE name = 'K1'").get();
  assert.equal(k.halbjahr, HJ1);
  // Klausur eines anderen Halbjahres per Ressourcen-Route
  getDb().prepare("INSERT INTO klausuren (fach_id, halbjahr, name, max_punkte_pro_aufgabe, gewichtung) VALUES (?, '5. Halbjahr', 'K5x', '[10]', 100)").run(matheId);
  const k5 = getDb().prepare("SELECT id FROM klausuren WHERE name = 'K5x'").get().id;
  r = await form(lehrer, `/teacher/klausuren/${k5}/gewichtung`, { gewichtung: '50', halbjahr: '5. Halbjahr' });
  assert.equal(r.status, 403);
  // Dashboard zeigt die Halbjahre der Zuordnung
  const dash = await (await lehrer('/teacher')).text();
  assert.match(dash, /1\., 2\. Halbjahr/);
  // Admin und unbeschränkte Zuordnungen bleiben unberührt
  assert.equal((await admin(`/teacher/fach/${matheId}?hj=${enc('5. Halbjahr')}`)).status, 200);
});

test('Fächer werden alphabetisch sortiert (deutsch: Groß-/Kleinschreibung egal, Umlaute, Zahlen numerisch)', async () => {
  for (const n of ['englisch', 'Ökonomie', 'Biologie', 'LF10', 'LF2']) {
    await form(admin, `/teacher/klassen/${klasseId}/faecher/neu`, { name: n });
  }
  const html = await (await admin(`/teacher/klassen/${klasseId}`)).text();
  const pos = (n) => html.indexOf(`data-fach-optionen data-fach-id="${getDb().prepare('SELECT id FROM faecher WHERE klasse_id = ? AND name = ?').get(klasseId, n).id}"`);
  const reihenfolge = ['Biologie', 'Deutsch', 'englisch', 'LF2', 'LF10', 'Mathe', 'Ökonomie'].map(pos);
  assert.ok(reihenfolge.every((p) => p > 0), 'alle Fächer stehen auf der Seite');
  assert.deepEqual([...reihenfolge].sort((a, b) => a - b), reihenfolge, 'Reihenfolge ist alphabetisch');
  const { vergleicheNamen } = await import('../src/format.js');
  assert.ok(vergleicheNamen('Ägypten', 'Zeichnen') < 0);
  assert.ok(vergleicheNamen('b', 'A') > 0);
});

test('Noteneingabe: Klassenfilter oben, sobald Fächer in mehreren Klassen/Kursen liegen', async () => {
  const einzel = await (await lehrer('/teacher')).text();
  assert.doesNotMatch(einzel, /id="klassenfilter"/, 'bei nur einer Klasse kein Filter');
  const sj = getDb().prepare('SELECT schuljahr_id FROM klassen WHERE id = ?').get(klasseId).schuljahr_id;
  await form(admin, '/teacher/klassen/neu', { schuljahr_id: String(sj), name: '11B', notenschluessel: 'IHK' });
  const b = getDb().prepare("SELECT id FROM klassen WHERE name = '11B'").get().id;
  await form(admin, `/teacher/klassen/${b}/faecher/neu`, { name: 'Sport' });
  const sport = getDb().prepare('SELECT id FROM faecher WHERE klasse_id = ?').get(b).id;
  getDb().prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES ((SELECT id FROM users WHERE username = ?), ?)').run('fremd', sport);
  const html = await (await fremd('/teacher')).text();
  assert.match(html, /<select id="klassenfilter">\s*<option value="">Alle Klassen<\/option>/);
  assert.match(html, new RegExp(`<option value="klasse-${b}">11B`));
  assert.match(html, new RegExp(`<option value="klasse-${klasseId}">11A`));
  assert.match(html, new RegExp(`data-gruppe="klasse-${b}"`));
  assert.ok(html.indexOf('id="klassenfilter"') < html.indexOf('class="klassen-gruppe"'), 'Filter steht oberhalb der Klassen');
});

test('Fach bearbeiten: Name, Halbjahre, Verrechnung; Fach anlegen mit Verrechnung; Dialog am Fachnamen', async () => {
  const html = await (await admin(`/teacher/klassen/${klasseId}`)).text();
  assert.match(html, new RegExp(`<button type="button" class="fach-name fach-name-knopf" data-fach-optionen data-fach-id="${matheId}"`));
  assert.match(html, /<dialog id="fach-optionen-dialog"/);
  assert.match(html, /<dialog id="fach-bearbeiten-dialog"/);
  assert.match(html, /<input type="hidden" name="verrechnung_gesetzt" value="1">/, 'Verrechnung auch beim Anlegen');
  // Nicht-Klassenleitung: normaler Link zur Noteneingabe, kein Bearbeiten
  assert.equal((await form(lehrer, `/teacher/faecher/${matheId}/bearbeiten`, { name: 'X' })).status, 403);
  // Umbenennen + Verrechnung; Unterfächer ziehen den Namen mit
  const alg = unterId('Algebra');
  let r = await form(admin, `/teacher/faecher/${matheId}/bearbeiten`, { name: 'Mathematik', halbjahre: ['1', '2', '3', '5', '6'], p_1: '30', p_2: '0' });
  assert.equal(r.status, 302);
  const mathe = getDb().prepare('SELECT * FROM faecher WHERE id = ?').get(matheId);
  assert.equal(mathe.name, 'Mathematik');
  assert.equal(mathe.verrechnung, JSON.stringify({ 1: 30 }));
  assert.equal(getDb().prepare('SELECT name FROM faecher WHERE id = ?').get(alg).name, 'Mathematik › Algebra');
  // Unterfach umbenennen (keine Verrechnung)
  r = await form(admin, `/teacher/faecher/${alg}/bearbeiten`, { name: 'Gleichungen', halbjahre: ['3'], p_1: '99' });
  const u = getDb().prepare('SELECT * FROM faecher WHERE id = ?').get(alg);
  assert.equal(u.name, 'Mathematik › Gleichungen');
  assert.equal(u.kurzname, 'Gleichungen');
  assert.equal(u.verrechnung, null);
  // Doppelter Name und ungültige Verrechnung ändern nichts
  await form(admin, `/teacher/faecher/${matheId}/bearbeiten`, { name: 'Deutsch', halbjahre: ['1', '2', '3', '5', '6'] });
  assert.equal(getDb().prepare('SELECT name FROM faecher WHERE id = ?').get(matheId).name, 'Mathematik');
  await form(admin, `/teacher/faecher/${matheId}/bearbeiten`, { name: 'Nope', halbjahre: ['1'], p_1: '500' });
  assert.equal(getDb().prepare('SELECT name FROM faecher WHERE id = ?').get(matheId).name, 'Mathematik');
  await form(admin, `/teacher/faecher/${matheId}/bearbeiten`, { name: 'Mathe', halbjahre: ['1', '2', '3', '5', '6'], p_1: '30' });
  // Anlegen mit Verrechnung
  await form(admin, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Physik', halbjahre: ['5', '6'], verrechnung_gesetzt: '1', p_5: '25' });
  assert.equal(getDb().prepare("SELECT verrechnung FROM faecher WHERE name = 'Physik'").get().verrechnung, JSON.stringify({ 5: 25 }));
  await form(lehrer, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Chemie', verrechnung_gesetzt: '1', p_1: '50' });
  assert.equal(getDb().prepare("SELECT verrechnung FROM faecher WHERE name = 'Chemie'").get()?.verrechnung ?? null, null, 'ohne Klassenleitung keine Verrechnung beim Anlegen');
});

test('Manuelle Noten sind entfernt: kein Reiter, keine Spalten, keine Routen, kein CSV-Feld', async () => {
  const html = await (await admin(`/teacher/fach/${matheId}?hj=${enc('5. Halbjahr')}`)).text();
  assert.doesNotMatch(html, /Manuelle Noten|panel-manuell|manuell-muendlich|manuell-schriftlich|Mündliche Noten<|Schriftliche Noten</);
  assert.match(html, /Mündliche Note<\/th>/);
  assert.equal((await form(admin, `/teacher/fach/${matheId}/noten/hinzufuegen`, { schueler_id: '1', typ: 'muendlich', wert: '2', halbjahr: '5. Halbjahr' })).status, 404);
  const csv = await (await admin(`/export/klasse/${klasseId}.csv`)).text();
  assert.doesNotMatch(csv, /\(manuell\)/);
});

test('Teilnehmer: nicht mehr in der Noteneingabe, Verwaltung über die Klassenseite -- offen für alle, bis es eine Klassenleitung gibt', async () => {
  const fachSeite = await (await admin(`/teacher/fach/${matheId}?hj=${enc('5. Halbjahr')}`)).text();
  assert.doesNotMatch(fachSeite, /panel-teilnehmer|teilnehmer-tabelle-body|Teilnehmer\/innen<\/button>/);
  const klassenSeite = await (await admin(`/teacher/klassen/${klasseId}`)).text();
  assert.ok(klassenSeite.includes(`href="/teacher/fach/${matheId}/teilnehmer"`), 'Link 👥 auf der Klassenseite');
  const seite = await admin(`/teacher/fach/${matheId}/teilnehmer`);
  assert.equal(seite.status, 200);
  assert.match(await seite.text(), /id="teilnehmer-tabelle-body"/);

  // Neue Klasse ohne Klassenleitung (angelegt von "fremd", eine Lehrkraft)
  const sj = getDb().prepare('SELECT schuljahr_id FROM klassen WHERE id = ?').get(klasseId).schuljahr_id;
  const k = getDb().prepare('INSERT INTO klassen (schuljahr_id, name, notenschluessel, notenschluessel_csv, created_by_id) VALUES (?, ?, ?, ?, ?)')
    .run(sj, 'TN1', 'IHK', '', getDb().prepare("SELECT id FROM users WHERE username = 'fremd'").get().id).lastInsertRowid;
  const f = getDb().prepare('INSERT INTO faecher (klasse_id, name) VALUES (?, ?)').run(k, 'Sozi').lastInsertRowid;
  const s1 = getDb().prepare("INSERT INTO schueler (klasse_id, nachname, vorname) VALUES (?, 'Test', 'Tina')").run(k).lastInsertRowid;
  getDb().prepare('INSERT INTO fach_teilnehmer (fach_id, schueler_id) VALUES (?, ?)').run(f, s1);
  getDb().prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES ((SELECT id FROM users WHERE username = ?), ?)').run('lehrer', f);
  // keine Klassenleitung: jede Lehrkraft mit Klassenzugriff (Ersteller 'fremd', zugewiesene 'lehrer') darf entfernen
  let r = await form(lehrer, `/teacher/fach/${f}/teilnehmer/entfernen`, { schueler_id: String(s1) });
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM fach_teilnehmer WHERE fach_id = ?').get(f).c, 0);
  getDb().prepare('INSERT INTO fach_teilnehmer (fach_id, schueler_id) VALUES (?, ?)').run(f, s1);
  // sobald jemand Klassenleitung ist, darf es nur noch die Klassenleitung
  getDb().prepare('INSERT INTO klassenleitung (klasse_id, user_id) VALUES (?, ?)').run(k, getDb().prepare("SELECT id FROM users WHERE username = 'fremd'").get().id);
  r = await form(lehrer, `/teacher/fach/${f}/teilnehmer/entfernen`, { schueler_id: String(s1) });
  assert.equal(r.status, 403);
  assert.equal((await lehrer(`/teacher/fach/${f}/teilnehmer`)).status, 403);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM fach_teilnehmer WHERE fach_id = ?').get(f).c, 1);
  r = await form(fremd, `/teacher/fach/${f}/teilnehmer/entfernen`, { schueler_id: String(s1) });
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM fach_teilnehmer WHERE fach_id = ?').get(f).c, 0);
  // Admin darf immer
  assert.equal((await admin(`/teacher/fach/${f}/teilnehmer`)).status, 200);
});

test('Klassenseite zeigt oben für alle, wer als Klassenleitung eingetragen ist', async () => {
  const sj = getDb().prepare('SELECT schuljahr_id FROM klassen WHERE id = ?').get(klasseId).schuljahr_id;
  const k = getDb().prepare('INSERT INTO klassen (schuljahr_id, name, notenschluessel, notenschluessel_csv, created_by_id) VALUES (?, ?, ?, ?, ?)')
    .run(sj, 'KL1', 'IHK', '', getDb().prepare("SELECT id FROM users WHERE username = 'fremd'").get().id).lastInsertRowid;
  getDb().prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES ((SELECT id FROM users WHERE username = ?), (SELECT id FROM faecher WHERE klasse_id = ? LIMIT 1))')
    .run('lehrer', getDb().prepare('INSERT INTO faecher (klasse_id, name) VALUES (?, ?)').run(k, 'Fach').lastInsertRowid && k);
  let html = await (await lehrer(`/teacher/klassen/${k}`)).text();
  assert.match(html, /<strong>Klassenleitung:<\/strong>\s*<span class="hint">noch niemand eingetragen<\/span>/);
  assert.ok(html.indexOf('klassenleitung-zeile') < html.indexOf('class="kopf-aktionen"'), 'oberste Zeile direkt unter dem Titel');
  getDb().prepare('INSERT INTO klassenleitung (klasse_id, user_id) VALUES (?, ?)').run(k, getDb().prepare("SELECT id FROM users WHERE username = 'fremd'").get().id);
  getDb().prepare('INSERT INTO klassenleitung (klasse_id, user_id) VALUES (?, ?)').run(k, getDb().prepare("SELECT id FROM users WHERE username = 'lehrer'").get().id);
  html = await (await lehrer(`/teacher/klassen/${k}`)).text();
  assert.match(html, /<strong>Klassenleitung:<\/strong>\s*fremd, lehrer/, 'alle Eingetragenen, auch für Lehrkräfte ohne Klassenleitung sichtbar');
});

test('Noteneingabe: Klassen stehen alphabetisch nach Klassenname (auch im Klassenfilter)', async () => {
  const sj = getDb().prepare('SELECT schuljahr_id FROM klassen WHERE id = ?').get(klasseId).schuljahr_id;
  const fremdId = getDb().prepare("SELECT id FROM users WHERE username = 'fremd'").get().id;
  for (const name of ['ZZ9', 'aa1', 'Ökö']) {
    const k = getDb().prepare('INSERT INTO klassen (schuljahr_id, name, notenschluessel, notenschluessel_csv) VALUES (?, ?, ?, ?)').run(sj, name, 'IHK', '').lastInsertRowid;
    const f = getDb().prepare('INSERT INTO faecher (klasse_id, name) VALUES (?, ?)').run(k, 'Fach').lastInsertRowid;
    getDb().prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)').run(fremdId, f);
  }
  const html = await (await fremd('/teacher')).text();
  const ueberschriften = [...html.matchAll(/<h2 id="klasse-\d+">([^<]*?) <small>/g)].map((m) => m[1]);
  assert.ok(ueberschriften.length >= 4);
  const sortiert = [...ueberschriften].sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base', numeric: true }));
  assert.deepEqual(ueberschriften, sortiert);
  assert.ok(ueberschriften.indexOf('11A') < ueberschriften.indexOf('aa1') && ueberschriften.indexOf('aa1') < ueberschriften.indexOf('Ökö'), 'Ziffern vor Buchstaben, Ö bei O');
  assert.equal(ueberschriften[ueberschriften.length - 1], 'ZZ9');
  const optionen = [...html.matchAll(/<option value="klasse-\d+">([^<(]*?) \(/g)].map((m) => m[1]);
  assert.deepEqual(optionen, ueberschriften, 'Klassenfilter in derselben Reihenfolge');
});

test('Unterfach-Seite und Zusammensetzungs-Seite bieten die direkte Noteneingabe', async () => {
  const alg = unterId('Gleichungen'); // früher umbenannt
  const unter = await (await admin(`/teacher/fach/${alg}?hj=${enc(HJ3)}`)).text();
  assert.match(unter, /id="endnoten-direkt"/, 'Unterfach: Direkte Endnoteneingabe');
  const eltern = await (await admin(`/teacher/fach/${matheId}?hj=${enc(HJ3)}`)).text();
  assert.match(eltern, /<th[^>]*>Direkteingabe<\/th>/, 'Fach mit Unterfächern: Direkteingabe der Fachnote');
  assert.match(eltern, /class="endnote-eingabe"/);
  // Unterfach-Endnote fließt in die Fachnote ein
  const r = await endnote(admin, alg, bertaId, '2', HJ3);
  assert.equal(r.status, 200);
  assert.equal(berechneGesamtnoten(alg, HJ3).get(bertaId), 2);
  // Direkteingabe landet sofort im Sync-Stand (Halbjahresübersicht der Klassenleitung) -- Unterfach und Fach
  const stand = (fid) => getDb().prepare('SELECT note FROM fach_sync_stand WHERE fach_id = ? AND halbjahr = ? AND schueler_id = ?').get(fid, HJ3, bertaId)?.note;
  assert.equal(stand(alg), 2);
  assert.equal(stand(matheId), berechneGesamtnoten(matheId, HJ3).get(bertaId), 'auch das Elternfach wird nachgezogen');
  // Korrigieren aktualisiert den Stand erneut
  await endnote(admin, alg, bertaId, '3', HJ3);
  assert.equal(stand(alg), 3);
  const uebersicht = await (await admin(`/klassenlehrer/klasse/${klasseId}?tab=halbjahr&hj=${enc(HJ3)}`)).text();
  assert.match(uebersicht, /Halbjahresübersicht/);
});

test('Noteneingabe: Schuljahr-Filter nach den Halbjahren der Fächer', async () => {
  const sj = getDb().prepare('SELECT schuljahr_id FROM klassen WHERE id = ?').get(klasseId).schuljahr_id;
  const fremdId = getDb().prepare("SELECT id FROM users WHERE username = 'fremd'").get().id;
  const mk = (name, einschulung, halbjahre) => {
    const k = getDb().prepare('INSERT INTO klassen (schuljahr_id, name, notenschluessel, notenschluessel_csv, einschulung_jahr, abschluss_jahr) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sj, name, 'IHK', '', einschulung, einschulung + 2).lastInsertRowid;
    const f = getDb().prepare('INSERT INTO faecher (klasse_id, name, halbjahre) VALUES (?, ?, ?)').run(k, `Fach ${name}`, halbjahre ? JSON.stringify(halbjahre) : null).lastInsertRowid;
    getDb().prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)').run(fremdId, f);
    return f;
  };
  mk('SJA', 2030, [1, 2]); // nur 2030/31
  mk('SJB', 2030, [3, 4]); // nur 2031/32
  mk('SJC', 2030, null); // alle drei Schuljahre
  const html = await (await fremd('/teacher')).text();
  assert.match(html, /<select id="schuljahrfilter">\s*<option value="">Alle Schuljahre<\/option>/);
  assert.match(html, /<option value="2030\/31">2030\/31<\/option>/);
  const attr = (name) => {
    const pos = html.indexOf(`Fach ${name}<`);
    const start = html.lastIndexOf('<li class="fach-kachel" data-schuljahre="', pos);
    return html.slice(start).match(/data-schuljahre="([^"]*)"/)[1];
  };
  assert.equal(attr('SJA'), '2030/31');
  assert.equal(attr('SJB'), '2031/32');
  assert.equal(attr('SJC'), '2030/31|2031/32|2032/33');
  assert.match(html, /data-gruppe="klasse-\d+" data-schuljahre="2030\/31\|2031\/32\|2032\/33"/);
  assert.ok(html.indexOf('id="schuljahrfilter"') < html.indexOf('class="klassen-gruppe"'), 'Filter steht oben');
});

test('Direkteingabe der Klassenleitung: Fächer ohne Lehrkraft jederzeit, mit Lehrkraft nur in vergangenen Halbjahren; Lehrkraft sieht den Wert später', async () => {
  const { fachHatLehrkraftImHalbjahr } = await import('../src/unterfaecher.js');
  const db = getDb();
  // Neues Fach OHNE Lehrkraft in der Zukunft (Klasse 2030): Klassenleitung (admin) trägt direkt ein
  const k = db.prepare("SELECT id FROM klassen WHERE name = 'SJC'").get().id;
  const f = db.prepare('INSERT INTO faecher (klasse_id, name) VALUES (?, ?)').run(k, 'Ohne Lehrkraft').lastInsertRowid;
  const s = db.prepare("INSERT INTO schueler (klasse_id, nachname, vorname) VALUES (?, 'Rast', 'Rita')").run(k).lastInsertRowid;
  db.prepare('INSERT INTO fach_teilnehmer (fach_id, schueler_id) VALUES (?, ?)').run(f, s);
  const fach = db.prepare('SELECT * FROM faecher WHERE id = ?').get(f);
  assert.equal(fachHatLehrkraftImHalbjahr(fach, 1), false);
  const html = await (await admin(`/klassenlehrer/klasse/${k}?tab=endnoten&hj=${enc('1. Halbjahr')}`)).text();
  assert.match(html, new RegExp(`class="endnote-raster"\\s+data-fach="${f}" data-sid="${s}"[^>]*?(?!disabled)>`));
  assert.doesNotMatch(html.match(new RegExp(`<input[^>]*data-fach="${f}"[^>]*>`))[0], /disabled/);
  const r = await form(admin, `/teacher/klassen/${k}/endnote`, { fach_id: String(f), schueler_id: String(s), halbjahr: '1. Halbjahr', wert: '2' });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT note FROM fach_sync_stand WHERE fach_id = ? AND halbjahr = ? AND schueler_id = ?').get(f, '1. Halbjahr', s).note, 2, 'sofort in der Halbjahresübersicht');
  // Mit Lehrkraft: Halbjahr in der Zukunft -> Klassenleitung darf nicht mehr, die Lehrkraft sieht und ändert den bestehenden Wert
  const fremdId = db.prepare("SELECT id FROM users WHERE username = 'fremd'").get().id;
  db.prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)').run(fremdId, f);
  assert.equal(fachHatLehrkraftImHalbjahr(fach, 1), true);
  const gesperrt = await form(admin, `/teacher/klassen/${k}/endnote`, { fach_id: String(f), schueler_id: String(s), halbjahr: '1. Halbjahr', wert: '5' });
  assert.equal(gesperrt.status, 400);
  const seite = await (await fremd(`/teacher/fach/${f}?hj=${enc('1. Halbjahr')}`)).text();
  assert.match(seite, /class="endnote-eingabe"[^>]*value="2"/, 'Lehrkraft sieht die eingetragene Endnote');
  const neu = await form(fremd, `/teacher/fach/${f}/endnote`, { schueler_id: String(s), halbjahr: '1. Halbjahr', wert: '3' });
  assert.equal(neu.status, 200);
});

test('Halbjahresübersicht zeigt direkt eingetragene Endnoten der Klassenleitung auch ohne Sync (Fach ohne Lehrkraft bzw. von der Klassenleitung eingetragen)', async () => {
  const { ladeHalbjahresuebersicht } = await import('../src/noten-sync.js');
  const db = getDb();
  const klasse = db.prepare("SELECT * FROM klassen WHERE name = 'SJA'").get();
  const adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  const fremdId = db.prepare("SELECT id FROM users WHERE username = 'fremd'").get().id;
  const sid = (n) => db.prepare('INSERT INTO schueler (klasse_id, nachname, vorname) VALUES (?, ?, ?)').run(klasse.id, n, 'X').lastInsertRowid;
  const [s1, s2, s3] = [sid('Eins'), sid('Zwei'), sid('Drei')];
  const mkFach = (name) => {
    const f = db.prepare('INSERT INTO faecher (klasse_id, name) VALUES (?, ?)').run(klasse.id, name).lastInsertRowid;
    for (const s of [s1, s2, s3]) db.prepare('INSERT INTO fach_teilnehmer (fach_id, schueler_id) VALUES (?, ?)').run(f, s);
    return f;
  };
  const leer = mkFach('Leer'); const mitLehrkraft = mkFach('MitLehrkraft');
  db.prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)').run(fremdId, mitLehrkraft);
  const direkt = (fach, s, note, von) => db.prepare("INSERT INTO halbjahr_endnoten (fach_id, schueler_id, halbjahr, note, ntg, eingetragen_von_id) VALUES (?, ?, '1. Halbjahr', ?, 0, ?)").run(fach, s, note, von);
  direkt(leer, s1, 2, fremdId); // Fach ohne Lehrkraft: zählt, egal wer es eingetragen hat
  direkt(mitLehrkraft, s1, 3, adminId); // Klassenleitung (Admin) trägt ein: zählt
  direkt(mitLehrkraft, s2, 5, fremdId); // Fachlehrkraft, nicht synchronisiert: noch nicht sichtbar
  const u = ladeHalbjahresuebersicht(klasse, '1. Halbjahr');
  const zelle = (s, f) => u.zeilen.find((z) => z.schueler.id === s).noten[u.faecher.findIndex((x) => x.id === f)].note;
  assert.equal(zelle(s1, leer), 2);
  assert.equal(zelle(s1, mitLehrkraft), 3);
  assert.equal(zelle(s2, mitLehrkraft), null, 'Endnote der Fachlehrkraft erscheint erst mit deren Sync');
  assert.equal(zelle(s3, leer), null);
  // Zugeordnete Lehrkräfte stehen an den Fächern (Halbjahres- und Abschlussübersicht)
  const lk = (u2, id) => u2.faecher.find((x) => x.id === id).lehrkraefte;
  assert.deepEqual(lk(u, mitLehrkraft), ['fremd']);
  assert.deepEqual(lk(u, leer), []);
  const { ladeAbschlussuebersicht } = await import('../src/fach-abschluss.js');
  const ab = ladeAbschlussuebersicht(klasse.id);
  assert.deepEqual(lk(ab, mitLehrkraft), ['fremd']);
  assert.deepEqual(lk(ab, leer), []);
  const html = await (await admin(`/teacher/klassen/${klasse.id}/uebersicht?hj=${enc('1. Halbjahr')}`)).text();
  assert.match(html, /🎓 fremd/);
  assert.match(html, /keine Lehrkraft/);
});

test.after(async () => {
  await fastify.close();
});
