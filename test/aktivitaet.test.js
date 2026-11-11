/**
 * Aktivitätsstatistik (Admin → Aktivität): Zähler je Person/Tag/Stunde, Einteilung nach aktiven Tagen, Auslastung, Zugriffsschutz.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-aktivitaet-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-aktivitaet-test-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const akt = await import('../src/aktivitaet.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
test.after(() => fastify.close());

function client() {
  const cookies = new Map();
  return async (url, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(base + url, { ...opts, headers, redirect: 'manual' });
    for (const raw of r.headers.getSetCookie()) { const [k, ...v] = raw.split(';')[0].split('='); cookies.set(k.trim(), v.join('=')); }
    return r;
  };
}
const form = (req, url, body) => req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });

test('Hilfsfunktionen: Ortszeit (Sommer-/Winterzeit), Tage rechnen, Wochentag, Einteilung', () => {
  assert.deepEqual(akt.ortszeit(new Date('2026-07-01T22:30:00Z')), { tag: '2026-07-02', stunde: 0 }, 'Sommerzeit UTC+2');
  assert.deepEqual(akt.ortszeit(new Date('2026-01-15T23:30:00Z')), { tag: '2026-01-16', stunde: 0 }, 'Winterzeit UTC+1');
  assert.equal(akt.tagPlus('2026-03-01', -1), '2026-02-28');
  assert.equal(akt.tagPlus('2026-12-31', 1), '2027-01-01');
  assert.equal(akt.wochentag('2026-11-09'), 0, 'Montag');
  assert.equal(akt.wochentag('2026-11-15'), 6, 'Sonntag');
  assert.equal(akt.stufeFuerTage(0).id, 'keine');
  assert.equal(akt.stufeFuerTage(1).id, 'einmalig');
  assert.equal(akt.stufeFuerTage(4).id, 'wenig');
  assert.equal(akt.stufeFuerTage(5).id, 'regelmaessig');
  assert.equal(akt.stufeFuerTage(20).id, 'intensiv');
});

let admin, lehrer;
let ids;

test('Vorbereitung: Admin, vier Lehrkräfte mit unterschiedlicher Nutzung', async () => {
  admin = client();
  assert.equal((await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' })).status, 302);
  const db = getDb();
  const neu = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, 'x', 'teacher')");
  ids = {};
  for (const n of ['nie', 'einmal', 'wenig', 'intensiv']) ids[n] = neu.run(n, `Person ${n}`).lastInsertRowid;
  const jetzt = new Date('2026-11-11T10:00:00Z');
  const tag = (offset, stunde = 10, f = 1) => { const d = new Date(jetzt.getTime() - offset * 86400000); d.setUTCHours(stunde - 1); return d; };
  akt.erfasse(ids.einmal, { jetzt: tag(3) });
  akt.erfasse(ids.wenig, { jetzt: tag(1) });
  akt.erfasse(ids.wenig, { jetzt: tag(2), eingabe: true });
  for (let i = 0; i < 25; i++) { akt.erfasse(ids.intensiv, { jetzt: tag(i), eingabe: i % 2 === 0 }); akt.erfasse(ids.intensiv, { jetzt: tag(i) }); }
  akt.speichere();
  // Die Einrichtung (Anmeldung des Admins) geschah zur echten Uhrzeit -- für feste Zahlen hier entfernen.
  db.prepare("DELETE FROM nutzer_aktivitaet WHERE user_id = (SELECT id FROM users WHERE username = 'admin')").run();
  assert.ok(db.prepare('SELECT COUNT(*) AS c FROM nutzer_aktivitaet').get().c > 25);
});

test('Auswertung: Einteilung, Quoten, Aktiv-Zahlen, Ohne-Eingaben', () => {
  const a = akt.auswertung(30, new Date('2026-11-11T10:00:00Z'));
  const stufe = (n) => a.personen.find((p) => p.username === n).stufe;
  assert.equal(stufe('nie'), 'keine');
  assert.equal(stufe('einmal'), 'einmalig');
  assert.equal(stufe('wenig'), 'wenig');
  assert.equal(stufe('intensiv'), 'intensiv');
  assert.equal(a.konten, 5, 'Admin + 4');
  assert.equal(a.aktiveImZeitraum, 3);
  assert.equal(a.ohneEingaben, 1, 'nur die Person „einmal“ hat nie etwas geändert');
  assert.equal(a.wiederkehrend, 2);
  assert.equal(a.stufen.reduce((s, x) => s + x.anzahl, 0), a.konten);
  assert.equal(a.personen.find((p) => p.username === 'intensiv').tage, 25);
  assert.equal(a.personen.find((p) => p.username === 'wenig').eingaben, 1);
  assert.equal(a.verlauf.length, 30);
  assert.equal(a.verlauf.at(-1).start, '2026-11-11');
  assert.ok(a.spitzeNutzer.nutzer >= 1);
  const kurz = akt.auswertung(30, new Date('2026-11-11T10:00:00Z'));
  assert.equal(kurz.heat.flat().reduce((s, x) => s + x, 0), kurz.summeAnfragen, 'Heatmap summiert alle Anfragen');
});

test('Zeitraum 365 Tage fasst zu Wochen zusammen; Zeitraum begrenzt die Zählung', () => {
  const jetzt = new Date('2026-11-11T10:00:00Z');
  const jahr = akt.auswertung(365, jetzt);
  assert.equal(jahr.woche, true);
  assert.ok(jahr.verlauf.length <= 54 && jahr.verlauf.length >= 52);
  assert.ok(jahr.verlauf.every((v) => akt.wochentag(v.start) === 0), 'Wochen beginnen am Montag');
  const kurz = akt.auswertung(7, jetzt);
  assert.equal(kurz.personen.find((p) => p.username === 'intensiv').tage, 7);
});

test('Zugriff: nur Admin; Seite zeigt Einteilung und Konten; ungültiger Zeitraum -> 90 Tage', async () => {
  const anonym = await client()('/admin/aktivitaet');
  assert.ok([302, 401, 403].includes(anonym.status));
  getDb().prepare("UPDATE users SET password_hash = ? WHERE username = 'nie'").run((await import('../src/auth.js')).hashPassword('lehrerpass123'));
  lehrer = client();
  await form(lehrer, '/login', { username: 'nie', password: 'lehrerpass123' });
  assert.equal((await lehrer('/admin/aktivitaet')).status, 403);

  const r = await admin('/admin/aktivitaet?tage=abc');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Aktivität und Auslastung/);
  assert.match(html, /Einmal reingeschaut/);
  assert.match(html, /Person intensiv/);
  assert.match(html, /Letzte 90 Tage/);
  assert.match(html, /href="\/admin\/aktivitaet"/, 'Menüpunkt');
  assert.equal((await (await admin('/admin/aktivitaet?tage=30')).text()).includes('class="aktuell"'), true);
});

test('Anfragen eingeloggter Personen werden gezählt (Seitenaufruf vs. Eingabe), Statisches und Anonymes nicht', async () => {
  const db = getDb();
  akt.speichere();
  const summe = (n) => db.prepare('SELECT COALESCE(SUM(anfragen),0) AS a, COALESCE(SUM(eingaben),0) AS e FROM nutzer_aktivitaet WHERE user_id = (SELECT id FROM users WHERE username = ?)').get(n);
  const vorher = summe('admin');
  await admin('/static/css/app.css');
  await client()('/login');
  await admin('/hilfe/suche?q=klausur');
  akt.speichere();
  assert.deepEqual(summe('admin'), vorher, 'Dateien, Live-Suche und anonyme Anfragen zählen nicht');
  await admin('/admin');
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2030/31' });
  akt.speichere();
  const nachher = summe('admin');
  assert.equal(nachher.a - vorher.a, 2);
  assert.equal(nachher.e - vorher.e, 1, 'nur das POST ist eine Eingabe');
});

test('Anmeldung: Zeitpunkt und Zähler am Konto', async () => {
  const row = getDb().prepare("SELECT letzter_login, anmeldungen FROM users WHERE username = 'nie'").get();
  assert.equal(row.anmeldungen, 1);
  assert.ok(row.letzter_login);
  const a = akt.auswertung(90);
  assert.equal(a.personen.find((p) => p.username === 'nie').anmeldungen, 1);
  assert.ok(a.personen.find((p) => p.username === 'nie').tage >= 1, 'Anmeldung zählt als aktiver Tag');
});

test('Bereinigung löscht Zähler älter als die Aufbewahrungsfrist', () => {
  const db = getDb();
  db.prepare("INSERT INTO nutzer_aktivitaet (user_id, tag, stunde, anfragen) VALUES (?, '2020-01-01', 8, 5)").run(ids.nie);
  akt.bereinige(new Date('2026-11-11T10:00:00Z'));
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM nutzer_aktivitaet WHERE tag = '2020-01-01'").get().c, 0);
  assert.ok(db.prepare('SELECT COUNT(*) AS c FROM nutzer_aktivitaet').get().c > 0);
});
