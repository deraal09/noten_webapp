/**
 * Beitritt zu einer Klasse und Löschrechte.
 *
 * Seit dem Beitritt per Freigabe-Flag (klassen.offen_fuer_beitritt, siehe
 * src/klassen-verknuepfung.js) bekommt jede LDAP-Lehrkraft ohne Rückfrage
 * eine Fach-Zuweisung in einer freigegebenen Klasse. Früher reichte genau
 * diese eine Zuweisung (userHatKlassenZugriff), um Fächer und Schüler/innen
 * ANDERER Lehrkräfte zu löschen — per ON DELETE CASCADE samt aller Noten.
 * Und die Freigabe war beim Anlegen einer Klasse vorbelegt.
 *
 * Jetzt:
 * - Die Freigabe ist beim Anlegen NICHT mehr vorbelegt.
 * - Fächer/Schüler/innen löschen, Abgang eintragen/rückgängig machen und das
 *   Abgangszeugnis (Noten ALLER Fächer) gibt es nur für Admin, Ersteller/in
 *   und Klassenleitung (userDarfKlasseVerwalten).
 * - Einen Kurs darf nur löschen, wer ihm als einzige Lehrkraft zugeordnet
 *   ist (sonst würden die Noten der anderen mitgelöscht) — oder der Admin.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-beitritt-loeschen-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-beitritt-loeschrechte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
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
const form = (req, url, body) => req(url, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body),
});

const db = () => getDb();
const admin = client();
const ersteller = client(); // legt die Klasse an
const beigetreten = client(); // tritt der freigegebenen Klasse bei
const klassenleitung = client(); // Co-Klassenleitung, nicht Ersteller/in
let sjId;
let klasseId;
let matheId;
let englischId;
let schuelerId;

/** Lehrkraft mit LDAP-Konto anlegen (nur solche dürfen Klassen anlegen/beitreten). */
function ldapKonto(name) {
  const info = db().prepare(`INSERT INTO users (username, display_name, password_hash, role, active, auth_source, login_sub)
                             VALUES (?, ?, ?, 'teacher', 1, 'ldap', ?)`).run(name, name, hashPassword(makeToken()), name);
  return Number(info.lastInsertRowid);
}

test('Vorbereitung: Admin, Schuljahr, drei LDAP-Lehrkräfte', async () => {
  let r = await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'geheim12', password2: 'geheim12',
  });
  assert.equal(r.status, 302);
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2026/27' });
  sjId = db().prepare('SELECT id FROM schuljahre').get().id;

  ldapKonto('ersteller');
  ldapKonto('beigetreten');
  ldapKonto('kl');
  setLdapAuthenticatorForTests(new FakeAuthenticator({
    ersteller: { passwort: 'pw-ersteller' },
    beigetreten: { passwort: 'pw-beigetreten' },
    kl: { passwort: 'pw-kl' },
  }));
  for (const [req, u, pw] of [[ersteller, 'ersteller', 'pw-ersteller'], [beigetreten, 'beigetreten', 'pw-beigetreten'], [klassenleitung, 'kl', 'pw-kl']]) {
    r = await form(req, '/login', { username: u, password: pw });
    assert.equal(r.headers.get('location'), '/', `Login ${u}`);
  }
});

test('Die Freigabe für automatischen Beitritt ist beim Anlegen nicht vorbelegt', async () => {
  const html = await (await ersteller('/teacher/klassen')).text();
  const checkboxen = html.match(/<input[^>]*name="offen_fuer_beitritt"[^>]*>/g) || [];
  assert.ok(checkboxen.length >= 1, 'Testannahme: das Anlegeformular hat die Checkbox');
  for (const c of checkboxen) assert.ok(!/\bchecked\b/.test(c), `vorbelegt: ${c}`);
});

