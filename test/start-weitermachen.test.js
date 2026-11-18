/**
 * Startseite: „Weitermachen“ zeigt die zuletzt geöffneten Fächer dieser Anmeldung (höchstens drei, neueste zuerst), nur mit Zugriff,
 * und nichts davon überlebt das Abmelden (die Liste liegt nur in der Sitzung).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-weitermachen-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-weitermachen-bitte-lang-genug-xxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
test.after(() => fastify.close());

function client() {
  const cookies = new Map();
  return async (url, body) => {
    const headers = {};
    if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const opts = { headers, redirect: 'manual' };
    if (body) { opts.method = 'POST'; headers['content-type'] = 'application/x-www-form-urlencoded'; opts.body = new URLSearchParams(body); }
    const r = await fetch(base + url, opts);
    for (const raw of r.headers.getSetCookie?.() ?? []) { const [k, ...v] = raw.split(';')[0].split('='); cookies.set(k.trim(), v.join('=')); }
    return r;
  };
}
const db = () => getDb();
const admin = client(); const anna = client(); const ben = client();
const ids = {};
const start = async (c) => (await c('/start')).text();
const weiter = (html) => /<section class="weitermachen"[\s\S]*?<\/section>/.exec(html)?.[0] ?? null;

test('Vorbereitung: Anna mit vier Fächern, Ben ohne Zugriff', async () => {
  await admin('/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await admin('/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  for (const [c, n] of [[anna, 'anna'], [ben, 'ben']]) {
    await admin('/admin/einladungen/neu', { display_name: n, ttl_days: '14' });
    await c(`/einladung/${db().prepare('SELECT token FROM invitations ORDER BY id DESC').get().token}`, { username: n, display_name: n, password: 'passwort123', password2: 'passwort123' });
  }
  db().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'anna'").run();
  const sj = db().prepare('SELECT id FROM schuljahre').get().id;
  await anna('/teacher/klassen/neu', { schuljahr_id: String(sj), name: '12A', notenschluessel: 'BG', einschulung_jahr: '2025' });
  const k = db().prepare("SELECT id FROM klassen WHERE name = '12A'").get().id;
  for (const n of ['Englisch', 'Mathe', 'Politik', 'Sport']) {
    await anna(`/teacher/klassen/${k}/faecher/neu`, { name: n });
    ids[n] = db().prepare('SELECT id FROM faecher WHERE klasse_id = ? AND name = ?').get(k, n).id;
  }
});

test('Ohne geöffnetes Fach gibt es kein „Weitermachen“', async () => {
  assert.equal(weiter(await start(anna)), null);
});

test('Geöffnete Fächer erscheinen neueste zuerst, höchstens drei', async () => {
  for (const n of ['Englisch', 'Mathe', 'Politik', 'Sport']) assert.equal((await anna(`/teacher/fach/${ids[n]}`)).status, 200);
  const w = weiter(await start(anna));
  assert.ok(w, 'Abschnitt vorhanden');
  const titel = [...w.matchAll(/<a class="weitermachen-link" href="([^"]+)">📝 ([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(titel.map((t) => t[1]), ['Sport – 12A', 'Politik – 12A', 'Mathe – 12A']);
  assert.equal(titel[0][0], `/teacher/fach/${ids.Sport}`);
  // Englisch erneut öffnen: rückt nach vorn, ohne doppelt zu erscheinen
  await anna(`/teacher/fach/${ids.Englisch}`);
  const w2 = weiter(await start(anna));
  assert.deepEqual([...w2.matchAll(/📝 ([^<]+)</g)].map((m) => m[1]), ['Englisch – 12A', 'Sport – 12A', 'Politik – 12A']);
});

test('Nur Fächer mit Zugriff: eine fremde Fachseite (403) wird nicht gemerkt, ein entzogener Zugriff blendet aus', async () => {
  assert.equal(weiter(await start(ben)), null);
  assert.equal((await ben(`/teacher/fach/${ids.Mathe}`)).status, 403);
  assert.equal(weiter(await start(ben)), null, 'ein verweigerter Aufruf wird nicht gemerkt');
  // Zugriff entziehen: Fach Sport verschwindet aus der Liste
  db().prepare('DELETE FROM fach_zuweisungen WHERE fach_id = ?').run(ids.Sport);
  db().prepare('UPDATE klassen SET created_by_id = created_by_id').run();
  const w = weiter(await start(anna)) || '';
  assert.doesNotMatch(w, /Sport/);
});

test('Nach dem Abmelden ist nichts davon übrig (nur Sitzung)', async () => {
  await anna('/logout');
  db().prepare("UPDATE users SET auth_source = 'lokal' WHERE username = 'anna'").run(); // damit die Anmeldung per Passwort geht
  const neu = client();
  const login = await neu('/login', { username: 'anna', password: 'passwort123' });
  assert.equal(login.status, 302);
  const seite = await neu('/start');
  assert.equal(seite.status, 200, 'wirklich angemeldet');
  assert.equal(weiter(await seite.text()), null, 'neue Anmeldung: kein „Weitermachen“ aus der alten Sitzung');
  const spalten = db().prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  assert.ok(!spalten.some((n) => /zuletzt|weiter/i.test(n)), 'nichts am Konto gespeichert');
});
