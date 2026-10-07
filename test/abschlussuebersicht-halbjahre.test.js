/**
 * Abschluss-/Abgangsübersicht: zeigt ALLE Fächer der Klasse über die gesamte
 * Laufzeit (mehrere Schuljahre), samt Fachabschlussnote. Fächer, die nur in
 * einzelnen Halbjahren gelten, tragen die Halbjahre und das/die Schuljahr(e)
 * als Beschriftung.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-abschluss-halbjahre-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-abschluss-halbjahre-test-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const J = await import('../src/klassen-jahre.js');
const { ladeAbschlussuebersicht } = await import('../src/fach-abschluss.js');

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
let klasseId, physikId, chemieId, biologieId;

test('Vorbereitung: Klasse mit Einschulung 2023 (6 Halbjahre) mit Physik (alle Halbjahre), Chemie (1.-4. Halbjahr) und Biologie (1.-2. Halbjahr)', async () => {
  let r = await form(admin, '/setup', {
    username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123',
  });
  assert.equal(r.status, 302);
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;

  await form(admin, '/admin/einladungen/neu', { display_name: 'Lehrer A', ttl_days: '14' });
  const inv = getDb().prepare('SELECT token FROM invitations ORDER BY id').get();
  await form(lehrerA, `/einladung/${inv.token}`, {
    username: 'lehrera', display_name: 'Lehrer A', password: 'passwortA1', password2: 'passwortA1',
  });
  getDb().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'lehrera'").run();

  await form(lehrerA, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '12B', notenschluessel: 'IHK', einschulung_jahr: '2023' });
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '12B'").get().id;
  await form(lehrerA, `/teacher/klassen/${klasseId}/klassenlehrer/eintragen`, {});
  await form(lehrerA, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });

  const mitHalbjahren = (name, nummern) => {
    const body = new URLSearchParams();
    body.append('name', name);
    for (const n of nummern) body.append('halbjahre', String(n));
    return lehrerA(`/teacher/klassen/${klasseId}/faecher/neu`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  };
  await form(lehrerA, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Physik' });
  await mitHalbjahren('Chemie', [1, 2, 3, 4]);
  await mitHalbjahren('Biologie', [1, 2]);
  physikId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Physik'").get(klasseId).id;
  chemieId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Chemie'").get(klasseId).id;
  biologieId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Biologie'").get(klasseId).id;
});

test('Abschluss ergibt sich aus den Halbjahren: Chemie (bis 4. Hj.) und Biologie (bis 2. Hj.) sind abgeschlossen, Physik (bis 6. Hj.) läuft', () => {
  // Heute (Testdatum) ist das 5. Halbjahr der Klasse.
  const status = (id) => getDb().prepare('SELECT * FROM faecher WHERE id = ?').get(id);
  assert.equal(J.istFachAbgeschlossen(status(physikId)), false);
  assert.equal(J.istFachAbgeschlossen(status(chemieId)), true);
  assert.equal(J.istFachAbgeschlossen(status(biologieId)), true);
});

test('ladeAbschlussuebersicht: enthält alle Fächer der Laufzeit alphabetisch, Fächer mit eingeschränkten Halbjahren mit Beschriftung', () => {
  const { faecher, zeilen } = ladeAbschlussuebersicht(klasseId);
  assert.deepEqual(
    faecher.map((f) => ({ name: f.name, schuljahrLabel: f.schuljahrLabel })),
    [
      { name: 'Biologie', schuljahrLabel: '1.–2. Halbjahr, 2023/24' },
      { name: 'Chemie', schuljahrLabel: '1.–4. Halbjahr, 2023/24–2024/25' },
      { name: 'Physik', schuljahrLabel: null },
    ],
  );
  const anna = zeilen[0];
  assert.equal(anna.noten.find((n) => n.fach.id === physikId).fach.abgeschlossen, 0);
  assert.equal(anna.noten.find((n) => n.fach.id === chemieId).fach.abgeschlossen, 1);
  assert.equal(anna.noten.find((n) => n.fach.id === biologieId).fach.abgeschlossen, 1);
});

test('Seite /teacher/klassen/:id/abschluss zeigt alle Fächer, eingeschränkte mit Halbjahren und Schuljahr(en) in der Überschrift', async () => {
  const html = await (await lehrerA(`/teacher/klassen/${klasseId}/abschluss`)).text();
  assert.match(html, /<th>Physik<br><small class="hint lehrkraefte-kopf">🎓 Lehrer A<\/small><br><small>läuft<\/small><\/th>/, 'Fach über alle Halbjahre ohne Zusatz, noch laufend');
  assert.match(html, /<th>Biologie <small class="hint">\(1\.–2\. Halbjahr, 2023\/24\)<\/small><br><small class="hint lehrkraefte-kopf">🎓 Lehrer A<\/small><br><small>abgeschlossen<\/small><\/th>/);
  assert.match(html, /<th>Chemie <small class="hint">\(1\.–4\. Halbjahr, 2023\/24–2024\/25\)<\/small><br><small class="hint lehrkraefte-kopf">🎓 Lehrer A<\/small><br><small>abgeschlossen<\/small><\/th>/);
});

test('Derselbe Reiter auf der Klassenleitungsübersicht zeigt dieselben Fächer', async () => {
  const html = await (await lehrerA(`/klassenlehrer/klasse/${klasseId}?tab=abschluss`)).text();
  assert.match(html, /Chemie <small class="hint">\(1\.–4\. Halbjahr, 2023\/24–2024\/25\)<\/small>/);
  assert.match(html, /Biologie <small class="hint">\(1\.–2\. Halbjahr, 2023\/24\)<\/small>/);
});

test.after(async () => {
  await fastify.close();
});
