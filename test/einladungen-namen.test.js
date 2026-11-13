/**
 * Einladungen: Der Anzeigename steht in der Liste (Admin und Klassenleitung); ohne Eingabe wird ein zufälliger Name aus dem Star-Trek-Universum
 * vergeben, der nur als Etikett dient (nicht in der Mail-Anrede, nicht als Name des neuen Kontos).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-einladungen-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-einladungen-bitte-lang-genug-xxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { STARTREK_NAMEN, zufaelligerStartrekName } = await import('../src/startrek-namen.js');
const { baueEinladungsMailtoLink } = await import('../src/format.js');
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
const admin = client();
const leitung = client();
const neu = client();
const letzte = () => db().prepare('SELECT * FROM invitations ORDER BY id DESC').get();

test('Namensliste: viele Einträge, eindeutig, aus verschiedenen Bereichen', () => {
  assert.ok(STARTREK_NAMEN.length >= 250);
  assert.equal(new Set(STARTREK_NAMEN.map((n) => n.toLowerCase())).size, STARTREK_NAMEN.length, 'keine Doppelten');
  for (const n of ['Worf', 'USS Enterprise', 'Deep Space Nine', 'Phaser', 'Bat’leth', 'Warpantrieb']) assert.ok(STARTREK_NAMEN.includes(n), n);
  assert.ok(STARTREK_NAMEN.every((n) => n === n.trim() && n.length > 0 && n.length <= 60));
});

test('Zufallsname: vermeidet vergebene Namen, ist mit fester Zufallsquelle reproduzierbar, bleibt auch bei Erschöpfung eindeutig', () => {
  assert.equal(zufaelligerStartrekName([], () => 0), STARTREK_NAMEN[0]);
  assert.equal(zufaelligerStartrekName([], () => 0.9999), STARTREK_NAMEN.at(-1));
  assert.equal(zufaelligerStartrekName([STARTREK_NAMEN[0].toUpperCase()], () => 0), STARTREK_NAMEN[1], 'Groß-/Kleinschreibung egal');
  const belegt = [];
  for (let i = 0; i < STARTREK_NAMEN.length; i++) belegt.push(zufaelligerStartrekName(belegt));
  assert.equal(new Set(belegt).size, STARTREK_NAMEN.length, 'alle verschieden');
  const wieder = zufaelligerStartrekName(belegt, () => 0);
  assert.match(wieder, / II$/, 'alle vergeben: römische Zahl');
  assert.ok(!belegt.includes(wieder));
  assert.ok(STARTREK_NAMEN.includes(zufaelligerStartrekName()));
});

test('Vorbereitung: Admin und eine Klassenleitung', async () => {
  await admin('/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await admin('/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  await admin('/admin/einladungen/neu', { display_name: 'Lena Leitung', ttl_days: '14' });
  await leitung(`/einladung/${letzte().token}`, { username: 'lena', display_name: 'Lena', password: 'passwort123', password2: 'passwort123' });
  db().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'lena'").run();
  const sj = db().prepare('SELECT id FROM schuljahre').get().id;
  await leitung('/teacher/klassen/neu', { schuljahr_id: String(sj), name: '12A', notenschluessel: 'IHK', einschulung_jahr: '2025' });
  const k = db().prepare("SELECT id FROM klassen WHERE name = '12A'").get().id;
  db().prepare('INSERT INTO klassenleitung (klasse_id, user_id) SELECT ?, id FROM users WHERE username = ?').run(k, 'lena');
});

test('Admin: eingegebener Name wird gespeichert und in der Liste angezeigt', async () => {
  const r = await admin('/admin/einladungen/neu', { display_name: '  Frau Müller  ', email: 'mueller@schule.de', ttl_days: '7' });
  assert.equal(r.status, 302);
  const e = letzte();
  assert.equal(e.display_name, 'Frau Müller');
  assert.equal(e.name_generiert, 0);
  const html = await (await admin('/admin/einladungen')).text();
  assert.match(html, /<th>Name<\/th>/);
  assert.match(html, /<strong>Frau Müller<\/strong>/);
  assert.match(html, /mueller@schule\.de/);
  assert.doesNotMatch(html.split('Frau Müller')[1].slice(0, 400), /zufällig/, 'eingegebene Namen sind nicht als zufällig markiert');
});

test('Admin: ohne Anzeigename wird ein zufälliger Star-Trek-Name vergeben, in der Liste markiert, je Einladung verschieden', async () => {
  const namen = [];
  for (let i = 0; i < 5; i++) {
    await admin('/admin/einladungen/neu', { display_name: '   ', ttl_days: '14' });
    const e = letzte();
    assert.equal(e.name_generiert, 1);
    assert.ok(STARTREK_NAMEN.includes(e.display_name), e.display_name);
    namen.push(e.display_name);
  }
  assert.equal(new Set(namen).size, 5, 'Etiketten offener Einladungen sind eindeutig');
  const html = await (await admin('/admin/einladungen')).text();
  assert.match(html, new RegExp(`<strong>${namen[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</strong>`.replace('’', '(?:’|&#39;)')));
  assert.match(html, /🖖 zufällig/);
  // Rückmeldung nach dem Anlegen (Meldung erscheint beim nächsten Aufruf der Liste)
  await admin('/admin/einladungen/neu', { display_name: '', ttl_days: '14' });
  const flash = await (await admin('/admin/einladungen')).text();
  assert.match(flash, /Einladung für .* erstellt \(zufälliger Name/);
});

test('Mail-Anrede: eingegebener Name ja, zufälliges Etikett nein', () => {
  const mit = decodeURIComponent(baueEinladungsMailtoLink({ display_name: 'Frau Müller', name_generiert: 0, expires_at: null }, 'https://x/einladung/t'));
  assert.match(mit, /Hallo Frau Müller,/);
  const ohne = decodeURIComponent(baueEinladungsMailtoLink({ display_name: 'Worf', name_generiert: 1, expires_at: null }, 'https://x/einladung/t'));
  assert.match(ohne, /Hallo,/);
  assert.doesNotMatch(ohne, /Worf/);
  const html = baueEinladungsMailtoLink({ display_name: null, name_generiert: 0 }, 'https://x');
  assert.match(decodeURIComponent(html), /Hallo,/);
});

test('Einlösen: zufälliges Etikett wird weder angezeigt noch als Name übernommen; eingegebener Name schon', async () => {
  await admin('/admin/einladungen/neu', { display_name: '', ttl_days: '14' });
  const gen = letzte();
  const seite = await (await neu(`/einladung/${gen.token}`)).text();
  assert.doesNotMatch(seite, new RegExp(gen.display_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('’', '(?:’|&#39;)')), 'Etikett nicht auf der Einladungsseite');
  assert.match(seite, /name="display_name" value=""/, 'Feld nicht vorbelegt');
  await neu(`/einladung/${gen.token}`, { username: 'tom', display_name: '', password: 'passwort123', password2: 'passwort123' });
  const tom = db().prepare("SELECT display_name, invited_by_id FROM users WHERE username = 'tom'").get();
  assert.equal(tom.display_name, 'tom', 'ohne eigene Eingabe der Benutzername, nicht das Etikett');
  assert.equal(tom.invited_by_id, db().prepare("SELECT id FROM users WHERE username = 'admin'").get().id, 'eingeladen von');

  await admin('/admin/einladungen/neu', { display_name: 'Herr Schmidt', ttl_days: '14' });
  const mit = letzte();
  const seite2 = await (await client()(`/einladung/${mit.token}`)).text();
  assert.match(seite2, /Herr Schmidt/);
  await client()(`/einladung/${mit.token}`, { username: 'schmidt', display_name: '', password: 'passwort123', password2: 'passwort123' });
  assert.equal(db().prepare("SELECT display_name FROM users WHERE username = 'schmidt'").get().display_name, 'Herr Schmidt');

  const liste = await (await admin('/admin/einladungen')).text();
  assert.match(liste, /eingelöst/);
  assert.match(liste, /von tom/);
});

test('Klassenleitung: gleiche Regeln in der eigenen Einladungsliste', async () => {
  await leitung('/teacher/einladungen/neu', { display_name: 'Herr Weber', ttl_days: '14' });
  assert.equal(letzte().display_name, 'Herr Weber');
  await leitung('/teacher/einladungen/neu', { display_name: '', ttl_days: '14' });
  const e = letzte();
  assert.equal(e.name_generiert, 1);
  assert.ok(STARTREK_NAMEN.includes(e.display_name));
  assert.equal(e.created_by_id, db().prepare("SELECT id FROM users WHERE username = 'lena'").get().id);
  const html = await (await leitung('/teacher/einladungen')).text();
  assert.match(html, /<th>Name<\/th>/);
  assert.match(html, /<strong>Herr Weber<\/strong>/);
  assert.match(html, /🖖 zufällig/);
  assert.match(html, /Star-Trek-Universum/, 'Hinweis am Formular');
});

test('Sehr langer Name wird gekürzt', async () => {
  await admin('/admin/einladungen/neu', { display_name: 'X'.repeat(300), ttl_days: '14' });
  assert.equal(letzte().display_name.length, 100);
});
