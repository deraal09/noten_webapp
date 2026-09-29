/**
 * Abschluss-/Abgangsübersicht: zeigt seit dieser Änderung nicht mehr nur die
 * Fächer des laufenden Schuljahres, sondern ALLE Fächer der gesamten
 * Schullaufbahn -- also auch rein historische Fächer vergangener Schuljahre
 * (siehe "Vergangenes Schuljahr hinzufügen"/Noten-Import), samt deren
 * Fachabschlussnote. Ein rein historisches Fach wird beim Anlegen eines
 * vergangenen Schuljahres per Name wiederverwendet (siehe
 * fuegeVergangenesSchuljahrHinzu) und kann deshalb historische Halbjahre
 * mehrerer Schuljahre tragen -- die Spalte zeigt dafür die Schuljahr-Spanne.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-abschluss-historisch-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-abschluss-historisch-test-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
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

test('Vorbereitung: Klasse (2025/26) mit aktuellem Fach Physik, plus zwei vergangene Schuljahre mit Fächern "Chemie" (beide Jahre) und "Biologie" (nur 2021/22)', async () => {
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

  await form(lehrerA, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '12B', notenschluessel: 'IHK' });
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '12B'").get().id;
  await form(lehrerA, `/teacher/klassen/${klasseId}/klassenlehrer/eintragen`, {});
  await form(lehrerA, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });

  await form(lehrerA, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Physik' });
  physikId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Physik'").get(klasseId).id;

  // "Chemie" existiert unter diesem Namen noch nicht -> wird beim ersten
  // vergangenen Schuljahr (2023/24) neu als rein historisches Fach angelegt.
  await form(lehrerA, `/klassenlehrer/klasse/${klasseId}/vergangenes-schuljahr/neu`, {
    bezeichnung: '2023/24', faecher: 'Chemie\nBiologie',
  });
  // Beim zweiten, ÄLTEREN vergangenen Schuljahr (2021/22) wird "Chemie" (Name
  // existiert bereits) wiederverwendet -- dasselbe Fach bekommt weitere
  // historische Halbjahre dazu, statt eine zweite Spalte zu erzeugen.
  // "Biologie" nur für 2023/24, nicht für 2021/22.
  await form(lehrerA, `/klassenlehrer/klasse/${klasseId}/vergangenes-schuljahr/neu`, {
    bezeichnung: '2021/22', faecher: 'Chemie',
  });

  chemieId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Chemie'").get(klasseId).id;
  biologieId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Biologie'").get(klasseId).id;
  const chemieHalbjahre = getDb().prepare('SELECT bezeichnung FROM historische_halbjahre WHERE fach_id = ? ORDER BY reihenfolge').all(chemieId);
  assert.deepEqual(chemieHalbjahre.map((h) => h.bezeichnung), [
    '1. Halbjahr 2023/24', '2. Halbjahr 2023/24', '1. Halbjahr 2021/22', '2. Halbjahr 2021/22',
  ], '"Chemie" ist EIN Fach mit historischen Halbjahren aus zwei Schuljahren, keine zwei getrennten Fächer');
});

test('Fach abschließen: das aktuelle Fach UND das durchgehende historische Fach werden abgeschlossen, "Biologie" läuft weiter', async () => {
  await form(lehrerA, `/teacher/fach/${physikId}/abschliessen`, {});
  await form(lehrerA, `/teacher/fach/${chemieId}/abschliessen`, {});
  assert.equal(getDb().prepare('SELECT abgeschlossen FROM faecher WHERE id = ?').get(physikId).abgeschlossen, 1);
  assert.equal(getDb().prepare('SELECT abgeschlossen FROM faecher WHERE id = ?').get(chemieId).abgeschlossen, 1);
  assert.equal(getDb().prepare('SELECT abgeschlossen FROM faecher WHERE id = ?').get(biologieId).abgeschlossen, 0);
});

test('ladeAbschlussuebersicht: enthält alle Fächer über alle Schuljahre, aktuelles Fach zuerst, historische Fächer alphabetisch mit Schuljahr(en)-Beschriftung', () => {
  const { faecher, zeilen } = ladeAbschlussuebersicht(klasseId);
  assert.deepEqual(
    faecher.map((f) => ({ name: f.name, schuljahrLabel: f.schuljahrLabel })),
    [
      { name: 'Physik', schuljahrLabel: null },
      { name: 'Biologie', schuljahrLabel: '2023/24' },
      { name: 'Chemie', schuljahrLabel: '2021/22–2023/24' },
    ],
  );
  assert.equal(faecher[1].id, biologieId);
  assert.equal(faecher[2].id, chemieId);

  const anna = zeilen[0];
  assert.equal(anna.noten.find((n) => n.fach.id === physikId).fach.abgeschlossen, 1);
  assert.equal(anna.noten.find((n) => n.fach.id === chemieId).fach.abgeschlossen, 1);
  assert.equal(anna.noten.find((n) => n.fach.id === biologieId).fach.abgeschlossen, 0);
});

test('Seite /teacher/klassen/:id/abschluss zeigt aktuelle und historische Fächer nebeneinander, historische mit Schuljahr(en) in der Überschrift', async () => {
  const html = await (await lehrerA(`/teacher/klassen/${klasseId}/abschluss`)).text();
  assert.match(html, /<th>Physik<br>/, 'aktuelles Fach ohne Schuljahr-Zusatz');
  assert.match(html, /<th>Biologie <small class="hint">\(2023\/24\)<\/small><br><small>läuft<\/small><\/th>/);
  assert.match(html, /<th>Chemie <small class="hint">\(2021\/22–2023\/24\)<\/small><br><small>abgeschlossen<\/small><\/th>/);

  const idxPhysik = html.indexOf('<th>Physik');
  const idxBio = html.indexOf('<th>Biologie');
  const idxChemie = html.indexOf('<th>Chemie');
  assert.ok(idxPhysik > 0 && idxPhysik < idxBio && idxBio < idxChemie, 'aktuelles Fach zuerst, dann historische alphabetisch');
});

test('Derselbe Reiter auf der Klassenleitungsübersicht zeigt dieselben Fächer', async () => {
  const html = await (await lehrerA(`/klassenlehrer/klasse/${klasseId}?tab=abschluss`)).text();
  assert.match(html, /Chemie <small class="hint">\(2021\/22–2023\/24\)<\/small>/);
  assert.match(html, /Biologie <small class="hint">\(2023\/24\)<\/small>/);
});

test.after(async () => {
  await fastify.close();
});
