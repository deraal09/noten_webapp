/**
 * Klassen und Kurse umbenennen: jede Lehrkraft, die der Klasse bzw. dem Kurs angehört, darf; der Name gilt für alle, die eingetragen sind.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-umbenennen-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-umbenennen-bitte-lang-genug-xxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
test.after(() => fastify.close());

function client() {
  const cookies = new Map();
  return async function req(url, body) {
    const headers = {};
    if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    const opts = { headers, redirect: 'manual' };
    if (body) { opts.method = 'POST'; headers['content-type'] = 'application/x-www-form-urlencoded'; opts.body = new URLSearchParams(body); }
    const r = await fetch(base + url, opts);
    for (const raw of r.headers.getSetCookie?.() ?? []) { const [k, ...v] = raw.split(';')[0].split('='); cookies.set(k.trim(), v.join('=').trim()); }
    return r;
  };
}
const admin = client();
const anna = client(); // legt Klasse und Kurs an
const ben = client(); // hat ein Fach in der Klasse und ist dem Kurs zugeordnet
const cora = client(); // gehört nicht dazu
const db = () => getDb();
let sjId; let klasseId; let klasseId2; let kursId;
const klassenName = (id) => db().prepare('SELECT name FROM klassen WHERE id = ?').get(id).name;

test('Vorbereitung: Klassen 10A und 10B, Kurs „Philo-AG“; Ben ist in Klasse 10A (Fach) und im Kurs eingetragen', async () => {
  await admin('/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await admin('/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  sjId = db().prepare('SELECT id FROM schuljahre').get().id;
  for (const [c, n] of [[anna, 'anna'], [ben, 'ben'], [cora, 'cora']]) {
    await admin('/admin/einladungen/neu', { display_name: n, ttl_days: '14' });
    const inv = db().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
    await c(`/einladung/${inv.token}`, { username: n, display_name: n, password: 'passwort123', password2: 'passwort123' });
  }
  db().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'anna'").run();
  await anna('/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '10A', notenschluessel: 'IHK', einschulung_jahr: '2025' });
  await anna('/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '10B', notenschluessel: 'IHK', einschulung_jahr: '2025' });
  klasseId = db().prepare("SELECT id FROM klassen WHERE name = '10A'").get().id;
  klasseId2 = db().prepare("SELECT id FROM klassen WHERE name = '10B'").get().id;
  await anna(`/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Mathe' });
  const mathe = db().prepare("SELECT id FROM faecher WHERE name = 'Mathe'").get().id;
  const benId = db().prepare("SELECT id FROM users WHERE username = 'ben'").get().id;
  db().prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)').run(benId, mathe);
  await anna('/teacher/kurse/neu', { schuljahr_id: String(sjId), name: 'Philo-AG', notenschluessel: 'IHK' });
  kursId = db().prepare('SELECT id FROM faecher WHERE ist_kurs = 1').get().id;
  db().prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)').run(benId, kursId);
});

test('Klasse: die Seite bietet das Umbenennen an', async () => {
  const html = await (await anna(`/teacher/klassen/${klasseId}`)).text();
  assert.match(html, /✏️ Klasse umbenennen/);
  assert.match(html, new RegExp(`action="/teacher/klassen/${klasseId}/umbenennen"`));
  assert.match(html, /gilt sofort für alle Lehrkräfte, die in der Klasse eingetragen sind/);
});

test('Klasse: Ben (nicht Ersteller, keine Klassenleitung) darf umbenennen -- Anna sieht den neuen Namen sofort', async () => {
  const r = await ben(`/teacher/klassen/${klasseId}/umbenennen`, { name: '  10A-Neu  ' });
  assert.equal(r.status, 302);
  assert.equal(klassenName(klasseId), '10A-Neu', 'getrimmt gespeichert');
  assert.match(await (await anna('/teacher/klassen')).text(), /10A-Neu/);
  assert.doesNotMatch(await (await anna('/teacher/klassen')).text(), />10A</);
  assert.match(await (await anna(`/teacher/klassen/${klasseId}`)).text(), /<h1>10A-Neu/);
  assert.match(await (await ben('/teacher')).text(), /10A-Neu/, 'auch in der Noteneingabe');
  assert.match(await (await ben(`/teacher/klassen/${klasseId}`)).text(), /Klasse umbenannt|10A-Neu/);
});

test('Klasse: leerer, zu langer, reservierter oder doppelter Name wird abgelehnt; Fremde und Sammelklasse nicht', async () => {
  for (const name of ['   ', 'x'.repeat(61), '__intern']) {
    assert.equal((await anna(`/teacher/klassen/${klasseId}/umbenennen`, { name })).status, 302);
    assert.equal(klassenName(klasseId), '10A-Neu', `unverändert bei „${name.slice(0, 12)}“`);
  }
  await anna(`/teacher/klassen/${klasseId}/umbenennen`, { name: '10B' });
  assert.equal(klassenName(klasseId), '10A-Neu', 'es gibt schon eine 10B im Schuljahr');
  await anna(`/teacher/klassen/${klasseId}/umbenennen`, { name: '10b' });
  assert.equal(klassenName(klasseId), '10A-Neu', 'auch ohne Beachtung der Groß-/Kleinschreibung');
  assert.equal((await cora(`/teacher/klassen/${klasseId}/umbenennen`, { name: 'Gekapert' })).status, 403);
  assert.equal(klassenName(klasseId), '10A-Neu');
  const ablage = db().prepare("INSERT INTO klassen (schuljahr_id, name, notenschluessel, notenschluessel_csv, ist_ablage) VALUES (?, 'Ohne Klasse', 'IHK', '', 1)").run(sjId).lastInsertRowid;
  assert.equal((await anna(`/teacher/klassen/${ablage}/umbenennen`, { name: 'Anders' })).status, 403);
  assert.equal((await admin(`/teacher/klassen/${ablage}/umbenennen`, { name: 'Anders' })).status, 403, 'auch der Admin nicht');
  assert.equal(klassenName(ablage), 'Ohne Klasse');
  assert.equal((await anna('/teacher/klassen/99999/umbenennen', { name: 'X' })).status, 404);
});

test('Kurs: jede zugeordnete Lehrkraft darf umbenennen, der Name gilt für alle; Fremde nicht', async () => {
  const kursName = () => db().prepare('SELECT name FROM faecher WHERE id = ?').get(kursId).name;
  const html = await (await anna(`/teacher/fach/${kursId}`)).text();
  assert.match(html, /✏️ Kurs umbenennen/);
  assert.match(html, new RegExp(`action="/teacher/kurse/${kursId}/umbenennen"`));

  assert.equal((await ben(`/teacher/kurse/${kursId}/umbenennen`, { name: 'Philosophie Q1' })).status, 302);
  assert.equal(kursName(), 'Philosophie Q1');
  assert.match(await (await anna('/teacher')).text(), /Philosophie Q1/);
  assert.match(await (await anna('/teacher/klassen')).text(), /Philosophie Q1/);

  assert.equal((await cora(`/teacher/kurse/${kursId}/umbenennen`, { name: 'Gekapert' })).status, 403);
  await anna(`/teacher/kurse/${kursId}/umbenennen`, { name: '' });
  assert.equal(kursName(), 'Philosophie Q1');
  // Unterfächer des Kurses ziehen mit
  const u = db().prepare("INSERT INTO faecher (klasse_id, name, parent_fach_id, kurzname) SELECT klasse_id, 'Philosophie Q1 – Ethik', id, 'Ethik' FROM faecher WHERE id = ?").run(kursId).lastInsertRowid;
  await anna(`/teacher/kurse/${kursId}/umbenennen`, { name: 'Ethik-Kurs' });
  assert.equal(db().prepare('SELECT name FROM faecher WHERE id = ?').get(u).name.startsWith('Ethik-Kurs'), true);
  // Normale Fächer sind kein Kurs
  const mathe = db().prepare("SELECT id FROM faecher WHERE name = 'Mathe'").get().id;
  assert.equal((await anna(`/teacher/kurse/${mathe}/umbenennen`, { name: 'Anders' })).status, 404);
});
