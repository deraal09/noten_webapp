/**
 * Der Hinweistext der Datumstabelle ist aufklappbar und standardmäßig eingeklappt (kompaktere Seite).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-datumstabelle-hinweis-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-datumstabelle-hinweis-bitte-lang-genug-x';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });

function client() {
  const cookies = new Map();
  return async function req(url, opts = {}) {
    const headers = { ...opts.headers };
    if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(base + url, { ...opts, headers, redirect: 'manual' });
    for (const raw of r.headers.getSetCookie?.() ?? []) {
      const [k, ...v] = raw.split(';')[0].split('=');
      cookies.set(k.trim(), v.join('=').trim());
    }
    return r;
  };
}
const form = (req, url, body = {}) => req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });

test('Hinweis der Datumstabelle: <details> ohne open-Attribut, Text darin; Termine-Formular bleibt sichtbar', async () => {
  const admin = client();
  await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sj = getDb().prepare('SELECT id FROM schuljahre').get().id;
  await form(admin, '/teacher/klassen/neu', { schuljahr_id: String(sj), name: '10A', notenschluessel: 'IHK' });
  const klasseId = getDb().prepare('SELECT id FROM klassen').get().id;
  await form(admin, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Mathe' });
  const fachId = getDb().prepare('SELECT id FROM faecher').get().id;
  const html = await (await admin(`/teacher/fach/${fachId}`)).text();
  const m = html.match(/<details class="hinweis-aufklappbar" id="datumstabelle-hinweis"([^>]*)>\s*<summary>Hinweis zur Datumstabelle<\/summary>\s*<p class="hint">([\s\S]*?)<\/p>\s*<\/details>/);
  assert.ok(m, 'aufklappbarer Hinweis vorhanden');
  assert.doesNotMatch(m[1], /\bopen\b/, 'standardmäßig eingeklappt');
  assert.match(m[2], /Eine Spalte je Unterrichtstermin/);
  assert.match(m[2], /n\.a\./);
  // der Text steht nicht mehr offen auf der Seite
  assert.equal(html.split('Eine Spalte je Unterrichtstermin').length - 1, 1, 'nur einmal, und zwar im Aufklapp-Bereich');
  assert.match(html, /\+ Datum hinzufügen/);
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Fachseite: gemerkter Reiter wird nur beim Neuladen/Zurück/aus der Fachseite selbst genutzt, nicht beim Öffnen des Fachs', async () => {
  const admin = client();
  await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' }).catch(() => {});
  await form(admin, '/login', { username: 'admin', password: 'adminpass123' });
  const fachId = getDb().prepare('SELECT id FROM faecher').get().id;
  const html = await (await admin(`/teacher/fach/${fachId}`)).text();
  assert.match(html, /function sollGemerktenReiterNutzen\(\)/);
  assert.match(html, /nav\.type === 'reload' \|\| nav\.type === 'back_forward'/);
  assert.match(html, /new URL\(document\.referrer\)\.pathname === location\.pathname/);
  assert.match(html, /if \(storageKey && sollGemerktenReiterNutzen\(\)\)/);
});
