/**
 * "Meine Klassen": "Neue Klasse anlegen" ist aufklappbar (<details>), und
 * die vorhandenen Klassen werden nach Schuljahr in Reitern (Tabs) sortiert
 * — das aktuelle Schuljahr (nach heutigem Datum) immer ganz vorne, auch
 * wenn ein vergangenes Schuljahr zuletzt/nachträglich angelegt wurde
 * (src/schuljahr-utils.js, sortiereSchuljahreFuerReiter).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-klassen-reiter-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-klassen-reiter-test-bitte-lang-genug';
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
const lehrerA = client();
const bezAktuell = baueSchuljahrBezeichnung(aktuellesStartjahr());
const bezVorjahr = baueSchuljahrBezeichnung(aktuellesStartjahr() - 1);
const bezNachgetragen = baueSchuljahrBezeichnung(aktuellesStartjahr() - 5);

test('Vorbereitung: Admin, Lehrkraft, drei Schuljahre (das älteste zuletzt/"nachgetragen" angelegt), Klassen', async () => {
  let r = await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
  });
  assert.equal(r.status, 302);

  // Bewusst NICHT chronologisch angelegt: aktuelles und Vorjahr zuerst,
  // das älteste Schuljahr ganz zuletzt ("nachgetragen").
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: bezAktuell });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: bezVorjahr });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: bezNachgetragen });

  await form(admin, '/admin/einladungen/neu', { display_name: 'Lehrer A', ttl_days: '14' });
  const inv = getDb().prepare('SELECT token FROM invitations ORDER BY id').get();
  r = await form(lehrerA, `/einladung/${inv.token}`, {
    username: 'lehrera', display_name: 'Lehrer A', password: 'passwortA1', password2: 'passwortA1',
  });
  assert.equal(r.status, 302);
  getDb().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'lehrera'").run();

  const sjAktuellId = getDb().prepare('SELECT id FROM schuljahre WHERE bezeichnung = ?').get(bezAktuell).id;
  const sjNachgetragenId = getDb().prepare('SELECT id FROM schuljahre WHERE bezeichnung = ?').get(bezNachgetragen).id;
  await form(lehrerA, '/teacher/klassen/neu', { schuljahr_id: String(sjAktuellId), name: '9A', notenschluessel: 'IHK' });
  await form(lehrerA, '/teacher/klassen/neu', { schuljahr_id: String(sjNachgetragenId), name: '5B', notenschluessel: 'IHK' });
});

test('"Neue Klasse anlegen" ist aufklappbar (<details>/<summary>)', async () => {
  const html = await (await lehrerA('/teacher/klassen')).text();
  assert.match(html, /<details>\s*<summary>Neue Klasse anlegen<\/summary>/);
});

test('Schuljahr-Reiter: aktuelles Schuljahr steht vorne, das nachgetragene ganz hinten', async () => {
  const html = await (await lehrerA('/teacher/klassen')).text();
  const reiterBlock = html.slice(html.indexOf('class="reiter"'), html.indexOf('</div>', html.indexOf('class="reiter"')));
  const positionen = [bezAktuell, bezVorjahr, bezNachgetragen].map((b) => reiterBlock.indexOf(b));
  assert.ok(positionen.every((p) => p !== -1), 'alle drei Schuljahre müssen als Reiter erscheinen');
  assert.ok(positionen[0] < positionen[1] && positionen[1] < positionen[2],
    'Reihenfolge muss aktuell, dann Vorjahr, dann das (nachgetragene) älteste Schuljahr sein');

  // Der erste Reiter (aktuelles Schuljahr) ist aktiv, sein Panel zeigt "9A".
  const ersterButtonStart = reiterBlock.indexOf('<button');
  const ersterButtonEnde = reiterBlock.indexOf('</button>', ersterButtonStart);
  assert.match(reiterBlock.slice(ersterButtonStart, ersterButtonEnde), /class="active"/);

  assert.match(html, /9A/);
  assert.match(html, /5B/);
});

test('Jede Klasse erscheint nur im Panel ihres eigenen Schuljahrs', async () => {
  const html = await (await lehrerA('/teacher/klassen')).text();
  const sjAktuellId = getDb().prepare('SELECT id FROM schuljahre WHERE bezeichnung = ?').get(bezAktuell).id;
  const sjNachgetragenId = getDb().prepare('SELECT id FROM schuljahre WHERE bezeichnung = ?').get(bezNachgetragen).id;
  const panelAktuellStart = html.indexOf(`id="sj-panel-${sjAktuellId}"`);
  const panelAktuellEnde = html.indexOf('</div>', html.indexOf('</table>', panelAktuellStart));
  const panelAktuell = html.slice(panelAktuellStart, panelAktuellEnde);
  assert.match(panelAktuell, /9A/);
  assert.doesNotMatch(panelAktuell, /5B/);

  const panelNachgetragenStart = html.indexOf(`id="sj-panel-${sjNachgetragenId}"`);
  const panelNachgetragenEnde = html.indexOf('</div>', html.indexOf('</table>', panelNachgetragenStart));
  const panelNachgetragen = html.slice(panelNachgetragenStart, panelNachgetragenEnde);
  assert.match(panelNachgetragen, /5B/);
  assert.doesNotMatch(panelNachgetragen, /9A/);
});

test.after(async () => {
  await fastify.close();
});
