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

test.after(async () => {
  await fastify.close();
});
