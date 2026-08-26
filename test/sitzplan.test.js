/**
 * Sitzplan: freie Anordnung von Namens-Plätzen je Klasse. Jede Lehrkraft mit
 * Klassenzugriff hat einen eigenen, privaten Entwurf — erst per Knopfdruck
 * ("Übertragen") wird er für andere Lehrkräfte der Klasse sichtbar.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-sitzplan-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-sitzplan-test-bitte-lang-genug';
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
const lehrerA = client();
const lehrerB = client();
let sjId, klasseId;

test('Vorbereitung: Admin, Klasse (Lehrer A), Lehrer B ohne Zugriff', async () => {
  let r = await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
  });
  assert.equal(r.status, 302);
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;

  for (const name of ['Lehrer A', 'Lehrer B']) {
    await form(admin, '/admin/einladungen/neu', { display_name: name, ttl_days: '14' });
  }
  const invs = getDb().prepare('SELECT token FROM invitations ORDER BY id').all();
  await form(lehrerA, `/einladung/${invs[0].token}`, {
    username: 'lehrera', display_name: 'Lehrer A', password: 'passwortA1', password2: 'passwortA1',
  });
  await form(lehrerB, `/einladung/${invs[1].token}`, {
    username: 'lehrerb', display_name: 'Lehrer B', password: 'passwortB1', password2: 'passwortB1',
  });

  r = await form(lehrerA, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '9A', notenschluessel: 'IHK' });
  assert.equal(r.status, 302);
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '9A'").get().id;
  await form(lehrerA, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
});

test('Zugriffsschutz: nur Lehrkräfte mit Klassenzugriff sehen/bearbeiten den Sitzplan', async () => {
  let r = await lehrerB(`/teacher/klassen/${klasseId}/sitzplan`);
  assert.equal(r.status, 403);

  r = await lehrerA(`/teacher/klassen/${klasseId}/sitzplan`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Sitzplan/);
  assert.match(html, /<option value="Anna">/); // im Autocomplete-Datalist (nur Vorname)

  r = await lehrerB(`/teacher/klassen/${klasseId}/sitzplan/speichern`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ plaetze: '[]' }),
  });
  assert.equal(r.status, 403);
});

test('Speichern: eigener Entwurf wird persistiert und beim nächsten Laden wieder angezeigt', async () => {
  const plaetze = [{ id: 'p1', x: 10, y: 20, text: 'Adler, Anna' }, { id: 'p2', x: 50, y: 50, text: 'Lehrertisch' }];
  const r = await lehrerA(`/teacher/klassen/${klasseId}/sitzplan/speichern`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ plaetze: JSON.stringify(plaetze) }),
  });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.anzahl, 2);

  const row = getDb().prepare('SELECT * FROM sitzplaene WHERE klasse_id = ? AND owner_id = (SELECT id FROM users WHERE username = ?)')
    .get(klasseId, 'lehrera');
  assert.ok(row);
  assert.deepEqual(JSON.parse(row.plaetze), plaetze);

  const html = await (await lehrerA(`/teacher/klassen/${klasseId}/sitzplan`)).text();
  assert.match(html, /Adler, Anna/);
  assert.match(html, /Lehrertisch/);

  // Lehrer B hat noch KEINEN eigenen Entwurf und noch nichts wurde übertragen.
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM sitzplaene').get().c, 1);
});

test('Speichern: Werte werden validiert/begrenzt (x/y geklemmt, Text gekürzt, ungültige Struktur abgelehnt)', async () => {
  let r = await lehrerA(`/teacher/klassen/${klasseId}/sitzplan/speichern`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ plaetze: 'kein-json' }),
  });
  assert.equal(r.status, 400);

  const langerText = 'x'.repeat(200);
  r = await lehrerA(`/teacher/klassen/${klasseId}/sitzplan/speichern`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ plaetze: JSON.stringify([{ id: 'p1', x: 500, y: -50, text: langerText }]) }),
  });
  assert.equal(r.status, 200);
  const row = getDb().prepare('SELECT plaetze FROM sitzplaene WHERE klasse_id = ? AND owner_id = (SELECT id FROM users WHERE username = ?)')
    .get(klasseId, 'lehrera');
  const gespeichert = JSON.parse(row.plaetze)[0];
  assert.equal(gespeichert.x, 100);
  assert.equal(gespeichert.y, 0);
  assert.ok(gespeichert.text.length <= 60);
});

test('Übertragen: nur per Knopfdruck sichtbar für andere Lehrkräfte, eigener Sync-Entwurf bleibt unverändert', async () => {
  // Lehrer B bekommt jetzt echten Klassenzugriff (Fach-Zuweisung), hat aber
  // noch KEINEN eigenen Sitzplan-Entwurf und noch nichts wurde übertragen.
  await form(lehrerA, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Physik' });
  const fachId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Physik'").get(klasseId).id;
  const lehrerBId = getDb().prepare('SELECT id FROM users WHERE username = ?').get('lehrerb').id;
  await form(lehrerA, `/teacher/klassen/${klasseId}/klassenlehrer/eintragen`, {});
  await form(lehrerA, `/teacher/klassen/${klasseId}/zuweisungen/neu`, { user_id: String(lehrerBId), fach_id: String(fachId) });

  let r = await lehrerB(`/teacher/klassen/${klasseId}/sitzplan`);
  assert.equal(r.status, 200);
  let html = await r.text();
  assert.match(html, /Noch kein Sitzplan an andere Lehrkräfte dieser Klasse übertragen/);

  // Eigener, unveröffentlichter Marker (kein Schülername) — taucht NICHT
  // schon zufällig im Autocomplete-Datalist der Schüler/innen auf.
  const plaetze = [{ id: 'p1', x: 10, y: 20, text: 'MARKIERUNG-VOR-UEBERTRAGEN' }];
  await lehrerA(`/teacher/klassen/${klasseId}/sitzplan/speichern`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ plaetze: JSON.stringify(plaetze) }),
  });

  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM sitzplan_geteilt').get().c, 0);
  // Ohne Übertragen sieht Lehrer B den Entwurf von Lehrer A weiterhin nicht.
  html = await (await lehrerB(`/teacher/klassen/${klasseId}/sitzplan`)).text();
  assert.doesNotMatch(html, /MARKIERUNG-VOR-UEBERTRAGEN/);

  r = await form(lehrerA, `/teacher/klassen/${klasseId}/sitzplan/uebertragen`, {});
  assert.equal(r.status, 302);

  const geteilt = getDb().prepare('SELECT * FROM sitzplan_geteilt WHERE klasse_id = ?').get(klasseId);
  assert.ok(geteilt);
  assert.deepEqual(JSON.parse(geteilt.plaetze), plaetze);

  html = await (await lehrerA(`/teacher/klassen/${klasseId}/sitzplan`)).text();
  assert.match(html, /an alle Lehrkräfte übertragen/);

  // Jetzt sieht auch Lehrer B den übertragenen Stand — aber weiterhin nur als
  // "geteilt", nicht als eigenen (automatisch übernommenen) Entwurf.
  html = await (await lehrerB(`/teacher/klassen/${klasseId}/sitzplan`)).text();
  assert.match(html, /MARKIERUNG-VOR-UEBERTRAGEN/);
  const eigenerVonB = getDb().prepare('SELECT * FROM sitzplaene WHERE klasse_id = ? AND owner_id = ?').get(klasseId, lehrerBId);
  assert.equal(eigenerVonB, undefined, 'Übertragen darf nicht automatisch den Entwurf einer anderen Lehrkraft anlegen/überschreiben');
});

test('Übernehmen: geteilten Sitzplan als eigenen Entwurf übernehmen überschreibt den eigenen Entwurf', async () => {
  // Lehrer A hat sonst nichts mehr geändert; ein zweiter Aufruf mit anderem
  // Inhalt zeigt, dass "Übernehmen" wirklich den geteilten Stand kopiert,
  // nicht nur ihn bestätigt.
  await lehrerA(`/teacher/klassen/${klasseId}/sitzplan/speichern`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ plaetze: JSON.stringify([{ id: 'p9', x: 1, y: 1, text: 'temporär' }]) }),
  });

  const r = await form(lehrerA, `/teacher/klassen/${klasseId}/sitzplan/uebernehmen`, {});
  assert.equal(r.status, 302);

  const eigener = getDb().prepare('SELECT plaetze FROM sitzplaene WHERE klasse_id = ? AND owner_id = (SELECT id FROM users WHERE username = ?)')
    .get(klasseId, 'lehrera');
  const geteilt = getDb().prepare('SELECT plaetze FROM sitzplan_geteilt WHERE klasse_id = ?').get(klasseId);
  assert.deepEqual(JSON.parse(eigener.plaetze), JSON.parse(geteilt.plaetze));
});

test('Autocomplete: doppelter Vorname bekommt Nachname-Anfangsbuchstaben statt nur dem Vornamen', async () => {
  await form(lehrerA, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Berger', vorname: 'Anna' });
  const html = await (await lehrerA(`/teacher/klassen/${klasseId}/sitzplan`)).text();
  assert.doesNotMatch(html, /<option value="Anna">/, 'bei einer Dopplung darf der reine Vorname nicht mehr allein vorgeschlagen werden');
  assert.match(html, /<option value="Anna A\.">/);
  assert.match(html, /<option value="Anna B\.">/);
});

test.after(async () => {
  await fastify.close();
});
