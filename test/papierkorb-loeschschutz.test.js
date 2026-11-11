/**
 * Löschschutz im Papierkorb: Wer die Zuweisung einer anderen Lehrkraft entfernt und dann die Klasse löscht, darf deren Noten
 * nicht über den Papierkorb vernichten -- weder über die Oberfläche ("Sofort löschen") noch über die API (DELETE /papierkorb/{id})
 * noch durch den automatischen Ablauf der Frist. Stehen in einem Fach Noten, dem keine Lehrkraft (mehr) zugeordnet ist,
 * bleibt die Klasse im Papierkorb; endgültig löschen kann sie dann nur der Admin. Klassen mit nur eigenen Noten bleiben löschbar.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-papierkorb-schutz-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-papierkorb-schutz-lang-genug-xxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { loescheAbgelaufeneKlassen, ladePapierkorb } = await import('../src/papierkorb.js');
const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
test.after(async () => { await fastify.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });

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
async function api(key, method, url) {
  const r = await fetch(`${base}/api/v1${url}`, { method, headers: { authorization: `Bearer ${key}` } });
  return { status: r.status, json: await r.json() };
}

const admin = client();
const anna = client(); // legt die Klasse an, ist Klassenleitung
const ben = client(); // Fachlehrkraft Mathe mit Noten
const db = () => getDb();
const klasseDa = (id) => Boolean(db().prepare('SELECT 1 FROM klassen WHERE id = ?').get(id));
const matheNoten = () => db().prepare('SELECT COUNT(*) AS n FROM halbjahr_endnoten WHERE fach_id = ?').get(matheId).n;
let sjId; let benId; let klasseId; let matheId; let annaKey;

test('Vorbereitung: Anna legt 10P an (Klassenleitung, Deutsch); Ben unterrichtet Mathe und hat Noten eingetragen', async () => {
  await admin('/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await admin('/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  sjId = db().prepare('SELECT id FROM schuljahre').get().id;
  for (const [c, n] of [[anna, 'anna'], [ben, 'ben']]) {
    await admin('/admin/einladungen/neu', { display_name: n, ttl_days: '14' });
    const inv = db().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
    await c(`/einladung/${inv.token}`, { username: n, display_name: n, password: 'passwort123', password2: 'passwort123' });
  }
  db().prepare("UPDATE users SET auth_source = 'ldap' WHERE username IN ('anna', 'ben')").run();
  benId = db().prepare("SELECT id FROM users WHERE username = 'ben'").get().id;

  await anna('/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '10P', notenschluessel: 'IHK', einschulung_jahr: '2025' });
  klasseId = db().prepare("SELECT id FROM klassen WHERE name = '10P'").get().id;
  await anna(`/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Deutsch' });
  await anna(`/teacher/klassen/${klasseId}/klassenlehrer/eintragen`, {});
  await anna(`/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Muster', vorname: 'Erika' });
  const s = db().prepare("SELECT id FROM schueler WHERE vorname = 'Erika'").get().id;
  matheId = Number(db().prepare("INSERT INTO faecher (klasse_id, name) VALUES (?, 'Mathe')").run(klasseId).lastInsertRowid);
  db().prepare('INSERT INTO fach_teilnehmer (fach_id, schueler_id) VALUES (?, ?)').run(matheId, s);
  db().prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)').run(benId, matheId);
  db().prepare("INSERT INTO halbjahr_endnoten (fach_id, schueler_id, halbjahr, note) VALUES (?, ?, '1. Halbjahr', 2)").run(matheId, s);

  const html = await (await anna('/konto/api', { name: 'Agent', scope: 'schreiben', gueltig_tage: '30' })).text();
  annaKey = /value="(nk_[A-Za-z0-9_-]+)"/.exec(html)?.[1];
  assert.ok(annaKey);
  assert.equal(matheNoten(), 1);
});

test('Anna entfernt Bens Zuweisung und löscht die Klasse: die Frist läuft, aber die Klasse ist blockiert', async () => {
  const z = db().prepare('SELECT id FROM fach_zuweisungen WHERE user_id = ? AND fach_id = ?').get(benId, matheId).id;
  assert.equal((await anna(`/teacher/zuweisungen/${z}/loeschen`, {})).status, 302);
  assert.equal((await anna(`/teacher/klassen/${klasseId}/loeschen`, {})).status, 302);
  const [eintrag] = ladePapierkorb(db().prepare("SELECT id FROM users WHERE username = 'anna'").get().id);
  assert.ok(eintrag.ablauf, 'niemand sonst ist mehr mit der Klasse verbunden');
  assert.deepEqual(eintrag.blockiert, ['Mathe']);
});

test('Oberfläche: kein "Sofort löschen", sondern ein Hinweis; der direkte POST löscht nichts', async () => {
  const seite = await (await anna('/teacher/papierkorb')).text();
  assert.match(seite, /Fächern ohne zugeordnete Lehrkraft \(Mathe\)/);
  assert.doesNotMatch(seite, new RegExp(`/teacher/papierkorb/${klasseId}/endgueltig`));
  const r = await anna(`/teacher/papierkorb/${klasseId}/endgueltig`, {});
  assert.equal(r.status, 302);
  assert.ok(klasseDa(klasseId), 'die Klasse bleibt');
  assert.equal(matheNoten(), 1, 'Bens Noten bleiben');
  assert.match(await (await anna(r.headers.get('location'))).text(), /nur der Admin/);
});

test('API: GET /papierkorb zeigt die Blockade, DELETE /papierkorb/{id} antwortet 409 fremde_noten', async () => {
  const liste = await api(annaKey, 'GET', '/papierkorb');
  assert.equal(liste.status, 200);
  const e = liste.json.klassen.find((k) => k.id === klasseId);
  assert.ok(e, JSON.stringify(liste.json));
  assert.equal(e.sofort_loeschbar, false);
  assert.deepEqual(e.blockiert_durch_faecher, ['Mathe']);

  const r = await api(annaKey, 'DELETE', `/papierkorb/${klasseId}`);
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'fremde_noten');
  assert.deepEqual(r.json.details, { faecher: ['Mathe'] });
  assert.ok(klasseDa(klasseId));
  assert.equal(matheNoten(), 1);
});

test('Automatischer Ablauf: eine blockierte Klasse wird auch nach der Frist nicht gelöscht', () => {
  loescheAbgelaufeneKlassen(new Date(Date.now() + 365 * 24 * 3600 * 1000));
  assert.ok(klasseDa(klasseId));
  assert.equal(matheNoten(), 1);
});

test('Wird Ben wieder zugeordnet, ist die Klasse nicht mehr blockiert (aber wieder mit ihm verbunden)', () => {
  db().prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)').run(benId, matheId);
  const annaId = db().prepare("SELECT id FROM users WHERE username = 'anna'").get().id;
  assert.deepEqual(ladePapierkorb(annaId).find((k) => k.id === klasseId).blockiert, []);
  db().prepare('DELETE FROM fach_zuweisungen WHERE user_id = ? AND fach_id = ?').run(benId, matheId);
});

test('Der Admin kann die blockierte Klasse endgültig löschen', async () => {
  assert.equal((await admin(`/teacher/klassen/${klasseId}/loeschen`, {})).status, 302);
  assert.equal(klasseDa(klasseId), false);
});

test('Nur eigene Noten (auch in einem Fach ohne Lehrkraft, aber ohne Noten): sofort löschen klappt weiter', async () => {
  await anna('/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '10Q', notenschluessel: 'IHK', einschulung_jahr: '2025' });
  const id = db().prepare("SELECT id FROM klassen WHERE name = '10Q'").get().id;
  await anna(`/teacher/klassen/${id}/faecher/neu`, { name: 'Deutsch' });
  await anna(`/teacher/klassen/${id}/schueler/neu`, { nachname: 'Beispiel', vorname: 'Ben' });
  const s = db().prepare("SELECT id FROM schueler WHERE vorname = 'Ben' AND klasse_id = ?").get(id).id;
  const deutsch = db().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Deutsch'").get(id).id;
  db().prepare("INSERT INTO halbjahr_endnoten (fach_id, schueler_id, halbjahr, note) VALUES (?, ?, '1. Halbjahr', 1)").run(deutsch, s);
  db().prepare("INSERT INTO faecher (klasse_id, name) VALUES (?, 'Leer')").run(id); // ohne Lehrkraft, ohne Noten
  await anna(`/teacher/klassen/${id}/loeschen`, {});
  assert.match(await (await anna('/teacher/papierkorb')).text(), new RegExp(`/teacher/papierkorb/${id}/endgueltig`));
  await anna(`/teacher/papierkorb/${id}/endgueltig`, {});
  assert.equal(klasseDa(id), false);
});
