/**
 * Sammeleingabe "Mehrere auf einmal": Komma, Semikolon, Tab oder Leerzeichen als
 * Trenner (Nachname zuerst); Doppelnamen ohne Komma werden zur Korrektur zurückgegeben.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

process.env.DB_PFAD = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-sammel-')), 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-sammel-test-bitte-lang-genug-xxxxxxxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { erkenneSchuelerZeile } = await import('../src/schueler-eingabe.js');

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
async function form(req, url, body) {
  return req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
}

test('Zeilen-Erkennung: Trennzeichen, mehrteilige Vornamen, Doppelnamen', () => {
  const ok = (z) => { const e = erkenneSchuelerZeile(z); assert.equal(e.typ, 'ok', z); return `${e.nachname}|${e.vorname}`; };
  assert.equal(ok('Müller, Anna'), 'Müller|Anna');
  assert.equal(ok('Müller,Anna'), 'Müller|Anna');
  assert.equal(ok('Müller; Anna'), 'Müller|Anna');
  assert.equal(ok('Müller\tAnna'), 'Müller|Anna');
  assert.equal(ok('Müller Anna'), 'Müller|Anna');
  assert.equal(ok('  Müller   Anna  '), 'Müller|Anna');
  assert.equal(ok('Müller-Schmidt Anna'), 'Müller-Schmidt|Anna');
  assert.equal(ok('Müller Schmidt, Anna Maria'), 'Müller Schmidt|Anna Maria', 'Komma macht Doppelnamen eindeutig');
  assert.equal(ok('Müller;;Anna'), 'Müller|Anna');
  assert.equal(ok('Cher'), 'Cher|', 'nur ein Wort: nur Nachname');
  assert.equal(erkenneSchuelerZeile('   ').typ, 'leer');
  assert.equal(erkenneSchuelerZeile(', Anna').typ, 'leer');
  assert.deepEqual(erkenneSchuelerZeile('Anna Maria Müller'), { typ: 'mehrdeutig', zeile: 'Anna Maria Müller' });
  assert.equal(erkenneSchuelerZeile('van der Berg Jan').typ, 'mehrdeutig');
});

test('Route: gemischte Trenner werden angelegt, Doppelnamen ohne Komma zur Korrektur zurückgegeben', async () => {
  const admin = client();
  await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sj = getDb().prepare('SELECT id FROM schuljahre').get().id;
  await form(admin, '/teacher/klassen/neu', { schuljahr_id: String(sj), name: '10A', notenschluessel: 'IHK' });
  const k = getDb().prepare("SELECT id FROM klassen WHERE name = '10A'").get().id;

  const text = 'Meier, Carla\nSchmidt Bernd\nKoch;Dora\nLang\tEmil\nVan Der Berg Jan\nWagner Schmidt, Fritz Karl';
  const r = await form(admin, `/teacher/klassen/${k}/schueler/bulk`, { text });
  assert.equal(r.status, 302);
  const namen = getDb().prepare('SELECT nachname, vorname FROM schueler WHERE klasse_id = ? ORDER BY nachname').all(k).map((s) => `${s.nachname}|${s.vorname}`);
  assert.deepEqual(namen, ['Koch|Dora', 'Lang|Emil', 'Meier|Carla', 'Schmidt|Bernd', 'Wagner Schmidt|Fritz Karl']);
  const ziel = r.headers.get('location');
  assert.match(ziel, /\?bulk=/);
  assert.equal(decodeURIComponent(ziel.split('?bulk=')[1]), 'Van Der Berg Jan');

  const html = await (await admin(ziel)).text();
  assert.match(html, /nicht sicher erkennbar/);
  assert.match(html, /„Van Der Berg Jan“/);
  assert.match(html, /Komma/);
  assert.match(html, /<textarea name="text"[^>]*id="bulk-text"[^>]*>Van Der Berg Jan<\/textarea>/);

  // Korrigierte Zeile mit Komma wird angelegt, keine Rückgabe mehr
  const r2 = await form(admin, `/teacher/klassen/${k}/schueler/bulk`, { text: 'Van Der Berg, Jan' });
  assert.equal(r2.headers.get('location'), `/teacher/klassen/${k}`);
  assert.ok(getDb().prepare("SELECT 1 FROM schueler WHERE nachname = 'Van Der Berg' AND vorname = 'Jan'").get());
});

test.after(async () => {
  await fastify.close();
});
