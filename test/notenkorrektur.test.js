/**
 * Notenkorrektur in der Notenbesprechung: Die Gesamtnote wird auf einen Wunschwert korrigiert, der errechnete
 * Korrekturwert steht mit Datum als eigener Termin ("Korrektur") in der Datumstabelle.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-korrektur-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-korrektur-bitte-lang-genug-xxxxxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { HALBJAHRE } = await import('../src/grade-calc.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
const HJ = HALBJAHRE[0];
const HEUTE = '2025-10-01'; // fester Testtag (siehe jetzt() in src/klassen-jahre.js)

function client() {
  const cookies = new Map();
  return async function req(url, body) {
    const headers = {};
    if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    const opts = { headers, redirect: 'manual' };
    if (body) {
      opts.method = 'POST';
      headers['content-type'] = 'application/x-www-form-urlencoded';
      opts.body = new URLSearchParams(body);
    }
    const r = await fetch(base + url, opts);
    for (const raw of r.headers.getSetCookie?.() ?? []) {
      const [k, ...v] = raw.split(';')[0].split('=');
      cookies.set(k.trim(), v.join('=').trim());
    }
    return r;
  };
}
const admin = client();
const fremd = client();
const db = () => getDb();
let fachId, klausurId, anna, ben, cora, termin1;

const korrektur = (sid, body, c = admin) => c(`/teacher/fach/${fachId}/besprechung/${sid}/korrektur`, { hj: HJ, ...body });
const gesamt = async (sid) => (await (await admin(`/teacher/fach/${fachId}/noten?hj=${encodeURIComponent(HJ)}`)).json()).schueler.find((s) => s.schueler_id === sid).gesamt;
const seite = async (sid) => (await admin(`/teacher/fach/${fachId}/besprechung/${sid}?hj=${encodeURIComponent(HJ)}`)).text();
const korrekturTermine = () => db().prepare('SELECT * FROM unterricht_termine WHERE korrektur = 1').all();
const korrekturWert = (sid) => db().prepare('SELECT un.wert FROM unterricht_noten un JOIN unterricht_termine ut ON ut.id = un.termin_id WHERE ut.korrektur = 1 AND un.schueler_id = ?').get(sid)?.wert;

test('Vorbereitung: Anna (Klausur 80 %, Datumstabelle 3), Ben (nichts), Cora (nur Klausur)', async () => {
  await admin('/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await admin('/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sj = db().prepare('SELECT id FROM schuljahre').get().id;
  await admin('/admin/einladungen/neu', { display_name: 'fremd', ttl_days: '14' });
  const inv = db().prepare('SELECT token FROM invitations').get();
  await fremd(`/einladung/${inv.token}`, { username: 'fremd', display_name: 'fremd', password: 'passwort123', password2: 'passwort123' });
  await admin('/teacher/klassen/neu', { schuljahr_id: String(sj), name: '11A', notenschluessel: 'IHK', einschulung_jahr: '2025' });
  const k = db().prepare('SELECT id FROM klassen').get().id;
  await admin(`/teacher/klassen/${k}/faecher/neu`, { name: 'Physik' });
  fachId = db().prepare('SELECT id FROM faecher').get().id;
  for (const n of ['Anna', 'Ben', 'Cora']) await admin(`/teacher/klassen/${k}/schueler/neu`, { nachname: n, vorname: 'X' });
  [anna, ben, cora] = db().prepare('SELECT id FROM schueler ORDER BY nachname').all().map((r) => r.id);
  await admin(`/teacher/fach/${fachId}/klausuren/neu`, { name: 'K1', aufgaben: '1', halbjahr: HJ });
  klausurId = db().prepare('SELECT id FROM klausuren').get().id;
  await admin(`/teacher/klausuren/${klausurId}/gewichtung`, { gewichtung: '100', halbjahr: HJ });
  await admin(`/teacher/klausuren/${klausurId}/maxpunkte`, { anzahl_aufgaben: '1', mp_0: '10', halbjahr: HJ });
  for (const s of [anna, cora]) await admin(`/teacher/klausuren/${klausurId}/punkte`, { schueler_id: String(s), aufgabe_idx: '0', wert: '8' });
  await admin(`/teacher/fach/${fachId}/unterricht/termine/neu`, { datum: '2025-09-10', halbjahr: HJ });
  termin1 = db().prepare('SELECT id FROM unterricht_termine').get().id;
  await admin(`/teacher/unterricht/termine/${termin1}/note`, { schueler_id: String(anna), wert: '3' });
  // Anna: 40 % Klausur (2,5) + 60 % Datumstabelle (3) = 2,8
  assert.equal(await gesamt(anna), 2.8);
});

test('Korrektur auf einen erreichbaren Wert: Korrekturwert mit Datum in der Datumstabelle, Notiz, Hinweis', async () => {
  let html = await seite(anna);
  assert.match(html, /Notenkorrektur/);
  assert.match(html, /name="ziel"/);
  const r = await korrektur(anna, { ziel: '2,5', aktion: 'korrigieren' });
  assert.equal(r.status, 302);
  assert.equal(await gesamt(anna), 2.5);
  const termine = korrekturTermine();
  assert.equal(termine.length, 1);
  assert.equal(termine[0].datum, HEUTE);
  assert.equal(termine[0].fach_id, fachId);
  assert.equal(korrekturWert(anna), 2, '(3 + 2) / 2 = 2,5 -> 40 % * 2,5 + 60 % * 2,5');
  // Datumstabelle und Besprechung zeigen die Korrektur gekennzeichnet; die anderen Personen bleiben leer
  const fach = await (await admin(`/teacher/fach/${fachId}?hj=${encodeURIComponent(HJ)}`)).text();
  assert.match(fach, /datum-head korrektur-head">\s*01\.10\.2025 <small[^>]*>Korrektur<\/small>/);
  html = await seite(anna);
  assert.match(html, /class="tag korrektur"[^>]*>Korrektur 01\.10\.2025: 2<\/span>/);
  assert.match(html, /Notenkorrektur: Gesamtnote 2,8 → 2,5; Korrekturwert 2 in der Datumstabelle \(01\.10\.2025\)\./);
  assert.match(html, /Korrekturen zurücknehmen/);
  assert.equal(korrekturWert(ben), undefined);
});

test('Erneute Korrektur am selben Tag überschreibt den Korrekturwert (ein Korrektur-Termin je Tag und Fach)', async () => {
  await korrektur(anna, { ziel: '2.9' });
  assert.equal(korrekturTermine().length, 1);
  assert.equal(korrekturWert(anna), 3.3);
  assert.ok(Math.abs((await gesamt(anna)) - 2.9) <= 0.05, `Gesamtnote ${await gesamt(anna)}`);
  // eine zweite Person bekommt ihren Wert im selben Termin
  await korrektur(cora, { ziel: '2' });
  assert.equal(korrekturTermine().length, 1);
  assert.ok(Math.abs((await gesamt(cora)) - 2) <= 0.05);
});

test('Nicht erreichbare Wunschnote: bester erreichbarer Wert, mit Hinweis', async () => {
  await korrektur(anna, { aktion: 'zuruecknehmen' });
  await korrektur(cora, { aktion: 'zuruecknehmen' });
  assert.equal(korrekturTermine().length, 0, 'leere Korrektur-Termine verschwinden');
  assert.equal(await gesamt(anna), 2.8);
  // Ziel 1,0: selbst mit dem besten Korrekturwert (1) bleibt die Gesamtnote bei 2,2
  const r = await korrektur(anna, { ziel: '1' });
  assert.equal(r.status, 302);
  assert.equal(korrekturWert(anna), 1);
  assert.equal(await gesamt(anna), 2.2);
  await korrektur(anna, { aktion: 'zuruecknehmen' });
});

test('Person ohne Noten: Korrektur setzt die Gesamtnote allein über den Korrekturwert', async () => {
  assert.equal(await gesamt(ben), null);
  await korrektur(ben, { ziel: '3' });
  assert.equal(await gesamt(ben), 3);
  assert.equal(korrekturWert(ben), 3);
  await korrektur(ben, { aktion: 'zuruecknehmen' });
  assert.equal(await gesamt(ben), null);
});

test('Abgelehnt: Wert außerhalb des Bereichs, leer, Endnote vorhanden, Sperre, fremde Lehrkraft', async () => {
  for (const ziel of ['0.5', '7', 'abc', '']) {
    await korrektur(ben, { ziel });
    assert.equal(korrekturTermine().length, 0, `ziel=${ziel}: nichts angelegt`);
  }
  // direkt eingetragene Endnote ersetzt die berechnete Note: keine Korrektur
  await admin(`/teacher/fach/${fachId}/endnote`, { schueler_id: String(cora), halbjahr: HJ, wert: '2' });
  assert.match(await seite(cora), /Endnote direkt eingetragen/);
  await korrektur(cora, { ziel: '3' });
  assert.equal(korrekturTermine().length, 0);
  await admin(`/teacher/fach/${fachId}/endnote`, { schueler_id: String(cora), halbjahr: HJ, wert: '' });
  // Lehrkraft ohne Zugriff
  assert.equal((await korrektur(anna, { ziel: '2' }, fremd)).status, 403);
  assert.equal(korrekturTermine().length, 0);
  assert.equal(await gesamt(anna), 2.8, 'nichts verändert');
});

test('Wirkungslose Korrektur wird abgelehnt und hinterlässt nichts (Datumstabelle ohne Gewicht)', async () => {
  // Eine Zusatzleistung mit 100 % Gewicht lässt der Datumstabelle keinen Anteil
  await admin(`/teacher/fach/${fachId}/uls/neu`, { name: 'UL1', aufgaben: '1', halbjahr: HJ, gewichtung: '100' });
  const ul = db().prepare('SELECT id FROM unterrichtsleistungen').get().id;
  await admin(`/teacher/uls/${ul}/maxpunkte`, { anzahl_aufgaben: '1', mp_0: '10', halbjahr: HJ });
  await admin(`/teacher/uls/${ul}/punkte`, { schueler_id: String(anna), aufgabe_idx: '0', wert: '5' });
  const vorher = await gesamt(anna);
  await korrektur(anna, { ziel: '2' });
  assert.equal(korrekturTermine().length, 0);
  assert.equal(await gesamt(anna), vorher);
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM unterricht_termine').get().c, 1, 'kein Termin zurückgeblieben');
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
