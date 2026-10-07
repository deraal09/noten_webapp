/**
 * Verrechnung der Halbjahresnoten: Prozentsatz der Vorhalbjahres-Note, der in
 * das nächste Halbjahr einfließt (Einstellung je Klasse und Übergang).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-verrechnung-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-verrechnung-test-bitte-lang-genug-xx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const J = await import('../src/klassen-jahre.js');
const { berechneGesamtnoten, berechneRohnoten } = await import('../src/noten-service.js');
const { syncFach } = await import('../src/noten-sync.js');

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
const enc = encodeURIComponent;
const HJ = (n) => `${n}. Halbjahr`;
const fachRow = (id = fachId) => getDb().prepare('SELECT * FROM faecher WHERE id = ?').get(id);
const verrechnung = (req, werte, id = fachId) => req(`/teacher/faecher/${id}/verrechnung`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(werte),
});
const endnote = (sid, wert, hj) => admin(`/teacher/fach/${fachId}/endnote`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ schueler_id: String(sid), halbjahr: hj, wert }),
});
const klausurMitPunkten = async (hj, punkte) => {
  await form(admin, `/teacher/fach/${fachId}/klausuren/neu`, { name: `K-${hj}`, aufgaben: '1', halbjahr: hj });
  const k = getDb().prepare('SELECT id FROM klausuren WHERE fach_id = ? AND halbjahr = ?').get(fachId, hj).id;
  await form(admin, `/teacher/klausuren/${k}/gewichtung`, { gewichtung: '100', halbjahr: hj });
  await form(admin, `/teacher/klausuren/${k}/maxpunkte`, { anzahl_aufgaben: '1', mp_0: '10', halbjahr: hj });
  await form(admin, `/teacher/klausuren/${k}/punkte`, { schueler_id: String(annaId), aufgabe_idx: '0', wert: String(punkte) });
};

test('Vorbereitung: IHK-Klasse (6 Halbjahre), Fach, zwei Personen, Klausuren in Halbjahr 2 und 3 für Anna', async () => {
  await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sj = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;
  await form(admin, '/admin/einladungen/neu', { display_name: 'Fremd', ttl_days: '14' });
  const inv = getDb().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
  await form(fremd, `/einladung/${inv.token}`, { username: 'fremd', display_name: 'Fremd', password: 'passwortF1', password2: 'passwortF1' });
  await form(admin, '/teacher/klassen/neu', { schuljahr_id: String(sj), name: '11A', notenschluessel: 'IHK' });
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '11A'").get().id;
  await form(admin, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Englisch' });
  fachId = getDb().prepare('SELECT id FROM faecher WHERE klasse_id = ?').get(klasseId).id;
  await form(admin, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
  await form(admin, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Berger', vorname: 'Berta' });
  annaId = getDb().prepare("SELECT id FROM schueler WHERE nachname = 'Adler'").get().id;
  bertaId = getDb().prepare("SELECT id FROM schueler WHERE nachname = 'Berger'").get().id;
  await klausurMitPunkten(HJ(2), 5);
  await klausurMitPunkten(HJ(3), 2);
  await klausurMitPunkten(HJ(1), 10);
});

test('wendeVerrechnungAn: Mischung, ohne Vorwert/Aktuell unverändert', () => {
  assert.equal(J.wendeVerrechnungAn(3, 1, 50), 2);
  assert.equal(J.wendeVerrechnungAn(4, 2, 25), 3.5);
  assert.equal(J.wendeVerrechnungAn(3.33, 2.01, 50), 2.67);
  assert.equal(J.wendeVerrechnungAn(3, null, 50), 3, 'ohne Vorhalbjahr unverändert');
  assert.equal(J.wendeVerrechnungAn(null, 2, 50), null, 'ohne aktuelle Note keine Note');
  assert.equal(J.wendeVerrechnungAn(3, 1, 0), 3);
});

test('Ohne Einstellung gibt es keine Verrechnung', () => {
  assert.deepEqual(J.ladeVerrechnung(klasseId), {});
  assert.deepEqual(J.ladeVerrechnungFuerFach(fachRow()), {});
  assert.equal(J.verrechnungsProzent(klasseId, HJ(2), fachRow()), 0);
});

test('Einstellung je Fach speichern (nur Klassenleitung), Ungültiges wird abgelehnt', async () => {
  let r = await verrechnung(admin, { p_1: '50', p_2: '0', p_3: '' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `/teacher/klassen/${klasseId}#verrechnung`);
  assert.deepEqual(J.ladeVerrechnungFuerFach(fachRow()), { 1: 50 });
  assert.equal(J.verrechnungsProzent(klasseId, HJ(2), fachRow()), 50);
  assert.equal(J.verrechnungsProzent(klasseId, HJ(3), fachRow()), 0);
  assert.equal(J.verrechnungsProzent(klasseId, HJ(1), fachRow()), 0, 'das 1. Halbjahr hat kein Vorhalbjahr');
  assert.deepEqual(J.ladeVerrechnung(klasseId), {}, 'die Klassen-Vorgabe bleibt unberührt');
  await verrechnung(admin, { p_1: '150' });
  assert.deepEqual(J.ladeVerrechnungFuerFach(fachRow()), { 1: 50 }, 'ungültig -> unverändert');
  r = await verrechnung(fremd, { p_1: '10' });
  assert.equal(r.status, 403);
  assert.deepEqual(J.ladeVerrechnungFuerFach(fachRow()), { 1: 50 });
});

test('Klassenseite: einklappbare Verrechnung oberhalb der Fächer mit Dialog je Fach; nicht mehr auf der Klassenleitungs-Seite', async () => {
  const html = await (await admin(`/teacher/klassen/${klasseId}`)).text();
  assert.match(html, /<details class="card" id="verrechnung">\s*<summary>Verrechnung der Halbjahre<\/summary>/);
  assert.match(html, /<dialog id="verrechnung-dialog"/);
  assert.match(html, new RegExp(`data-verrechnung-dialog data-fach-id="${fachId}"`));
  assert.match(html, /1\. → 2\.: 50 %/);
  assert.ok(html.indexOf('id="verrechnung"') < html.indexOf('class="faecher-baum"'), 'oberhalb der Fächer');
  const kl = await (await admin(`/klassenlehrer/klasse/${klasseId}?tab=klassenleitung`)).text();
  assert.doesNotMatch(kl, /Verrechnung der Halbjahre/);
  assert.doesNotMatch(kl, /Laufzeit der Klasse/);
});

test('Unterfächer und SPA-Fächer haben keine Verrechnung; "für alle Fächer" und Klassen-Vorgabe', async () => {
  await form(admin, `/teacher/faecher/${fachId}/unterfaecher`, { name: 'Grammatik', halbjahre: ['5', '6'] });
  const kind = getDb().prepare('SELECT id FROM faecher WHERE parent_fach_id = ?').get(fachId).id;
  const r = await verrechnung(admin, { p_1: '30' }, kind);
  assert.equal(r.status, 302);
  assert.equal(fachRow(kind).verrechnung, null, 'Unterfach bleibt ohne eigene Einstellung');
  assert.deepEqual(J.ladeVerrechnungFuerFach(fachRow(kind)), {});
  assert.equal((await (await admin(`/teacher/klassen/${klasseId}`)).text()).includes(`data-verrechnung-dialog data-fach-id="${kind}"`), false);
  getDb().prepare('DELETE FROM faecher WHERE id = ?').run(kind);
  // Klassen-Vorgabe gilt für Fächer ohne eigene Einstellung
  await form(admin, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Deutsch' });
  const deutsch = getDb().prepare("SELECT id FROM faecher WHERE name = 'Deutsch'").get().id;
  getDb().prepare('UPDATE klassen SET verrechnung = ? WHERE id = ?').run(JSON.stringify({ 2: 20 }), klasseId);
  assert.equal(J.verrechnungsProzent(klasseId, HJ(3), fachRow(deutsch)), 20);
  assert.equal(J.verrechnungsProzent(klasseId, HJ(3), fachRow()), 0, 'das Fach mit eigener Einstellung ignoriert die Vorgabe');
  // Für alle Fächer übernehmen
  await verrechnung(admin, { p_1: '10', p_2: '40', fuer_alle: '1' }, deutsch);
  assert.deepEqual(J.ladeVerrechnungFuerFach(fachRow(deutsch)), { 1: 10, 2: 40 });
  assert.deepEqual(J.ladeVerrechnungFuerFach(fachRow()), { 1: 10, 2: 40 });
  getDb().prepare('UPDATE klassen SET verrechnung = NULL WHERE id = ?').run(klasseId);
  await verrechnung(admin, { p_1: '50', p_2: '0' });
  await verrechnung(admin, { p_1: '50', p_2: '0' }, deutsch);
  getDb().prepare('DELETE FROM faecher WHERE id = ?').run(deutsch);
});

test('Halbjahr 2 besteht zu 50 % aus der Note des Halbjahres 1', async () => {
  const note1 = berechneGesamtnoten(fachId, HJ(1)).get(annaId);
  const roh2 = berechneRohnoten(fachId, HJ(2)).get(annaId);
  assert.notEqual(note1, null);
  assert.notEqual(roh2, null);
  const erwartet = Math.round((0.5 * roh2 + 0.5 * note1) * 100) / 100;
  assert.equal(berechneGesamtnoten(fachId, HJ(2)).get(annaId), erwartet);
  assert.notEqual(erwartet, roh2, 'die Verrechnung ändert die Note');
  const daten = await (await admin(`/teacher/fach/${fachId}/noten?hj=${enc(HJ(2))}`)).json();
  const zeile = daten.schueler.find((s) => s.schueler_id === annaId);
  assert.equal(zeile.gesamt, erwartet);
  assert.equal(zeile.gesamtOhneVerrechnung, roh2);
  assert.equal(zeile.vorhalbjahrNote, note1);
  assert.equal(zeile.gesamtBerechnet, erwartet);
});

test('Ohne eigene Note im Halbjahr 2 kommt nichts zustande (Berta), Halbjahr 3 bleibt unverrechnet (0 %)', async () => {
  assert.equal(berechneGesamtnoten(fachId, HJ(2)).get(bertaId) ?? null, null);
  assert.equal(berechneGesamtnoten(fachId, HJ(3)).get(annaId), berechneRohnoten(fachId, HJ(3)).get(annaId));
});

test('Kette: bei 100 % im Übergang 2 -> 3 zählt die endgültige Note des Halbjahres 2 (samt deren Verrechnung/Endnote)', async () => {
  await verrechnung(admin, { p_1: '50', p_2: '100' });
  const hj2 = berechneGesamtnoten(fachId, HJ(2)).get(annaId);
  assert.equal(berechneGesamtnoten(fachId, HJ(3)).get(annaId), hj2, '100 % Vorhalbjahr');
  // Direkte Endnote im Halbjahr 2 ersetzt dessen Wert -- und damit auch den Vorwert für Halbjahr 3
  const r = await endnote(annaId, '4', HJ(2));
  assert.equal((await r.json()).note, 4);
  assert.equal(berechneGesamtnoten(fachId, HJ(2)).get(annaId), 4);
  assert.equal(berechneGesamtnoten(fachId, HJ(3)).get(annaId), 4);
  await endnote(annaId, '', HJ(2));
});

test('Fachseite zeigt die Spalte Vorhalbjahr nur bei aktiver Verrechnung', async () => {
  const mit = await (await admin(`/teacher/fach/${fachId}?hj=${enc(HJ(2))}`)).text();
  assert.match(mit, /Vorhalbjahr <small>\(50 %\)<\/small>/);
  assert.match(mit, /class="note-cell vorhalbjahr-zelle"/);
  const ohne = await (await admin(`/teacher/fach/${fachId}?hj=${enc(HJ(1))}`)).text();
  assert.doesNotMatch(ohne, /vorhalbjahr-zelle/);
});

test('Sync: Änderung im Halbjahr 1 aktualisiert den bereits synchronisierten Stand des Halbjahres 2', async () => {
  await verrechnung(admin, { p_1: '50', p_2: '0' });
  const userId = getDb().prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  syncFach(fachId, HJ(1), userId);
  syncFach(fachId, HJ(2), userId);
  const stand2 = () => getDb().prepare('SELECT note FROM fach_sync_stand WHERE fach_id = ? AND halbjahr = ? AND schueler_id = ?').get(fachId, HJ(2), annaId).note;
  const vorher = stand2();
  await endnote(annaId, '6', HJ(1));
  syncFach(fachId, HJ(1), userId);
  assert.notEqual(stand2(), vorher, 'Halbjahr 2 wurde mit aktualisiert');
  assert.equal(stand2(), berechneGesamtnoten(fachId, HJ(2)).get(annaId));
});

test.after(async () => {
  await fastify.close();
});
