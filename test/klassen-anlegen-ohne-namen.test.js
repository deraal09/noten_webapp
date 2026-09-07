/**
 * "Neue Klasse anlegen" auf "Meine Klassen": ohne im System bereits
 * verwendete Klassennamen gibt es nur das Register "Neue Klasse anlegen"
 * (kein Select ohne Auswahlmöglichkeiten) -- siehe klassen-liste-reiter.test.js
 * für den Fall mit bereits bekannten Namen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-klassen-anlegen-leer-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-klassen-anlegen-leer-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');

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

test('Ohne bekannte Klassennamen gibt es nur das Register "Neue Klasse anlegen", kein leeres Select', async () => {
  await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
  });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });

  const html = await (await admin('/teacher/klassen')).text();
  const anlegenBlock = html.slice(html.indexOf('<details>'), html.indexOf('<h2>Vorhandene Klassen</h2>'));

  assert.doesNotMatch(anlegenBlock, /Vorhandene Klasse wählen/,
    'ohne bekannte Namen darf kein Auswahl-Register angeboten werden');
  assert.match(anlegenBlock, /data-target="klasse-anlegen-neu">Neue Klasse anlegen/);
  assert.match(anlegenBlock, /id="klasse-anlegen-neu" class="reiter-panel unter-panel card active"/,
    '"Neue Klasse anlegen" ist dann das einzige und von Anfang an aktive Register');
  assert.match(anlegenBlock, /<input type="text" name="name" placeholder="z\. B\. 12BFI1" required>/);
});

test.after(async () => {
  await fastify.close();
});
