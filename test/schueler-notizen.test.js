/**
 * Gemeinsames Notizbuch je Schüler/in auf der Klassenleitungsseite
 * (routes/klassenlehrer.js, POST /schueler/:id/notiz) — unabhängig von
 * Notenbesprechungs-Notizen und vom alten, nicht mehr im UI genutzten
 * fehlzeiten.notiz-Feld. Mehrere Klassenlehrkräfte können hineinschreiben,
 * ältere Einträge bleiben erhalten (Verlauf statt überschreibbares Feld).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-schueler-notizen-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-schueler-notizen-bitte-lang-genug';
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
const lehrerC = client();
let sjId;
let klasseId;
let schuelerId;

test('Vorbereitung: Admin, Schuljahr, drei Lehrkräfte, Klasse mit Klassenleitung A+B, ein Schüler', async () => {
  let r = await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
  });
  assert.equal(r.status, 302);
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;

  for (const name of ['Lehrer A', 'Lehrer B', 'Lehrer C']) {
    await form(admin, '/admin/einladungen/neu', { display_name: name, ttl_days: '14' });
  }
  const invs = getDb().prepare('SELECT token FROM invitations ORDER BY id').all();
  await form(lehrerA, `/einladung/${invs[0].token}`, {
    username: 'lehrera', display_name: 'Lehrer A', password: 'passwortA1', password2: 'passwortA1',
  });
  await form(lehrerB, `/einladung/${invs[1].token}`, {
    username: 'lehrerb', display_name: 'Lehrer B', password: 'passwortB1', password2: 'passwortB1',
  });
  await form(lehrerC, `/einladung/${invs[2].token}`, {
    username: 'lehrerc', display_name: 'Lehrer C', password: 'passwortC1', password2: 'passwortC1',
  });
  const lehrerBId = getDb().prepare("SELECT id FROM users WHERE username = 'lehrerb'").get().id;

  r = await form(lehrerA, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '9A', notenschluessel: 'IHK' });
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '9A'").get().id;
  await form(lehrerA, `/teacher/klassen/${klasseId}/klassenlehrer/eintragen`, {});
  await form(lehrerA, `/teacher/klassen/${klasseId}/klassenleitung/hinzufuegen`, { user_id: String(lehrerBId) });

  await form(lehrerA, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
  schuelerId = getDb().prepare('SELECT id FROM schueler WHERE klasse_id = ?').get(klasseId).id;
});

test('Fehlzeiten-Tabelle zeigt einen Notizen-Button statt der alten Notiz-Textfelder', async () => {
  const html = await (await lehrerA(`/klassenlehrer/klasse/${klasseId}`)).text();
  assert.match(html, /📝 Notizen/);
  assert.doesNotMatch(html, /name="notiz_/, 'die alten Pro-Fehlzeitenart-Notizfelder dürfen nicht mehr im Formular sein');
});

test('Lehrer A trägt eine Notiz ein, sie erscheint im Dialog', async () => {
  const r = await form(lehrerA, `/klassenlehrer/schueler/${schuelerId}/notiz`, {
    text: 'Spricht kaum im Unterricht, evtl. Elterngespräch.', hj: '1. Halbjahr',
  });
  assert.equal(r.status, 302);
  const html = await (await lehrerA(`/klassenlehrer/klasse/${klasseId}`)).text();
  assert.match(html, /Spricht kaum im Unterricht/);
  assert.match(html, /Lehrer A/);
  assert.match(html, /📝 Notizen \(1\)/);
});

test('Lehrer B (Co-Klassenlehrkraft) sieht dieselbe Notiz und kann eine zweite hinzufügen', async () => {
  let html = await (await lehrerB(`/klassenlehrer/klasse/${klasseId}`)).text();
  assert.match(html, /Spricht kaum im Unterricht/);

  const r = await form(lehrerB, `/klassenlehrer/schueler/${schuelerId}/notiz`, {
    text: 'Update: Elterngespräch war konstruktiv.', hj: '1. Halbjahr',
  });
  assert.equal(r.status, 302);

  html = await (await lehrerA(`/klassenlehrer/klasse/${klasseId}`)).text();
  assert.match(html, /Spricht kaum im Unterricht/, 'ältere Notiz bleibt erhalten');
  assert.match(html, /Update: Elterngespräch war konstruktiv/);
  assert.match(html, /📝 Notizen \(2\)/);

  const alle = getDb().prepare('SELECT text FROM schueler_notizen WHERE schueler_id = ? ORDER BY created_at').all(schuelerId);
  assert.equal(alle.length, 2);
});

test('Lehrer C (nicht Klassenleitung dieser Klasse) darf keine Notiz eintragen', async () => {
  const r = await form(lehrerC, `/klassenlehrer/schueler/${schuelerId}/notiz`, { text: 'Sollte nicht gespeichert werden', hj: '1. Halbjahr' });
  assert.equal(r.status, 403);
  const anzahl = getDb().prepare('SELECT COUNT(*) AS c FROM schueler_notizen WHERE schueler_id = ?').get(schuelerId).c;
  assert.equal(anzahl, 2);
});

test('Leerer Text wird nicht als Notiz gespeichert', async () => {
  const vorher = getDb().prepare('SELECT COUNT(*) AS c FROM schueler_notizen WHERE schueler_id = ?').get(schuelerId).c;
  const r = await form(lehrerA, `/klassenlehrer/schueler/${schuelerId}/notiz`, { text: '   ', hj: '1. Halbjahr' });
  assert.equal(r.status, 302);
  const nachher = getDb().prepare('SELECT COUNT(*) AS c FROM schueler_notizen WHERE schueler_id = ?').get(schuelerId).c;
  assert.equal(nachher, vorher);
});

test.after(async () => {
  await fastify.close();
});
