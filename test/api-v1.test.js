/**
 * API für KI-Agenten (/api/v1): API-Schlüssel (Anlegen, Hash, Widerruf, Ablauf, Berechtigung), Auslesen, Berechnen und Eintragen
 * (alles oder nichts, Probelauf, Rechte der Lehrkraft), öffentliche Dokumentation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-api-v1-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-api-v1-bitte-lang-genug-xxxxxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { rateLimitErreicht, RATE_PRO_MINUTE, pruefeSchluessel } = await import('../src/api-keys.js');
const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
test.after(() => fastify.close());

function client() {
  const cookies = new Map();
  return async function req(url, body) {
    const headers = {};
    if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    const opts = { headers, redirect: 'manual' };
    if (body) { opts.method = 'POST'; headers['content-type'] = 'application/x-www-form-urlencoded'; opts.body = new URLSearchParams(body); }
    const r = await fetch(base + url, opts);
    for (const raw of r.headers.getSetCookie?.() ?? []) { const [k, ...v] = raw.split(';')[0].split('='); cookies.set(k.trim(), v.join('=').trim()); }
    return r;
  };
}
const admin = client();
const anna = client();
const ben = client();

// API-Aufruf mit Schlüssel
async function api(key, method, url, body) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const r = await fetch(`${base}/api/v1${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await r.json(); } catch { /* kein JSON */ }
  return { status: r.status, json };
}

const db = () => getDb();
let klasseId; let fachId; let sid1; let sid2; let sid3; let leseKey; let schreibKey; let benKey; let coraKeyCache;
const coraKeyGlobal = () => coraKeyCache;
const HJ = '1. Halbjahr';

async function neuerSchluessel(c, name, scope, tage = '') {
  const html = await (await c('/konto/api', { name, scope, gueltig_tage: tage })).text();
  const m = /value="(nk_[A-Za-z0-9_-]+)"/.exec(html);
  assert.ok(m, 'Schlüssel wird einmalig angezeigt');
  return m[1];
}

