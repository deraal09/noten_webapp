/**
 * Notensperre: nach der Notenkonferenz kann die Klassenleitung die Noten
 * einer/eines Schüler:in klassenweit für ein Halbjahr sperren — betroffene
 * Fachlehrkräfte können dann keine Punkte/Noten mehr eintragen, aber eine
 * Aufhebung anfragen statt selbst zu entsperren.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-sperre-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-sperre-test-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { HALBJAHRE } = await import('../src/grade-calc.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
const HJ = HALBJAHRE[0];

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
const lehrerB = client();
let sjId, klasseId, fachId, klausurId, ulId, s1, s2;

test('Vorbereitung: Klasse mit Klassenleitung (A), zugewiesene Fachlehrkraft (B), Klausur+UL, zwei Schüler', async () => {
  let r = await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
  });
  assert.equal(r.status, 302);
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;

  for (const name of ['Lehrer A', 'Lehrer B']) {
    await form(admin, '/admin/einladungen/neu', { display_name: name, ttl_days: '14' });
  }
  const invs = getDb().prepare('SELECT token FROM invitations ORDER BY id').all();
  await form(lehrerA, `/einladung/${invs[0].token}`, {
    username: 'lehrera', display_name: 'Lehrer A', password: 'passwortA1', password2: 'passwortA1',
  });
  await form(lehrerB, `/einladung/${invs[1].token}`, {
    username: 'lehrerb', display_name: 'Lehrer B', password: 'passwortB1', password2: 'passwortB1',
  });
  const lehrerBId = getDb().prepare('SELECT id FROM users WHERE username = ?').get('lehrerb').id;

  await form(lehrerA, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '9A', notenschluessel: 'IHK' });
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '9A'").get().id;
  await form(lehrerA, `/teacher/klassen/${klasseId}/klassenlehrer/eintragen`, {});
  await form(lehrerA, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
  await form(lehrerA, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Berger', vorname: 'Ben' });
  const schueler = getDb().prepare('SELECT id FROM schueler WHERE klasse_id = ? ORDER BY nachname').all(klasseId);
  s1 = schueler[0].id;
  s2 = schueler[1].id;

  await form(lehrerA, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Englisch' });
  fachId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Englisch'").get(klasseId).id;
  await form(lehrerA, `/teacher/klassen/${klasseId}/zuweisungen/neu`, { user_id: String(lehrerBId), fach_id: String(fachId) });

  await form(lehrerB, `/teacher/fach/${fachId}/klausuren/neu`, { name: 'K1', aufgaben: '1', halbjahr: HJ });
  klausurId = getDb().prepare('SELECT id FROM klausuren WHERE fach_id = ?').get(fachId).id;
  await form(lehrerB, `/teacher/klausuren/${klausurId}/maxpunkte`, { anzahl_aufgaben: '1', mp_0: '10', halbjahr: HJ });

  await form(lehrerB, `/teacher/fach/${fachId}/uls/neu`, { name: 'UL1', aufgaben: '1', halbjahr: HJ });
  ulId = getDb().prepare('SELECT id FROM unterrichtsleistungen WHERE fach_id = ?').get(fachId).id;
  await form(lehrerB, `/teacher/uls/${ulId}/maxpunkte`, { anzahl_aufgaben: '1', mp_0: '10', halbjahr: HJ });
});

test('Vor der Sperre: Fachlehrkraft kann Punkte/manuelle Noten normal eintragen', async () => {
  const r = await lehrerB(`/teacher/klausuren/${klausurId}/punkte`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ schueler_id: String(s1), aufgabe_idx: '0', wert: '5' }),
  });
  assert.equal(r.status, 200);
  const eintrag = getDb().prepare('SELECT punkte FROM klausur_ergebnisse WHERE klausur_id = ? AND schueler_id = ?').get(klausurId, s1);
  assert.deepEqual(JSON.parse(eintrag.punkte), [5]);
});

test('Sperren: nur Klassenleitung darf sperren', async () => {
  let r = await form(lehrerB, `/teacher/klassen/${klasseId}/konferenz/${s1}/sperren`, { halbjahr: HJ });
  assert.equal(r.status, 403);

  r = await form(lehrerA, `/teacher/klassen/${klasseId}/konferenz/${s1}/sperren`, { halbjahr: HJ });
  assert.equal(r.status, 302);
  const sperre = getDb().prepare('SELECT * FROM notensperren WHERE klasse_id = ? AND schueler_id = ? AND halbjahr = ?')
    .get(klasseId, s1, HJ);
  assert.ok(sperre);

  const html = await (await lehrerA(`/teacher/klassen/${klasseId}/konferenz/${s1}?hj=${encodeURIComponent(HJ)}`)).text();
  assert.match(html, /gesperrt/);
});

test('Nach der Sperre: Fachlehrkraft kann Punkte/manuelle Noten NICHT mehr für die gesperrte Person ändern', async () => {
  // Klausur-Punkte
  let r = await lehrerB(`/teacher/klausuren/${klausurId}/punkte`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ schueler_id: String(s1), aufgabe_idx: '0', wert: '9' }),
  });
  assert.equal(r.status, 403);
  const eintrag = getDb().prepare('SELECT punkte FROM klausur_ergebnisse WHERE klausur_id = ? AND schueler_id = ?').get(klausurId, s1);
  assert.deepEqual(JSON.parse(eintrag.punkte), [5], 'gesperrter Punktwert darf nicht überschrieben werden');

  // UL-Punkte
  r = await lehrerB(`/teacher/uls/${ulId}/punkte`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ schueler_id: String(s1), aufgabe_idx: '0', wert: '9' }),
  });
  assert.equal(r.status, 403);

  // Manuelle Note hinzufügen
  r = await form(lehrerB, `/teacher/fach/${fachId}/noten/hinzufuegen`, {
    schueler_id: String(s1), typ: 'muendlich', wert: '2', halbjahr: HJ,
  });
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM noten WHERE schueler_id = ?').get(s1).c, 0);

  // Andere Schüler:in (nicht gesperrt) bleibt normal bearbeitbar.
  r = await lehrerB(`/teacher/klausuren/${klausurId}/punkte`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ schueler_id: String(s2), aufgabe_idx: '0', wert: '7' }),
  });
  assert.equal(r.status, 200);
});

test('Löschen einer bereits vorhandenen manuellen Note ist für die gesperrte Person ebenfalls blockiert', async () => {
  // Zuerst für s2 (nicht gesperrt) eine Note anlegen, dann s2 sperren und Löschversuch prüfen.
  await form(lehrerB, `/teacher/fach/${fachId}/noten/hinzufuegen`, {
    schueler_id: String(s2), typ: 'muendlich', wert: '2', halbjahr: HJ,
  });
  const noteId = getDb().prepare('SELECT id FROM noten WHERE schueler_id = ?').get(s2).id;
  await form(lehrerA, `/teacher/klassen/${klasseId}/konferenz/${s2}/sperren`, { halbjahr: HJ });

  const r = await form(lehrerB, `/teacher/noten/${noteId}/loeschen`, {});
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM noten WHERE id = ?').get(noteId).c, 1, 'gesperrte Note darf nicht gelöscht werden');
});

test('Entsperrung anfragen (Fachlehrkraft) statt selbst zu entsperren', async () => {
  let r = await form(lehrerB, `/teacher/fach/${fachId}/sperre/${s1}/anfragen`, { halbjahr: HJ, grund: 'Tippfehler korrigieren' });
  assert.equal(r.status, 302);

  const sperre = getDb().prepare('SELECT * FROM notensperren WHERE klasse_id = ? AND schueler_id = ? AND halbjahr = ?')
    .get(klasseId, s1, HJ);
  assert.equal(sperre.aufhebung_angefragt, 1);
  assert.equal(sperre.aufhebung_grund, 'Tippfehler korrigieren');

  // Die Fachlehrkraft selbst kann NICHT direkt entsperren.
  r = await form(lehrerB, `/teacher/klassen/${klasseId}/konferenz/${s1}/entsperren`, { halbjahr: HJ });
  assert.equal(r.status, 403);
  assert.ok(getDb().prepare('SELECT * FROM notensperren WHERE klasse_id = ? AND schueler_id = ? AND halbjahr = ?')
    .get(klasseId, s1, HJ), 'Sperre besteht weiterhin, bis die Klassenleitung entsperrt');

  // Die Anfrage ist für die Klassenleitung sichtbar.
  const html = await (await lehrerA(`/teacher/klassen/${klasseId}/konferenz/${s1}?hj=${encodeURIComponent(HJ)}`)).text();
  assert.match(html, /Entsperrung angefragt/);
  assert.match(html, /Tippfehler korrigieren/);
});

test('Entsperren (Klassenleitung): Fachlehrkraft kann danach wieder eintragen', async () => {
  const r = await form(lehrerA, `/teacher/klassen/${klasseId}/konferenz/${s1}/entsperren`, { halbjahr: HJ });
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM notensperren WHERE klasse_id = ? AND schueler_id = ?').get(klasseId, s1).c, 0);

  const r2 = await lehrerB(`/teacher/klausuren/${klausurId}/punkte`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ schueler_id: String(s1), aufgabe_idx: '0', wert: '9' }),
  });
  assert.equal(r2.status, 200);
  const eintrag = getDb().prepare('SELECT punkte FROM klausur_ergebnisse WHERE klausur_id = ? AND schueler_id = ?').get(klausurId, s1);
  assert.deepEqual(JSON.parse(eintrag.punkte), [9]);
});

test.after(async () => {
  await fastify.close();
});
