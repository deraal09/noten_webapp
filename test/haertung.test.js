/**
 * Härtung (Phase D):
 * - Weiterleitungsziele nur innerhalb der Anwendung (kein "/\evil.example" nach dem Login oder beim Notenschlüssel-Hinweis).
 * - Auf Halbjahre begrenzte Zuordnung: Routen prüfen das Halbjahr, mit dem sie tatsächlich arbeiten -- auch ohne hj.
 * - Punkte, Noten und Notizen nur für Teilnehmer/innen des Fachs.
 * - WebDAV nur per https (außer localhost).
 * - Neue Sitzung beim Login (Session-Fixation), Beenden aller LDAP-Sitzungen auf Wunsch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-haertung-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-haertung-lang-genug-xxxxxxxxxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { hashPassword, makeToken, setLdapAuthenticatorForTests } = await import('../src/auth.js');
const { FakeAuthenticator } = await import('../src/auth/authenticator.js');
const { sicheresZiel } = await import('../src/weiterleitung.js');
const { pruefeEingabe } = await import('../src/backup/einstellungen.js');
const { halbjahrText, klassenLaufzeit, aktuellesHalbjahrDerKlasse, jetzt } = await import('../src/klassen-jahre.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });

function client() {
  const cookies = new Map();
  const req = async (url, opts = {}) => {
    const headers = { ...opts.headers };
    if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(base + url, { ...opts, headers, redirect: 'manual' });
    for (const raw of r.headers.getSetCookie()) { const [k, ...v] = raw.split(';')[0].split('='); cookies.set(k.trim(), v.join('=').trim()); }
    return r;
  };
  req.cookies = cookies;
  return req;
}
const form = (req, url, body = {}) => req(url, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body),
});
const db = () => getDb();
const admin = client();
const lehrer = client();
let lehrerId; let klasseId; let fachId; let teilnehmer; let fremd; let hjAktuell; let hjAnders;

test('Vorbereitung: Klasse mit Fach, Teilnehmerin, fremde Person; LDAP-Lehrkraft nur für ein Halbjahr zugeordnet', async () => {
  await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'geheim12', password2: 'geheim12' });
  db().prepare("INSERT INTO schuljahre (id, bezeichnung) VALUES (1, '2025/26')").run();
  klasseId = Number(db().prepare("INSERT INTO klassen (schuljahr_id, name, notenschluessel) VALUES (1, '10A', 'IHK')").run().lastInsertRowid);
  const andereKlasse = Number(db().prepare("INSERT INTO klassen (schuljahr_id, name, notenschluessel) VALUES (1, '10B', 'IHK')").run().lastInsertRowid);
  fachId = Number(db().prepare("INSERT INTO faecher (klasse_id, name) VALUES (?, 'Mathe')").run(klasseId).lastInsertRowid);
  teilnehmer = Number(db().prepare("INSERT INTO schueler (klasse_id, nachname, vorname) VALUES (?, 'Muster', 'Erika')").run(klasseId).lastInsertRowid);
  fremd = Number(db().prepare("INSERT INTO schueler (klasse_id, nachname, vorname) VALUES (?, 'Fremd', 'Felix')").run(andereKlasse).lastInsertRowid);
  db().prepare('INSERT INTO fach_teilnehmer (fach_id, schueler_id) VALUES (?, ?)').run(fachId, teilnehmer);
  lehrerId = Number(db().prepare(`INSERT INTO users (username, display_name, password_hash, role, active, auth_source, login_sub)
    VALUES ('lehrer', 'Lehrer', ?, 'teacher', 1, 'ldap', 'lehrer')`).run(hashPassword(makeToken())).lastInsertRowid);
  setLdapAuthenticatorForTests(new FakeAuthenticator({ lehrer: { passwort: 'pw-lehrer' } }));
  // Zuordnung nur für ein anderes Halbjahr als das aktuelle (auf das Routen ohne hj zurückfallen).
  hjAktuell = aktuellesHalbjahrDerKlasse(klassenLaufzeit(klasseId), jetzt());
  const nrAktuell = Number.parseInt(hjAktuell, 10);
  const nrAnders = nrAktuell === 1 ? 2 : 1;
  hjAnders = halbjahrText(nrAnders);
  db().prepare('INSERT INTO fach_zuweisungen (user_id, fach_id, halbjahre) VALUES (?, ?, ?)').run(lehrerId, fachId, JSON.stringify([nrAnders]));
});

test('Weiterleitungsziele: nur Pfade dieser Anwendung', () => {
  assert.equal(sicheresZiel('/teacher/klassen?hj=2'), '/teacher/klassen?hj=2');
  for (const boese of ['//evil.example', '/\\evil.example', '/\t/evil.example', '/\n/evil.example', 'https://evil.example', 'evil', '', null]) {
    assert.equal(sicheresZiel(boese, '/x'), '/x', JSON.stringify(boese));
  }
});

test('Login mit next=/\\evil.example landet nicht auf der fremden Seite', async () => {
  const c = client();
  let r = await form(c, '/login', { username: 'lehrer', password: 'pw-lehrer', next: '/\\evil.example/login' });
  assert.equal(r.headers.get('location'), '/');
  r = await form(c, '/login', { username: 'lehrer', password: 'pw-lehrer', next: '/teacher/klassen' });
  assert.equal(r.headers.get('location'), '/teacher/klassen', 'eigene Pfade bleiben erlaubt');
});

test('Notenschlüssel-Hinweis "Verstanden": weiter=/\\evil.example führt auf /start', async () => {
  assert.equal((await form(lehrer, '/login', { username: 'lehrer', password: 'pw-lehrer' })).status, 302);
  const r = await form(lehrer, '/notenschluessel/gelesen', { weiter: '/\\evil.example' });
  assert.equal(r.headers.get('location'), '/start');
});

test('Login vergibt eine neue Sitzungs-ID; die alte Sitzung ist danach ungültig', async () => {
  const c = client();
  await form(c, '/login', { username: 'lehrer', password: 'pw-lehrer' });
  const erste = [...c.cookies.values()].join(';');
  assert.ok(erste, 'Testannahme: nach dem Login gibt es ein Sitzungs-Cookie');
  const alt = client();
  for (const [k, v] of c.cookies) alt.cookies.set(k, v);
  await form(c, '/login', { username: 'lehrer', password: 'pw-lehrer' });
  assert.notEqual([...c.cookies.values()].join(';'), erste, 'neue Sitzungs-ID');
  assert.equal((await c('/teacher')).status, 200, 'die neue Sitzung ist angemeldet');
  assert.ok([302, 401].includes((await alt('/teacher')).status), 'die alte Sitzungs-ID ist nicht mehr angemeldet');
});

test('Halbjahres-Zuordnung: ohne hj greift die Prüfung für das tatsächlich verwendete (aktuelle) Halbjahr', async () => {
  // Lesen: Notenbesprechung und Notenliste ohne hj fallen auf das aktuelle Halbjahr zurück -- dort nicht zugeordnet.
  assert.equal((await lehrer(`/teacher/fach/${fachId}/besprechung/${teilnehmer}`)).status, 403);
  assert.equal((await lehrer(`/teacher/fach/${fachId}/noten`, { headers: { accept: 'application/json' } })).status, 403);
  // Schreiben: Klausur ohne halbjahr würde im aktuellen Halbjahr angelegt.
  assert.equal((await form(lehrer, `/teacher/fach/${fachId}/klausuren/neu`, { name: 'K1', aufgaben: '1' })).status, 403);
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM klausuren').get().c, 0);
  // Im zugeordneten Halbjahr geht alles.
  assert.equal((await lehrer(`/teacher/fach/${fachId}/besprechung/${teilnehmer}?hj=${encodeURIComponent(hjAnders)}`)).status, 200);
  assert.equal((await form(lehrer, `/teacher/fach/${fachId}/klausuren/neu`, { name: 'K1', aufgaben: '1', halbjahr: hjAnders })).status, 302);
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM klausuren WHERE halbjahr = ?').get(hjAnders).c, 1);
});

test('Punkte, Extrapunkte, Termin-Noten und Notizen nur für Teilnehmer/innen des Fachs', async () => {
  const kid = db().prepare('SELECT id FROM klausuren').get().id;
  let r = await form(lehrer, `/teacher/klausuren/${kid}/punkte`, { schueler_id: String(fremd), aufgabe_idx: '0', wert: '1' });
  assert.equal(r.status, 404);
  r = await form(lehrer, `/teacher/klausuren/${kid}/extrapunkte`, { schueler_id: String(fremd), wert: '1' });
  assert.equal(r.status, 404);
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM klausur_ergebnisse WHERE schueler_id = ?').get(fremd).c, 0);
  const tid = db().prepare("INSERT INTO unterricht_termine (fach_id, halbjahr, datum) VALUES (?, ?, '2025-09-01')").run(fachId, hjAnders).lastInsertRowid;
  assert.equal((await form(lehrer, `/teacher/unterricht/termine/${tid}/note`, { schueler_id: String(fremd), wert: '2' })).status, 404);
  assert.equal((await form(lehrer, `/teacher/fach/${fachId}/besprechung/${fremd}/notiz`, { halbjahr: hjAnders, text: 'x', typ: 'konferenz' })).status, 404);
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM notenbesprechung_notizen WHERE schueler_id = ?').get(fremd).c, 0);
  // Für die Teilnehmerin funktioniert es.
  assert.equal((await form(lehrer, `/teacher/unterricht/termine/${tid}/note`, { schueler_id: String(teilnehmer), wert: '2' })).status, 200);
  assert.equal((await form(lehrer, `/teacher/fach/${fachId}/besprechung/${teilnehmer}/notiz`, { halbjahr: hjAnders, text: 'gut' })).status, 302);
});

test('WebDAV nur per https -- http:// nur für localhost', () => {
  const basis = { typ: 'webdav', intervall_stunden: '24', aufbewahren: '7' };
  assert.equal(pruefeEingabe({ ...basis, ziel: 'http://nas.schule.local/dav' }).ok, false);
  assert.equal(pruefeEingabe({ ...basis, ziel: 'https://nas.schule.local/dav' }).ok, true);
  assert.equal(pruefeEingabe({ ...basis, ziel: 'http://127.0.0.1:8080/dav' }).ok, true);
  assert.equal(pruefeEingabe({ ...basis, ziel: 'http://localhost/dav' }).ok, true);
});

test('LDAP-Einstellungen: auf Wunsch alle laufenden LDAP-Anmeldungen beenden, lokale bleiben', async () => {
  assert.equal((await lehrer('/teacher')).status, 200);
  const r = await form(admin, '/admin/ldap/einstellungen', { url: 'ldap://example.invalid', base_dn: 'dc=x', ldap_sitzungen_beenden: '1' });
  assert.equal(r.status, 302);
  assert.ok([302, 401].includes((await lehrer('/teacher')).status), 'die LDAP-Lehrkraft muss sich neu anmelden');
  assert.equal((await admin('/admin')).status, 200, 'der lokale Admin bleibt angemeldet');
  // Ohne Haken bleiben die Sitzungen bestehen.
  await form(lehrer, '/login', { username: 'lehrer', password: 'pw-lehrer' });
  await form(admin, '/admin/ldap/einstellungen', { url: 'ldap://example.invalid', base_dn: 'dc=x' });
  assert.equal((await lehrer('/teacher')).status, 200);
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
