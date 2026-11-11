/**
 * CSV-Import der Teilnehmerliste eines Kurses (POST /teacher/fach/:id/teilnehmer/csv): Nachname;Vorname;Klasse, je Zeile wie
 * "Manuell anlegen" (Klasse wird bei Bedarf angelegt, Notenschlüssel geprüft, Doppelte übersprungen), Meldung mit Zählern.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-kurs-csv-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-kurs-csv-bitte-lang-genug-xxxxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
test.after(() => fastify.close());

function client() {
  const cookies = new Map();
  return async function req(url, opts = {}) {
    const headers = { ...opts.headers };
    if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(base + url, { ...opts, headers, redirect: 'manual' });
    for (const raw of r.headers.getSetCookie?.() ?? []) { const [k, ...v] = raw.split(';')[0].split('='); cookies.set(k.trim(), v.join('=').trim()); }
    return r;
  };
}
const form = (req, url, body) => req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
const upload = (req, url, inhalt, name = 'kurs.csv') => {
  const fd = new FormData();
  if (inhalt !== null) fd.append('datei', new Blob([inhalt], { type: 'text/csv' }), name);
  return req(url, { method: 'POST', body: fd });
};

const admin = client();
const lehrer = client();
const fremd = client();
let kursId; let sjId;
const db = () => getDb();
const teilnehmer = () => db().prepare(`
  SELECT s.nachname, s.vorname, k.name AS klasse FROM fach_teilnehmer ft JOIN schueler s ON s.id = ft.schueler_id JOIN klassen k ON k.id = s.klasse_id
  WHERE ft.fach_id = ? ORDER BY s.nachname, s.vorname
`).all(kursId);
// Meldungen stehen nach dem Redirect in der nächsten Seite
const meldungen = async (c) => (await (await c(`/teacher/fach/${kursId}/teilnehmer`)).text());

test('Vorbereitung: Kurs (IHK) einer Lehrkraft; vorhandene Klasse 10B (IHK) und 10X (BG)', async () => {
  await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  sjId = db().prepare('SELECT id FROM schuljahre').get().id;
  for (const [c, n] of [[lehrer, 'lehrer'], [fremd, 'fremd']]) {
    await form(admin, '/admin/einladungen/neu', { display_name: n, ttl_days: '14' });
    const inv = db().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
    await form(c, `/einladung/${inv.token}`, { username: n, display_name: n, password: 'passwort123', password2: 'passwort123' });
  }
  db().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'lehrer'").run();
  await form(lehrer, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '10B', notenschluessel: 'IHK', einschulung_jahr: '2025' });
  await form(lehrer, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '10X', notenschluessel: 'BG', einschulung_jahr: '2025' });
  await form(lehrer, '/teacher/kurse/neu', { schuljahr_id: String(sjId), name: 'Philo-AG', notenschluessel: 'IHK' });
  kursId = db().prepare('SELECT id FROM faecher WHERE ist_kurs = 1').get().id;
  assert.equal(teilnehmer().length, 0);
});

test('Die Seite hat die Upload-Box mit Hinweis auf Nachname;Vorname;Klasse', async () => {
  const html = await meldungen(lehrer);
  assert.match(html, /id="teilnehmer-csv"/);
  assert.match(html, /action="\/teacher\/fach\/\d+\/teilnehmer\/csv" enctype="multipart\/form-data"/);
  assert.match(html, /Nachname;Vorname;Klasse/);
});

test('Import: Kopfzeile erkannt, Klasse wird angelegt, Zähler in der Meldung', async () => {
  const csv = 'Nachname;Vorname;Klasse\nAdler;Anna;10B\nBerger;Bert;10B\nClaus;Cem;11NEU\nDietz;Dora;11NEU\n';
  const r = await upload(lehrer, `/teacher/fach/${kursId}/teilnehmer/csv`, csv);
  assert.equal(r.status, 302);
  assert.deepEqual(teilnehmer().map((t) => `${t.nachname}/${t.klasse}`), ['Adler/10B', 'Berger/10B', 'Claus/11NEU', 'Dietz/11NEU']);
  const k = db().prepare("SELECT notenschluessel, schuljahr_id FROM klassen WHERE name = '11NEU'").get();
  assert.equal(k.notenschluessel, 'IHK', 'neue Klasse mit dem Notenschlüssel des Kurses');
  assert.equal(k.schuljahr_id, sjId);
  assert.match(await meldungen(lehrer), /4 hinzugefügt, 0 übersprungen/);
});

test('Erneuter Import: Doppelte werden übersprungen; neue Zeilen kommen dazu; Komma/Tab ohne Kopfzeile', async () => {
  const r = await upload(lehrer, `/teacher/fach/${kursId}/teilnehmer/csv`, 'Adler,Anna,10B\nEngel,Emil,10B\n');
  assert.equal(r.status, 302);
  assert.equal(teilnehmer().length, 5);
  assert.match(await meldungen(lehrer), /1 hinzugefügt, 1 übersprungen/);
  await upload(lehrer, `/teacher/fach/${kursId}/teilnehmer/csv`, 'Fuchs\tFelix\t10B\n');
  assert.equal(teilnehmer().length, 6);
});

test('Falscher Notenschlüssel und fehlende Klasse werden gemeldet, alle übrigen Zeilen trotzdem übernommen', async () => {
  const csv = 'Nachname;Vorname;Klasse\nGross;Gina;10B\nHaas;Hans;10X\nIlse;;10B\nJung;Jan;\n';
  await upload(lehrer, `/teacher/fach/${kursId}/teilnehmer/csv`, csv);
  const namen = teilnehmer().map((t) => t.nachname);
  assert.ok(namen.includes('Gross'));
  assert.ok(!namen.includes('Haas'), '10X ist BG, der Kurs IHK');
  assert.ok(!namen.includes('Jung'));
  const html = await meldungen(lehrer);
  assert.match(html, /1 hinzugefügt, 0 übersprungen/);
  assert.match(html, /3 Zeilen nicht übernommen/);
  assert.match(html, /Haas, Hans \(10X\): Notenschlüssel der Klasse passt nicht zum Fach/);
  assert.match(html, /Spalte „Klasse“/);
});

test('Keine Datei oder leere Datei: Fehlermeldung; fremde Lehrkraft darf nicht', async () => {
  const vorher = teilnehmer().length;
  assert.equal((await upload(lehrer, `/teacher/fach/${kursId}/teilnehmer/csv`, null)).status, 302);
  assert.match(await meldungen(lehrer), /Bitte eine CSV-Datei auswählen/);
  assert.equal((await upload(lehrer, `/teacher/fach/${kursId}/teilnehmer/csv`, '\n\n')).status, 302);
  assert.match(await meldungen(lehrer), /keine Zeilen gelesen/);
  assert.equal((await upload(fremd, `/teacher/fach/${kursId}/teilnehmer/csv`, 'Zorn;Zoe;10B\n')).status, 403);
  assert.equal(teilnehmer().length, vorher);
});