test('Vorbereitung: Anna (Klasse, Fach, drei Schüler:innen), Ben (fremde Lehrkraft); Schlüssel über die Oberfläche', async () => {
  await admin('/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await admin('/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sj = db().prepare('SELECT id FROM schuljahre').get().id;
  for (const [c, n] of [[anna, 'anna'], [ben, 'ben']]) {
    await admin('/admin/einladungen/neu', { display_name: n, ttl_days: '14' });
    const inv = db().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
    await c(`/einladung/${inv.token}`, { username: n, display_name: n, password: 'passwort123', password2: 'passwort123' });
  }
  db().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'anna'").run();
  await anna('/teacher/klassen/neu', { schuljahr_id: String(sj), name: '12E', notenschluessel: 'BG', einschulung_jahr: '2025' });
  klasseId = db().prepare("SELECT id FROM klassen WHERE name = '12E'").get().id;
  await anna(`/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Englisch' });
  fachId = db().prepare('SELECT id FROM faecher WHERE klasse_id = ?').get(klasseId).id;
  for (const [n, v] of [['Adler', 'Anna'], ['Berger', 'Bert'], ['Claus', 'Cem']]) await anna(`/teacher/klassen/${klasseId}/schueler/neu`, { nachname: n, vorname: v });
  [sid1, sid2, sid3] = db().prepare('SELECT id FROM schueler ORDER BY nachname').all().map((r) => r.id);
  leseKey = await neuerSchluessel(anna, 'Lesen', 'lesen', '30');
  schreibKey = await neuerSchluessel(anna, 'Schreiben', 'schreiben', '');
  benKey = await neuerSchluessel(ben, 'Ben', 'schreiben');
});

test('Schlüssel: nur der Hash steht in der Datenbank, nicht der Klartext', () => {
  const rows = db().prepare('SELECT * FROM api_keys').all();
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.match(r.key_hash, /^[0-9a-f]{64}$/);
    assert.ok(![leseKey, schreibKey, benKey].some((k) => JSON.stringify(r).includes(k)), 'kein Klartext gespeichert');
  }
  assert.equal(db().prepare("SELECT key_hash FROM api_keys WHERE name = 'Lesen'").get().key_hash, crypto.createHash('sha256').update(leseKey).digest('hex'));
});

test('Dokumentation ist öffentlich (OpenAPI und Seite), Endpunkte und Hinweise sind enthalten', async () => {
  const spec = await (await fetch(`${base}/api/v1/openapi.json`)).json();
  assert.equal(spec.openapi, '3.0.3');
  for (const p of ['/me', '/klassen', '/faecher/{id}/noten', '/klausuren/{id}/ergebnisse', '/faecher/{id}/endnoten', '/berechnen/klausur']) assert.ok(spec.paths[p], p);
  assert.ok(spec.paths['/klausuren/{id}/ergebnisse'].put.requestBody);
  const html = await (await fetch(`${base}/api/v1/docs`)).text();
  assert.match(html, /API für KI-Agenten/);
  assert.match(html, /dry_run=true/);
  assert.match(html, /Authorization: Bearer nk_/);
  assert.match(html, /id="ep-klausur-ergebnisse"/);
});

test('Ohne, mit falschem, widerrufenem oder abgelaufenem Schlüssel: 401', async () => {
  assert.equal((await api(null, 'GET', '/me')).status, 401);
  assert.equal((await api('nk_falsch', 'GET', '/me')).status, 401);
  assert.equal((await api('irgendwas', 'GET', '/me')).status, 401);
  const wegwerf = await neuerSchluessel(anna, 'Wegwerf', 'lesen');
  assert.equal((await api(wegwerf, 'GET', '/me')).status, 200);
  const id = db().prepare("SELECT id FROM api_keys WHERE name = 'Wegwerf'").get().id;
  assert.equal((await anna(`/konto/api/${id}/widerrufen`, {})).status, 302);
  assert.equal((await api(wegwerf, 'GET', '/me')).status, 401, 'widerrufen');
  db().prepare("UPDATE api_keys SET expires_at = '2020-01-01T00:00:00.000Z' WHERE name = 'Lesen'").run();
  assert.equal((await api(leseKey, 'GET', '/me')).status, 401, 'abgelaufen');
  db().prepare("UPDATE api_keys SET expires_at = NULL WHERE name = 'Lesen'").run();
  assert.equal((await api(leseKey, 'GET', '/me')).status, 200);
  // Fremde Lehrkraft kann Annas Schlüssel nicht widerrufen
  const annaKeyId = db().prepare("SELECT id FROM api_keys WHERE name = 'Schreiben'").get().id;
  await ben(`/konto/api/${annaKeyId}/widerrufen`, {});
  assert.equal((await api(schreibKey, 'GET', '/me')).status, 200);
});

test('/me, /klassen, /klassen/:id/schueler, /notenschluessel', async () => {
  const me = await api(schreibKey, 'GET', '/me');
  assert.equal(me.json.nutzer.benutzername, 'anna');
  assert.equal(me.json.schluessel.berechtigung, 'schreiben');
  const kl = await api(leseKey, 'GET', '/klassen');
  assert.equal(kl.json.klassen.length, 1);
  assert.equal(kl.json.klassen[0].name, '12E');
  assert.equal(kl.json.klassen[0].faecher[0].id, fachId);
  assert.deepEqual((await api(leseKey, 'GET', `/klassen/${klasseId}/schueler`)).json.schueler.map((s) => s.nachname), ['Adler', 'Berger', 'Claus']);
  assert.equal((await api(benKey, 'GET', '/klassen')).json.klassen.length, 0, 'Ben sieht Annas Klasse nicht');
  assert.equal((await api(benKey, 'GET', `/klassen/${klasseId}/schueler`)).status, 403);
  const ns = (await api(leseKey, 'GET', '/notenschluessel')).json.notenschluessel;
  assert.deepEqual(ns.map((n) => n.typ), ['IHK', 'BG', 'SPA']);
  assert.ok(ns[1].tabelle.some((z) => z.ab_prozent === 95 && z.note === 15));
});

test('Berechnen (ohne zu speichern): Hörverstehen ohne Rundung, Inhalt & Sprache direkt gemittelt', async () => {
  const teile = [{ name: 'Hören', aufgaben: 1, gewichtung: 40, art: 'hoeren' }, { name: 'Text', aufgaben: 2, gewichtung: 60, art: 'inhalt_sprache', inhalt_anteil: 50 }];
  const r = await api(leseKey, 'POST', '/berechnen/klausur', { notenschluessel: 'BG', max_punkte: [15, 15, 15], punkte: [12, 4, 3], teile });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.teilnoten, [12, 3.5]);
  assert.equal(r.json.note, 6.9);
  assert.equal((await api(leseKey, 'POST', '/berechnen/klausur', { notenschluessel: 'BG', max_punkte: [15], punkte: [4], teile: null })).json.note, 2, 'normale Klausur: 27 %');
  assert.equal((await api(leseKey, 'POST', '/berechnen/klausur', { notenschluessel: 'BG', max_punkte: [10], punkte: [11] })).status, 400, 'über dem Maximum');
  assert.equal((await api(leseKey, 'POST', '/berechnen/klausur', { notenschluessel: 'XY', max_punkte: [10], punkte: [1] })).status, 400);
});

test('Lesender Schlüssel darf nicht eintragen; fremde Lehrkraft darf nicht an Annas Fach', async () => {
  const r = await api(leseKey, 'POST', `/faecher/${fachId}/klausuren`, { name: 'K', max_punkte: [10] });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'forbidden_scope');
  assert.equal((await api(benKey, 'POST', `/faecher/${fachId}/klausuren`, { name: 'K', max_punkte: [10] })).status, 403);
  assert.equal((await api(benKey, 'GET', `/faecher/${fachId}/noten`)).status, 403);
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM klausuren').get().c, 0);
});

let klausurId;
test('Klausur anlegen: Probelauf speichert nichts, danach echt; Validierung', async () => {
  const body = { halbjahr: 1, name: 'Klausur 1', datum: '2025-10-14', max_punkte: [10, 10, 5] };
  const trocken = await api(schreibKey, 'POST', `/faecher/${fachId}/klausuren?dry_run=true`, body);
  assert.equal(trocken.status, 200);
  assert.equal(trocken.json.gespeichert, false);
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM klausuren').get().c, 0);
  assert.equal((await api(schreibKey, 'POST', `/faecher/${fachId}/klausuren`, { ...body, max_punkte: [] })).status, 422);
  assert.equal((await api(schreibKey, 'POST', `/faecher/${fachId}/klausuren`, { ...body, datum: '14.10.2025' })).status, 422);
  assert.equal((await api(schreibKey, 'POST', `/faecher/${fachId}/klausuren`, { ...body, halbjahr: 'Quatsch' })).status, 400);
  const echt = await api(schreibKey, 'POST', `/faecher/${fachId}/klausuren`, body);
  assert.equal(echt.status, 200);
  klausurId = echt.json.klausur.id;
  assert.deepEqual(JSON.parse(db().prepare('SELECT max_punkte_pro_aufgabe AS m FROM klausuren WHERE id = ?').get(klausurId).m), [10, 10, 5]);
  assert.ok(echt.json.klausur.gewichtung > 0, 'Gewichtung wie in der Oberfläche automatisch verteilt');
  const fach = await api(leseKey, 'GET', `/faecher/${fachId}?halbjahr=1`);
  assert.equal(fach.json.klausuren[0].name, 'Klausur 1');
  assert.deepEqual(fach.json.klausuren[0].max_punkte, [10, 10, 5]);
});

test('Klausurergebnisse eintragen: alles oder nichts, Probelauf mit Noten, Teilnahme und Maximum werden geprüft', async () => {
  const gut = { ergebnisse: [{ schueler_id: sid1, punkte: [10, 10, 5] }, { schueler_id: sid2, punkte: [5, 5, 2.5] }] };
  const trocken = await api(schreibKey, 'PUT', `/klausuren/${klausurId}/ergebnisse?dry_run=true`, gut);
  assert.equal(trocken.status, 200);
  assert.equal(trocken.json.ergebnisse[0].note, 15);
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM klausur_ergebnisse').get().c, 0, 'Probelauf speichert nichts');

  const schlecht = await api(schreibKey, 'PUT', `/klausuren/${klausurId}/ergebnisse`, {
    ergebnisse: [{ schueler_id: sid1, punkte: [10, 10, 5] }, { schueler_id: sid2, punkte: [11, 5, 2] }, { schueler_id: 99999, punkte: [1, 1, 1] }, { schueler_id: sid3, punkte: [1, 2] }],
  });
  assert.equal(schlecht.status, 422);
  assert.equal(schlecht.json.details.length, 3);
  assert.match(schlecht.json.details[0].fehler, /Maximum/);
  assert.match(schlecht.json.details[1].fehler, /nicht an diesem Fach/);
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM klausur_ergebnisse').get().c, 0, 'nichts gespeichert, auch Person 1 nicht');

  const echt = await api(schreibKey, 'PUT', `/klausuren/${klausurId}/ergebnisse`, gut);
  assert.equal(echt.status, 200);
  assert.equal(echt.json.anzahl, 2);
  // Wiederholen ist gefahrlos
  assert.equal((await api(schreibKey, 'PUT', `/klausuren/${klausurId}/ergebnisse`, gut)).status, 200);
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM klausur_ergebnisse').get().c, 2);
  // Teilweise Aktualisierung einer Person (null = noch offen)
  await api(schreibKey, 'PUT', `/klausuren/${klausurId}/ergebnisse`, { ergebnisse: [{ schueler_id: sid3, punkte: [10, null, null] }] });
  assert.deepEqual(JSON.parse(db().prepare('SELECT punkte FROM klausur_ergebnisse WHERE schueler_id = ?').get(sid3).punkte), [10, null, null]);
});

test('Noten auslesen und auswerten: Notenübersicht und Statistik', async () => {
  const n = await api(leseKey, 'GET', `/faecher/${fachId}/noten?halbjahr=1`);
  assert.equal(n.status, 200);
  const adler = n.json.schueler.find((s) => s.nachname === 'Adler');
  assert.equal(adler.klausuren[0].note, 15);
  assert.deepEqual(adler.klausuren[0].punkte, [10, 10, 5]);
  assert.equal(adler.gesamtnote, 15);
  const berger = n.json.schueler.find((s) => s.nachname === 'Berger');
  assert.equal(berger.klausuren[0].note, 6, '12,5 von 25 = 50 % -> 6 Notenpunkte');
  const claus = n.json.schueler.find((s) => s.nachname === 'Claus');
  assert.equal(claus.klausuren[0].note, null, 'noch nicht vollständig');
  const st = await api(leseKey, 'GET', `/faecher/${fachId}/statistik?halbjahr=1`);
  assert.equal(st.json.anzahl_mit_note, 2);
  assert.equal(st.json.anzahl_ohne_note, 1);
  assert.equal(st.json.durchschnitt, 10.5);
  assert.equal(st.json.beste, 15);
  assert.equal(st.json.schlechteste, 6);
  assert.deepEqual(st.json.verteilung, [{ note: 6, anzahl: 1 }, { note: 15, anzahl: 1 }]);
});

test('Extrapunkte einer einteiligen Klausur; Zusatzleistung (Unterrichtsleistung) anlegen und eintragen', async () => {
  const ex = await api(schreibKey, 'PUT', `/klausuren/${klausurId}/ergebnisse`, { ergebnisse: [{ schueler_id: sid2, extrapunkte: 2 }] });
  assert.equal(ex.status, 200);
  assert.equal(db().prepare('SELECT extrapunkte FROM klausur_ergebnisse WHERE schueler_id = ?').get(sid2).extrapunkte, 2);
  assert.equal((await api(schreibKey, 'PUT', `/klausuren/${klausurId}/ergebnisse`, { ergebnisse: [{ schueler_id: sid2, extrapunkte: 99 }] })).status, 422);

  const ul = await api(schreibKey, 'POST', `/faecher/${fachId}/unterrichtsleistungen`, { halbjahr: 1, name: 'Referat', max_punkte: [10], gewichtung: 20 });
  assert.equal(ul.status, 200);
  const r = await api(schreibKey, 'PUT', `/unterrichtsleistungen/${ul.json.unterrichtsleistung.id}/ergebnisse`, { ergebnisse: [{ schueler_id: sid1, punkte: [9] }] });
  assert.equal(r.status, 200);
  assert.ok(r.json.ergebnisse[0].note !== null);
  const n = await api(leseKey, 'GET', `/faecher/${fachId}/noten?halbjahr=1`);
  assert.equal(n.json.schueler.find((s) => s.nachname === 'Adler').unterrichtsleistungen[0].punkte[0], 9);
});

test('Datumstabelle: Termin anlegen, Noten (auch n.a. und leeren) eintragen, Bereich wird geprüft', async () => {
  const t = await api(schreibKey, 'POST', `/faecher/${fachId}/termine`, { halbjahr: 1, datum: '2025-09-15' });
  assert.equal(t.status, 200);
  const tid = t.json.termin.id;
  assert.equal((await api(schreibKey, 'POST', `/faecher/${fachId}/termine`, { halbjahr: 1, datum: 'morgen' })).status, 422);
  const schlecht = await api(schreibKey, 'PUT', `/termine/${tid}/noten`, { noten: [{ schueler_id: sid1, note: 11 }, { schueler_id: sid2, note: 16 }] });
  assert.equal(schlecht.status, 422);
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM unterricht_noten').get().c, 0, 'nichts gespeichert');
  const ok = await api(schreibKey, 'PUT', `/termine/${tid}/noten`, { noten: [{ schueler_id: sid1, note: 11 }, { schueler_id: sid2, note: 'n.a.' }, { schueler_id: sid3, note: null }] });
  assert.equal(ok.status, 200);
  const rows = db().prepare('SELECT schueler_id, wert, nicht_anwesend FROM unterricht_noten WHERE termin_id = ? ORDER BY schueler_id').all(tid);
  assert.deepEqual(rows.map((r) => [r.wert, r.nicht_anwesend]), [[11, 0], [null, 1], [null, 0]]);
  const n = await api(leseKey, 'GET', `/faecher/${fachId}/noten?halbjahr=1`);
  assert.equal(n.json.schueler.find((s) => s.nachname === 'Adler').datumsnoten[0].note, 11);
  assert.equal(n.json.schueler.find((s) => s.nachname === 'Berger').datumsnoten[0].nicht_anwesend, true);
});

test('Endnoten: eintragen, ntg, Bereich prüfen, leeren; Probelauf; Sperre verhindert die Eingabe', async () => {
  const bad = await api(schreibKey, 'PUT', `/faecher/${fachId}/endnoten`, { halbjahr: 1, endnoten: [{ schueler_id: sid1, note: 16 }] });
  assert.equal(bad.status, 422);
  assert.equal((await api(schreibKey, 'PUT', `/faecher/${fachId}/endnoten?dry_run=true`, { halbjahr: 1, endnoten: [{ schueler_id: sid1, note: 12 }] })).json.gespeichert, false);
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM halbjahr_endnoten').get().c, 0);
  const ok = await api(schreibKey, 'PUT', `/faecher/${fachId}/endnoten`, { halbjahr: 1, endnoten: [{ schueler_id: sid1, note: 12 }, { schueler_id: sid2, note: 'ntg' }] });
  assert.equal(ok.status, 200);
  const n = await api(leseKey, 'GET', `/faecher/${fachId}/noten?halbjahr=1`);
  assert.deepEqual(n.json.schueler.find((s) => s.nachname === 'Adler').endnote, { note: 12, ntg: false });
  assert.equal(n.json.schueler.find((s) => s.nachname === 'Adler').gesamtnote, 12, 'Endnote ersetzt die berechnete Note');
  assert.equal(n.json.schueler.find((s) => s.nachname === 'Berger').endnote.ntg, true);
  assert.equal((await api(schreibKey, 'PUT', `/faecher/${fachId}/endnoten`, { halbjahr: 1, endnoten: [{ schueler_id: sid1, note: null }] })).status, 200);
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM halbjahr_endnoten WHERE schueler_id = ?').get(sid1).c, 0);
  // Notenkonferenz-Sperre
  const { sperren } = await import('../src/noten-sperre.js');
  sperren(klasseId, [sid3], HJ, db().prepare("SELECT id FROM users WHERE username = 'anna'").get().id);
  const gesperrt = await api(schreibKey, 'PUT', `/klausuren/${klausurId}/ergebnisse`, { ergebnisse: [{ schueler_id: sid3, punkte: [1, 1, 1] }] });
  assert.equal(gesperrt.status, 422);
  assert.match(gesperrt.json.details[0].fehler, /gesperrt/);
  assert.equal((await api(leseKey, 'GET', `/faecher/${fachId}/noten?halbjahr=1`)).json.schueler.find((s) => s.nachname === 'Claus').gesperrt, true);
});

test('Ungültiges Halbjahr 400; unbekannter Endpunkt 404 als JSON; Konto deaktiviert -> 401; Rate-Limit', async () => {
  assert.equal((await api(leseKey, 'GET', `/faecher/${fachId}/noten?halbjahr=9`)).status, 400);
  const unbekannt = await api(leseKey, 'GET', '/gibtesnicht');
  assert.equal(unbekannt.status, 404);
  assert.equal(unbekannt.json.error, 'not_found');
  assert.equal((await api(leseKey, 'GET', '/faecher/99999/noten')).status, 404);
  assert.equal((await api(leseKey, 'GET', '/faecher/abc')).status, 404);

  let limit = false;
  for (let i = 0; i <= RATE_PRO_MINUTE + 1 && !limit; i += 1) limit = rateLimitErreicht(987654, 1_000_000);
  assert.equal(limit, true, 'nach 120 Anfragen pro Minute gesperrt');
  assert.equal(rateLimitErreicht(987654, 1_000_000 + 61000), false, 'neue Minute');

  db().prepare("UPDATE users SET active = 0 WHERE username = 'ben'").run();
  assert.equal((await api(benKey, 'GET', '/me')).status, 401);
  assert.equal(pruefeSchluessel(`Bearer ${benKey}`).ok, false);
});

test('Oberfläche: Seite API-Zugang listet Schlüssel ohne Klartext; Menüpunkt vorhanden', async () => {
  const html = await (await anna('/konto/api')).text();
  assert.match(html, /API-Zugang/);
  assert.match(html, /Schreiben/);
  assert.doesNotMatch(html, new RegExp(schreibKey), 'Klartext nur bei der Anlage');
  assert.match(html, /nk_[A-Za-z0-9_-]{8}…/);
  const start = await (await anna('/start')).text();
  assert.match(start, /href="\/konto\/api"/);
  assert.ok([302, 401].includes((await fetch(`${base}/konto/api`, { redirect: 'manual' })).status), 'ohne Anmeldung kein Zugang');
});

test('Sync mit der Klassenleitung: Stand abfragen, auf Knopfdruck synchronisieren, Auto-Sync schalten; API-Eintragungen lösen ihn aus', async () => {
  const fach = () => api(leseKey, 'GET', `/faecher/${fachId}?halbjahr=1`);
  const stand = (await fach()).json.sync;
  assert.equal(stand.automatisch, false, 'Anna hat den Haken nicht gesetzt');
  const anzahlStand = () => db().prepare('SELECT COUNT(*) AS c FROM fach_sync_stand').get().c;
  const vorher = anzahlStand();

  assert.equal((await api(leseKey, 'POST', `/faecher/${fachId}/sync`, {})).status, 403, 'lesender Schlüssel darf nicht synchronisieren');
  const trocken = await api(schreibKey, 'POST', `/faecher/${fachId}/sync?dry_run=true`, { halbjahr: 1 });
  assert.equal(trocken.json.synchronisiert, false);
  assert.equal(anzahlStand(), vorher, 'Probelauf ändert nichts');

  const sync = await api(schreibKey, 'POST', `/faecher/${fachId}/sync`, { halbjahr: 1 });
  assert.equal(sync.status, 200);
  assert.equal(sync.json.synchronisiert, true);
  assert.ok(sync.json.sync.zuletzt_synchronisiert_am);
  assert.equal(sync.json.sync.zuletzt_synchronisiert_von, 'anna');
  const gesamt = async () => (await api(leseKey, 'GET', `/faecher/${fachId}/noten?halbjahr=1`)).json.schueler.find((x) => x.id === sid1).gesamtnote;
  const synchronisiert = () => db().prepare('SELECT note FROM fach_sync_stand WHERE fach_id = ? AND halbjahr = ? AND schueler_id = ?').get(fachId, HJ, sid1)?.note;
  const rows = db().prepare('SELECT schueler_id, note FROM fach_sync_stand WHERE fach_id = ? AND halbjahr = ?').all(fachId, HJ);
  assert.ok(rows.length >= 2, 'Stand für die Klassenleitung geschrieben');
  const stand1 = await gesamt();
  assert.equal(synchronisiert(), stand1, 'Klassenleitung sieht die aktuelle Gesamtnote');

  // Auto-Sync einschalten: sofort synchronisiert, danach löst jede API-Eintragung den Sync aus
  assert.equal((await api(schreibKey, 'PUT', `/faecher/${fachId}/auto-sync`, { aktiv: 'ja' })).status, 422);
  const an = await api(schreibKey, 'PUT', `/faecher/${fachId}/auto-sync`, { halbjahr: 1, aktiv: true });
  assert.equal(an.status, 200);
  assert.equal(an.json.sync.automatisch, true);
  assert.equal((await fach()).json.sync.automatisch, true);
  await api(schreibKey, 'PUT', `/klausuren/${klausurId}/ergebnisse`, { ergebnisse: [{ schueler_id: sid1, punkte: [5, 5, 2.5] }] });
  const schlechter = await gesamt();
  assert.notEqual(schlechter, stand1);
  assert.equal(synchronisiert(), schlechter, 'neuer Stand automatisch synchronisiert');

  const aus = await api(schreibKey, 'PUT', `/faecher/${fachId}/auto-sync`, { aktiv: false });
  assert.equal(aus.json.sync.automatisch, false);
  await api(schreibKey, 'PUT', `/klausuren/${klausurId}/ergebnisse`, { ergebnisse: [{ schueler_id: sid1, punkte: [10, 10, 5] }] });
  assert.equal(await gesamt(), stand1);
  assert.equal(synchronisiert(), schlechter, 'ohne Auto-Sync bleibt der alte Stand bis zum nächsten Sync');
  await api(schreibKey, 'POST', `/faecher/${fachId}/sync`, { halbjahr: 1 });
  assert.equal(synchronisiert(), stand1);

  // Fremde Lehrkraft und Admin ohne Zuordnung
  assert.equal((await api(benKey, 'POST', `/faecher/${fachId}/sync`, {})).status, 401, 'Ben ist deaktiviert (vorheriger Test)');
});

test('Auto-Sync braucht eine Zuordnung zum Fach; der Admin ohne Zuordnung bekommt 409, kann aber synchronisieren', async () => {
  await admin('/admin/einladungen/neu', { display_name: 'x', ttl_days: '14' });
  const adminKey = await neuerSchluessel(admin, 'Admin-Agent', 'schreiben');
  assert.equal((await api(adminKey, 'PUT', `/faecher/${fachId}/auto-sync`, { aktiv: true })).status, 409);
  assert.equal((await api(adminKey, 'POST', `/faecher/${fachId}/sync`, { halbjahr: 1 })).status, 200);
  assert.equal((await api(adminKey, 'GET', `/faecher/${fachId}?halbjahr=1`)).json.sync.automatisch, null);
});

test('Teilnehmerliste: auslesen und Personen aufnehmen (neu, schon vorhanden, falscher Notenschlüssel); alles oder nichts; Probelauf', async () => {
  const kurs = async () => {
    await anna('/teacher/kurse/neu', { schuljahr_id: String(db().prepare('SELECT id FROM schuljahre').get().id), name: 'Philo-AG', notenschluessel: 'BG' });
    return db().prepare("SELECT id FROM faecher WHERE name = 'Philo-AG'").get().id;
  };
  const kursId = await kurs();
  const stand = () => db().prepare('SELECT COUNT(*) AS c FROM fach_teilnehmer WHERE fach_id = ?').get(kursId).c;
  assert.equal((await api(leseKey, 'GET', `/faecher/${kursId}/teilnehmer`)).json.anzahl, 0);
  assert.equal((await api(leseKey, 'POST', `/faecher/${kursId}/teilnehmer`, { teilnehmer: [] })).status, 403, 'lesender Schlüssel');

  const body = { teilnehmer: [{ nachname: 'Neu', vorname: 'Nora', klasse: '13NEU' }, { nachname: 'Berger', vorname: 'Bert', klasse: '12E' }] };
  const klassenVorher = db().prepare('SELECT COUNT(*) AS c FROM klassen').get().c;
  const trocken = await api(schreibKey, 'POST', `/faecher/${kursId}/teilnehmer?dry_run=true`, body);
  assert.equal(trocken.status, 200);
  assert.equal(trocken.json.gespeichert, false);
  assert.equal(trocken.json.hinzugefuegt, 2);
  assert.equal(stand(), 0, 'Probelauf nimmt alles zurück');
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM klassen').get().c, klassenVorher, 'auch die neue Klasse');

  const echt = await api(schreibKey, 'POST', `/faecher/${kursId}/teilnehmer`, body);
  assert.equal(echt.status, 200);
  assert.equal(echt.json.hinzugefuegt, 2);
  assert.ok(echt.json.teilnehmer.every((t) => Number.isInteger(t.schueler_id) && t.status === 'hinzugefuegt'));
  assert.equal(stand(), 2);
  assert.equal(db().prepare("SELECT notenschluessel FROM klassen WHERE name = '13NEU'").get().notenschluessel, 'BG', 'neue Klasse mit dem Schlüssel des Kurses');
  // Berger aus 12E ist dieselbe Person wie in der Klasse (keine Dublette)
  assert.equal(db().prepare("SELECT COUNT(*) AS c FROM schueler WHERE nachname = 'Berger'").get().c, 1);

  const nochmal = await api(schreibKey, 'POST', `/faecher/${kursId}/teilnehmer`, { teilnehmer: [{ nachname: 'Neu', vorname: 'Nora', klasse: '13NEU' }, { nachname: 'Frisch', vorname: 'Finn', klasse: '13NEU' }] });
  assert.equal(nochmal.json.hinzugefuegt, 1);
  assert.equal(nochmal.json.uebersprungen, 1);
  assert.deepEqual(nochmal.json.teilnehmer.map((t) => t.status), ['uebersprungen', 'hinzugefuegt']);
  assert.equal(stand(), 3);

  // Alles oder nichts: ein fehlerhafter Eintrag verhindert alle (auch neue Personen und Klassen)
  db().prepare("INSERT INTO klassen (schuljahr_id, name, notenschluessel, notenschluessel_csv) SELECT schuljahr_id, '13IHK', 'IHK', '' FROM klassen WHERE name = '13NEU'").run();
  const klassenAnzahl = db().prepare('SELECT COUNT(*) AS c FROM klassen').get().c;
  const schlecht = await api(schreibKey, 'POST', `/faecher/${kursId}/teilnehmer`, { teilnehmer: [
    { nachname: 'Gut', vorname: 'Gerd', klasse: '14GUT' }, { nachname: 'Falsch', vorname: 'Fred', klasse: '13IHK' }, { nachname: 'Ohne', vorname: 'Olga' },
  ] });
  assert.equal(schlecht.status, 422);
  assert.equal(schlecht.json.details.length, 2);
  assert.match(schlecht.json.details[0].fehler, /Notenschlüssel/);
  assert.match(schlecht.json.details[1].fehler, /erforderlich/);
  assert.equal(stand(), 3, 'nichts gespeichert');
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM klassen').get().c, klassenAnzahl, 'Klasse 14GUT wurde nicht angelegt');
  assert.equal(db().prepare("SELECT COUNT(*) AS c FROM schueler WHERE nachname = 'Gut'").get().c, 0);

  const liste = await api(leseKey, 'GET', `/faecher/${kursId}/teilnehmer`);
  assert.equal(liste.json.anzahl, 3);
  assert.deepEqual(liste.json.teilnehmer.map((t) => t.nachname).sort(), ['Berger', 'Frisch', 'Neu']);
  assert.equal(liste.json.fach.kurs, true);

  // Fremde Lehrkraft (Cora hat keinen Zugriff) darf nicht
  const coraKey = await (async () => {
    await admin('/admin/einladungen/neu', { display_name: 'cora', ttl_days: '14' });
    const inv = db().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
    const cora = client();
    await cora(`/einladung/${inv.token}`, { username: 'cora', display_name: 'cora', password: 'passwort123', password2: 'passwort123' });
    const k = await neuerSchluessel(cora, 'Cora', 'schreiben');
    coraKeyCache = k;
    return k;
  })();
  assert.equal((await api(coraKey, 'POST', `/faecher/${kursId}/teilnehmer`, body)).status, 403);
  assert.equal((await api(coraKey, 'GET', `/faecher/${kursId}/teilnehmer`)).status, 403);
  assert.equal((await api(schreibKey, 'POST', `/faecher/${kursId}/teilnehmer`, { teilnehmer: 'x' })).status, 400);
});

test('Mit der Teilnehmerliste können Noten eingetragen werden (Kurs-Workflow für Agenten)', async () => {
  const kursId = db().prepare("SELECT id FROM faecher WHERE name = 'Philo-AG'").get().id;
  const liste = (await api(leseKey, 'GET', `/faecher/${kursId}/teilnehmer`)).json.teilnehmer;
  const nora = liste.find((t) => t.nachname === 'Neu');
  const k = await api(schreibKey, 'POST', `/faecher/${kursId}/klausuren`, { halbjahr: 1, name: 'K1', max_punkte: [10] });
  assert.equal(k.status, 200);
  const r = await api(schreibKey, 'PUT', `/klausuren/${k.json.klausur.id}/ergebnisse`, { ergebnisse: [{ schueler_id: nora.id, punkte: [10] }] });
  assert.equal(r.status, 200);
  assert.equal(r.json.ergebnisse[0].note, 15);
});

test('Klasse umbenennen über die API: jede Lehrkraft der Klasse, gilt für alle; Regeln wie in der App; Probelauf', async () => {
  const name = () => db().prepare('SELECT name FROM klassen WHERE id = ?').get(klasseId).name;
  assert.equal((await api(leseKey, 'PUT', `/klassen/${klasseId}/name`, { name: 'Neu' })).status, 403, 'lesender Schlüssel');
  const trocken = await api(schreibKey, 'PUT', `/klassen/${klasseId}/name?dry_run=true`, { name: '12E-Neu' });
  assert.equal(trocken.status, 200);
  assert.equal(trocken.json.gespeichert, false);
  assert.equal(name(), '12E', 'Probelauf ändert nichts');
  const r = await api(schreibKey, 'PUT', `/klassen/${klasseId}/name`, { name: '  12E-Neu ' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.klasse, { id: klasseId, name: '12E-Neu', vorher: '12E' });
  assert.equal(name(), '12E-Neu');
  assert.equal((await api(leseKey, 'GET', '/klassen')).json.klassen[0].name, '12E-Neu');
  assert.match(await (await anna('/teacher/klassen')).text(), /12E-Neu/, 'auch in der App');
  // Regeln
  for (const n of ['', 'x'.repeat(61), '__x']) assert.equal((await api(schreibKey, 'PUT', `/klassen/${klasseId}/name`, { name: n })).status, 422);
  db().prepare("INSERT INTO klassen (schuljahr_id, name, notenschluessel, notenschluessel_csv) SELECT schuljahr_id, 'Doppelt', 'BG', '' FROM klassen WHERE id = ?").run(klasseId);
  const doppelt = await api(schreibKey, 'PUT', `/klassen/${klasseId}/name`, { name: 'doppelt' });
  assert.equal(doppelt.status, 422);
  assert.match(doppelt.json.message, /gibt es schon/);
  assert.equal(name(), '12E-Neu');
  // Nicht Zugehörige, unbekannte Klasse, Sammelklasse
  assert.equal((await api(coraKeyGlobal(), 'PUT', `/klassen/${klasseId}/name`, { name: 'Gekapert' })).status, 403);
  assert.equal((await api(schreibKey, 'PUT', '/klassen/99999/name', { name: 'X' })).status, 404);
  const ablage = db().prepare("INSERT INTO klassen (schuljahr_id, name, notenschluessel, notenschluessel_csv, ist_ablage) SELECT schuljahr_id, 'Ohne Klasse', 'IHK', '', 1 FROM klassen WHERE id = ?").run(klasseId).lastInsertRowid;
  assert.equal((await api(schreibKey, 'PUT', `/klassen/${ablage}/name`, { name: 'Anders' })).status, 403);
  // Zurück für spätere Tests
  await api(schreibKey, 'PUT', `/klassen/${klasseId}/name`, { name: '12E' });
});

test('Kurs umbenennen über die API: zugeordnete Lehrkraft, gilt für alle; nur Kurse; Probelauf; Rechte', async () => {
  const kursId = db().prepare("SELECT id FROM faecher WHERE name = 'Philo-AG'").get().id;
  const name = () => db().prepare('SELECT name FROM faecher WHERE id = ?').get(kursId).name;
  assert.equal((await api(leseKey, 'PUT', `/faecher/${kursId}/name`, { name: 'X' })).status, 403, 'lesender Schlüssel');
  const trocken = await api(schreibKey, 'PUT', `/faecher/${kursId}/name?dry_run=true`, { name: 'Philosophie Q1' });
  assert.equal(trocken.status, 200);
  assert.equal(trocken.json.gespeichert, false);
  assert.equal(name(), 'Philo-AG');
  const r = await api(schreibKey, 'PUT', `/faecher/${kursId}/name`, { name: ' Philosophie Q1 ' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.kurs, { id: kursId, name: 'Philosophie Q1', vorher: 'Philo-AG' });
  assert.equal(name(), 'Philosophie Q1');
  assert.equal((await api(leseKey, 'GET', '/klassen')).json.kurse.some((k) => k.name === 'Philosophie Q1'), true, 'in der Kursliste der API');
  for (const n of ['', 'x'.repeat(101)]) assert.equal((await api(schreibKey, 'PUT', `/faecher/${kursId}/name`, { name: n })).status, 422);
  assert.equal(name(), 'Philosophie Q1');
  assert.equal((await api(coraKeyGlobal(), 'PUT', `/faecher/${kursId}/name`, { name: 'Gekapert' })).status, 403);
  assert.equal((await api(schreibKey, 'PUT', `/faecher/${fachId}/name`, { name: 'Anders' })).status, 409, 'Englisch ist kein Kurs');
  assert.equal(db().prepare('SELECT name FROM faecher WHERE id = ?').get(fachId).name, 'Englisch');
  assert.equal((await api(schreibKey, 'PUT', '/faecher/99999/name', { name: 'X' })).status, 404);
  await api(schreibKey, 'PUT', `/faecher/${kursId}/name`, { name: 'Philo-AG' });
});

test('Kurs anlegen über die API: Standard BG, Probelauf, wiederholbar, Schuljahr, Rechte; danach Teilnehmer aufnehmen', async () => {
  const kurse = () => db().prepare("SELECT COUNT(*) AS c FROM faecher WHERE ist_kurs = 1").get().c;
  const vorher = kurse();
  assert.equal((await api(leseKey, 'POST', '/kurse', { name: 'API-Kurs' })).status, 403, 'lesender Schlüssel');
  const trocken = await api(schreibKey, 'POST', '/kurse?dry_run=true', { name: 'API-Kurs', schuljahr: '2025/26' });
  assert.equal(trocken.status, 200);
  assert.equal(trocken.json.kurs.notenschluessel, 'BG');
  assert.equal(kurse(), vorher, 'Probelauf legt nichts an');

  const r = await api(schreibKey, 'POST', '/kurse', { name: ' API-Kurs ', schuljahr: '2025/26' });
  assert.equal(r.status, 200);
  assert.equal(r.json.gespeichert, true);
  assert.equal(r.json.kurs.name, 'API-Kurs');
  assert.equal(r.json.kurs.notenschluessel, 'BG', 'Standard-Notenschlüssel BG');
  assert.equal(r.json.kurs.schuljahr, '2025/26');
  const kursId = r.json.kurs.id;
  assert.equal(db().prepare('SELECT 1 FROM fach_zuweisungen WHERE fach_id = ? AND user_id = (SELECT id FROM users WHERE username = ?)').get(kursId, 'anna') !== undefined, true, 'Anna ist dem Kurs zugeordnet');
  assert.equal(kurse(), vorher + 1);
  // Wiederholen: kein zweiter Kurs
  const nochmal = await api(schreibKey, 'POST', '/kurse', { name: 'API-Kurs', schuljahr: '2025/26' });
  assert.equal(nochmal.json.bereits_vorhanden, true);
  assert.equal(nochmal.json.kurs.id, kursId);
  assert.equal(kurse(), vorher + 1);
  // IHK wählbar, Schuljahr als ID, ohne Schuljahr = aktuelles
  const ihk = await api(schreibKey, 'POST', '/kurse', { name: 'IHK-Kurs', notenschluessel: 'IHK', schuljahr: db().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id });
  assert.equal(ihk.json.kurs.notenschluessel, 'IHK');
  assert.equal((await api(schreibKey, 'POST', '/kurse', { name: 'Aktuell' })).status, 200);
  // Fehler
  assert.equal((await api(schreibKey, 'POST', '/kurse', { name: '' })).status, 422);
  assert.equal((await api(schreibKey, 'POST', '/kurse', { name: 'X', notenschluessel: 'SPA' })).status, 422);
  assert.equal((await api(schreibKey, 'POST', '/kurse', { name: 'X', schuljahr: '1999/00' })).status, 422);
  assert.equal((await api(coraKeyGlobal(), 'POST', '/kurse', { name: 'Fremd' })).status, 403, 'ohne Schul-Zugang (LDAP)');
  // Weiter mit Teilnehmern
  const t = await api(schreibKey, 'POST', `/faecher/${kursId}/teilnehmer`, { teilnehmer: [{ nachname: 'Kurs', vorname: 'Kai', klasse: '12E' }] });
  assert.equal(t.status, 200);
  assert.equal(t.json.hinzugefuegt, 1);
  assert.ok((await api(leseKey, 'GET', '/klassen')).json.kurse.some((k) => k.id === kursId && k.art === 'kurs'));
});

test('Klasse anlegen über die API: IHK-Standard, Laufzeit, Probelauf, wiederholbar, SPA mit Fächervorgabe, Fehler, Rechte', async () => {
  const klassen = () => db().prepare('SELECT COUNT(*) AS c FROM klassen WHERE ist_kurs_huelle = 0 AND ist_ablage = 0').get().c;
  const vorher = klassen();
  assert.equal((await api(leseKey, 'POST', '/klassen', { name: 'API-Klasse' })).status, 403, 'lesender Schlüssel');
  const trocken = await api(schreibKey, 'POST', '/klassen?dry_run=true', { name: 'API-Klasse', schuljahr: '2025/26' });
  assert.equal(trocken.status, 200);
  assert.equal(trocken.json.dry_run, true);
  assert.equal(trocken.json.klasse.id, null);
  assert.equal(klassen(), vorher, 'Probelauf legt nichts an');

  const r = await api(schreibKey, 'POST', '/klassen', { name: ' API-Klasse ', schuljahr: '2025/26', notenschluessel: 'BG', einschulung_jahr: 2025, anzahl_jahre: 2, offen_fuer_beitritt: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.gespeichert, true);
  assert.equal(r.json.klasse.name, 'API-Klasse');
  assert.equal(r.json.klasse.notenschluessel, 'BG');
  assert.equal(r.json.klasse.einschulung_jahr, 2025);
  assert.equal(r.json.klasse.abschluss_jahr, 2026);
  const zeile = db().prepare('SELECT k.*, u.username FROM klassen k JOIN users u ON u.id = k.created_by_id WHERE k.id = ?').get(r.json.klasse.id);
  assert.equal(zeile.username, 'anna', 'angelegt von der Lehrkraft des Schlüssels');
  assert.equal(zeile.offen_fuer_beitritt, 1);
  assert.equal(zeile.abschluss_jahr, 2026);
  assert.equal(klassen(), vorher + 1);
  assert.ok((await api(leseKey, 'GET', '/klassen')).json.klassen.some((k) => k.id === r.json.klasse.id), 'Klasse erscheint in der Liste der Lehrkraft');

  // Wiederholen: keine zweite Klasse, Hinweis und Zugriff
  const nochmal = await api(schreibKey, 'POST', '/klassen', { name: 'API-Klasse', schuljahr: '2025/26' });
  assert.equal(nochmal.json.bereits_vorhanden, true);
  assert.equal(nochmal.json.klasse.id, r.json.klasse.id);
  assert.equal(nochmal.json.zugriff, true);
  assert.equal(klassen(), vorher + 1);

  // Standard: IHK, aktuelles Schuljahr; Schuljahr als ID
  const std = await api(schreibKey, 'POST', '/klassen', { name: 'Standard-Klasse' });
  assert.equal(std.status, 200);
  assert.equal(std.json.klasse.notenschluessel, 'IHK');
  assert.equal(std.json.klasse.abschluss_jahr, std.json.klasse.einschulung_jahr + 2, 'Standard: 3 Jahre');
  const sjId = db().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;
  assert.equal((await api(schreibKey, 'POST', '/klassen', { name: 'ID-Klasse', schuljahr: sjId })).json.klasse.schuljahr, '2025/26');

  // SPA: Bildungsgang Pflicht, Fächervorgabe wird geladen
  assert.equal((await api(schreibKey, 'POST', '/klassen', { name: 'SPA-X', notenschluessel: 'SPA' })).status, 422, 'Bildungsgang fehlt');
  assert.equal((await api(schreibKey, 'POST', '/klassen', { name: 'SPA-X', notenschluessel: 'SPA', spa_bildungsgang: 'GIBTS_NICHT' })).status, 422);
  const spa = await api(schreibKey, 'POST', '/klassen', { name: 'API-SPA', schuljahr: '2025/26', notenschluessel: 'SPA', spa_bildungsgang: 'SPA_PIA' });
  assert.equal(spa.status, 200);
  assert.equal(spa.json.klasse.spa_bildungsgang, 'SPA_PIA');
  assert.equal(spa.json.klasse.abschluss_jahr, spa.json.klasse.einschulung_jahr + 1, 'SPA: 2 Jahre');
  assert.ok(db().prepare('SELECT COUNT(*) AS c FROM faecher WHERE klasse_id = ?').get(spa.json.klasse.id).c > 0, 'Fächervorgabe des Bildungsgangs geladen');
  const ohneFaecher = await api(schreibKey, 'POST', '/klassen', { name: 'API-SPA-leer', schuljahr: '2025/26', notenschluessel: 'SPA', spa_bildungsgang: 'SPA_REGULAR', spa_vorlage: 'keine' });
  assert.equal(ohneFaecher.status, 200);
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM faecher WHERE klasse_id = ?').get(ohneFaecher.json.klasse.id).c, 0, 'spa_vorlage keine');
  assert.equal((await api(schreibKey, 'POST', '/klassen', { name: 'SPA-Y', notenschluessel: 'SPA', spa_bildungsgang: 'SPA_PIA', spa_vorlage: 99999 })).status, 422, 'unbekannte Vorlage');

  // Fehler
  for (const body of [
    { name: '' }, { name: 'X'.repeat(101) }, { name: 'X', notenschluessel: 'ABC' }, { name: 'X', schuljahr: '1999/00' },
    { name: 'X', spa_bildungsgang: 'SPA_PIA' }, { name: 'X', einschulung_jahr: 'bald' }, { name: 'X', anzahl_jahre: 0 }, { name: 'X', anzahl_jahre: 99 },
    { name: 'X', einschulung_jahr: 2025, abschluss_jahr: 2020 }, { name: 'X', offen_fuer_beitritt: 'ja' },
  ]) assert.equal((await api(schreibKey, 'POST', '/klassen', body)).status, 422, JSON.stringify(body));
  assert.equal(klassen(), vorher + 5, 'Fehlerfälle legen nichts an (Klassen: API-Klasse, Standard, ID, SPA, SPA-leer)');
  assert.equal((await api(coraKeyGlobal(), 'POST', '/klassen', { name: 'Fremd' })).status, 403, 'ohne Schul-Zugang (LDAP)');
});

test('Lernfelder (SPA): Komponenten und Unterfächer sind sichtbar, beschreibbar, mit Leistungspunkten; das Lernfeld selbst verweist auf sie', async () => {
  const sj = db().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;
  await admin('/teacher/klassen/neu', { schuljahr_id: String(sj), name: '13SPA', notenschluessel: 'SPA', spa_bildungsgang: 'SPA_PIA', einschulung_jahr: '2025' });
  const spaId = db().prepare("SELECT id FROM klassen WHERE name = '13SPA'").get().id;
  const lf3 = db().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND spa_fach_key = 'LF3'").get(spaId);
  await admin(`/teacher/klassen/${spaId}/schueler/neu`, { nachname: 'Spa', vorname: 'Sina' });
  const sina = db().prepare("SELECT id FROM schueler WHERE nachname = 'Spa'").get().id;
  const komp = db().prepare('SELECT * FROM faecher WHERE parent_fach_id = ? ORDER BY id').all(lf3.id)[0];
  assert.ok(komp, 'Komponente vorhanden');
  const annaId = db().prepare("SELECT id FROM users WHERE username = 'anna'").get().id;
  db().prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)').run(annaId, komp.id); // Anna unterrichtet nur diese Komponente
  assert.ok(db().prepare('SELECT 1 FROM fach_teilnehmer WHERE fach_id = ? AND schueler_id = ?').get(komp.id, sina), 'Person nimmt an der Komponente teil');

  // Sichtbar mit Bezug zum Lernfeld
  const kl = (await api(leseKey, 'GET', '/klassen')).json.klassen.find((k) => k.id === spaId);
  const eintrag = kl.faecher.find((f) => f.id === komp.id);
  assert.equal(eintrag.art, 'komponente');
  assert.equal(eintrag.uebergeordnet.id, lf3.id);
  assert.ok(!kl.faecher.some((f) => f.id === lf3.id), 'das Lernfeld selbst ist Anna nicht zugeordnet');
  const f = await api(leseKey, 'GET', `/faecher/${komp.id}?halbjahr=1`);
  assert.equal(f.status, 200);
  assert.equal(f.json.fach.art, 'komponente');
  assert.equal(f.json.fach.uebergeordnet.name.length > 0, true);

  // Das Lernfeld ist lesbar (Zusammensetzung), nennt die Unterfächer, kann aber nicht beschrieben werden
  const lf = await api(leseKey, 'GET', `/faecher/${lf3.id}?halbjahr=1`);
  assert.equal(lf.status, 200);
  assert.equal(lf.json.fach.art, 'lernfeld');
  const kind = lf.json.unterfaecher.find((u) => u.id === komp.id);
  assert.equal(kind.zugriff, true);
  const schreibLf = await api(schreibKey, 'POST', `/faecher/${lf3.id}/klausuren`, { halbjahr: 1, name: 'LF-Klausur', max_punkte: [10] });
  assert.equal(schreibLf.status, 403, 'nicht dem Lernfeld zugeordnet');
  const adminKey = await neuerSchluessel(admin, 'Admin SPA', 'schreiben');
  const schreibAdmin = await api(adminKey, 'POST', `/faecher/${lf3.id}/klausuren`, { halbjahr: 1, name: 'LF-Klausur', max_punkte: [10] });
  assert.equal(schreibAdmin.status, 409);
  assert.ok(schreibAdmin.json.details.some((u) => u.id === komp.id), 'die Antwort nennt die Komponenten');

  // Eintragen in der Komponente: Klausur, Punkte, Leistungspunkte und Tendenz
  const k = await api(schreibKey, 'POST', `/faecher/${komp.id}/klausuren`, { halbjahr: 1, name: 'DV-Klausur', max_punkte: [10] });
  assert.equal(k.status, 200);
  const e = await api(schreibKey, 'PUT', `/klausuren/${k.json.klausur.id}/ergebnisse`, { ergebnisse: [{ schueler_id: sina, punkte: [10] }] });
  assert.equal(e.status, 200);
  const n = await api(leseKey, 'GET', `/faecher/${komp.id}/noten?halbjahr=1`);
  const sz = n.json.schueler.find((s) => s.id === sina);
  assert.equal(sz.klausuren[0].note, 1, 'SPA-Schlüssel: 100 % = Note 1');
  assert.equal(sz.leistungspunkte, 14);
  assert.equal(sz.tendenz, '1');
  // Das Lernfeld zeigt die Zusammensetzung
  const lfNoten = await api(leseKey, 'GET', `/faecher/${lf3.id}/noten?halbjahr=1`);
  assert.equal(lfNoten.status, 200);
});
