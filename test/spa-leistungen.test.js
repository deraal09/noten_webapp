/**
 * SPA: Klausuren und Unterrichtsleistung wie bei IHK. Die Leistungsnote
 * (Note 1-6, in Punkte umgerechnet) ersetzt den Punktwert des Halbjahres --
 * bzw. füttert bei Fächern mit Komponenten die gewählte Komponente --, solange
 * nichts von Hand eingetragen ist. Nur das Zeugnis nutzt das eigene
 * SPA-Bewertungssystem.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-spa-leistungen-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-spa-leistungen-test-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { spaTendenz } = await import('../src/spa-leistung.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });

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

const admin = client();
let klasseId, schuelerId, lf1Id, lf2Id;

async function klausurMitPunkten(fachId, halbjahr, punkte) {
  await form(admin, `/teacher/fach/${fachId}/klausuren/neu`, { name: `K ${halbjahr}`, aufgaben: '1', halbjahr });
  const kId = getDb().prepare('SELECT id FROM klausuren WHERE fach_id = ? AND halbjahr = ?').get(fachId, halbjahr).id;
  await form(admin, `/teacher/klausuren/${kId}/gewichtung`, { gewichtung: '100', halbjahr });
  await form(admin, `/teacher/klausuren/${kId}/maxpunkte`, { anzahl_aufgaben: '1', mp_0: '10', halbjahr });
  await admin(`/teacher/klausuren/${kId}/punkte`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ schueler_id: String(schuelerId), aufgabe_idx: '0', wert: String(punkte) }),
  });
  return kId;
}
const spaDaten = async (fachId, hj) => {
  const data = await (await admin(`/teacher/fach/${fachId}/spa/daten?hj=${hj}`)).json();
  return data.schueler.find((s) => s.schueler_id === schuelerId);
};

test('spaTendenz: Punkte 0-15 werden mit der SPA-Notenskala in Tendenznoten umgerechnet', () => {
  assert.equal(spaTendenz(15), '1+');
  assert.equal(spaTendenz(14), '1');
  assert.equal(spaTendenz(11), '2');
  assert.equal(spaTendenz(6), '4+');
  assert.equal(spaTendenz(5.6), '4+', 'es wird kaufmännisch auf ganze Punkte gerundet');
  assert.equal(spaTendenz(0), '6');
  assert.equal(spaTendenz(null), null);
});

test('Vorbereitung: SPA-Klasse, Person, LF1 Halbjahr 1 = 10 Punkte von Hand', async () => {
  let r = await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  assert.equal(r.status, 302);
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2026/27' });
  const sj = getDb().prepare('SELECT id FROM schuljahre').get();
  await form(admin, '/teacher/klassen/neu', {
    schuljahr_id: String(sj.id), name: '13SPA1', notenschluessel: 'SPA', spa_bildungsgang: 'SPA_PIA', offen_fuer_beitritt: '1',
  });
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '13SPA1'").get().id;
  lf1Id = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND spa_fach_key = 'LF1'").get(klasseId).id;
  lf2Id = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND spa_fach_key = 'LF2'").get(klasseId).id;
  await form(admin, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Musterfrau', vorname: 'Maxi' });
  schuelerId = getDb().prepare('SELECT id FROM schueler WHERE nachname = ?').get('Musterfrau').id;
  await form(admin, `/teacher/fach/${lf1Id}/spa/eingabe`, { schueler_id: String(schuelerId), halbjahr: '1', feld: 'direktwert', wert: '10' });
});

test('Klausuren lassen sich in allen vier Halbjahren eines SPA-Fachs anlegen (Halbjahr als Text)', async () => {
  await form(admin, `/teacher/fach/${lf1Id}/klausuren/neu`, { name: 'Klausur Hj 3', aufgaben: '1', halbjahr: '3. Halbjahr' });
  const k = getDb().prepare("SELECT halbjahr FROM klausuren WHERE fach_id = ? AND name = 'Klausur Hj 3'").get(lf1Id);
  assert.equal(k.halbjahr, '3. Halbjahr');
  getDb().prepare("DELETE FROM klausuren WHERE fach_id = ? AND name = 'Klausur Hj 3'").run(lf1Id);
});

test('Direkt-Fach (LF1): die Leistungspunkte aus der Klausur ersetzen den Punktwert (10/10 = 100 % -> 15 Punkte)', async () => {
  await klausurMitPunkten(lf1Id, '2. Halbjahr', 10);
  const daten = await spaDaten(lf1Id, 2);
  // LF1 2. Hj.: fortlaufend 50/50 aus 1. Hj. (10 von Hand) und 2. Hj. (15 aus der Klausur) = 12,5
  assert.equal(daten.endpunkte, 12.5);
  const html = await (await admin(`/teacher/klassen/${klasseId}/zeugnis?hj=2`)).text();
  assert.match(html, /12\.50/);
});

test('Ein von Hand eingetragener Punktwert hat Vorrang vor der Leistungsnote', async () => {
  await form(admin, `/teacher/fach/${lf1Id}/spa/eingabe`, { schueler_id: String(schuelerId), halbjahr: '2', feld: 'direktwert', wert: '12' });
  assert.equal((await spaDaten(lf1Id, 2)).endpunkte, 11, '0,5 * 10 + 0,5 * 12');
  await form(admin, `/teacher/fach/${lf1Id}/spa/eingabe`, { schueler_id: String(schuelerId), halbjahr: '2', feld: 'direktwert', wert: '' });
  assert.equal((await spaDaten(lf1Id, 2)).endpunkte, 12.5, 'ohne Handwert wieder die Leistungspunkte');
});

test('Leistungen-Seite eines SPA-Fachs: Klausuren/UL wie bei IHK, vier Halbjahre, Gesamtpunkte mit Tendenz, nur die passenden Reiter', async () => {
  const r = await admin(`/teacher/fach/${lf1Id}?ansicht=leistungen&hj=2`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Gesamtpunkte/);
  assert.match(html, /spa-tendenz-cell">1\+</, '15 Punkte = Tendenz 1+');
  assert.match(html, /data-target="panel-klausuren"/);
  assert.match(html, /data-target="panel-uls"/);
  assert.match(html, /4\. Halbjahr/);
  assert.doesNotMatch(html, /data-target="panel-manuell"/);
  assert.doesNotMatch(html, /data-target="panel-sync"/);
  assert.match(html, /Dieses Fach hat im 2\. Halbjahr einen einzelnen Punktwert/);

  // Die Redirects der Klausur-/UL-Aktionen (Text-Halbjahr) landen ebenfalls auf dieser Seite.
  const html2 = await (await admin(`/teacher/fach/${lf1Id}?hj=${encodeURIComponent('2. Halbjahr')}`)).text();
  assert.match(html2, /Gesamtpunkte/);
});

test('Halbe Punktzahl: 5/10 = 50 % -> 6 Punkte -> Tendenz 4+ (Punkteschlüssel, keine Umrechnung über Schulnoten)', async () => {
  await klausurMitPunkten(lf1Id, '3. Halbjahr', 5);
  const html = await (await admin(`/teacher/fach/${lf1Id}?ansicht=leistungen&hj=${encodeURIComponent('3. Halbjahr')}`)).text();
  assert.match(html, /gesamt-cell">6,0</);
  assert.match(html, /spa-tendenz-cell">4\+</);
});

test('SPA-Eingabemaske verlinkt auf die Leistungen und zeigt die Leistungsnote als Platzhalter', async () => {
  const html = await (await admin(`/teacher/fach/${lf1Id}?hj=2`)).text();
  assert.match(html, /\?ansicht=leistungen&(amp;)?hj=2/);
  assert.match(html, /placeholder="15"/);
});

test('Fach mit Komponenten (LF2): ohne gewählte Komponente keine Wirkung, mit Auswahl füttert die Leistungsnote sie', async () => {
  await klausurMitPunkten(lf2Id, '1. Halbjahr', 10);
  assert.equal((await spaDaten(lf2Id, 1)).zwischennote, null, 'ohne Ziel-Komponente bleibt LF2 unberührt');

  const html = await (await admin(`/teacher/fach/${lf2Id}?ansicht=leistungen&hj=1`)).text();
  assert.match(html, /Leistungsnote fließt in Komponente/);
  assert.match(html, /value="gesundheit"/);

  let r = await form(admin, `/teacher/fach/${lf2Id}/spa/leistung-ziel`, { halbjahr: '1', komponente: 'gesundheit' });
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare('SELECT komponente_schluessel FROM spa_leistung_ziele WHERE fach_id = ? AND halbjahr = 1').get(lf2Id).komponente_schluessel, 'gesundheit');
  assert.notEqual((await spaDaten(lf2Id, 1)).zwischennote, null, 'LF2: Gesundheit wird aus der Klausur gespeist');

  // Ungültige Komponente wird abgelehnt, die bisherige bleibt.
  await form(admin, `/teacher/fach/${lf2Id}/spa/leistung-ziel`, { halbjahr: '1', komponente: 'gibtesnicht' });
  assert.equal(getDb().prepare('SELECT komponente_schluessel FROM spa_leistung_ziele WHERE fach_id = ? AND halbjahr = 1').get(lf2Id).komponente_schluessel, 'gesundheit');

  // Von Hand eingetragener Komponentenwert hat Vorrang; leeres Ziel schaltet die Speisung ab.
  r = await form(admin, `/teacher/fach/${lf2Id}/spa/leistung-ziel`, { halbjahr: '1', komponente: '' });
  assert.equal(getDb().prepare('SELECT 1 FROM spa_leistung_ziele WHERE fach_id = ?').get(lf2Id), undefined);
  assert.equal((await spaDaten(lf2Id, 1)).zwischennote, null);
});

test('Zugriffsschutz: Lehrkraft ohne Zugriff darf die Ziel-Komponente nicht ändern', async () => {
  const fremd = client();
  await form(admin, '/admin/einladungen/neu', { display_name: 'Fremd', ttl_days: '14' });
  const inv = getDb().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
  await form(fremd, `/einladung/${inv.token}`, { username: 'fremd', display_name: 'Fremd', password: 'passwortF1', password2: 'passwortF1' });
  const r = await form(fremd, `/teacher/fach/${lf2Id}/spa/leistung-ziel`, { halbjahr: '1', komponente: 'gesundheit' });
  assert.equal(r.status, 403);
});

test.after(async () => {
  await fastify.close();
});
