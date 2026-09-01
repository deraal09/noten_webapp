/**
 * Untis-Import: Klassen (und optional Schüler/innen) aus WebUntis
 * importieren. Die echte Untis-API wird nie in Tests angesprochen — ein
 * FakeUntisClient (siehe setUntisClientForTests) simuliert die Antworten,
 * genau wie FakeAuthenticator es für LDAP tut.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-untis-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-untis-test-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { setUntisClientForTests } = await import('../src/untis-client.js');

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

/** Baut eine URLSearchParams mit mehreren Werten für denselben Key (z. B. klasse_id[]). */
function multiForm(pairs) {
  const usp = new URLSearchParams();
  for (const [k, v] of pairs) usp.append(k, v);
  return usp;
}

const admin = client();
const lehrerA = client();
let sjId;

class FakeUntisClient {
  constructor({
    gueltigeZugangsdaten, klassen, schuelerGesamt, wirftBeiSchuelern,
    schuelerProKlasseFilter, wirftBeiSchuelernGefiltert,
    identitaetErgebnis, stunden, wirftBeiIdentitaet, wirftBeiZeitplan,
  }) {
    this.gueltigeZugangsdaten = gueltigeZugangsdaten;
    this.klassenListe = klassen;
    this.schuelerGesamt = schuelerGesamt || [];
    this.wirftBeiSchuelern = wirftBeiSchuelern || null;
    this.schuelerProKlasseFilter = schuelerProKlasseFilter || {};
    this.wirftBeiSchuelernGefiltert = wirftBeiSchuelernGefiltert || null;
    // Standardmäßig nicht implementiert (wie bei den meisten realen
    // Untis-Instanzen, solange es nicht getestet wird) — der Import fällt
    // dann auf die ungefilterte Klassenliste zurück, genau wie im Live-Betrieb.
    this.identitaetErgebnis = identitaetErgebnis || null;
    this.stunden = stunden || [];
    this.wirftBeiIdentitaet = wirftBeiIdentitaet || null;
    this.wirftBeiZeitplan = wirftBeiZeitplan || null;
    this.abmeldeAufrufe = 0;
  }
  async anmelden({ username, password }) {
    if (username !== this.gueltigeZugangsdaten.username || password !== this.gueltigeZugangsdaten.password) {
      throw new Error('Untis-Anmeldung fehlgeschlagen (Code 4010) — Benutzername/Passwort prüfen.');
    }
    return { sessionId: 'fake-session-123', personId: 1, personType: 2, klasseId: null, cookieHeader: 'JSESSIONID=fake-session-123' };
  }
  async abmelden() { this.abmeldeAufrufe++; }
  async klassen() { return this.klassenListe; }
  async identitaet() {
    if (this.wirftBeiIdentitaet) throw new Error(this.wirftBeiIdentitaet);
    if (!this.identitaetErgebnis) throw new Error('app/config nicht implementiert (Fake-Standard)');
    return this.identitaetErgebnis;
  }
  async zeitplan() {
    if (this.wirftBeiZeitplan) throw new Error(this.wirftBeiZeitplan);
    return this.stunden;
  }
  async studenten({ filter } = {}) {
    if (filter && filter.klasseId !== undefined) {
      if (this.wirftBeiSchuelernGefiltert) throw new Error(this.wirftBeiSchuelernGefiltert);
      return this.schuelerProKlasseFilter[filter.klasseId] || [];
    }
    if (this.wirftBeiSchuelern) throw new Error(this.wirftBeiSchuelern);
    return this.schuelerGesamt;
  }
}

test('Vorbereitung: Admin, Schuljahr, Lehrkraft', async () => {
  let r = await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
  });
  assert.equal(r.status, 302);
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;

  await form(admin, '/admin/einladungen/neu', { display_name: 'Lehrer A', ttl_days: '14' });
  const inv = getDb().prepare('SELECT token FROM invitations ORDER BY id').get();
  r = await form(lehrerA, `/einladung/${inv.token}`, {
    username: 'lehrera', display_name: 'Lehrer A', password: 'passwortA1', password2: 'passwortA1',
  });
  assert.equal(r.status, 302);
  // Untis-Import (Klassenanlage) ist an LDAP-Zugang gebunden (userDarfSelbstKlasseAnlegen).
  getDb().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'lehrera'").run();
});

test('Login-Formular ist erreichbar, ohne Verbindung wird Schritt 1 gezeigt', async () => {
  const r = await lehrerA('/teacher/untis-import');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Mit Untis verbinden/);
  assert.doesNotMatch(html, /Klassen auswählen/);
});

