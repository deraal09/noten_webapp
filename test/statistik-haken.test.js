/**
 * Der Statistik-Haken der Klausuren gehört zum Konto (Server), nicht nur zum localStorage eines Browsers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-stat-haken-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-statistik-haken-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { ladeEinstellung, setzeEinstellung } = await import('../src/einstellungen.js');
const { HALBJAHRE } = await import('../src/grade-calc.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
const HJ = HALBJAHRE[0];

function client() {
  const cookies = new Map();
  return async (url, opts = {}) => {
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
const post = (req, url, body) => req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });

const lehrer = client();
const anonym = client();
let fachId;

test('Vorbereitung: Fach mit Klausur', async () => {
  await post(lehrer, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  getDb().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'admin'").run();
  await post(lehrer, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sj = getDb().prepare('SELECT id FROM schuljahre').get().id;
  await post(lehrer, '/teacher/klassen/neu', { schuljahr_id: String(sj), name: '9B', notenschluessel: 'IHK' });
  const kid = getDb().prepare('SELECT id FROM klassen').get().id;
  await post(lehrer, `/teacher/klassen/${kid}/klassenlehrer/eintragen`, {});
  await post(lehrer, `/teacher/klassen/${kid}/faecher/neu`, { name: 'Deutsch' });
  fachId = getDb().prepare('SELECT id FROM faecher').get().id;
  await post(lehrer, `/teacher/fach/${fachId}/klausuren/neu`, { name: 'K1', aufgaben: '2', halbjahr: HJ });
});

const fachSeite = async () => (await lehrer(`/teacher/fach/${fachId}?hj=${encodeURIComponent(HJ)}`)).text();

test('Ohne gespeicherte Wahl bleibt data-an leer (der Browser-Speicher dient als Rückfall)', async () => {
  assert.match(await fachSeite(), /data-klausur-statistik data-an="" data-klausur=/);
});

test('Haken speichern: gilt serverseitig und kommt beim nächsten Laden zurück, auch nach Aus- und Einschalten', async () => {
  let r = await post(lehrer, '/konto/einstellung', { schluessel: 'statistik_an', wert: '1' });
  assert.equal(r.status, 200);
  assert.match(await fachSeite(), /data-klausur-statistik data-an="1"/);
  r = await post(lehrer, '/konto/einstellung', { schluessel: 'statistik_an', wert: '0' });
  assert.equal(r.status, 200);
  assert.match(await fachSeite(), /data-klausur-statistik data-an="0"/);
  await post(lehrer, '/konto/einstellung', { schluessel: 'statistik_an', wert: '1' });
  assert.equal(getDb().prepare("SELECT COUNT(*) AS c FROM user_einstellungen WHERE schluessel = 'statistik_an'").get().c, 1, 'ein Eintrag je Konto, wird überschrieben');
});

test('Ungültige Schlüssel/Werte werden abgelehnt; ohne Anmeldung kein Zugriff', async () => {
  assert.equal((await post(lehrer, '/konto/einstellung', { schluessel: 'irgendwas', wert: '1' })).status, 400);
  assert.equal((await post(lehrer, '/konto/einstellung', { schluessel: 'statistik_an', wert: 'ja' })).status, 400);
  assert.equal((await post(lehrer, '/konto/einstellung', { schluessel: 'statistik_an' })).status, 400);
  assert.notEqual((await post(anonym, '/konto/einstellung', { schluessel: 'statistik_an', wert: '1' })).status, 200);
  assert.equal(ladeEinstellung(1, 'irgendwas'), null);
  assert.equal(setzeEinstellung(1, 'statistik_an', '2'), false);
});

test('Einstellung gilt je Konto', async () => {
  const db = getDb();
  db.prepare("INSERT INTO users (username, display_name, role, active, auth_source, password_hash) VALUES ('zweite', 'Zweite', 'teacher', 1, 'ldap', 'x')").run();
  const zweite = db.prepare("SELECT id FROM users WHERE username = 'zweite'").get().id;
  assert.equal(ladeEinstellung(zweite, 'statistik_an'), null);
  setzeEinstellung(zweite, 'statistik_an', '0');
  assert.equal(ladeEinstellung(zweite, 'statistik_an'), '0');
  assert.equal(ladeEinstellung(db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id, 'statistik_an'), '1');
});

test('Skript: Server-Wert hat Vorrang, Browser-Speicher wird einmalig übernommen, Änderungen gehen an den Server', async () => {
  const js = await (await lehrer('/static/js/klausur-statistik.js')).text();
  assert.match(js, /panels\[0\]\.dataset\.an/);
  assert.match(js, /\/konto\/einstellung/);
  assert.match(js, /speichereAufServer\(an\)/);
  assert.match(js, /pageshow/);
});

test.after(async () => { await fastify.close(); });
