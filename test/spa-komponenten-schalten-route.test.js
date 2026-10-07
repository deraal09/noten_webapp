/**
 * End-to-End-Test der SPA-Komponenten als vorgegebene Unterfächer: Sie stehen auf
 * der Klassenseite unter dem Lernfeld (Fächer und Lehrkräftezuordnung) und werden
 * dort halbjahresweise geschaltet (POST /teacher/faecher/:id/halbjahre): nur die
 * Klassenleitung darf schalten, nur schaltbare (Rest-Anteil-)Komponenten, und die
 * Eingabemaske zeigt/versteckt die Spalte je nach Aktiv-Status. Die Leistungspunkte
 * eines Komponenten-Unterfachs füttern die Komponente des Lernfelds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-spa-komponente-route-test-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-spa-komponente-route-test-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { ladeEingabeAnzeige } = await import('../src/spa-noten-service.js');
const { spaSchemaFuerFach } = await import('../src/spa-noten-service.js');
const { berechneZwischennote } = await import('../src/spa-grade-calc.js');
const { leistungsPunkte } = await import('../src/spa-leistung.js');
const { ladeVerrechnungFuerFach } = await import('../src/klassen-jahre.js');
const J_ladeFuerFach = (id) => ladeVerrechnungFuerFach(getDb().prepare('SELECT * FROM faecher WHERE id = ?').get(id));

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
  return req(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: (() => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) for (const w of Array.isArray(v) ? v : [v]) params.append(k, w);
      return params;
    })(),
  });
}

const admin = client();
const fachlehrkraft = client();
let klasseId;
let lf3Id;

test('Vorbereitung: SPA_REGULAR-Klasse (auto-geseedete Fächer, inkl. LF3), eine zugewiesene Fachlehrkraft ohne Klassenleitung', async () => {
  let r = await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  assert.equal(r.status, 302);
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2026/27' });
  const sj = getDb().prepare('SELECT id FROM schuljahre').get();

  r = await form(admin, '/teacher/klassen/neu', {
    schuljahr_id: String(sj.id), name: '13SPA1', notenschluessel: 'SPA', spa_bildungsgang: 'SPA_REGULAR', offen_fuer_beitritt: '1',
  });
  assert.equal(r.status, 302);
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '13SPA1'").get().id;
  lf3Id = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND spa_fach_key = 'LF3'").get(klasseId).id;
  await form(admin, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Musterfrau', vorname: 'Maxi' });

  await form(admin, '/admin/einladungen/neu', { display_name: 'Fachlehrkraft', ttl_days: '14' });
  const inv = getDb().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
  await form(fachlehrkraft, `/einladung/${inv.token}`, { username: 'fachlehrkraft', display_name: 'Fachlehrkraft', password: 'passwort123', password2: 'passwort123' });
  getDb().prepare('INSERT OR IGNORE INTO fach_zuweisungen (user_id, fach_id) VALUES ((SELECT id FROM users WHERE username = ?), ?)')
    .run('fachlehrkraft', lf3Id);
});

const komp = (schluessel) => getDb().prepare('SELECT * FROM faecher WHERE parent_fach_id = ? AND spa_komponente = ?').get(lf3Id, schluessel);

test('Klassenseite listet die Komponenten als vorgegebene Unterfächer unter dem Lernfeld (ohne Unterfach-Button, ohne Löschen)', async () => {
  const html = await (await admin(`/teacher/klassen/${klasseId}`)).text();
  assert.match(html, /Fächer und Lehrkräftezuordnung/);
  for (const k of ['kunst', 'musik', 'spiel', 'bewegung', 'paedagogik', 'bericht']) assert.ok(komp(k), `Unterfach ${k} wurde angelegt`);
  assert.ok(html.includes(`/teacher/fach/${komp('musik').id}`));
  assert.ok(!html.includes(`data-unterfach-dialog data-fach-id="${lf3Id}"`), 'SPA-Lernfelder bekommen keine freien Unterfächer');
  assert.ok(!html.includes(`/teacher/faecher/${komp('musik').id}/loeschen`), 'vorgegebene Komponenten lassen sich nicht löschen');
  // Lernfeld-Lehrkraft bleibt am Lernfeld selbst
  assert.ok(html.includes(`data-lehrkraft-dialog data-fach-id="${lf3Id}"`));
  const r = await form(admin, `/teacher/faecher/${komp('musik').id}/loeschen`, {});
  assert.equal(r.status, 302);
  assert.ok(komp('musik'), 'Löschen wird abgewiesen');
});

test('Fachlehrkraft ohne Klassenleitung darf keine Komponente schalten', async () => {
  const r = await form(fachlehrkraft, `/teacher/faecher/${komp('musik').id}/halbjahre`, { halbjahre: ['2', '3', '4'], zurueck: 'klasse' });
  assert.equal(r.status, 403);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM spa_deaktivierte_komponenten').get().c, 0);
});

test('Admin (zählt als Klassenleitung) schaltet Musik im 1. Hj. ab -- Eingabemaske verliert die Spalte', async () => {
  const r = await form(admin, `/teacher/faecher/${komp('musik').id}/halbjahre`, { halbjahre: ['2', '3', '4'], zurueck: 'klasse' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `/teacher/klassen/${klasseId}#faecher-lehrkraefte`);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM spa_deaktivierte_komponenten WHERE komponente_schluessel = ?').get('musik').c, 1);
  assert.equal(komp('musik').halbjahre, '[2,3,4]');

  const html = await (await admin(`/teacher/fach/${lf3Id}?ansicht=endnoten&hj=1`)).text();
  assert.ok(!html.includes('data-feld="komponente:musik"'), 'deaktivierte Komponente darf keine Eingabespalte mehr haben');
  assert.ok(html.includes('data-feld="komponente:kunst"'), 'andere Komponenten bleiben unverändert');
  const htmlHj2 = await (await admin(`/teacher/fach/${lf3Id}?ansicht=endnoten&hj=2`)).text();
  assert.ok(htmlHj2.includes('data-feld="komponente:musik"'), '2. Hj. ist von der Deaktivierung im 1. Hj. nicht betroffen');
  // Klassenseite zeigt die Halbjahre der Komponente
  const klassenHtml = await (await admin(`/teacher/klassen/${klasseId}`)).text();
  assert.match(klassenHtml, /Musik/);
});

test('Einfache Fachlehrkraft sieht den abgeschalteten Status informativ, ohne ihn ändern zu können', async () => {
  const html = await (await fachlehrkraft(`/teacher/fach/${lf3Id}?ansicht=endnoten&hj=1`)).text();
  assert.ok(html.includes('abgeschaltet'));
  assert.ok(!html.includes('/spa/komponente'));
});

test('Feste Komponente (Pädagogik) lässt sich nicht abschalten', async () => {
  const r = await form(admin, `/teacher/faecher/${komp('paedagogik').id}/halbjahre`, { halbjahre: ['2', '3', '4'], zurueck: 'klasse' });
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS c FROM spa_deaktivierte_komponenten WHERE komponente_schluessel = 'paedagogik'").get().c, 0);
});

test('Leistungspunkte eines Komponenten-Unterfachs füttern die Komponente des Lernfelds (Handeingabe hat Vorrang)', async () => {
  const kunst = komp('kunst');
  const schuelerId = getDb().prepare("SELECT id FROM schueler WHERE nachname = 'Musterfrau'").get().id;
  // Lehrkraft für das Unterfach Kunst
  await form(admin, `/teacher/klassen/${klasseId}/zuweisungen/neu`, {
    user_id: String(getDb().prepare("SELECT id FROM users WHERE username = 'fachlehrkraft'").get().id), fach_id: String(kunst.id), halbjahre: ['2'],
  });
  let page = await fachlehrkraft(`/teacher/fach/${kunst.id}?hj=${encodeURIComponent('2. Halbjahr')}`);
  assert.equal(page.status, 200);
  const text = await page.text();
  assert.match(text, /Komponente <strong>Kunst<\/strong>/);
  assert.equal((await fachlehrkraft(`/teacher/fach/${kunst.id}?hj=${encodeURIComponent('3. Halbjahr')}`)).status, 302, 'nur das zugeordnete Halbjahr');
  // Klausur im 2. Halbjahr
  await form(fachlehrkraft, `/teacher/fach/${kunst.id}/klausuren/neu`, { name: 'K', aufgaben: '1', halbjahr: '2. Halbjahr' });
  const k = getDb().prepare('SELECT id, max_punkte_pro_aufgabe FROM klausuren WHERE fach_id = ?').get(kunst.id);
  await form(fachlehrkraft, `/teacher/klausuren/${k.id}/gewichtung`, { gewichtung: '100', halbjahr: '2. Halbjahr' });
  await form(fachlehrkraft, `/teacher/klausuren/${k.id}/punkte`, { schueler_id: String(schuelerId), aufgabe_idx: '0', wert: String(JSON.parse(k.max_punkte_pro_aufgabe)[0]) });
  const db = getDb();
  const schemaHj = spaSchemaFuerFach(db, lf3Id).schema.find((x) => x.halbjahr === 2);
  const anzeige = ladeEingabeAnzeige(db, lf3Id, schuelerId, 2, schemaHj);
  assert.equal(anzeige.komponentenLeistung.kunst, 15, 'volle Punktzahl = 15 Punkte');
  assert.equal(anzeige.komponentenLeistung.spiel, null);
  assert.equal(anzeige.komponenten.kunst, null, 'die Leistung ist Platzhalter, kein Handwert');
  const lf3Html = await (await admin(`/teacher/fach/${lf3Id}?ansicht=endnoten&hj=2`)).text();
  assert.match(lf3Html, /placeholder="15"/);
});

test('Komponenten lassen sich komplett abwählen (kein Halbjahr) und wieder zuschalten; feste Gewichte werden hochgerechnet', async () => {
  for (const k of ['kunst', 'spiel', 'musik', 'bewegung']) {
    const r = await form(admin, `/teacher/faecher/${komp(k).id}/halbjahre`, { zurueck: 'klasse' });
    assert.equal(r.status, 302);
  }
  assert.equal(getDb().prepare("SELECT COUNT(*) AS c FROM spa_deaktivierte_komponenten WHERE komponente_schluessel IN ('kunst','spiel','musik','bewegung')").get().c, 16);
  const klassenHtml = await (await admin(`/teacher/klassen/${klasseId}`)).text();
  assert.ok((klassenHtml.match(/abgeschaltet/g) || []).length >= 4, 'Klassenseite zeigt die Komponenten als abgeschaltet');
  const html = await (await admin(`/teacher/fach/${lf3Id}?ansicht=endnoten&hj=1`)).text();
  for (const k of ['kunst', 'spiel', 'musik', 'bewegung']) assert.ok(!html.includes(`data-feld="komponente:${k}"`));
  assert.ok(html.includes('data-feld="komponente:paedagogik"'));
  // Nur Pädagogik (Gewicht 0,4) bleibt: 10 Punkte ergeben 10, nicht 4
  const schemaHj = spaSchemaFuerFach(getDb(), lf3Id).schema.find((x) => x.halbjahr === 1);
  assert.equal(berechneZwischennote(schemaHj, { halbjahr: 1, komponenten: { paedagogik: 10 } }), 10);
  // Wieder zuschalten
  await form(admin, `/teacher/faecher/${komp('kunst').id}/halbjahre`, { halbjahre: ['1', '2', '3', '4'], zurueck: 'klasse' });
  assert.equal(getDb().prepare("SELECT COUNT(*) AS c FROM spa_deaktivierte_komponenten WHERE komponente_schluessel = 'kunst'").get().c, 0);
  assert.ok((await (await admin(`/teacher/fach/${lf3Id}?ansicht=endnoten&hj=1`)).text()).includes('data-feld="komponente:kunst"'));
});

test('SPA: Verrechnung der Halbjahre je Fach auf der Fachseite (Leistungspunkte des Vorhalbjahres fließen ein)', async () => {
  const db = getDb();
  const lf1 = db.prepare("SELECT id FROM faecher WHERE klasse_id = ? AND spa_fach_key = 'LF1'").get(klasseId).id;
  const lf4 = db.prepare("SELECT id FROM faecher WHERE klasse_id = ? AND spa_fach_key = 'LF4'").get(klasseId).id;
  const schuelerId = db.prepare("SELECT id FROM schueler WHERE nachname = 'Musterfrau'").get().id;
  const klausur = async (hj, punkteAnteil) => {
    await form(admin, `/teacher/fach/${lf1}/klausuren/neu`, { name: `K${hj}`, aufgaben: '1', halbjahr: `${hj}. Halbjahr` });
    const k = db.prepare('SELECT id, max_punkte_pro_aufgabe FROM klausuren WHERE fach_id = ? AND halbjahr = ?').get(lf1, `${hj}. Halbjahr`);
    await form(admin, `/teacher/klausuren/${k.id}/gewichtung`, { gewichtung: '100', halbjahr: `${hj}. Halbjahr` });
    await form(admin, `/teacher/klausuren/${k.id}/punkte`, { schueler_id: String(schuelerId), aufgabe_idx: '0', wert: String(JSON.parse(k.max_punkte_pro_aufgabe)[0] * punkteAnteil) });
  };
  await klausur(1, 1);
  await klausur(2, 0.5);
  const ohne = leistungsPunkte(db, lf1, 2, schuelerId);
  assert.ok(ohne !== null && ohne < leistungsPunkte(db, lf1, 1, schuelerId));
  // Fachseite zeigt die Einstellung; Klassenleitung (Admin) kann sie ändern, Fachlehrkraft nicht
  const seite = await (await admin(`/teacher/fach/${lf1}?hj=1`)).text();
  assert.match(seite, /<details id="verrechnung" class="verrechnung-einstellung">/);
  assert.match(seite, new RegExp(`action="/teacher/faecher/${lf1}/verrechnung"`));
  assert.equal((await form(fachlehrkraft, `/teacher/faecher/${lf1}/verrechnung`, { p_1: '50' })).status, 403);
  const r = await form(admin, `/teacher/faecher/${lf1}/verrechnung`, { p_1: '50', halbjahr: '2. Halbjahr' });
  assert.equal(r.status, 302);
  assert.match(decodeURIComponent(r.headers.get('location')), new RegExp(`/teacher/fach/${lf1}\\?hj=2`));
  const punkte1 = leistungsPunkte(db, lf1, 1, schuelerId);
  const mit = leistungsPunkte(db, lf1, 2, schuelerId);
  assert.equal(mit, Math.round(((ohne + punkte1) / 2) * 100) / 100, '50 % Vorhalbjahr, 50 % Halbjahr');
  assert.match(await (await admin(`/teacher/fach/${lf1}?hj=2`)).text(), /1\. → 2\.: 50 %/);
  // Nur das Fach mit Einstellung ist betroffen; die Klassenseite führt SPA-Fächer nicht im Verrechnungs-Abschnitt
  assert.deepEqual(J_ladeFuerFach(lf4), {});
  const klassenHtml = await (await admin(`/teacher/klassen/${klasseId}`)).text();
  assert.ok(!klassenHtml.includes(`data-verrechnung-dialog data-fach-id="${lf1}"`));
});

test('SPA-Eingabemaske hat keine Altnote (importiert) mehr; das Feld wird nicht mehr angenommen', async () => {
  const html = await (await admin(`/teacher/fach/${lf3Id}?ansicht=endnoten&hj=1`)).text();
  assert.ok(!html.includes('Altnote'));
  assert.ok(!html.includes('importierte_endnote'));
  const schuelerId = getDb().prepare("SELECT id FROM schueler WHERE nachname = 'Musterfrau'").get().id;
  const r = await form(admin, `/teacher/fach/${lf3Id}/spa/eingabe`, { schueler_id: String(schuelerId), halbjahr: '1', feld: 'importierte_endnote', wert: '9' });
  assert.equal(r.status, 400);
});

test('Komponenten-Unterfach: direkte Eingabe der Gesamtpunkte ersetzt die berechneten Leistungspunkte und füttert die Komponente', async () => {
  const db = getDb();
  const kunst = komp('kunst');
  const schuelerId = db.prepare("SELECT id FROM schueler WHERE nachname = 'Musterfrau'").get().id;
  const html = await (await admin(`/teacher/fach/${kunst.id}?hj=${encodeURIComponent('2. Halbjahr')}`)).text();
  assert.match(html, /id="endnoten-direkt"/);
  assert.match(html, /Gesamtpunkte \(Direkteingabe\)/);
  const r = await form(admin, `/teacher/fach/${kunst.id}/endnote`, { schueler_id: String(schuelerId), halbjahr: '2. Halbjahr', wert: '11' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, note: 11, ntg: false });
  const schemaHj = spaSchemaFuerFach(db, lf3Id).schema.find((x) => x.halbjahr === 2);
  assert.equal(ladeEingabeAnzeige(db, lf3Id, schuelerId, 2, schemaHj).komponentenLeistung.kunst, 11, 'Direkteingabe vor der berechneten Leistung (15)');
  assert.equal((await form(admin, `/teacher/fach/${kunst.id}/endnote`, { schueler_id: String(schuelerId), halbjahr: '2. Halbjahr', wert: '16' })).status, 400, 'nur 0-15');
  await form(admin, `/teacher/fach/${kunst.id}/endnote`, { schueler_id: String(schuelerId), halbjahr: '2. Halbjahr', wert: '' });
  assert.equal(ladeEingabeAnzeige(db, lf3Id, schuelerId, 2, schemaHj).komponentenLeistung.kunst, 15, 'leer = wieder die berechneten Leistungspunkte');
});

test('Klassenleitung: SPA-Fächer stehen in der Direkteingabe; Gesamtpunkte gelten als Endpunkte des Halbjahres', async () => {
  const db = getDb();
  const schuelerId = db.prepare("SELECT id FROM schueler WHERE nachname = 'Musterfrau'").get().id;
  const html = await (await admin(`/klassenlehrer/klasse/${klasseId}?tab=endnoten&hj=${encodeURIComponent('1. Halbjahr')}`)).text();
  assert.match(html, /<table class="data" id="endnoten-raster">/);
  assert.ok(html.includes(`data-fach="${lf3Id}"`), 'LF3 (SPA) hat eine Eingabezelle');
  // (Die Klassenleitungs-Route gilt nur für vergangene Halbjahre; diese Klasse liegt in der Zukunft -- gleiche Speicherung über die Fach-Route.)
  const r = await form(admin, `/teacher/fach/${lf3Id}/endnote`, { schueler_id: String(schuelerId), halbjahr: '1. Halbjahr', wert: '9' });
  assert.equal(r.status, 200);
  const { berechneFachFuerSchueler } = await import('../src/spa-noten-service.js');
  assert.equal(berechneFachFuerSchueler(db, lf3Id, schuelerId).find((e) => e.halbjahr === 1).endpunkte, 9);
  assert.notEqual(berechneFachFuerSchueler(db, lf3Id, schuelerId, { ohneDirekteingabe: true }).find((e) => e.halbjahr === 1).endpunkte, 9);
  await form(admin, `/teacher/fach/${lf3Id}/endnote`, { schueler_id: String(schuelerId), halbjahr: '1. Halbjahr', wert: '' });
});

test('Klassenleitung: Halbjahres-Reiter bleiben im gewählten Menü (Link-Anpassung per Skript)', async () => {
  const html = await (await admin(`/klassenlehrer/klasse/${klasseId}?tab=endnoten`)).text();
  assert.match(html, /class="hj-tab[^"]*" href="\?hj=[^"]*&tab=endnoten"/);
  assert.match(html, /a\.href = a\.href\.replace\(\/\(\[\?&\]\)tab=\[\^&\]\*\//, 'Skript hält den Menü-Namen in den Halbjahres-Links aktuell');
});

test.after(async () => {
  await fastify.close();
});