test('Falsches Passwort: Fehlermeldung, keine Session-Verbindung aufgebaut', async () => {
  setUntisClientForTests(new FakeUntisClient({
    gueltigeZugangsdaten: { username: 'lehrer.a', password: 'geheim123' },
    klassen: [{ id: 501, name: '10A', longName: 'Klasse 10A' }],
  }));
  const r = await form(lehrerA, '/teacher/untis-import/verbinden', {
    server: 'neilo.webuntis.com', school: 'bbz-rd-eck', username: 'lehrer.a', password: 'falsch',
  });
  assert.equal(r.status, 302);
  const html = await (await lehrerA('/teacher/untis-import')).text();
  assert.match(html, /fehlgeschlagen/);
  assert.match(html, /Mit Untis verbinden/); // immer noch Schritt 1
});

test('Erfolgreicher Login: Klassen aus Untis werden zur Auswahl angezeigt', async () => {
  const r = await form(lehrerA, '/teacher/untis-import/verbinden', {
    server: 'neilo.webuntis.com', school: 'bbz-rd-eck', username: 'lehrer.a', password: 'geheim123',
  });
  assert.equal(r.status, 302);
  const html = await (await lehrerA('/teacher/untis-import')).text();
  assert.match(html, /Klassen auswählen/);
  assert.match(html, /10A/);
});

test('Eigene Klassen laut Stundenplan werden vorausgewählt, der Rest hinter "Alle Klassen anzeigen"', async () => {
  const fake = new FakeUntisClient({
    gueltigeZugangsdaten: { username: 'lehrer.a', password: 'geheim123' },
    klassen: [
      { id: 601, name: '11B', longName: '' },
      { id: 602, name: '11C', longName: '' },
    ],
    identitaetErgebnis: { personId: 42, personType: 2 },
    stunden: [{ kl: [{ id: 601, name: '11B' }] }, { kl: [{ id: 601, name: '11B' }] }],
  });
  setUntisClientForTests(fake);
  await form(lehrerA, '/teacher/untis-import/verbinden', {
    server: 'neilo.webuntis.com', school: 'bbz-rd-eck', username: 'lehrer.a', password: 'geheim123',
  });

  const html = await (await lehrerA('/teacher/untis-import')).text();
  assert.match(html, /davon 1 laut deinem eigenen Stundenplan/);
  const vorAusklappen = html.slice(0, html.indexOf('Alle 2 Klassen der Schule anzeigen'));
  assert.match(vorAusklappen, /value="601"[^>]*checked/, '11B (eigene Klasse) ist vorausgewählt außerhalb des Ausklapp-Bereichs');
  assert.doesNotMatch(vorAusklappen, /value="602"/, '11C (nicht eigene Klasse) erscheint nicht vor dem Ausklapp-Bereich');
  assert.match(html, /value="602"/, '11C ist trotzdem wählbar (im Ausklapp-Bereich)');
});

test('Stundenplan-Abruf nicht verfügbar: Fallback auf ungefilterte Klassenliste', async () => {
  const fake = new FakeUntisClient({
    gueltigeZugangsdaten: { username: 'lehrer.a', password: 'geheim123' },
    klassen: [{ id: 701, name: '12A', longName: '' }],
    wirftBeiIdentitaet: 'app/config nicht erreichbar',
  });
  setUntisClientForTests(fake);
  await form(lehrerA, '/teacher/untis-import/verbinden', {
    server: 'neilo.webuntis.com', school: 'bbz-rd-eck', username: 'lehrer.a', password: 'geheim123',
  });
  const html = await (await lehrerA('/teacher/untis-import')).text();
  assert.doesNotMatch(html, /laut deinem eigenen Stundenplan/);
  assert.doesNotMatch(html, /Alle \d+ Klassen der Schule anzeigen/, 'ohne Filter gibt es nichts Zusätzliches zum Ausklappen');
  assert.match(html, /app\/config nicht erreichbar/, 'der genaue Grund des Fallbacks muss zur Fehlersuche angezeigt werden');
  assert.match(html, /12A/);
});

