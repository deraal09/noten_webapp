/**
 * Admin-Route für Schuljahre: Format-Validierung (immer "YYYY/YY") und
 * Sortierung/„aktuell"-Kennzeichnung nach echtem Startjahr statt nach
 * Anlage-Reihenfolge — ein nachträglich erfasstes, vergangenes Schuljahr
 * darf nie als neuestes/aktuelles erscheinen (siehe src/schuljahr-utils.js).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-schuljahre-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-schuljahre-test-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { aktuellesStartjahr, baueSchuljahrBezeichnung } = await import('../src/schuljahr-utils.js');

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

test('Vorbereitung: Admin', async () => {
  const r = await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
  });
  assert.equal(r.status, 302);
});

test('Ungültiges Format wird abgelehnt, kein Schuljahr angelegt', async () => {
  const vorher = getDb().prepare('SELECT COUNT(*) AS c FROM schuljahre').get().c;
  for (const bez of ['2025-26', '25/26', '2025/27', 'Schuljahr 2025/26', '2025/2026']) {
    const r = await form(admin, '/admin/schuljahre/neu', { bezeichnung: bez });
    assert.equal(r.status, 302);
    const html = await (await admin('/admin')).text();
    assert.match(html, /Ungültiges Format/, `"${bez}" sollte abgelehnt werden`);
  }
  const nachher = getDb().prepare('SELECT COUNT(*) AS c FROM schuljahre').get().c;
  assert.equal(nachher, vorher, 'keines der ungültigen Formate wurde angelegt');
});

test('Nachträglich erfasstes vergangenes Schuljahr erscheint nicht als aktuell/neuestes', async () => {
  // Reihenfolge des Anlegens bewusst nicht chronologisch: 2025/26 zuerst,
  // 2026/27 danach, und ein vergangenes 2022/23 ganz zuletzt "nachgetragen".
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2026/27' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2022/23' });

  const html = await (await admin('/admin')).text();
  const positionen = ['2026/27', '2025/26', '2022/23'].map((bez) => html.indexOf(bez));
  assert.ok(positionen.every((p) => p !== -1), 'alle drei Schuljahre müssen auf der Seite erscheinen');
  assert.ok(positionen[0] < positionen[1] && positionen[1] < positionen[2],
    '2026/27 vor 2025/26 vor 2022/23 — nach echtem Startjahr sortiert, nicht nach Anlage-Reihenfolge');

  // Das nachgetragene 2022/23 darf nicht als "(aktuell)" markiert sein.
  const zeile2022 = html.slice(html.indexOf('2022/23'), html.indexOf('2022/23') + 60);
  assert.doesNotMatch(zeile2022, /\(aktuell\)/);
});

test('Das tatsächlich aktuelle Schuljahr (nach heutigem Datum) wird als "(aktuell)" markiert', async () => {
  const bezAktuell = baueSchuljahrBezeichnung(aktuellesStartjahr());
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: bezAktuell });
  const html = await (await admin('/admin')).text();
  const tabellenStart = html.indexOf('<tbody>');
  const start = html.indexOf(`>${bezAktuell}<`, tabellenStart);
  assert.ok(start !== -1, 'die Tabellenzeile (nicht das Platzhalter-Beispiel im Formular) muss gefunden werden');
  const zeile = html.slice(start, start + 80);
  assert.match(zeile, /\(aktuell\)/);
});

test.after(async () => {
  await fastify.close();
});
