/**
 * "Vergangene Schuljahre hinzufügen" in der Klassenleitungsübersicht (Tab
 * "Halbjahresübersicht"): legt auf einen Schlag für ALLE Fächer einer
 * Klasse ein Paar historischer Halbjahre ("1./2. Halbjahr <Schuljahr>") an,
 * statt dass die Klassenleitung das Fach für Fach von Hand eintippen muss.
 *
 * Deckt sowohl die reinen Service-Funktionen (src/fach-abschluss.js:
 * ladeVergangeneSchuljahre/fuegeVergangenesSchuljahrHinzu) als auch die
 * echte Route (POST /klassenlehrer/klasse/:id/vergangenes-schuljahr/neu)
 * inklusive der drei geforderten Sperren ab: kein aktuelles/zukünftiges
 * Schuljahr, kein bereits vorhandenes vergangenes Schuljahr, und dass die
 * eigentliche Noteneingabe unverändert über die bestehende
 * "Historische Halbjahre"-Seite je Fach läuft.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-vergangene-schuljahre-test-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-vergangene-schuljahre-test-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { ladeVergangeneSchuljahre, fuegeVergangenesSchuljahrHinzu } = await import('../src/fach-abschluss.js');

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
const lehrerFremd = client();
let klasseId;

test('Vorbereitung: Klasse 12A mit zwei Fächern, Lehrer A als Klassenleitung, eine fachfremde Lehrkraft', async () => {
  await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2026/27' });
  const sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2026/27'").get().id;
  await form(admin, `/admin/schuljahre/${sjId}/klassen/neu`, { name: '12A' });
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '12A'").get().id;
  await form(admin, `/admin/klassen/${klasseId}/faecher/neu`, { name: 'Deutsch' });
  await form(admin, `/admin/klassen/${klasseId}/faecher/neu`, { name: 'Mathematik' });
  await form(admin, `/admin/klassen/${klasseId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });

  for (const [name, uname] of [['Lehrer A', 'lehrera'], ['Lehrer Fremd', 'lehrerfremd']]) {
    await form(admin, '/admin/einladungen/neu', { display_name: name, ttl_days: '14' });
  }
  const invs = getDb().prepare('SELECT token, display_name FROM invitations ORDER BY id').all();
  for (const inv of invs) {
    const c = inv.display_name === 'Lehrer A' ? lehrerA : lehrerFremd;
    const uname = inv.display_name === 'Lehrer A' ? 'lehrera' : 'lehrerfremd';
    await form(c, `/einladung/${inv.token}`, { username: uname, password: 'lehrerpass123', password2: 'lehrerpass123' });
  }
  getDb().prepare('INSERT INTO klassenleitung (klasse_id, user_id) VALUES (?, (SELECT id FROM users WHERE username = ?))')
    .run(klasseId, 'lehrera');
});

test('fuegeVergangenesSchuljahrHinzu legt für ALLE Fächer der Klasse zwei historische Halbjahre an', () => {
  const ergebnis = fuegeVergangenesSchuljahrHinzu(klasseId, '2024/25', 1);
  assert.deepEqual(ergebnis, { ok: true });

  const faecher = getDb().prepare('SELECT id, name FROM faecher WHERE klasse_id = ?').all(klasseId);
  assert.equal(faecher.length, 2);
  for (const f of faecher) {
    const hh = getDb().prepare('SELECT bezeichnung FROM historische_halbjahre WHERE fach_id = ? ORDER BY reihenfolge').all(f.id);
    assert.deepEqual(hh.map((h) => h.bezeichnung), ['1. Halbjahr 2024/25', '2. Halbjahr 2024/25']);
  }
});

test('fuegeVergangenesSchuljahrHinzu lehnt ein bereits vorhandenes Schuljahr ab (keine Duplikate)', () => {
  const ergebnis = fuegeVergangenesSchuljahrHinzu(klasseId, '2024/25', 1);
  assert.deepEqual(ergebnis, { ok: false, fehler: 'bereits-vorhanden' });

  // Keine zusätzlichen Zeilen entstanden.
  const faecher = getDb().prepare('SELECT id FROM faecher WHERE klasse_id = ?').all(klasseId);
  for (const f of faecher) {
    const anzahl = getDb().prepare('SELECT COUNT(*) AS c FROM historische_halbjahre WHERE fach_id = ?').get(f.id).c;
    assert.equal(anzahl, 2);
  }
});

test('ladeVergangeneSchuljahre gruppiert die beiden Halbjahre zu einem Schuljahr, mit allen beteiligten Fächern', () => {
  const liste = ladeVergangeneSchuljahre(klasseId);
  assert.equal(liste.length, 1);
  assert.equal(liste[0].schuljahr, '2024/25');
  assert.deepEqual(liste[0].faecher.map((f) => f.name).sort(), ['Deutsch', 'Mathematik']);
});

test('POST /klassenlehrer/klasse/:id/vergangenes-schuljahr/neu: nur die Klassenleitung darf', async () => {
  const r = await form(lehrerFremd, `/klassenlehrer/klasse/${klasseId}/vergangenes-schuljahr/neu`, { bezeichnung: '2023/24' });
  assert.equal(r.status, 403);
  assert.equal(ladeVergangeneSchuljahre(klasseId).length, 1); // unverändert
});

test('POST .../vergangenes-schuljahr/neu: aktuelles/zukünftiges Schuljahr wird abgelehnt', async () => {
  let r = await form(lehrerA, `/klassenlehrer/klasse/${klasseId}/vergangenes-schuljahr/neu`, { bezeichnung: '2026/27' });
  assert.equal(r.status, 302);
  assert.equal(ladeVergangeneSchuljahre(klasseId).length, 1);

  r = await form(lehrerA, `/klassenlehrer/klasse/${klasseId}/vergangenes-schuljahr/neu`, { bezeichnung: '2027/28' });
  assert.equal(r.status, 302);
  assert.equal(ladeVergangeneSchuljahre(klasseId).length, 1);
});

test('POST .../vergangenes-schuljahr/neu: ungültiges Format wird abgelehnt', async () => {
  const r = await form(lehrerA, `/klassenlehrer/klasse/${klasseId}/vergangenes-schuljahr/neu`, { bezeichnung: 'irgendwas' });
  assert.equal(r.status, 302);
  assert.equal(ladeVergangeneSchuljahre(klasseId).length, 1);
});

test('POST .../vergangenes-schuljahr/neu: Klassenleitung legt ein echtes vergangenes Schuljahr über die Route an', async () => {
  const r = await form(lehrerA, `/klassenlehrer/klasse/${klasseId}/vergangenes-schuljahr/neu`, { bezeichnung: '2023/24' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `/klassenlehrer/klasse/${klasseId}?tab=halbjahr`);

  const liste = ladeVergangeneSchuljahre(klasseId);
  assert.deepEqual(liste.map((sj) => sj.schuljahr).sort(), ['2023/24', '2024/25']);
});

test('Klassenleitungsübersicht zeigt die vergangenen Schuljahre mit Links zur Fach-Seite', async () => {
  const html = await (await lehrerA(`/klassenlehrer/klasse/${klasseId}?tab=halbjahr`)).text();
  assert.ok(html.includes('2023/24'));
  assert.ok(html.includes('2024/25'));
  assert.ok(html.includes('?tab=historie'));
});

test('Die eigentliche Noteneingabe läuft weiter über die bestehende Fach-Seite (Historische Halbjahre), für Klassenleitung UND Fachlehrkraft', async () => {
  const deutschId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Deutsch'").get(klasseId).id;
  const hh = getDb().prepare("SELECT id FROM historische_halbjahre WHERE fach_id = ? AND bezeichnung = '1. Halbjahr 2023/24'").get(deutschId);
  const schuelerId = getDb().prepare('SELECT id FROM schueler WHERE klasse_id = ?').get(klasseId).id;

  // Fachlehrkraft ohne Zuweisung darf (noch) nicht -- erst nach Zuweisung.
  let r = await form(lehrerFremd, `/teacher/historie/${hh.id}/speichern`, { ['note_' + schuelerId]: '2' });
  assert.equal(r.status, 403);

  // Klassenleitung darf direkt (userDarfFachBearbeiten erlaubt Klassenleitung).
  r = await form(lehrerA, `/teacher/historie/${hh.id}/speichern`, { ['note_' + schuelerId]: '2' });
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare('SELECT note FROM historische_noten WHERE historisches_halbjahr_id = ? AND schueler_id = ?').get(hh.id, schuelerId).note, 2);
});

test.after(async () => {
  await fastify.close();
});
