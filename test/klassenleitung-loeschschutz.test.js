/**
 * Klassenleitung, Löschschutz, Sammelklasse und Versetzen.
 *
 * - Als Klassenleitung eintragen kann sich jede Lehrkraft mit eigenem Fach in
 *   der Klasse (gewollt, auch nach einem Beitritt) -- die Klassenleitung kann
 *   aber keine Noten ANDERER Lehrkräfte vernichten: Fächer, Schüler/innen und
 *   Klassen mit fremden Noten löscht nur der Admin (src/loeschschutz.js).
 * - Die Sammelklasse "Ohne Klasse" verwaltet nur der Admin: wer eine Klasse
 *   löscht, wird nicht mehr ihre Klassenleitung (und sieht damit nicht die
 *   Noten aller dort geparkten Personen).
 * - Versetzen verlangt das Verwaltungsrecht an Quelle UND Ziel.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-kl-loeschschutz-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-klassenleitung-loeschschutz-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb, closeDb } = await import('../src/db.js');
const { hashPassword, makeToken, setLdapAuthenticatorForTests } = await import('../src/auth.js');
const { FakeAuthenticator } = await import('../src/auth/authenticator.js');

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
const form = (req, url, body = {}) => req(url, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body),
});
const db = () => getDb();
const id = (sql, ...p) => db().prepare(sql).get(...p)?.id;
const klasseVon = (schuelerId) => db().prepare('SELECT klasse_id FROM schueler WHERE id = ?').get(schuelerId).klasse_id;
const endnote = (fachId, schuelerId) => db()
  .prepare("INSERT INTO halbjahr_endnoten (fach_id, schueler_id, halbjahr, note) VALUES (?, ?, '1. Halbjahr', 2)").run(fachId, schuelerId);

const admin = client();
const opfer = client(); // legt Klassen an, hat Noten
const angreifer = client(); // tritt bei bzw. hat eine eigene Klasse
const dritte = client(); // ohne jedes Recht an den Klassen der anderen
let sjId;

test('Vorbereitung: Admin, Schuljahr, drei LDAP-Lehrkräfte', async () => {
  await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'geheim12', password2: 'geheim12' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2026/27' });
  sjId = id('SELECT id FROM schuljahre');
  for (const n of ['opfer', 'angreifer', 'dritte']) {
    db().prepare(`INSERT INTO users (username, display_name, password_hash, role, active, auth_source, login_sub)
                  VALUES (?, ?, ?, 'teacher', 1, 'ldap', ?)`).run(n, n, hashPassword(makeToken()), n);
  }
  setLdapAuthenticatorForTests(new FakeAuthenticator({ opfer: { passwort: 'p1' }, angreifer: { passwort: 'p2' }, dritte: { passwort: 'p3' } }));
  for (const [c, u, p] of [[opfer, 'opfer', 'p1'], [angreifer, 'angreifer', 'p2'], [dritte, 'dritte', 'p3']]) {
    assert.equal((await form(c, '/login', { username: u, password: p })).headers.get('location'), '/');
  }
});

// ---------- 2a/2b: Beitritt + Klassenleitung, aber kein Löschen fremder Noten ----------
let k10b; let mathe; let englisch; let erika;

test('Beitritt zu einer offenen Klasse und danach selbst Klassenleitung: bleibt möglich (gewollt)', async () => {
  await form(opfer, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '10B', notenschluessel: 'IHK', offen_fuer_beitritt: '1' });
  k10b = id("SELECT id FROM klassen WHERE name = '10B'");
  await form(opfer, `/teacher/klassen/${k10b}/faecher/neu`, { name: 'Mathe' });
  await form(opfer, `/teacher/klassen/${k10b}/schueler/neu`, { nachname: 'Muster', vorname: 'Erika' });
  mathe = id("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Mathe'", k10b);
  erika = id("SELECT id FROM schueler WHERE vorname = 'Erika'");
  endnote(mathe, erika);

  await form(angreifer, `/teacher/klassen/${k10b}/verknuepfen`, { fach: 'Englisch' });
  englisch = id("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Englisch'", k10b);
  assert.ok(englisch);
  await form(angreifer, `/teacher/klassen/${k10b}/klassenlehrer/eintragen`);
  assert.ok(db().prepare("SELECT 1 FROM klassenleitung kl JOIN users u ON u.id = kl.user_id WHERE kl.klasse_id = ? AND u.username = 'angreifer'").get(k10b));
});

test('Die neue Klassenleitung löscht kein Fach, keine Person und keine Klasse mit Noten anderer', async () => {
  let r = await form(angreifer, `/teacher/faecher/${mathe}/loeschen`);
  assert.equal(r.status, 403);
  assert.match(await r.text(), /Noten anderer Lehrkräfte \(Mathe\)/);
  assert.ok(db().prepare('SELECT 1 FROM faecher WHERE id = ?').get(mathe), 'Mathe samt Noten bleibt');

  r = await form(angreifer, `/teacher/schueler/${erika}/loeschen`);
  assert.equal(r.status, 403);
  assert.match(await r.text(), /Abgang/);
  assert.ok(db().prepare('SELECT 1 FROM schueler WHERE id = ?').get(erika));

  r = await form(angreifer, `/teacher/klassen/${k10b}/loeschen`);
  assert.equal(r.status, 403);
  assert.ok(db().prepare('SELECT 1 FROM klassen WHERE id = ?').get(k10b), 'die Klasse bleibt');
});

test('Auch "Zuordnung entfernen, dann als Fach ohne Lehrkraft löschen" geht nicht', async () => {
  const z = id("SELECT fz.id FROM fach_zuweisungen fz JOIN users u ON u.id = fz.user_id WHERE fz.fach_id = ? AND u.username = 'opfer'", mathe);
  await form(angreifer, `/teacher/zuweisungen/${z}/loeschen`);
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM fach_zuweisungen WHERE fach_id = ?').get(mathe).c, 0, 'Testannahme: Klassenleitung darf Zuordnungen entfernen');
  await form(angreifer, `/klassenlehrer/fach/${mathe}/loeschen`);
  assert.equal((await form(angreifer, `/teacher/faecher/${mathe}/loeschen`)).status, 403);
  assert.ok(db().prepare('SELECT 1 FROM faecher WHERE id = ?').get(mathe));
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM halbjahr_endnoten WHERE fach_id = ?').get(mathe).c, 1, 'die Note ist noch da');
});

test('Erlaubt bleibt: eigenes Fach mit eigenen Noten, leere Fächer, Personen ohne fremde Noten', async () => {
  endnote(englisch, erika);
  assert.equal((await form(angreifer, `/teacher/faecher/${englisch}/loeschen`)).status, 302);
  assert.equal(db().prepare('SELECT 1 FROM faecher WHERE id = ?').get(englisch), undefined, 'eigenes Fach gelöscht');

  await form(angreifer, `/teacher/klassen/${k10b}/faecher/neu`, { name: 'Leer' });
  const leer = id("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Leer'", k10b);
  db().prepare('DELETE FROM fach_zuweisungen WHERE fach_id = ?').run(leer); // auch ohne Zuordnung: keine Noten, also löschbar
  assert.equal((await form(angreifer, `/teacher/faecher/${leer}/loeschen`)).status, 302);
  assert.equal(db().prepare('SELECT 1 FROM faecher WHERE id = ?').get(leer), undefined);

  await form(angreifer, `/teacher/klassen/${k10b}/schueler/neu`, { nachname: 'Neu', vorname: 'Nina' });
  const nina = id("SELECT id FROM schueler WHERE vorname = 'Nina'");
  assert.equal((await form(angreifer, `/teacher/schueler/${nina}/loeschen`)).status, 302);
  assert.equal(db().prepare('SELECT 1 FROM schueler WHERE id = ?').get(nina), undefined);
});

test('Der Admin darf weiterhin alles löschen', async () => {
  assert.equal((await form(admin, `/teacher/schueler/${erika}/loeschen`)).status, 302);
  assert.equal(db().prepare('SELECT 1 FROM schueler WHERE id = ?').get(erika), undefined);
  assert.equal((await form(admin, `/teacher/klassen/${k10b}/loeschen`)).status, 302);
  assert.equal(db().prepare('SELECT 1 FROM klassen WHERE id = ?').get(k10b), undefined);
});

// ---------- 2c/2d: Sammelklasse und Versetzen ----------
let k10a; let fremd; let ben; let cem;

test('Eine Klasse löschen macht nicht zur Klassenleitung der Sammelklasse -- keine fremden Abgangszeugnisse', async () => {
  await form(opfer, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '10A', notenschluessel: 'IHK' });
  k10a = id("SELECT id FROM klassen WHERE name = '10A'");
  await form(opfer, `/teacher/klassen/${k10a}/faecher/neu`, { name: 'GeheimMathe' });
  for (const [n, v] of [['Beispiel', 'Ben'], ['Claus', 'Cem']]) await form(opfer, `/teacher/klassen/${k10a}/schueler/neu`, { nachname: n, vorname: v });
  ben = id("SELECT id FROM schueler WHERE vorname = 'Ben'");
  cem = id("SELECT id FROM schueler WHERE vorname = 'Cem'");
  endnote(id("SELECT id FROM faecher WHERE name = 'GeheimMathe'"), cem);
  assert.equal((await form(opfer, `/teacher/schueler/${cem}/versetzen`, { ziel_klasse_id: 'ohne-klasse' })).status, 302);
  const ablage = id('SELECT id FROM klassen WHERE ist_ablage = 1');
  assert.equal(klasseVon(cem), ablage);

  // Trick von früher: Dummy-Klasse mit einer Person anlegen und löschen.
  await form(angreifer, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: 'Dummy', notenschluessel: 'IHK' });
  const dummy = id("SELECT id FROM klassen WHERE name = 'Dummy'");
  await form(angreifer, `/teacher/klassen/${dummy}/schueler/neu`, { nachname: 'X', vorname: 'Y' });
  assert.equal((await form(angreifer, `/teacher/klassen/${dummy}/loeschen`)).status, 302);
  assert.equal(db().prepare('SELECT 1 FROM klassenleitung WHERE klasse_id = ?').get(ablage), undefined);
  assert.equal((await angreifer(`/teacher/schueler/${cem}/abgangszeugnis`)).status, 403);
});

test('Versetzen: ohne Recht an der Quelle (auch Sammelklasse) nicht, und nicht in fremde Klassen', async () => {
  await form(dritte, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: 'Fremd', notenschluessel: 'IHK' });
  fremd = id("SELECT id FROM klassen WHERE name = 'Fremd'");

  // Ohne jedes Recht: Person aus der Sammelklasse in die 10A des Opfers schieben.
  assert.equal((await form(dritte, `/teacher/schueler/${cem}/versetzen`, { ziel_klasse_id: String(k10a) })).status, 403);
  assert.equal(db().prepare('SELECT ist_ablage FROM klassen WHERE id = ?').get(klasseVon(cem)).ist_ablage, 1);

  // Ersteller/in der 10A schiebt Ben in die fremde Klasse "Fremd": nein.
  assert.equal((await form(opfer, `/teacher/schueler/${ben}/versetzen`, { ziel_klasse_id: String(fremd) })).status, 403);
  assert.equal(klasseVon(ben), k10a);
  // Die Auswahlliste bietet fremde Klassen gar nicht erst an.
  const html = await (await opfer(`/teacher/klassen/${k10a}`)).text();
  const dialog = html.slice(html.indexOf('<dialog id="versetzen-dialog"'), html.indexOf('</dialog>', html.indexOf('<dialog id="versetzen-dialog"')));
  assert.doesNotMatch(dialog, new RegExp(`value="${fremd}"`));
});

test('Versetzen erlaubt: in eigene Klassen und nach "Ohne Klasse"; zurück holt man über "Übernehmen"', async () => {
  await form(opfer, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '10C', notenschluessel: 'IHK' });
  const k10c = id("SELECT id FROM klassen WHERE name = '10C'");
  assert.equal((await form(opfer, `/teacher/schueler/${ben}/versetzen`, { ziel_klasse_id: String(k10c) })).status, 302);
  assert.equal(klasseVon(ben), k10c);
  await form(opfer, `/teacher/schueler/${ben}/versetzen`, { ziel_klasse_id: 'ohne-klasse' });
  assert.equal(db().prepare('SELECT ist_ablage FROM klassen WHERE id = ?').get(klasseVon(ben)).ist_ablage, 1);
  assert.equal((await form(opfer, `/teacher/klassen/${k10a}/schueler/aus-ablage`, { schueler_id: String(ben) })).status, 302);
  assert.equal(klasseVon(ben), k10a);
  // Der Admin darf auch direkt aus der Sammelklasse versetzen.
  assert.equal((await form(admin, `/teacher/schueler/${cem}/versetzen`, { ziel_klasse_id: String(fremd) })).status, 302);
  assert.equal(klasseVon(cem), fremd);
});

test('Migration (Schema 23): bestehende Klassenleitungen der Sammelklasse werden entfernt', () => {
  const ablage = id('SELECT id FROM klassen WHERE ist_ablage = 1');
  const angreiferId = id("SELECT id FROM users WHERE username = 'angreifer'");
  db().prepare('INSERT INTO klassenleitung (klasse_id, user_id) VALUES (?, ?)').run(ablage, angreiferId);
  db().prepare('INSERT OR IGNORE INTO klassenleitung (klasse_id, user_id) VALUES (?, ?)').run(k10a, angreiferId);
  db().prepare("UPDATE schema_meta SET value = '22' WHERE key = 'version'").run();
  closeDb();
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM klassenleitung WHERE klasse_id = ?').get(ablage).c, 0);
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM klassenleitung WHERE klasse_id = ?').get(k10a).c, 1, 'echte Klassen bleiben unberührt');
  assert.equal(db().prepare("SELECT value FROM schema_meta WHERE key = 'version'").get().value, '23');
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