test('Stundenplan geliefert, aber ohne "kl"-Feld erkennbar: Diagnose zeigt tatsächliche Felder', async () => {
  const fake = new FakeUntisClient({
    gueltigeZugangsdaten: { username: 'lehrer.a', password: 'geheim123' },
    klassen: [{ id: 801, name: '13A', longName: '' }],
    identitaetErgebnis: { personId: 42, personType: 2 },
    stunden: [{ klassen: [{ id: 801 }], lstext: 'Mathe' }],
  });
  setUntisClientForTests(fake);
  await form(lehrerA, '/teacher/untis-import/verbinden', {
    server: 'neilo.webuntis.com', school: 'bbz-rd-eck', username: 'lehrer.a', password: 'geheim123',
  });
  const html = await (await lehrerA('/teacher/untis-import')).text();
  assert.doesNotMatch(html, /laut deinem eigenen Stundenplan/);
  assert.match(html, /keine Klasse im Feld.*?kl.*? gefunden/, 'EJS escaped die Anführungszeichen als &#34; im HTML');
  assert.match(html, /klassen, lstext/, 'die tatsächlichen Feldnamen müssen zur Fehlersuche angezeigt werden');
});

test('Trennen: Session-Verbindung wird gelöscht und bei Untis abgemeldet', async () => {
  const fake = new FakeUntisClient({
    gueltigeZugangsdaten: { username: 'x', password: 'y' }, klassen: [],
  });
  setUntisClientForTests(fake);
  await form(lehrerA, '/teacher/untis-import/verbinden', { username: 'x', password: 'y' });
  const r = await form(lehrerA, '/teacher/untis-import/trennen', {});
  assert.equal(r.status, 302);
  assert.equal(fake.abmeldeAufrufe, 1);
  const html = await (await lehrerA('/teacher/untis-import')).text();
  assert.match(html, /Mit Untis verbinden/);
});

test('Import: Klasse mit Schüler/innen (getStudents liefert die Schulliste, Zuordnung über klasseId/klasse)', async () => {
  const fake = new FakeUntisClient({
    gueltigeZugangsdaten: { username: 'lehrer.a', password: 'geheim123' },
    klassen: [
      { id: 601, name: '11B', longName: '' },
      { id: 602, name: '11C', longName: '' },
    ],
    schuelerGesamt: [
      { name: 'Adler', foreName: 'Anna', klasseId: 601 },
      { name: 'Berger', foreName: 'Ben', klasse: '11B' },
      { name: 'Fremd', foreName: 'Fritz', klasseId: 999 }, // andere Klasse, darf nicht landen
    ],
  });
  setUntisClientForTests(fake);
  await form(lehrerA, '/teacher/untis-import/verbinden', {
    server: 'neilo.webuntis.com', school: 'bbz-rd-eck', username: 'lehrer.a', password: 'geheim123',
  });

  const r = await lehrerA('/teacher/untis-import/importieren', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: multiForm([
      ['schuljahr_id', String(sjId)], ['notenschluessel', 'IHK'], ['mit_schuelern', '1'],
      ['klasse_id', '601'], ['klasse_id', '602'],
    ]),
  });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /11B/);
  assert.match(html, /11C/);
  assert.match(html, /neu angelegt/);
  assert.match(html, /keine gefunden/, '11C hat keine passenden Schüler/innen in der Liste');
  assert.match(html, /schulweit 3 Schüler/, 'Diagnose-Hinweis mit Gesamtzahl muss angezeigt werden');
  assert.match(html, /name, foreName, klasseId/, 'Beispiel-Feldnamen des ersten Schülers müssen zur Fehlersuche angezeigt werden');

  const klasse11B = getDb().prepare("SELECT * FROM klassen WHERE name = '11B' AND schuljahr_id = ?").get(sjId);
  assert.ok(klasse11B);
  const schueler = getDb().prepare('SELECT * FROM schueler WHERE klasse_id = ? ORDER BY nachname').all(klasse11B.id);
  assert.equal(schueler.length, 2);
  assert.equal(schueler[0].nachname, 'Adler');
  assert.equal(schueler[0].vorname, 'Anna');

  const klasse11C = getDb().prepare("SELECT * FROM klassen WHERE name = '11C' AND schuljahr_id = ?").get(sjId);
  assert.ok(klasse11C);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM schueler WHERE klasse_id = ?').get(klasse11C.id).c, 0);

  // Untis-Verbindung wurde nach dem Import beendet.
  assert.equal(fake.abmeldeAufrufe, 1);
  const nachDemImport = await (await lehrerA('/teacher/untis-import')).text();
  assert.match(nachDemImport, /Mit Untis verbinden/);
});