test('Ohne Freigabe kann niemand einfach beitreten', async () => {
  let r = await form(ersteller, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: 'Geschlossen', notenschluessel: 'IHK' });
  assert.equal(r.status, 302);
  const id = db().prepare("SELECT id, offen_fuer_beitritt FROM klassen WHERE name = 'Geschlossen'").get();
  assert.equal(id.offen_fuer_beitritt, 0, 'ohne Haken bleibt die Klasse geschlossen');

  r = await form(beigetreten, `/teacher/klassen/${id.id}/verknuepfen`, { fach: 'Physik' });
  assert.equal(r.headers.get('location'), '/teacher/klassen');
  const zuweisung = db().prepare(`SELECT 1 FROM fach_zuweisungen fz JOIN faecher f ON f.id = fz.fach_id
                                  JOIN users u ON u.id = fz.user_id
                                  WHERE f.klasse_id = ? AND u.username = 'beigetreten'`).get(id.id);
  assert.equal(zuweisung, undefined);
});

test('Freigegebene Klasse: Beitritt klappt weiterhin sofort (gewolltes Verhalten)', async () => {
  let r = await form(ersteller, '/teacher/klassen/neu', {
    schuljahr_id: String(sjId), name: '10A', notenschluessel: 'IHK', offen_fuer_beitritt: '1',
  });
  assert.equal(r.status, 302);
  klasseId = db().prepare("SELECT id FROM klassen WHERE name = '10A'").get().id;
  await form(ersteller, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Mathe' });
  await form(ersteller, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Musterfrau', vorname: 'Erika' });
  matheId = db().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Mathe'").get(klasseId).id;
  schuelerId = db().prepare('SELECT id FROM schueler WHERE klasse_id = ?').get(klasseId).id;

  r = await form(beigetreten, `/teacher/klassen/${klasseId}/verknuepfen`, { fach: 'Englisch' });
  assert.equal(r.headers.get('location'), `/teacher/klassen/${klasseId}`);
  englischId = db().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Englisch'").get(klasseId).id;

  // Der eigentliche Zweck des Beitritts bleibt: im eigenen Fach arbeiten.
  assert.equal((await beigetreten(`/teacher/fach/${englischId}`)).status, 200);
  assert.equal((await beigetreten(`/teacher/klassen/${klasseId}`)).status, 200);
});

test('Nach dem Beitritt: keine Fächer oder Schüler/innen anderer löschen', async () => {
  let r = await form(beigetreten, `/teacher/faecher/${matheId}/loeschen`, {});
  assert.equal(r.status, 403);
  assert.match(await r.text(), /nur die Klassenleitung/);
  assert.ok(db().prepare('SELECT 1 FROM faecher WHERE id = ?').get(matheId), 'Mathe (samt Noten) muss noch da sein');

  r = await form(beigetreten, `/teacher/schueler/${schuelerId}/loeschen`, {});
  assert.equal(r.status, 403);
  assert.ok(db().prepare('SELECT 1 FROM schueler WHERE id = ?').get(schuelerId), 'die Schülerin muss noch da sein');
});

test('Nach dem Beitritt: auch kein Abgang, kein Reaktivieren, kein Abgangszeugnis', async () => {
  assert.equal((await form(beigetreten, `/teacher/schueler/${schuelerId}/abgang`, {})).status, 403);
  assert.equal(db().prepare('SELECT status FROM schueler WHERE id = ?').get(schuelerId).status, 'aktiv');
  assert.equal((await form(beigetreten, `/teacher/schueler/${schuelerId}/reaktivieren`, {})).status, 403);
  // Das Abgangszeugnis zeigt die Noten ALLER Fächer der Person — nicht nur
  // die des eigenen.
  assert.equal((await beigetreten(`/teacher/schueler/${schuelerId}/abgangszeugnis`)).status, 403);
});

test('Das eigene Fach löscht nach einem Beitritt ebenfalls die Klassenleitung', async () => {
  // Bewusste Regel: Beim Beitritt mit einem schon vorhandenen Fachnamen wird
  // man diesem Fach zugeordnet (fachAnlegenOderFinden) — "eigenes" Fach ist
  // also kein verlässliches Kriterium.
  const r = await form(beigetreten, `/teacher/faecher/${englischId}/loeschen`, {});
  assert.equal(r.status, 403);
});

test('Die Klassenseite zeigt nach dem Beitritt keine Buttons, die nicht funktionieren', async () => {
  const html = await (await beigetreten(`/teacher/klassen/${klasseId}`)).text();
  assert.ok(html.includes('Musterfrau'), 'die Schülerliste bleibt sichtbar');
  assert.ok(!html.includes(`/teacher/faecher/${matheId}/loeschen`));
  assert.ok(!html.includes(`/teacher/schueler/${schuelerId}/loeschen`));
  assert.ok(!html.includes(`/teacher/schueler/${schuelerId}/abgang`));
});

test('Ersteller/in der Klasse darf weiterhin verwalten und löschen', async () => {
  const html = await (await ersteller(`/teacher/klassen/${klasseId}`)).text();
  assert.ok(html.includes(`/teacher/faecher/${matheId}/loeschen`), 'Lösch-Button für die Ersteller/in sichtbar');

  let r = await form(ersteller, `/teacher/schueler/${schuelerId}/abgang`, {});
  assert.equal(r.status, 302);
  assert.equal((await ersteller(`/teacher/schueler/${schuelerId}/abgangszeugnis`)).status, 200);
  r = await form(ersteller, `/teacher/schueler/${schuelerId}/reaktivieren`, {});
  assert.equal(r.status, 302);

  r = await form(ersteller, `/teacher/faecher/${englischId}/loeschen`, {});
  assert.equal(r.status, 302);
  assert.equal(db().prepare('SELECT 1 FROM faecher WHERE id = ?').get(englischId), undefined);
});

test('Eine Klassenleitung, die die Klasse nicht angelegt hat, darf ebenfalls verwalten', async () => {
  const klId = db().prepare("SELECT id FROM users WHERE username = 'kl'").get().id;
  db().prepare('INSERT INTO klassenleitung (klasse_id, user_id) VALUES (?, ?)').run(klasseId, klId);
  const r = await form(klassenleitung, `/teacher/schueler/${schuelerId}/abgang`, {});
  assert.equal(r.status, 302);
  assert.equal(db().prepare('SELECT status FROM schueler WHERE id = ?').get(schuelerId).status, 'abgang');
});

test('Kurs: die einzige Lehrkraft darf ihn löschen', async () => {
  const r = await form(ersteller, '/teacher/kurse/neu', { schuljahr_id: String(sjId), name: 'Solo-Kurs', notenschluessel: 'IHK' });
  assert.equal(r.status, 302);
  const kursId = db().prepare("SELECT id FROM faecher WHERE name = 'Solo-Kurs'").get().id;
  const del = await form(ersteller, `/teacher/faecher/${kursId}/loeschen`, {});
  assert.equal(del.status, 302);
  assert.equal(db().prepare('SELECT 1 FROM faecher WHERE id = ?').get(kursId), undefined);
});

test('Kurs mit mehreren Lehrkräften: keine von ihnen löscht die Noten der anderen mit', async () => {
  await form(ersteller, '/teacher/kurse/neu', { schuljahr_id: String(sjId), name: 'Team-Kurs', notenschluessel: 'IHK' });
  const kursId = db().prepare("SELECT id FROM faecher WHERE name = 'Team-Kurs'").get().id;
  const zweiteId = db().prepare("SELECT id FROM users WHERE username = 'beigetreten'").get().id;
  db().prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)').run(zweiteId, kursId);

  for (const req of [ersteller, beigetreten]) {
    const r = await form(req, `/teacher/faecher/${kursId}/loeschen`, {});
    assert.equal(r.status, 403);
    assert.match(await r.text(), /weitere Lehrkräfte/);
  }
  assert.ok(db().prepare('SELECT 1 FROM faecher WHERE id = ?').get(kursId), 'der Kurs muss noch da sein');

  // Der Admin kann es weiterhin (z. B. auf Bitte der Beteiligten).
  const r = await form(admin, `/teacher/faecher/${kursId}/loeschen`, {});
  assert.equal(r.status, 302);
  assert.equal(db().prepare('SELECT 1 FROM faecher WHERE id = ?').get(kursId), undefined);
});

test.after(async () => {
  setLdapAuthenticatorForTests(undefined);
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
