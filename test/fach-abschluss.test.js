/**
 * Fachabschluss (optional): berechnet je Schüler/in eine Fachabschlussnote
 * als Mittelwert aus allen Halbjahren, in denen das Fach gilt -- berechnet
 * aus Klausuren/Unterrichtsleistung oder direkt als Endnote eingetragen. Die
 * dem Fach zugewiesenen Lehrkräfte tragen/korrigieren die Endnoten.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-abschluss-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-abschluss-test-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { HALBJAHRE } = await import('../src/grade-calc.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
const HJ1 = HALBJAHRE[0];
const HJ2 = HALBJAHRE[1];

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
    body: new URLSearchParams(body),
  });
}

const admin = client();
const lehrerA = client();
const lehrerC = client();
let sjId, klasseId, fachId, s1, s2;

test('Vorbereitung: Klasse, Fach, zwei Schüler/innen, Klausur mit Noten in beiden Halbjahren', async () => {
  let r = await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
  });
  assert.equal(r.status, 302);
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;

  for (const name of ['Lehrer A', 'Lehrer C']) {
    await form(admin, '/admin/einladungen/neu', { display_name: name, ttl_days: '14' });
  }
  const invs = getDb().prepare('SELECT token FROM invitations ORDER BY id').all();
  await form(lehrerA, `/einladung/${invs[0].token}`, {
    username: 'lehrera', display_name: 'Lehrer A', password: 'passwortA1', password2: 'passwortA1',
  });
  await form(lehrerC, `/einladung/${invs[1].token}`, {
    username: 'lehrerc', display_name: 'Lehrer C', password: 'passwortC1', password2: 'passwortC1',
  });
  getDb().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'lehrera'").run();

  await form(lehrerA, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '11A', notenschluessel: 'IHK' });
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '11A'").get().id;
  await form(lehrerA, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
  await form(lehrerA, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Berger', vorname: 'Ben' });
  const schueler = getDb().prepare('SELECT id FROM schueler WHERE klasse_id = ? ORDER BY nachname').all(klasseId);
  s1 = schueler[0].id;
  s2 = schueler[1].id;

  await form(lehrerA, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Physik' });
  fachId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Physik'").get(klasseId).id;

  // s1 bekommt in beiden Halbjahren eine (sehr gute) Klausurnote, s2 nur im 1. Halbjahr.
  for (const hj of [HJ1, HJ2]) {
    await form(lehrerA, `/teacher/fach/${fachId}/klausuren/neu`, { name: 'K ' + hj, aufgaben: '1', halbjahr: hj });
    const kId = getDb().prepare('SELECT id FROM klausuren WHERE fach_id = ? AND halbjahr = ?').get(fachId, hj).id;
    await form(lehrerA, `/teacher/klausuren/${kId}/gewichtung`, { gewichtung: '100', halbjahr: hj });
    await form(lehrerA, `/teacher/klausuren/${kId}/maxpunkte`, { anzahl_aufgaben: '1', mp_0: '10', halbjahr: hj });
    await lehrerA(`/teacher/klausuren/${kId}/punkte`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ schueler_id: String(s1), aufgabe_idx: '0', wert: '10' }),
    });
    if (hj === HJ1) {
      await lehrerA(`/teacher/klausuren/${kId}/punkte`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ schueler_id: String(s2), aufgabe_idx: '0', wert: '10' }),
      });
    }
  }
});

test('Direkte Endnote (3. Halbjahr): zugewiesene Lehrkraft darf sie eintragen, ohne Zuweisung/Klassenleitung kein Zugriff', async () => {
  const HJ3 = '3. Halbjahr';
  const endnote = (client, sid, wert) => client(`/teacher/fach/${fachId}/endnote`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ schueler_id: String(sid), halbjahr: HJ3, wert }),
  });
  // Lehrer C ist noch niemandem zugewiesen und keine Klassenleitung -> kein Zugriff.
  let r = await endnote(lehrerC, s1, '2');
  assert.equal(r.status, 403);

  // Lehrer A ist dem Fach als Ersteller/in zugewiesen -> darf direkte Endnoten eintragen.
  r = await endnote(lehrerA, s1, '2');
  assert.equal(r.status, 200);

  // Für die Zuweisung weiterer Lehrkräfte (unten) muss Lehrer A Klassenleitung sein.
  await form(lehrerA, `/teacher/klassen/${klasseId}/klassenlehrer/eintragen`, {});

  // Lehrer C ist immer noch nicht zugewiesen -> darf nichts ändern.
  r = await endnote(lehrerC, s2, '4');
  assert.equal(r.status, 403);

  // Erst nach Zuweisung darf Lehrer C die Endnoten pflegen.
  await form(lehrerA, `/teacher/klassen/${klasseId}/zuweisungen/neu`, {
    user_id: String(getDb().prepare('SELECT id FROM users WHERE username = ?').get('lehrerc').id),
    fach_id: String(fachId),
  });
  r = await endnote(lehrerC, s2, '4');
  assert.equal(r.status, 200);
  const noten = getDb().prepare("SELECT schueler_id, note FROM halbjahr_endnoten WHERE fach_id = ? AND halbjahr = '3. Halbjahr'").all(fachId);
  assert.equal(noten.find((n) => n.schueler_id === s1).note, 2);
  assert.equal(noten.find((n) => n.schueler_id === s2).note, 4);
});

test('Abschluss ergibt sich aus den Halbjahren (kein Button mehr): Fachabschlussnote = Mittelwert aus allen Halbjahren (berechnet + direkte Endnote)', async () => {
  const fach = getDb().prepare('SELECT * FROM faecher WHERE id = ?').get(fachId);
  const { istFachAbgeschlossen } = await import('../src/klassen-jahre.js');
  const { ladeAbschlussnoten } = await import('../src/fach-abschluss.js');
  const laufzeit = (await import('../src/klassen-jahre.js')).klassenLaufzeit(fach.klasse_id);
  const letztes = laufzeit.anzahlHalbjahre;
  // Das Fach gilt in allen Halbjahren der Klasse -- das letzte liegt (noch) nicht hinter uns.
  assert.equal(istFachAbgeschlossen(fach), istFachAbgeschlossen({ ...fach, halbjahre: null }));
  assert.ok(letztes >= 3);

  const noten = ladeAbschlussnoten(fach);
  // s1: HJ1=sehr gut (10/10 -> 1), HJ2=sehr gut (10/10 -> 1), 3. Halbjahr=2 -> Mittelwert ≈ 1,33
  assert.ok(noten.get(s1) > 1 && noten.get(s1) < 1.5, `erwartet ~1,33, war ${noten.get(s1)}`);
  // s2: HJ1=sehr gut (1), HJ2=keine Note (ignoriert), 3. Halbjahr=4 -> Mittelwert = 2,5
  assert.equal(noten.get(s2), 2.5);

  // Keine Schaltflächen/Routen zum Abschließen mehr
  const html = await (await lehrerA(`/teacher/fach/${fachId}`)).text();
  assert.doesNotMatch(html, /Fach abschließen|panel-abschluss/);
  assert.equal((await form(lehrerA, `/teacher/fach/${fachId}/abschliessen`, {})).status, 404);
});

test.after(async () => {
  await fastify.close();
});
