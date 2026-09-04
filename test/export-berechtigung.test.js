/**
 * Wer eine Klasse als CSV exportieren darf, entscheidet ausschließlich
 * userDarfKlasseExportieren() in src/auth.js — und zwar für BEIDE
 * Export-Routen gleich.
 *
 * Der CSV-Export enthält Live-Noten. Die Klassenleitung ist davon bewusst
 * ausgenommen: Sie soll fremde Notentafeln nur über den Sync-Stand sehen
 * (src/noten-sync.js), nicht live. /export/schuljahr/:id.csv hatte dafür
 * früher eine eigene Abfrage, die zusätzlich `klassen_lehrkraefte` einschloss
 * — damit ließ sich der Einzel-Export umgehen (403 auf die Klasse, 200 auf
 * das ganze Schuljahr mit derselben Klasse darin). Umgekehrt fehlte dort
 * `created_by_id`, sodass die Ersteller/in ihrer eigenen Klasse leer ausging.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-export-rechte-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-export-berechtigung-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { hashPassword } = await import('../src/auth.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });

function client() {
  const cookies = new Map();
  return async function req(url, opts = {}) {
    const headers = { ...opts.headers };
    if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(base + url, { ...opts, headers, redirect: 'manual' });
    for (const raw of r.headers.getSetCookie()) {
      const [k, ...v] = raw.split(';')[0].split('=');
      cookies.set(k.trim(), v.join('=').trim());
    }
    return r;
  };
}

const form = (req, url, body) => req(url, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body),
});

/** Legt ein Lehrkraft-Konto an und meldet es an. */
async function lehrkraft(username) {
  const info = getDb().prepare(`INSERT INTO users (username, display_name, password_hash, role, active, auth_source)
                                VALUES (?, ?, ?, 'teacher', 1, 'lokal')`)
    .run(username, username, hashPassword('geheim12'));
  const req = client();
  const r = await form(req, '/login', { username, password: 'geheim12' });
  assert.equal(r.headers.get('location'), '/', `Login ${username} fehlgeschlagen`);
  return { id: Number(info.lastInsertRowid), req };
}

const admin = client();
let klasseId;

test('Vorbereitung: Admin, Schuljahr, Klasse mit einem Fach', async () => {
  let r = await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'geheim12', password2: 'geheim12',
  });
  assert.equal(r.status, 302);
  r = await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  assert.equal(r.status, 302);
  r = await form(admin, '/admin/schuljahre/1/klassen/neu', { name: 'K1', notenschluessel: 'IHK' });
  assert.equal(r.status, 302);
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = 'K1'").get().id;
  r = await form(admin, `/admin/klassen/${klasseId}/faecher/neu`, { name: 'Mathe' });
  assert.equal(r.status, 302);
  // Ohne Fach UND Schüler/in erzeugt baueKlasseCsv() keine einzige Datenzeile
  // — der Klassenname stünde dann nirgends im Export.
  r = await form(admin, `/admin/klassen/${klasseId}/schueler/neu`, { nachname: 'Musterfrau', vorname: 'Erika' });
  assert.equal(r.status, 302);
});

test('Fachlehrkraft darf beide Exporte', async () => {
  const { id, req } = await lehrkraft('fachlehrkraft');
  const fachId = getDb().prepare('SELECT id FROM faecher WHERE klasse_id = ?').get(klasseId).id;
  getDb().prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)').run(id, fachId);

  assert.equal((await req(`/export/klasse/${klasseId}.csv`)).status, 200);
  assert.equal((await req('/export/schuljahr/1.csv')).status, 200);
});

test('Ersteller/in der Klasse darf beide Exporte', async () => {
  const { id, req } = await lehrkraft('erstellerin');
  const info = getDb().prepare(`INSERT INTO klassen (schuljahr_id, name, notenschluessel, notenschluessel_csv, created_by_id)
                                VALUES (1, 'K-Eigen', 'IHK', '', ?)`).run(id);
  const eigeneKlasseId = Number(info.lastInsertRowid);
  getDb().prepare("INSERT INTO faecher (klasse_id, name) VALUES (?, 'Deutsch')").run(eigeneKlasseId);
  getDb().prepare("INSERT INTO schueler (klasse_id, nachname, vorname) VALUES (?, 'Beispiel', 'Max')").run(eigeneKlasseId);

  assert.equal((await req(`/export/klasse/${eigeneKlasseId}.csv`)).status, 200);
  // Das war die zweite Hälfte der Inkonsistenz: created_by_id fehlte in der
  // alten Schuljahres-Abfrage komplett.
  const r = await req('/export/schuljahr/1.csv');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /K-Eigen/);
});

test('Klassenleitung darf KEINEN der beiden Exporte — auch nicht über das Schuljahr', async () => {
  // Beide Wege, auf denen jemand Klassenleitung wird, müssen gleich behandelt
  // werden: klassen_lehrkraefte (alte Admin-Zuweisung je Fach) …
  const alt = await lehrkraft('kl-alt');
  const fachId = getDb().prepare('SELECT id FROM faecher WHERE klasse_id = ?').get(klasseId).id;
  getDb().prepare('INSERT INTO klassen_lehrkraefte (user_id, klasse_id, fach_id) VALUES (?, ?, ?)')
    .run(alt.id, klasseId, fachId);
  assert.equal((await alt.req(`/export/klasse/${klasseId}.csv`)).status, 403);
  assert.equal((await alt.req('/export/schuljahr/1.csv')).status, 403);

  // … und klassenleitung (klassenweite Selbstregistrierung/Co-Klassenlehrkraft).
  const neu = await lehrkraft('kl-neu');
  getDb().prepare('INSERT INTO klassenleitung (klasse_id, user_id) VALUES (?, ?)').run(klasseId, neu.id);
  assert.equal((await neu.req(`/export/klasse/${klasseId}.csv`)).status, 403);
  assert.equal((await neu.req('/export/schuljahr/1.csv')).status, 403);
});

test('Unbeteiligte Lehrkraft bekommt bei beiden Exporten 403', async () => {
  const { req } = await lehrkraft('fremde');
  assert.equal((await req(`/export/klasse/${klasseId}.csv`)).status, 403);
  assert.equal((await req('/export/schuljahr/1.csv')).status, 403);
});

test('Der Schuljahres-Export enthält nur die erlaubten Klassen', async () => {
  // Die Fachlehrkraft ist nur K1 zugewiesen — K-Eigen (fremde Klasse) darf
  // in ihrem Schuljahres-Export nicht auftauchen.
  const req = client();
  await form(req, '/login', { username: 'fachlehrkraft', password: 'geheim12' });
  const csv = await (await req('/export/schuljahr/1.csv')).text();
  assert.match(csv, /K1/);
  assert.ok(!csv.includes('K-Eigen'), 'fremde Klassen gehören nicht in den Export');
});

test('Admin darf alles', async () => {
  assert.equal((await admin(`/export/klasse/${klasseId}.csv`)).status, 200);
  const csv = await (await admin('/export/schuljahr/1.csv')).text();
  assert.match(csv, /K1/);
  assert.match(csv, /K-Eigen/);
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
