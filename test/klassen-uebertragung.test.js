/**
 * Klasse ins nächste Schuljahr übertragen: kopiert Schüler/innen (und
 * optional Fächer samt Lehrkraft-Zuweisungen + Klassenleitung) in ein
 * anderes Schuljahr, ohne die ursprüngliche Klasse (und ihre Noten) zu
 * verändern.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-uebertragung-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-uebertragung-test-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');

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
    body: new URLSearchParams(body),
  });
}

const admin = client();
const lehrerA = client();
const lehrerB = client();
let sjAltId, sjNeuId, sjDrittId, klasseId, fachId, lehrerBId;

test('Vorbereitung: Admin, zwei Schuljahre, Klasse mit Klassenleitung/Fach/Zuweisung/Schüler', async () => {
  let r = await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
  });
  assert.equal(r.status, 302);
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2026/27' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2027/28' });
  sjAltId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;
  sjNeuId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2026/27'").get().id;
  sjDrittId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2027/28'").get().id;

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
  lehrerBId = getDb().prepare('SELECT id FROM users WHERE username = ?').get('lehrerb').id;

  await form(lehrerA, '/teacher/klassen/neu', { schuljahr_id: String(sjAltId), name: '10A', notenschluessel: 'IHK' });
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '10A'").get().id;
  await form(lehrerA, `/teacher/klassen/${klasseId}/klassenlehrer/eintragen`, {});
  await form(lehrerA, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
  await form(lehrerA, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Berger', vorname: 'Ben' });
  await form(lehrerA, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Deutsch' });
  fachId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Deutsch'").get(klasseId).id;
  await form(lehrerA, `/teacher/klassen/${klasseId}/zuweisungen/neu`, { user_id: String(lehrerBId), fach_id: String(fachId) });
});

test('Zugriffsschutz: nur die Klassenleitung darf übertragen', async () => {
  const r = await form(lehrerB, `/teacher/klassen/${klasseId}/naechstes-schuljahr`, {
    ziel_schuljahr_id: String(sjNeuId), neuer_name: '11A', mit_faechern: '1',
  });
  assert.equal(r.status, 403);
});

test('Übertragen mit Fächern: neue Klasse mit Schüler/innen, Fach, Zuweisung und Klassenleitung', async () => {
  const r = await form(lehrerA, `/teacher/klassen/${klasseId}/naechstes-schuljahr`, {
    ziel_schuljahr_id: String(sjNeuId), neuer_name: '11A', mit_faechern: '1',
  });
  assert.equal(r.status, 302);
  const neueKlasse = getDb().prepare("SELECT * FROM klassen WHERE schuljahr_id = ? AND name = '11A'").get(sjNeuId);
  assert.ok(neueKlasse);
  assert.equal(neueKlasse.notenschluessel, 'IHK');
  assert.equal(r.headers.get('location'), `/teacher/klassen/${neueKlasse.id}`);

  const neueSchueler = getDb().prepare('SELECT * FROM schueler WHERE klasse_id = ? ORDER BY nachname').all(neueKlasse.id);
  assert.equal(neueSchueler.length, 2);
  assert.equal(neueSchueler[0].nachname, 'Adler');
  // Eigene, neue Datensätze — nicht dieselben IDs wie in der alten Klasse.
  const alteSchuelerIds = getDb().prepare('SELECT id FROM schueler WHERE klasse_id = ?').all(klasseId).map((s) => s.id);
  assert.ok(neueSchueler.every((s) => !alteSchuelerIds.includes(s.id)));

  const neuesFach = getDb().prepare("SELECT * FROM faecher WHERE klasse_id = ? AND name = 'Deutsch'").get(neueKlasse.id);
  assert.ok(neuesFach);
  const neueZuweisung = getDb().prepare('SELECT * FROM fach_zuweisungen WHERE fach_id = ? AND user_id = ?')
    .get(neuesFach.id, lehrerBId);
  assert.ok(neueZuweisung);

  const klassenleitung = getDb().prepare('SELECT * FROM klassenleitung WHERE klasse_id = ?').all(neueKlasse.id);
  assert.equal(klassenleitung.length, 1);

  // Alte Klasse bleibt vollständig unverändert.
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM schueler WHERE klasse_id = ?').get(klasseId).c, 2);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM faecher WHERE klasse_id = ?').get(klasseId).c, 1);
});

test('Übertragen ohne Fächer: keine Fächer in der neuen Klasse', async () => {
  const r = await form(lehrerA, `/teacher/klassen/${klasseId}/naechstes-schuljahr`, {
    ziel_schuljahr_id: String(sjDrittId), neuer_name: '12A',
  });
  assert.equal(r.status, 302);
  const neueKlasse = getDb().prepare("SELECT * FROM klassen WHERE schuljahr_id = ? AND name = '12A'").get(sjDrittId);
  assert.ok(neueKlasse);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM faecher WHERE klasse_id = ?').get(neueKlasse.id).c, 0);
  // Klassenleitung wird trotzdem übernommen (unabhängig von "mit Fächern").
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM klassenleitung WHERE klasse_id = ?').get(neueKlasse.id).c, 1);
});

test('Namenskollision im Ziel-Schuljahr: freundliche Fehlermeldung statt Absturz, keine Teilkopie', async () => {
  // "11A" existiert im Ziel-Schuljahr (sjNeuId) bereits aus dem ersten Test.
  const vorherAnzahl = getDb().prepare('SELECT COUNT(*) AS c FROM klassen WHERE schuljahr_id = ?').get(sjNeuId).c;
  const r = await form(lehrerA, `/teacher/klassen/${klasseId}/naechstes-schuljahr`, {
    ziel_schuljahr_id: String(sjNeuId), neuer_name: '11A', mit_faechern: '1',
  });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `/teacher/klassen/${klasseId}`);
  const nachherAnzahl = getDb().prepare('SELECT COUNT(*) AS c FROM klassen WHERE schuljahr_id = ?').get(sjNeuId).c;
  assert.equal(nachherAnzahl, vorherAnzahl, 'bei einem Namenskonflikt darf keine (Teil-)Kopie entstehen');
});

test.after(async () => {
  await fastify.close();
});