test('Import: schulweiter Schülerabruf ohne Rechte (-8509) — Fallback pro Klasse mit Filter funktioniert', async () => {
  const fake = new FakeUntisClient({
    gueltigeZugangsdaten: { username: 'lehrer.a', password: 'geheim123' },
    klassen: [{ id: 701, name: '12A', longName: '' }],
    wirftBeiSchuelern: 'Untis-Fehler -8509: no right for getStudents()',
    schuelerProKlasseFilter: { 701: [{ name: 'Cortes', foreName: 'Clara' }] },
  });
  setUntisClientForTests(fake);
  await form(lehrerA, '/teacher/untis-import/verbinden', {
    server: 'neilo.webuntis.com', school: 'bbz-rd-eck', username: 'lehrer.a', password: 'geheim123',
  });

  const r = await lehrerA('/teacher/untis-import/importieren', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: multiForm([
      ['schuljahr_id', String(sjId)], ['notenschluessel', 'IHK'], ['mit_schuelern', '1'], ['klasse_id', '701'],
    ]),
  });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /12A/);
  assert.match(html, /neu angelegt/);
  assert.match(html, /no right for getStudents/, 'der ursprüngliche Rechte-Fehler muss zur Fehlersuche mit angezeigt werden');

  const klasse12A = getDb().prepare("SELECT * FROM klassen WHERE name = '12A' AND schuljahr_id = ?").get(sjId);
  assert.ok(klasse12A);
  const schueler = getDb().prepare('SELECT * FROM schueler WHERE klasse_id = ?').all(klasse12A.id);
  assert.equal(schueler.length, 1);
  assert.equal(schueler[0].nachname, 'Cortes');
});

test('Import: schulweiter Schülerabruf UND Fallback pro Klasse scheitern beide — Klasse wird trotzdem angelegt', async () => {
  const fake = new FakeUntisClient({
    gueltigeZugangsdaten: { username: 'lehrer.a', password: 'geheim123' },
    klassen: [{ id: 702, name: '12B', longName: '' }],
    wirftBeiSchuelern: 'keine Berechtigung',
    wirftBeiSchuelernGefiltert: 'keine Berechtigung',
  });
  setUntisClientForTests(fake);
  await form(lehrerA, '/teacher/untis-import/verbinden', {
    server: 'neilo.webuntis.com', school: 'bbz-rd-eck', username: 'lehrer.a', password: 'geheim123',
  });

  const r = await lehrerA('/teacher/untis-import/importieren', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: multiForm([
      ['schuljahr_id', String(sjId)], ['notenschluessel', 'IHK'], ['mit_schuelern', '1'], ['klasse_id', '702'],
    ]),
  });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /12B/);
  assert.match(html, /neu angelegt/);
  assert.match(html, /von Untis nicht verfügbar/);
  assert.match(html, /keine Berechtigung/, 'der genaue Untis-Fehlertext muss zur Fehlersuche mit angezeigt werden');

  const klasse12B = getDb().prepare("SELECT * FROM klassen WHERE name = '12B' AND schuljahr_id = ?").get(sjId);
  assert.ok(klasse12B);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM schueler WHERE klasse_id = ?').get(klasse12B.id).c, 0);
});

test('Import: Namenskollision im Ziel-Schuljahr wird übersprungen, keine Dopplung', async () => {
  const fake = new FakeUntisClient({
    gueltigeZugangsdaten: { username: 'lehrer.a', password: 'geheim123' },
    klassen: [{ id: 601, name: '11B', longName: '' }], // "11B" existiert in sjId bereits
  });
  setUntisClientForTests(fake);
  await form(lehrerA, '/teacher/untis-import/verbinden', {
    server: 'neilo.webuntis.com', school: 'bbz-rd-eck', username: 'lehrer.a', password: 'geheim123',
  });

  const vorher = getDb().prepare('SELECT COUNT(*) AS c FROM klassen WHERE name = ?').get('11B').c;
  const r = await lehrerA('/teacher/untis-import/importieren', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ schuljahr_id: String(sjId), notenschluessel: 'IHK', klasse_id: '601' }),
  });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /übersprungen/);
  const nachher = getDb().prepare('SELECT COUNT(*) AS c FROM klassen WHERE name = ?').get('11B').c;
  assert.equal(nachher, vorher, 'keine doppelte Klasse durch den Import');
});

test('Import ohne aktive Verbindung wird abgelehnt', async () => {
  const r = await lehrerA('/teacher/untis-import/importieren', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ schuljahr_id: String(sjId), klasse_id: '999' }),
  });
  assert.equal(r.status, 302);
  const html = await (await lehrerA('/teacher/untis-import')).text();
  assert.match(html, /erneut anmelden/);
});

test.after(async () => {
  setUntisClientForTests(undefined);
  await fastify.close();
});
