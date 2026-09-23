/**
 * End-to-End-Test der SPA-Komponenten-Konfigurierbarkeit über die echte
 * Route (POST /teacher/fach/:id/spa/komponente): nur die Klassenleitung
 * darf schalten (enger als die normale Noteneingabe-Berechtigung), nur
 * schaltbare (Rest-Anteil-)Komponenten lassen sich schalten, und die
 * Eingabemaske zeigt/versteckt die Spalte je nach Aktiv-Status.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-spa-komponente-route-test-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-spa-komponente-route-test-bitte-lang-genug';
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
const fachlehrkraft = client();
let klasseId;
let lf3Id;

test('Vorbereitung: SPA_REGULAR-Klasse (auto-geseedete Fächer, inkl. LF3), eine zugewiesene Fachlehrkraft ohne Klassenleitung', async () => {
  let r = await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  assert.equal(r.status, 302);
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2026/27' });
  const sj = getDb().prepare('SELECT id FROM schuljahre').get();

  r = await form(admin, '/teacher/klassen/neu', {
    schuljahr_id: String(sj.id), name: '13SPA1', notenschluessel: 'SPA', spa_bildungsgang: 'SPA_REGULAR', offen_fuer_beitritt: '1',
  });
  assert.equal(r.status, 302);
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '13SPA1'").get().id;
  lf3Id = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND spa_fach_key = 'LF3'").get(klasseId).id;
  await form(admin, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Musterfrau', vorname: 'Maxi' });

  await form(admin, '/admin/einladungen/neu', { display_name: 'Fachlehrkraft', ttl_days: '14' });
  const inv = getDb().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
  await form(fachlehrkraft, `/einladung/${inv.token}`, { username: 'fachlehrkraft', display_name: 'Fachlehrkraft', password: 'passwort123', password2: 'passwort123' });
  getDb().prepare('INSERT OR IGNORE INTO fach_zuweisungen (user_id, fach_id) VALUES ((SELECT id FROM users WHERE username = ?), ?)')
    .run('fachlehrkraft', lf3Id);
});

test('GET /teacher/fach/:id (LF3) zeigt die Komponenten-Einstellung nur der Klassenleitung als Formular, sonst nur informativ', async () => {
  const adminHtml = await (await admin(`/teacher/fach/${lf3Id}?hj=1`)).text();
  assert.ok(adminHtml.includes('Zusammensetzung für diese Klasse'));
  assert.ok(adminHtml.includes('/spa/komponente'));

  const lehrkraftHtml = await (await fachlehrkraft(`/teacher/fach/${lf3Id}?hj=1`)).text();
  assert.ok(!lehrkraftHtml.includes('/spa/komponente'), 'einfache Fachlehrkraft darf keine Schalt-Formulare sehen');
});

test('Fachlehrkraft ohne Klassenleitung darf keine Komponente schalten', async () => {
  const r = await form(fachlehrkraft, `/teacher/fach/${lf3Id}/spa/komponente`, {
    halbjahr: '1', komponente: 'musik', aktiv: '0',
  });
  assert.equal(r.status, 403);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM spa_deaktivierte_komponenten').get().c, 0);
});

test('Admin (zählt als Klassenleitung) kann Musik im 1. Hj. abschalten -- Eingabemaske verliert die Spalte', async () => {
  let r = await form(admin, `/teacher/fach/${lf3Id}/spa/komponente`, {
    halbjahr: '1', komponente: 'musik', aktiv: '0',
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });

  const html = await (await admin(`/teacher/fach/${lf3Id}?hj=1`)).text();
  assert.ok(!html.includes('data-feld="komponente:musik"'), 'deaktivierte Komponente darf keine Eingabespalte mehr haben');
  assert.ok(html.includes('data-feld="komponente:kunst"'), 'andere Komponenten bleiben unverändert');
  assert.ok(html.includes('komponente-inaktiv'), 'Musik-Umschalter zeigt sich als inaktiv');

  // 2. Hj. ist von der Deaktivierung im 1. Hj. nicht betroffen.
  const htmlHj2 = await (await admin(`/teacher/fach/${lf3Id}?hj=2`)).text();
  assert.ok(htmlHj2.includes('data-feld="komponente:musik"'));
});

test('Einfache Fachlehrkraft sieht den deaktivierten Status informativ, ohne ihn ändern zu können', async () => {
  const html = await (await fachlehrkraft(`/teacher/fach/${lf3Id}?hj=1`)).text();
  assert.ok(html.includes('deaktiviert'));
  assert.ok(!html.includes('/spa/komponente'));
});

test('Feste Komponente (Pädagogik) lässt sich nicht schalten', async () => {
  const r = await form(admin, `/teacher/fach/${lf3Id}/spa/komponente`, {
    halbjahr: '1', komponente: 'paedagogik', aktiv: '0',
  });
  assert.equal(r.status, 400);
});

test.after(async () => {
  await fastify.close();
});
