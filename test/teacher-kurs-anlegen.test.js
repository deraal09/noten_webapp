/**
 * Neuen Kurs anlegen (POST /teacher/kurse/neu, src/routes/teacher.js): ein
 * Kurs braucht KEINE Ausgangsklasse (mehr) -- er bekommt beim Anlegen nur
 * Name/Schuljahr/Notenschlüssel und eine unsichtbare, leere Klassen-Hülle
 * als technischen Anker (klassen.ist_kurs_huelle), taucht also nirgends als
 * "echte" Klasse auf. Teilnehmer/innen kommen erst danach explizit dazu
 * (Reiter „Teilnehmer/innen" auf der Fach-Seite, siehe fach-teilnehmer.test.js).
 * Das Anlegerecht folgt denselben Regeln wie bei "Klasse anlegen"
 * (userDarfSelbstKlasseAnlegen: Admin oder LDAP-Konto).
 *
 * Deckt außerdem den Bugfix ab, dass ein Kurs sich bisher nicht mehr löschen
 * ließ (die Löschberechtigung prüfte fälschlich Zugriff auf die -- bei einem
 * Kurs oft fremde oder gar nicht mehr existierende -- Heimat-Klasse statt die
 * eigene Fach-Zuweisung, siehe userDarfFachLoeschen in src/auth.js).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-kurs-anlegen-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-kurs-anlegen-test-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });

function client() {
  const cookies = new Map();
  function setCookie(setCookieHeader) {
    if (!setCookieHeader) return;
    const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    for (const raw of arr) {
      const [pair] = raw.split(';');
      const [k, ...v] = pair.split('=');
      cookies.set(k.trim(), v.join('=').trim());
    }
  }
  return async function req(url, opts = {}) {
    const headers = { ...opts.headers };
    if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(base + url, { ...opts, headers, redirect: 'manual' });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : r.headers.get('set-cookie');
    if (sc) setCookie(sc);
    return r;
  };
}

async function form(req, url, body) {
  return req(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
}

const admin = client();
const lehrerLdap = client();
const lehrerLokal = client();
let sjId;
let klasseAId;
let schuelerA1;

test('Vorbereitung: Schuljahr, Klasse 10A mit einer Person, ein LDAP- und ein lokales Lehrkraft-Konto', async () => {
  await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
  });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;
  await form(admin, `/admin/schuljahre/${sjId}/klassen/neu`, { name: '10A' });
  klasseAId = getDb().prepare("SELECT id FROM klassen WHERE name = '10A'").get().id;
  await form(admin, `/admin/klassen/${klasseAId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
  schuelerA1 = getDb().prepare("SELECT id FROM schueler WHERE nachname = 'Adler'").get().id;

  for (const [name, uname] of [['Lehrer LDAP', 'lehrerldap'], ['Lehrer Lokal', 'lehrerlokal']]) {
    await form(admin, '/admin/einladungen/neu', { display_name: name, ttl_days: '14' });
  }
  const invs = getDb().prepare('SELECT token, display_name FROM invitations ORDER BY id').all();
  for (const inv of invs) {
    const client_ = inv.display_name === 'Lehrer LDAP' ? lehrerLdap : lehrerLokal;
    const uname = inv.display_name === 'Lehrer LDAP' ? 'lehrerldap' : 'lehrerlokal';
    await form(client_, `/einladung/${inv.token}`, {
      username: uname, password: 'lehrerpass123', password2: 'lehrerpass123',
    });
  }
  // Einladungslink-Konten sind per Default auth_source 'lokal' -- eines der
  // beiden wird für diesen Test manuell auf 'ldap' umgestellt (siehe
  // userDarfSelbstKlasseAnlegen), das andere bleibt bewusst 'lokal'.
  getDb().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'lehrerldap'").run();
});

test('Lokales Konto ohne LDAP-Zugang darf keinen Kurs anlegen', async () => {
  const r = await form(lehrerLokal, '/teacher/kurse/neu', {
    schuljahr_id: String(sjId), name: 'Fremdkurs', notenschluessel: 'IHK',
  });
  assert.equal(r.status, 302); // Redirect mit Fehlermeldung, kein 403 (wie bei /klassen/neu)
  const fach = getDb().prepare("SELECT id FROM faecher WHERE name = 'Fremdkurs'").get();
  assert.equal(fach, undefined);
});

let kursId;
let huelleId;

test('LDAP-Konto legt einen Kurs OHNE Ausgangsklasse an -- leere Teilnehmerliste, Redirect auf Teilnehmer-Reiter', async () => {
  const r = await form(lehrerLdap, '/teacher/kurse/neu', {
    schuljahr_id: String(sjId), name: 'Musikkurs Test', notenschluessel: 'IHK',
  });
  assert.equal(r.status, 302);
  const fach = getDb().prepare("SELECT id, klasse_id, ist_kurs FROM faecher WHERE name = 'Musikkurs Test'").get();
  assert.ok(fach, 'Fach wurde angelegt');
  assert.equal(fach.ist_kurs, 1);
  kursId = fach.id;
  huelleId = fach.klasse_id;
  assert.equal(r.headers.get('location'), `/teacher/fach/${fach.id}?tab=teilnehmer`);

  const huelle = getDb().prepare('SELECT * FROM klassen WHERE id = ?').get(huelleId);
  assert.equal(huelle.ist_kurs_huelle, 1);
  assert.equal(huelle.schuljahr_id, sjId);
  assert.equal(huelle.notenschluessel, 'IHK');

  // Keine automatische Vorbefüllung mehr -- die Teilnehmerliste ist leer,
  // bis explizit jemand hinzugefügt wird.
  const teilnehmer = getDb().prepare('SELECT COUNT(*) AS c FROM fach_teilnehmer WHERE fach_id = ?').get(fach.id).c;
  assert.equal(teilnehmer, 0);

  const zuweisung = getDb().prepare('SELECT * FROM fach_zuweisungen WHERE fach_id = ? AND user_id = (SELECT id FROM users WHERE username = ?)')
    .get(fach.id, 'lehrerldap');
  assert.ok(zuweisung, 'Ersteller/in wird automatisch dem Kurs zugewiesen');
});

test('Der Kurs erscheint in "Meine Klassen" unter Kurse (nicht nur als Platzhaltertext im Anlege-Formular)', async () => {
  const html = await (await lehrerLdap('/teacher/klassen')).text();
  // Gezielt im Kurse-Listenpunkt suchen (Link zur Fach-Seite), nicht nur
  // irgendwo auf der Seite -- das Anlege-Formular hat zufällig denselben
  // Beispieltext "Spanisch AG" im placeholder stehen, das würde einen Bug
  // in der Auflistung selbst sonst unbemerkt lassen.
  assert.ok(html.includes(`/teacher/fach/${kursId}?tab=teilnehmer`), 'Kurs sollte als anklickbarer Listeneintrag erscheinen');
  assert.ok(!html.includes('Keine Kurse im Schuljahr'), 'die Kurse-Liste sollte nicht mehr leer sein');
  assert.ok(html.includes('Musikkurs Test'));
  assert.ok(!html.includes(getDb().prepare('SELECT name FROM klassen WHERE id = ?').get(huelleId).name));

  const adminSjHtml = await (await admin(`/admin/schuljahre/${sjId}`)).text();
  assert.ok(!adminSjHtml.includes('__kurshuelle_'));

  const bekannt = getDb().prepare('SELECT DISTINCT name FROM klassen WHERE ist_kurs_huelle = 0').all().map((r) => r.name);
  assert.ok(!bekannt.some((n) => n.startsWith('__kurshuelle_')));
});

test('Dashboard ("Noteneingabe") und Fach-Seite zeigen "Kurs" statt des technischen Hüllen-Namens', async () => {
  const huelleName = getDb().prepare('SELECT name FROM klassen WHERE id = ?').get(huelleId).name;

  const dashboardHtml = await (await lehrerLdap('/teacher')).text();
  assert.ok(dashboardHtml.includes('Kurse'));
  assert.ok(dashboardHtml.includes('Musikkurs Test'));
  assert.ok(!dashboardHtml.includes(huelleName));

  const fachHtml = await (await lehrerLdap(`/teacher/fach/${kursId}`)).text();
  assert.ok(fachHtml.includes('Musikkurs Test'));
  assert.ok(fachHtml.includes('Kurs'));
  assert.ok(!fachHtml.includes(huelleName));
  assert.ok(!fachHtml.includes('Sitzplan')); // ergibt für einen Kurs ohne Heimat-Klasse keinen Sinn
});

test('Aus bestehender Klasse hinzufügen funktioniert für den Kurs wie gehabt', async () => {
  const r = await form(lehrerLdap, `/teacher/fach/${kursId}/teilnehmer/hinzufuegen`, { schueler_id: String(schuelerA1) });
  assert.equal(r.status, 302);
  assert.ok(getDb().prepare('SELECT 1 FROM fach_teilnehmer WHERE fach_id = ? AND schueler_id = ?').get(kursId, schuelerA1));
});

test('Manuelles Hinzufügen legt bei Bedarf eine neue, für alle offene Klasse an', async () => {
  const r = await form(lehrerLdap, `/teacher/fach/${kursId}/teilnehmer/manuell`, {
    nachname: 'Neu', vorname: 'Nele', klasse: '10Z-Neu',
  });
  assert.equal(r.status, 302);
  const neueKlasse = getDb().prepare("SELECT * FROM klassen WHERE name = '10Z-Neu'").get();
  assert.ok(neueKlasse, 'Klasse wurde still angelegt');
  assert.equal(neueKlasse.ist_kurs_huelle, 0, 'ist eine ganz normale, sichtbare Klasse -- keine Kurs-Hülle');
  assert.equal(neueKlasse.created_by_id, null);
});

test('Kurs löschen funktioniert jetzt über die eigene Fach-Zuweisung -- keine Berechtigung auf die Hülle nötig', async () => {
  const r = await form(lehrerLdap, `/teacher/faecher/${kursId}/loeschen`, {});
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/teacher/klassen');
  assert.equal(getDb().prepare('SELECT id FROM faecher WHERE id = ?').get(kursId), undefined);
  // Die Hülle gehörte exakt diesem Kurs und wird mit ihm aufgeräumt.
  assert.equal(getDb().prepare('SELECT id FROM klassen WHERE id = ?').get(huelleId), undefined);
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
