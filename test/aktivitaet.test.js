/**
 * ANONYME Aktivitätsstatistik (Admin → Aktivität): Zähler ohne Kontobezug, Einteilung in Gruppen, Auslastung, Zugriffsschutz.
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

let admin;
let ids;
const JETZT = new Date('2026-11-11T10:00:00Z');

test('Vorbereitung: Admin, vier Lehrkräfte mit unterschiedlicher Nutzung', async () => {
  admin = client();
  assert.equal((await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' })).status, 302);
  const db = getDb();
  const neu = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, 'x', 'teacher')");
  ids = {};
  for (const n of ['nie', 'einmal', 'wenig', 'intensiv']) ids[n] = neu.run(`konto_${n}`, `Geheime Person ${n}`).lastInsertRowid;
  const tag = (offset) => { const d = new Date(JETZT.getTime() - offset * 86400000); d.setUTCHours(9); return d; };
  akt.erfasse(ids.einmal, { jetzt: tag(3) });
  akt.erfasse(ids.wenig, { jetzt: tag(1) });
  akt.erfasse(ids.wenig, { jetzt: tag(2), eingabe: true });
  for (let i = 0; i < 25; i++) { akt.erfasse(ids.intensiv, { jetzt: tag(i), eingabe: i % 2 === 0 }); akt.erfasse(ids.intensiv, { jetzt: tag(i) }); }
  akt.speichere();
  // Die Einrichtung (Anmeldung des Admins) geschah zur echten Uhrzeit -- für feste Zahlen die Zähler leeren und den Admin nicht mitzählen.
  db.prepare('DELETE FROM nutzung_tage WHERE tag > ?').run('2026-11-11');
  db.prepare("DELETE FROM nutzung_tage WHERE profil = ?").run(akt.profilFuer(1));
  assert.ok(db.prepare('SELECT COUNT(*) AS c FROM nutzung_tage').get().c > 25);
});

test('Anonymität: Tabellen enthalten keine Konto-Spalte, keine Namen, keine Uhrzeit je Zählwert', () => {
  const db = getDb();
  for (const t of ['nutzung_tage', 'nutzung_stunden']) {
    const spalten = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.ok(!spalten.some((n) => /user|konto|name|id$/i.test(n)), `${t}: ${spalten}`);
    assert.deepEqual(db.prepare(`PRAGMA foreign_key_list(${t})`).all(), [], 'kein Fremdschlüssel auf users');
  }
  assert.deepEqual(db.prepare('PRAGMA table_info(nutzung_tage)').all().map((c) => c.name), ['profil', 'tag', 'anfragen', 'eingaben'], 'Tag, aber keine Stunde je Zählwert');
  const inhalt = JSON.stringify([db.prepare('SELECT * FROM nutzung_tage').all(), db.prepare('SELECT * FROM nutzung_stunden').all()]);
  assert.ok(!/konto_|Geheime|admin/i.test(inhalt), 'keine Namen in den Zähltabellen');
  const p = akt.profilFuer(ids.einmal);
  assert.match(p, /^[0-9a-f]{20}$/);
  assert.notEqual(p, akt.profilFuer(ids.wenig));
  assert.equal(p, akt.profilFuer(ids.einmal), 'stabil, damit Tage derselben Person zählbar sind');
  assert.ok(!p.includes(String(ids.einmal)) || p.length === 20);
  assert.ok(!db.prepare('PRAGMA table_info(users)').all().some((c) => ['letzter_login', 'anmeldungen'].includes(c.name)), 'keine Nutzungsdaten am Konto');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'nutzer_aktivitaet'").get().c, 0, 'alte personenbezogene Tabelle entfernt');
});

test('Auswertung (anonym): Gruppen, Quoten, Aktiv-Zahlen, Ohne-Eingaben – und keine Einträge einzelner Personen', () => {
  const a = akt.auswertung(30, JETZT, { personen: false });
  const anzahl = (id) => a.stufen.find((s) => s.id === id).anzahl;
  assert.equal(a.konten, 5, 'Admin + 4 Konten');
  assert.equal(anzahl('einmalig'), 1);
  assert.equal(anzahl('wenig'), 1);
  assert.equal(anzahl('intensiv'), 1);
  assert.equal(anzahl('keine'), 2, 'Admin (hier ohne Zähler) und „nie“');
  assert.equal(a.aktiveImZeitraum, 3);
  assert.equal(a.ohneEingaben, 1, 'nur „einmal“ hat nie etwas geändert');
  assert.equal(a.wiederkehrend, 2);
  assert.equal(a.stufen.reduce((s, x) => s + x.anzahl, 0), a.konten);
  assert.equal(a.nieAktiv, 2);
  assert.equal(a.abstaende.reduce((s, x) => s + x.anzahl, 0) + a.nieAktiv, a.konten);
  assert.equal(a.verlauf.length, 30);
  assert.equal(a.verlauf.at(-1).start, '2026-11-11');
  assert.equal(a.spitzeNutzer.nutzer >= 1, true);
  assert.equal(a.heat.flat().reduce((s, x) => s + x, 0), a.summeAnfragen, 'Heatmap summiert alle Anfragen');
  assert.equal(a.kleineGruppe, true, 'unter 10 Konten: Hinweis');
  // Ergebnis enthält keine Personenliste
  assert.equal(a.personen, null);
  assert.ok(!/konto_|Geheime|admin/i.test(JSON.stringify(a)), 'keine Namen im Ergebnis');
});

test('Zeitraum 365 Tage fasst zu Wochen zusammen; Zeitraum begrenzt die Zählung', () => {
  const jahr = akt.auswertung(365, JETZT);
  assert.equal(jahr.woche, true);
  assert.ok(jahr.verlauf.length <= 54 && jahr.verlauf.length >= 52);
  assert.ok(jahr.verlauf.every((v) => akt.wochentag(v.start) === 0), 'Wochen beginnen am Montag');
  const kurz = akt.auswertung(7, JETZT);
  assert.equal(kurz.stufen.find((s) => s.id === 'intensiv').anzahl, 0, 'in 7 Tagen kann niemand 20 aktive Tage haben');
  assert.equal(kurz.stufen.find((s) => s.id === 'regelmaessig').anzahl, 1, '7 Tage = regelmäßig');
});

test('Profile ehemaliger Konten lassen die Grundgesamtheit nicht unter die Zahl der Aktiven fallen', () => {
  const db = getDb();
  db.prepare("UPDATE users SET active = 0 WHERE username IN ('konto_einmal','konto_wenig','konto_intensiv','konto_nie')").run();
  const a = akt.auswertung(30, JETZT);
  assert.ok(a.konten >= a.aktiveImZeitraum);
  assert.ok(a.stufen.every((s) => s.anzahl >= 0 && s.anteil <= 1));
  db.prepare("UPDATE users SET active = 1 WHERE username LIKE 'konto_%'").run();
});

test('Zugriff: nur Admin; Testphase zeigt Gruppen und die Konten mit Namen', async () => {
  assert.ok([302, 401, 403].includes((await client()('/admin/aktivitaet')).status));
  getDb().prepare("UPDATE users SET password_hash = ? WHERE username = 'konto_nie'").run((await import('../src/auth.js')).hashPassword('lehrerpass123'));
  const lehrer = client();
  await form(lehrer, '/login', { username: 'konto_nie', password: 'lehrerpass123' });
  assert.equal((await lehrer('/admin/aktivitaet')).status, 403);

  const r = await admin('/admin/aktivitaet?tage=abc');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Aktivität und Auslastung/);
  assert.match(html, /Testphase/);
  assert.match(html, /Einmal reingeschaut/);
  assert.match(html, /Letzte 90 Tage/);
  assert.match(html, /href="\/admin\/aktivitaet"/, 'Menüpunkt');
  assert.match(html, /Alle Konten/);
  assert.match(html, /Geheime Person intensiv/);
  assert.match(html, /konto_wenig/);
  assert.doesNotMatch(html, /So bleibt die Statistik anonym/, 'in der Testphase wird nicht Anonymität versprochen');
});

test('Testphase: Personenliste mit Zahlen je Konto (aus dem Zählwert errechnet, nichts am Konto gespeichert)', () => {
  const a = akt.auswertung(30, JETZT);
  assert.ok(Array.isArray(a.personen));
  const von = (n) => a.personen.find((p) => p.username === n);
  assert.equal(von('konto_intensiv').tage, 25);
  assert.equal(von('konto_intensiv').stufe, 'intensiv');
  assert.equal(von('konto_wenig').tage, 2);
  assert.equal(von('konto_wenig').eingaben, 1);
  assert.equal(von('konto_einmal').tage, 1);
  assert.equal(von('konto_nie').tage >= 0, true);
  assert.equal(von('konto_intensiv').name, 'Geheime Person intensiv');
  assert.equal(von('konto_einmal').letzterTag, '2026-11-08');
  assert.equal(a.personen[0].username, 'konto_intensiv', 'sortiert nach aktiven Tagen');
  // die Speicherung bleibt anonym
  const db = getDb();
  assert.deepEqual(db.prepare('PRAGMA table_info(nutzung_tage)').all().map((c) => c.name), ['profil', 'tag', 'anfragen', 'eingaben']);
});

test('Testphase beenden: AKTIVITAET_PERSONEN=0 schaltet die Personenansicht wieder aus', async () => {
  process.env.AKTIVITAET_PERSONEN = '0';
  try {
    assert.equal(akt.personenAnsichtAktiv(), false);
    assert.equal(akt.auswertung(30, JETZT).personen, null);
    const html = await (await admin('/admin/aktivitaet')).text();
    assert.match(html, /So bleibt die Statistik anonym/);
    assert.doesNotMatch(html, /Geheime Person|konto_(nie|einmal|wenig|intensiv)|Alle Konten|Testphase/);
  } finally {
    delete process.env.AKTIVITAET_PERSONEN;
  }
  assert.equal(akt.personenAnsichtAktiv(), true);
});

test('Anfragen eingeloggter Personen werden gezählt (Seitenaufruf vs. Eingabe), Statisches und Anonymes nicht', async () => {
  const db = getDb();
  akt.speichere();
  const summe = () => db.prepare('SELECT COALESCE(SUM(anfragen),0) AS a, COALESCE(SUM(eingaben),0) AS e FROM nutzung_stunden').get();
  const vorher = summe();
  await admin('/static/css/app.css');
  await client()('/login');
  await admin('/hilfe/suche?q=klausur');
  akt.speichere();
  assert.deepEqual(summe(), vorher, 'Dateien, Live-Suche und anonyme Anfragen zählen nicht');
  await admin('/admin');
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2030/31' });
  akt.speichere();
  const nachher = summe();
  assert.equal(nachher.a - vorher.a, 2);
  assert.equal(nachher.e - vorher.e, 1, 'nur das POST ist eine Eingabe');
});

test('Stundenzähler: verschiedene Personen je Stunde werden nicht doppelt gezählt, auch nicht über mehrere Speichervorgänge', () => {
  const db = getDb();
  const zeit = new Date('2031-03-03T10:30:00Z'); // 11 Uhr Ortszeit (Winterzeit)
  akt.erfasse(ids.einmal, { jetzt: zeit });
  akt.speichere();
  akt.erfasse(ids.einmal, { jetzt: zeit });
  akt.erfasse(ids.wenig, { jetzt: zeit });
  akt.speichere();
  const z = db.prepare("SELECT * FROM nutzung_stunden WHERE tag = '2031-03-03' AND stunde = 11").get();
  assert.equal(z.anfragen, 3);
  assert.equal(z.nutzer, 2);
  db.prepare("DELETE FROM nutzung_stunden WHERE tag = '2031-03-03'").run();
  db.prepare("DELETE FROM nutzung_tage WHERE tag = '2031-03-03'").run();
});

test('Anmeldung zählt wie ein Aufruf, ohne etwas am Konto zu vermerken', async () => {
  const vorher = JSON.stringify(getDb().prepare("SELECT * FROM users WHERE username = 'konto_nie'").get());
  akt.registriereAnmeldung(ids.nie);
  akt.speichere();
  assert.equal(JSON.stringify(getDb().prepare("SELECT * FROM users WHERE username = 'konto_nie'").get()), vorher);
});

test('Bereinigung löscht Zähler älter als die Aufbewahrungsfrist', () => {
  const db = getDb();
  db.prepare("INSERT INTO nutzung_tage (profil, tag, anfragen) VALUES ('alt', '2020-01-01', 5)").run();
  db.prepare("INSERT INTO nutzung_stunden (tag, stunde, anfragen) VALUES ('2020-01-01', 8, 5)").run();
  akt.bereinige(JETZT);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM nutzung_tage WHERE tag = '2020-01-01'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM nutzung_stunden WHERE tag = '2020-01-01'").get().c, 0);
  assert.ok(db.prepare('SELECT COUNT(*) AS c FROM nutzung_tage').get().c > 0);
});
