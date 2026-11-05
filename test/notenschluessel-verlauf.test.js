/**
 * Verlauf der übergeordneten Notenschlüssel: Eine Änderung durch den Admin gilt ab dem laufenden Halbjahr.
 * Abgeschlossene Halbjahre rechnen mit der Fassung, die zum Ende des Halbjahrs galt, gesperrte Noten
 * (Notenkonferenz) mit der Fassung vom Zeitpunkt der Sperre. Die beim Einführen geltende Fassung ist die erste.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-ns-verlauf-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-notenschluessel-verlauf-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb, closeDb } = await import('../src/db.js');
const { ladeNotenuebersicht, ladeFachMitUmfeld, berechneGesamtnoteEinerPerson } = await import('../src/noten-service.js');
const { halbjahrEnde } = await import('../src/notenschluessel.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
const cookies = new Map();
async function admin(url, body) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const r = await fetch(base + url, { method: 'POST', headers, body: new URLSearchParams(body), redirect: 'manual' });
  for (const raw of r.headers.getSetCookie()) { const [k, ...v] = raw.split(';')[0].split('='); cookies.set(k.trim(), v.join('=').trim()); }
  return r;
}
const db = () => getDb();
const sjText = (start) => `${start}/${String((start + 1) % 100).padStart(2, '0')}`;
// 70 % ergeben nach der Vorgabe Note 3,2, nach diesem geänderten Schlüssel Note 5.
const NEU_IHK = '100,1;80,2;71,3;50,5;0,6';
const HJ1 = '1. Halbjahr';

/** Klasse (IHK) im Schuljahr `start` mit Fach und einer Person, die in einer Klausur 70 % erreicht. */
async function klasseMitNote(name, start) {
  let sj = db().prepare('SELECT id FROM schuljahre WHERE bezeichnung = ?').get(sjText(start));
  if (!sj) { await admin('/admin/schuljahre/neu', { bezeichnung: sjText(start) }); sj = db().prepare('SELECT id FROM schuljahre WHERE bezeichnung = ?').get(sjText(start)); }
  await admin(`/admin/schuljahre/${sj.id}/klassen/neu`, { name, notenschluessel: 'IHK' });
  const klasseId = db().prepare('SELECT id FROM klassen WHERE name = ?').get(name).id;
  const fachId = Number(db().prepare('INSERT INTO faecher (klasse_id, name) VALUES (?, ?)').run(klasseId, 'Mathe').lastInsertRowid);
  const personen = ['Erika', 'Ben'].map((v) => Number(db().prepare("INSERT INTO schueler (klasse_id, nachname, vorname) VALUES (?, 'Muster', ?)").run(klasseId, v).lastInsertRowid));
  const kid = db().prepare("INSERT INTO klausuren (fach_id, halbjahr, name, max_punkte_pro_aufgabe, gewichtung) VALUES (?, ?, 'K1', '[100]', 100)").run(fachId, HJ1).lastInsertRowid;
  for (const p of personen) {
    db().prepare('INSERT INTO fach_teilnehmer (fach_id, schueler_id) VALUES (?, ?)').run(fachId, p);
    db().prepare("INSERT INTO klausur_ergebnisse (klausur_id, schueler_id, punkte) VALUES (?, ?, '[70]')").run(kid, p);
  }
  return { klasseId, fachId, personen };
}
const noteVon = (fachId, schuelerId) => ladeNotenuebersicht(ladeFachMitUmfeld(fachId), HJ1).rows.find((r) => r.schueler_id === schuelerId).gesamt;

const jahr = new Date().getFullYear();
let alt; let neu;

test('Vorbereitung: eine Klasse mit längst abgeschlossenem und eine mit künftigem 1. Halbjahr', async () => {
  await admin('/setup', { username: 'admin', display_name: 'Admin', password: 'geheim12', password2: 'geheim12' });
  alt = await klasseMitNote('Alt', jahr - 4);
  neu = await klasseMitNote('Neu', jahr + 1);
  assert.equal(noteVon(alt.fachId, alt.personen[0]), 3.2);
  assert.equal(noteVon(neu.fachId, neu.personen[0]), 3.2);
});

test('Halbjahresende: 1. Hälfte bis 1. Februar, 2. Hälfte bis 1. August des Folgejahres', () => {
  const laufzeit = { einschulungJahr: 2025 };
  assert.equal(halbjahrEnde(laufzeit, 1), '2026-02-01 00:00:00');
  assert.equal(halbjahrEnde(laufzeit, 2), '2026-08-01 00:00:00');
  assert.equal(halbjahrEnde(laufzeit, 3), '2027-02-01 00:00:00');
});

test('Eine Änderung gilt ab dem laufenden Halbjahr -- abgeschlossene Halbjahre behalten ihre Noten', async () => {
  // Eine Person der künftigen Klasse war schon vor der Änderung gesperrt (Notenkonferenz).
  db().prepare("INSERT INTO notensperren (klasse_id, schueler_id, halbjahr, gesperrt_am) VALUES (?, ?, ?, datetime('now', '-1 hour'))")
    .run(neu.klasseId, neu.personen[1], HJ1);
  assert.equal((await admin('/admin/notenschluessel/IHK', { csv: NEU_IHK, hinweis: 'Test' })).status, 302);

  assert.equal(noteVon(alt.fachId, alt.personen[0]), 3.2, 'abgeschlossenes Halbjahr: alte Fassung');
  assert.equal(noteVon(neu.fachId, neu.personen[0]), 5, 'laufende/künftige Halbjahre: neue Fassung');
  assert.equal(noteVon(neu.fachId, neu.personen[1]), 3.2, 'gesperrte Person: Fassung vom Zeitpunkt der Sperre');
  // Dieselbe Regel gilt für die Einzelberechnung (SPA, Sync) ...
  assert.equal(berechneGesamtnoteEinerPerson(alt.fachId, HJ1, alt.personen[0]), 3.2);
  assert.equal(berechneGesamtnoteEinerPerson(neu.fachId, HJ1, neu.personen[0]), 5);
});

test('Wird die Sperre aufgehoben, gilt wieder die Fassung zum Halbjahresende', () => {
  db().prepare('DELETE FROM notensperren WHERE schueler_id = ?').run(neu.personen[1]);
  assert.equal(noteVon(neu.fachId, neu.personen[1]), 5);
});

test('Verlauf: die bisherige Fassung (hier die Vorgabe) ist die erste, die neue gilt ab jetzt', () => {
  const verlauf = db().prepare("SELECT version, gueltig_ab FROM notenschluessel_fassungen WHERE typ = 'IHK' ORDER BY id").all();
  assert.equal(verlauf.length, 2);
  assert.equal(verlauf[0].gueltig_ab, '0000-01-01 00:00:00');
  assert.ok(verlauf[1].gueltig_ab > '2000');
});

test('Migration: bereits angepasste Schlüssel werden als erste Fassung übernommen (für alle bisherigen Halbjahre)', () => {
  // Zustand wie vor der Einführung des Verlaufs: angepasster Schlüssel, aber noch kein Verlauf.
  db().prepare('DELETE FROM notenschluessel_fassungen').run();
  closeDb();
  const verlauf = db().prepare("SELECT csv, gueltig_ab FROM notenschluessel_fassungen WHERE typ = 'IHK'").all();
  assert.deepEqual(verlauf, [{ csv: NEU_IHK, gueltig_ab: '0000-01-01 00:00:00' }]);
  assert.equal(noteVon(alt.fachId, alt.personen[0]), 5, 'die heute geltende Fassung gilt ab jetzt auch rückwirkend');
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
