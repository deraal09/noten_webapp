/**
 * Klausur: optionale Extrapunkte je Person (Prozentwert darf über 100 liegen) und eine Notiz je Klausur.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-extrapunkte-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-extrapunkte-bitte-lang-genug-xxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const G = await import('../src/grade-calc.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
const HJ = G.HALBJAHRE[0];
const csv = G.DEFAULT_NS_CSV.IHK;

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
let fachId, klausurId, s1, s2;

const noten = async () => (await (await admin(`/teacher/fach/${fachId}/noten?hj=${encodeURIComponent(HJ)}`)).json()).schueler;
const klausurZeile = async (sid) => (await noten()).find((s) => s.schueler_id === sid).klausuren[0];
const punkte = (sid, wert, idx = 0) => admin(`/teacher/klausuren/${klausurId}/punkte`, { schueler_id: String(sid), aufgabe_idx: String(idx), wert: String(wert) });
const extra = (sid, wert, client_ = admin) => client_(`/teacher/klausuren/${klausurId}/extrapunkte`, { schueler_id: String(sid), wert: String(wert) });

test('Rechenkern: Extrapunkte zählen zu den Punkten, über 100 % bleibt die beste Note', () => {
  assert.equal(G.noteAusPunkten([8], [10], csv), 2.5, '80 %');
  assert.equal(G.noteAusPunkten([8], [10], csv, 1), 1.6, '90 % mit 1 Extrapunkt');
  assert.equal(G.noteAusPunkten([10], [10], csv, 3), 1, '130 % = beste Note');
  assert.equal(G.klausurProzent([10], [10], 0.5), 105);
  assert.equal(G.klausurProzent([10], [10]), 100);
  assert.equal(G.klausurProzent([null], [10], 2), null, 'ohne vollständige Punkte kein Prozentwert');
  assert.equal(G.noteAusPunkten([null], [10], csv, 5), null, 'Extrapunkte allein ergeben keine Note');
  assert.equal(G.noteAusPunkten([8], [10], csv, -3), 2.5, 'negative Extrapunkte zählen nicht');
  const teile = { teile: [{ name: 'A', aufgaben: 1, gewichtung: 50 }, { name: 'B', aufgaben: 1, gewichtung: 50 }], bestimmend: null };
  assert.equal(G.klausurNote([5, 5], [10, 10], teile, csv, 10), G.klausurNote([5, 5], [10, 10], teile, csv), 'mehrteilige Klausuren ignorieren Extrapunkte');
});

test('Vorbereitung: Klasse, Fach, zwei Schüler/innen, Klausur mit einer Aufgabe (10 Punkte)', async () => {
  await admin('/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await admin('/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sj = db().prepare('SELECT id FROM schuljahre').get().id;
  await admin('/admin/einladungen/neu', { display_name: 'fremd', ttl_days: '14' });
  const inv = db().prepare('SELECT token FROM invitations').get();
  await fremd(`/einladung/${inv.token}`, { username: 'fremd', display_name: 'fremd', password: 'passwort123', password2: 'passwort123' });
  await admin('/teacher/klassen/neu', { schuljahr_id: String(sj), name: '11A', notenschluessel: 'IHK' });
  const k = db().prepare('SELECT id FROM klassen').get().id;
  await admin(`/teacher/klassen/${k}/faecher/neu`, { name: 'Physik' });
  fachId = db().prepare('SELECT id FROM faecher').get().id;
  await admin(`/teacher/klassen/${k}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
  await admin(`/teacher/klassen/${k}/schueler/neu`, { nachname: 'Berger', vorname: 'Ben' });
  [s1, s2] = db().prepare('SELECT id FROM schueler ORDER BY nachname').all().map((r) => r.id);
  await admin(`/teacher/fach/${fachId}/klausuren/neu`, { name: 'K1', aufgaben: '1', halbjahr: HJ });
  klausurId = db().prepare('SELECT id FROM klausuren').get().id;
  await admin(`/teacher/klausuren/${klausurId}/gewichtung`, { gewichtung: '100', halbjahr: HJ });
  await admin(`/teacher/klausuren/${klausurId}/maxpunkte`, { anzahl_aufgaben: '1', mp_0: '10', halbjahr: HJ });
  await punkte(s1, 8);
});

test('Extrapunkte verbessern die Note und werden mit Prozentwert angezeigt; leer/0 entfernt sie wieder', async () => {
  assert.equal((await klausurZeile(s1)).note, 2.5);
  let r = await extra(s1, '1,5');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).wert, 1.5);
  let z = await klausurZeile(s1);
  assert.equal(z.extrapunkte, 1.5);
  assert.equal(z.note, 1.3, '8 + 1,5 = 9,5 von 10 = 95 %');
  const seite = async () => (await admin(`/teacher/fach/${fachId}?hj=${encodeURIComponent(HJ)}`)).text();
  let html = await seite();
  assert.match(html, /<th class="extra-head"[^>]*>Extra<\/th>/);
  assert.match(html, new RegExp(`class="extrapunkt" data-kid="${klausurId}" data-sid="${s1}"[^>]*value="1.5"`));
  assert.match(html, /9\.5 \/ 10 <small>\(95 %\)<\/small>/);
  // über 100 %: Prozentwert steigt, die Note bleibt die beste
  await punkte(s1, 10);
  await extra(s1, '2');
  z = await klausurZeile(s1);
  assert.equal(z.note, 1);
  assert.match(await seite(), /12 \/ 10 <small>\(120 %\)<\/small>/);
  // entfernen
  assert.equal((await extra(s1, '')).status, 200);
  z = await klausurZeile(s1);
  assert.equal(z.extrapunkte, null);
  assert.equal(z.note, 1);
  await punkte(s1, 8);
  await extra(s1, '1');
  assert.equal((await extra(s1, '0')).status, 200);
  assert.equal((await klausurZeile(s1)).note, 2.5);
  assert.equal(db().prepare('SELECT extrapunkte FROM klausur_ergebnisse WHERE schueler_id = ?').get(s1).extrapunkte, null);
});

test('Extrapunkte allein ergeben keine Note; ungültige Werte und fehlende Rechte werden abgewiesen', async () => {
  assert.equal((await extra(s2, '3')).status, 200);
  const z = await klausurZeile(s2);
  assert.equal(z.extrapunkte, 3);
  assert.equal(z.note, null, 'ohne Aufgabenpunkte keine Note');
  assert.equal((await extra(s2, '')).status, 200);
  for (const wert of ['-1', 'abc', '11']) {
    const r = await extra(s2, wert);
    assert.equal(r.status, 400, wert);
    assert.match((await r.json()).error, /Extrapunkte/);
  }
  assert.equal((await extra(s1, '1', fremd)).status, 403, 'Lehrkraft ohne Zugriff auf das Fach');
  assert.equal((await klausurZeile(s1)).extrapunkte, null);
  assert.equal((await admin('/teacher/klausuren/9999/extrapunkte', { schueler_id: String(s1), wert: '1' })).status, 404);
});

test('Mehrteilige Klausur: keine Extrapunkte-Spalte, Eingabe wird abgelehnt', async () => {
  await admin(`/teacher/fach/${fachId}/klausuren/neu`, { name: 'K2', aufgaben: '2', halbjahr: HJ });
  const k2 = db().prepare("SELECT id FROM klausuren WHERE name = 'K2'").get().id;
  db().prepare('UPDATE klausuren SET teile = ? WHERE id = ?').run(JSON.stringify({ teile: [{ name: 'A', aufgaben: 1, gewichtung: 50 }, { name: 'B', aufgaben: 1, gewichtung: 50 }], bestimmend: null }), k2);
  const html = await (await admin(`/teacher/fach/${fachId}?hj=${encodeURIComponent(HJ)}`)).text();
  const panel = html.slice(html.indexOf(`id="klausur-panel-${k2}"`));
  assert.doesNotMatch(panel.slice(0, panel.indexOf('klausur-notiz-label')), /class="extrapunkt"/);
  const r = await admin(`/teacher/klausuren/${k2}/extrapunkte`, { schueler_id: String(s1), wert: '1' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /einteiligen/);
});

test('Notiz je Klausur: Textfeld unter der Schülertabelle, speichern, HTML-sicher, Längenlimit, Rechte', async () => {
  const seite = async () => (await admin(`/teacher/fach/${fachId}?hj=${encodeURIComponent(HJ)}`)).text();
  let html = await seite();
  assert.equal((html.match(/<textarea class="klausur-notiz"/g) || []).length, 2, 'je Klausur ein Feld');
  const text = 'Aufgabe 3 war zu schwer\n<script>alert(1)</script> & Co.';
  let r = await admin(`/teacher/klausuren/${klausurId}/notiz`, { text });
  assert.equal(r.status, 200);
  assert.equal(db().prepare('SELECT notiz FROM klausuren WHERE id = ?').get(klausurId).notiz, text);
  html = await seite();
  assert.match(html, /Aufgabe 3 war zu schwer\n&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; Co\./);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  const panel = html.slice(html.indexOf(`id="klausur-panel-${klausurId}"`));
  assert.ok(panel.indexOf('</table>') < panel.indexOf('class="klausur-notiz"'), 'Notiz steht unter der Tabelle');
  r = await admin(`/teacher/klausuren/${klausurId}/notiz`, { text: 'x'.repeat(5001) });
  assert.equal(r.status, 400);
  assert.equal((await fremd(`/teacher/klausuren/${klausurId}/notiz`, { text: 'fremd' })).status, 403);
  assert.equal(db().prepare('SELECT notiz FROM klausuren WHERE id = ?').get(klausurId).notiz, text);
  assert.equal((await admin('/teacher/klausuren/9999/notiz', { text: 'x' })).status, 404);
  assert.equal((await admin(`/teacher/klausuren/${klausurId}/notiz`, { text: '' })).status, 200, 'leeren ist erlaubt');
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
