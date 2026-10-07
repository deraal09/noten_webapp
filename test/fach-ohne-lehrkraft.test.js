/**
 * Fächer ohne Lehrkraft: Die Klassenleitung sieht sie im Halbjahres-Reiter und
 * darf sie löschen -- aber nur ohne zugewiesene Lehrkraft.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-fach-ohne-lehrkraft-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-fach-ohne-lehrkraft-test-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });

// ---------- Routen / Oberfläche ----------
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
  return req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
}
// Wiederholte Felder (teil_name, teil_aufgaben, ...) wie ein Browser senden.
async function formListe(req, url, paare) {
  const body = new URLSearchParams();
  for (const [k, v] of paare) body.append(k, v);
  return req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
}



const admin = client();
const lehrerA = client();
const lehrerFremd = client();
let klasseId, mathId, deutschId;

test('Vorbereitung: Klasse 12A mit zwei Fächern, Lehrer A als Klassenleitung, Mathematik einer fremden Lehrkraft zugewiesen', async () => {
  await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2026/27' });
  const sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2026/27'").get().id;
  await form(admin, `/admin/schuljahre/${sjId}/klassen/neu`, { name: '12A' });
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '12A'").get().id;
  await form(admin, `/admin/klassen/${klasseId}/faecher/neu`, { name: 'Deutsch' });
  await form(admin, `/admin/klassen/${klasseId}/faecher/neu`, { name: 'Mathematik' });
  deutschId = getDb().prepare("SELECT id FROM faecher WHERE name = 'Deutsch'").get().id;
  mathId = getDb().prepare("SELECT id FROM faecher WHERE name = 'Mathematik'").get().id;
  for (const [name, c, uname] of [['Lehrer A', lehrerA, 'lehrera'], ['Lehrer Fremd', lehrerFremd, 'lehrerfremd']]) {
    await form(admin, '/admin/einladungen/neu', { display_name: name, ttl_days: '14' });
    const inv = getDb().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
    await form(c, `/einladung/${inv.token}`, { username: uname, password: 'lehrerpass123', password2: 'lehrerpass123' });
  }
  getDb().prepare('INSERT INTO klassenleitung (klasse_id, user_id) VALUES (?, (SELECT id FROM users WHERE username = ?))').run(klasseId, 'lehrera');
  getDb().prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES ((SELECT id FROM users WHERE username = ?), ?)').run('lehrerfremd', mathId);
});

test('Klassenleitungsübersicht listet nur Fächer ohne Lehrkraft', async () => {
  const html = await (await lehrerA(`/klassenlehrer/klasse/${klasseId}?tab=halbjahr`)).text();
  const karte = html.slice(html.indexOf('id="fuer-loeschung"'));
  assert.ok(karte.includes('Fächer ohne Lehrkraft'));
  assert.ok(karte.slice(0, 1500).includes('Deutsch'));
  assert.ok(!karte.slice(0, 1500).includes('Mathematik'), 'zugewiesenes Fach fehlt in der Liste');
});

test('POST /klassenlehrer/fach/:id/loeschen: nur die Klassenleitung darf, und nur ohne zugewiesene Lehrkraft', async () => {
  // Fremde Lehrkraft (keine Klassenleitung) darf nicht.
  let r = await form(lehrerFremd, `/klassenlehrer/fach/${deutschId}/loeschen`, {});
  assert.equal(r.status, 403);
  assert.ok(getDb().prepare('SELECT 1 FROM faecher WHERE id = ?').get(deutschId));

  // Mathematik ist noch zugewiesen -- auch die Klassenleitung darf hier nicht löschen.
  r = await form(lehrerA, `/klassenlehrer/fach/${mathId}/loeschen`, {});
  assert.equal(r.status, 302);
  assert.ok(getDb().prepare('SELECT 1 FROM faecher WHERE id = ?').get(mathId));

  // Deutsch ist unzugewiesen -- die Klassenleitung darf es löschen, samt Endnoten.
  getDb().prepare("INSERT INTO schueler (klasse_id, nachname, vorname) VALUES (?, 'Adler', 'Anna')").run(klasseId);
  const anna = getDb().prepare('SELECT id FROM schueler').get().id;
  getDb().prepare("INSERT INTO halbjahr_endnoten (fach_id, schueler_id, halbjahr, note) VALUES (?, ?, '1. Halbjahr', 2)").run(deutschId, anna);
  r = await form(lehrerA, `/klassenlehrer/fach/${deutschId}/loeschen`, {});
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare('SELECT 1 FROM faecher WHERE id = ?').get(deutschId), undefined);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM halbjahr_endnoten WHERE fach_id = ?').get(deutschId).c, 0, 'Endnoten verschwinden per ON DELETE CASCADE');
  // Redirect springt zurück zum Fächer-Bereich (#fuer-loeschung), nicht an den Seitenanfang.
  assert.ok(r.headers.get('location').endsWith('#fuer-loeschung'));
});

test.after(async () => {
  await fastify.close();
});
