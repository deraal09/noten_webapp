/**
 * ⚙ Fach einstellen (IHK/BG): Name, Halbjahre, Unterfächer als Text (Name; Gewicht; Halbjahre) und Verrechnung der
 * Halbjahre auf einer Seite -- statt der früheren Symbole für Halbjahre, Unterfach hinzufügen/löschen und Verrechnung.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-fach-einstellungen-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-fach-einstellungen-bitte-lang-genug-xx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const E = await import('../src/fach-einstellungen.js');
const J = await import('../src/klassen-jahre.js');

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
const form = (req, url, body = {}) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) for (const w of Array.isArray(v) ? v : [v]) params.append(k, w);
  return req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params });
};

const admin = client();
const lehrer = client();
const db = () => getDb();
let klasseId, matheId, annaId;
const fach = (id) => db().prepare('SELECT * FROM faecher WHERE id = ?').get(id);
const kinder = () => db().prepare('SELECT * FROM faecher WHERE parent_fach_id = ? ORDER BY id').all(matheId);
const einstellungen = (body) => form(admin, `/teacher/faecher/${matheId}/einstellungen`, { name: 'Mathe', halbjahre: ['1', '2', '3', '4', '5', '6'], ...body });

test('Vorbereitung: Klasse (Einschulung 2023), Fach Mathe, eine Person, eine Lehrkraft mit Fachzugriff', async () => {
  await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sj = db().prepare('SELECT id FROM schuljahre').get().id;
  await form(admin, '/admin/einladungen/neu', { display_name: 'lehrer', ttl_days: '14' });
  const inv = db().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
  await form(lehrer, `/einladung/${inv.token}`, { username: 'lehrer', display_name: 'lehrer', password: 'passwort123', password2: 'passwort123' });
  await form(admin, '/teacher/klassen/neu', { schuljahr_id: String(sj), name: '11A', notenschluessel: 'IHK', einschulung_jahr: '2023' });
  klasseId = db().prepare("SELECT id FROM klassen WHERE name = '11A'").get().id;
  await form(admin, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Mathe' });
  matheId = db().prepare('SELECT id FROM faecher WHERE klasse_id = ?').get(klasseId).id;
  await form(admin, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
  annaId = db().prepare('SELECT id FROM schueler').get().id;
  db().prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES ((SELECT id FROM users WHERE username = ?), ?)').run('lehrer', matheId);
});

test('Textformat: Halbjahre lesen und schreiben, Fehler mit Zeilennummer', () => {
  const l = J.klassenLaufzeit(klasseId);
  const ok = E.parseUnterfaecher('Algebra; 3; 3-4\n\nGeometrie;;1, 3\nStatistik', l);
  assert.deepEqual(ok.eintraege, [
    { name: 'Algebra', gewicht: 3, nummern: [3, 4] },
    { name: 'Geometrie', gewicht: null, nummern: [1, 3] },
    { name: 'Statistik', gewicht: null, nummern: null },
  ]);
  assert.equal(E.parseUnterfaecher('Algebra; 2,5', l).eintraege[0].gewicht, 2.5, 'Komma als Dezimaltrenner');
  assert.match(E.parseUnterfaecher('Algebra; x', l).fehler, /Zeile 1.*Gewicht/);
  assert.match(E.parseUnterfaecher('A\nB; 1; 9', l).fehler, /Zeile 2.*Halbjahr „9“/);
  assert.match(E.parseUnterfaecher('A; 1; abc', l).fehler, /nicht verständlich/);
  assert.match(E.parseUnterfaecher('A\na', l).fehler, /Zeile 2.*schon in der Liste/);
  assert.equal(E.halbjahreAlsText([3, 4], [1, 2, 3, 4, 5, 6]), '3, 4');
  assert.equal(E.halbjahreAlsText([2, 3, 4], [1, 2, 3, 4, 5, 6]), '2-4');
  assert.equal(E.halbjahreAlsText([1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6]), 'alle');
  assert.equal(E.halbjahreAlsText([1, 3, 5], [1, 2, 3, 4, 5, 6]), '1, 3, 5');
});

test('Zugriff: nur Klassenleitung/Ersteller/Admin; SPA-Fach leitet zum Bewertungsschema; Unterfach hat keine Seite', async () => {
  assert.equal((await admin(`/teacher/faecher/${matheId}/einstellungen`)).status, 200);
  assert.equal((await lehrer(`/teacher/faecher/${matheId}/einstellungen`)).status, 403);
  assert.equal((await form(lehrer, `/teacher/faecher/${matheId}/einstellungen`, { name: 'X', unterfaecher: 'Y' })).status, 403);
  assert.equal(fach(matheId).name, 'Mathe');
  assert.equal((await admin('/teacher/faecher/9999/einstellungen')).status, 404);
});

test('Unterfächer per Text anlegen (Gewicht, Halbjahre), Seite zeigt sie wieder als Text', async () => {
  const r = await einstellungen({ unterfaecher: 'Algebra; 3; 3-4\nGeometrie; 1; 3, 4' });
  assert.equal(r.status, 302);
  const k = kinder();
  assert.deepEqual(k.map((x) => [x.kurzname, x.name, x.gewicht, x.halbjahre]), [
    ['Algebra', 'Mathe › Algebra', 3, '[3,4]'],
    ['Geometrie', 'Mathe › Geometrie', 1, '[3,4]'],
  ]);
  const html = await (await admin(`/teacher/faecher/${matheId}/einstellungen`)).text();
  assert.match(html, /Algebra; 3; 3, 4\nGeometrie; 1; 3, 4/);
});

test('Ändern: Gewicht, Halbjahre eines Unterfachs, neues Unterfach; Zeile entfernen löscht (ohne Daten)', async () => {
  await einstellungen({ unterfaecher: 'Algebra; 2; 3\nGeometrie; 1; 3, 4\nStatistik; ; 4' });
  let k = kinder();
  assert.deepEqual(k.map((x) => [x.kurzname, x.gewicht, x.halbjahre]), [['Algebra', 2, '[3]'], ['Geometrie', 1, '[3,4]'], ['Statistik', null, '[4]']]);
  await einstellungen({ unterfaecher: 'Algebra; 2; 3\nStatistik; ; 4' });
  assert.deepEqual(kinder().map((x) => x.kurzname), ['Algebra', 'Statistik'], 'Geometrie wurde entfernt');
});

test('Unterfach mit eingetragenen Noten wird nicht gelöscht (Hinweis), der Rest wird gespeichert', async () => {
  const alg = kinder().find((x) => x.kurzname === 'Algebra').id;
  db().prepare("INSERT INTO halbjahr_endnoten (fach_id, schueler_id, halbjahr, note) VALUES (?, ?, '3. Halbjahr', 2)").run(alg, annaId);
  await einstellungen({ unterfaecher: 'Statistik; 4; 4' });
  assert.deepEqual(kinder().map((x) => x.kurzname), ['Algebra', 'Statistik'], 'Algebra bleibt wegen der Endnote');
  assert.equal(kinder().find((x) => x.kurzname === 'Statistik').gewicht, 4);
});

test('Fehler im Text: Seite mit Meldung, nichts gespeichert; doppelter Fachname', async () => {
  const vorher = JSON.stringify(kinder());
  const r = await einstellungen({ name: 'Neu', unterfaecher: 'Statistik; viel; 4' });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Zeile 1.*Gewicht/);
  assert.match(html, /Statistik; viel; 4/, 'Eingabe bleibt im Textfeld');
  assert.equal(JSON.stringify(kinder()), vorher);
  assert.equal(fach(matheId).name, 'Mathe');
  await form(admin, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Deutsch' });
  const doppelt = await einstellungen({ name: 'Deutsch', unterfaecher: 'Algebra; 2; 3' });
  assert.equal(doppelt.status, 200);
  assert.match(await doppelt.text(), /gibt es in dieser Klasse schon/);
});

test('Name und Halbjahre des Fachs; Unterfächer ziehen den Namen mit; Halbjahre mit Daten sind geschützt', async () => {
  await einstellungen({ name: 'Mathematik', halbjahre: ['1', '2', '3', '4'], unterfaecher: 'Algebra; 2; 3\nStatistik; 4; 4' });
  assert.equal(fach(matheId).name, 'Mathematik');
  assert.equal(fach(matheId).halbjahre, '[1,2,3,4]');
  assert.deepEqual(kinder().map((x) => x.name), ['Mathematik › Algebra', 'Mathematik › Statistik']);
  // Halbjahr 3 hat Daten (Endnote Algebra): lässt sich nicht abwählen -> nichts ändert sich
  const r = await einstellungen({ name: 'Mathe2', halbjahre: ['1', '2', '4'], unterfaecher: 'Algebra; 2; 3\nStatistik; 4; 4' });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /3\. Halbjahr/);
  assert.equal(fach(matheId).name, 'Mathematik');
  assert.equal(fach(matheId).halbjahre, '[1,2,3,4]');
  await einstellungen({ name: 'Mathe', halbjahre: ['1', '2', '3', '4', '5', '6'], unterfaecher: 'Algebra; 2; 3\nStatistik; 4; 4' });
  assert.equal(fach(matheId).halbjahre, null);
});

test('Verrechnung der Halbjahre auf der Seite (nur dieses Fach oder alle Fächer)', async () => {
  await einstellungen({ unterfaecher: 'Algebra; 2; 3\nStatistik; 4; 4', p_1: '40', p_2: '0', p_3: '25' });
  assert.deepEqual(J.ladeVerrechnungFuerFach(fach(matheId)), { 1: 40, 3: 25 });
  const deutsch = db().prepare("SELECT id FROM faecher WHERE name = 'Deutsch'").get().id;
  assert.notDeepEqual(J.ladeVerrechnungFuerFach(fach(deutsch)), { 1: 40, 3: 25 }, 'andere Fächer bleiben unberührt');
  await einstellungen({ unterfaecher: 'Algebra; 2; 3\nStatistik; 4; 4', p_1: '10', fuer_alle: '1' });
  assert.deepEqual(J.ladeVerrechnungFuerFach(fach(deutsch)), { 1: 10 });
  assert.deepEqual(J.ladeVerrechnungFuerFach(fach(matheId)), { 1: 10 });
  const ungueltig = await einstellungen({ unterfaecher: 'Algebra; 2; 3\nStatistik; 4; 4', p_1: '150' });
  assert.equal(ungueltig.status, 200);
  assert.match(await ungueltig.text(), /Ungültiger Prozentwert/);
  // die Seite zeigt die eingestellten Werte
  const html = await (await admin(`/teacher/faecher/${matheId}/einstellungen`)).text();
  assert.match(html, /name="p_1"[^>]*value="10"/);
});

test('Klassenseite: Zahnrad je Fach, Übersicht bleibt, die alten Symbole und Dialoge sind weg', async () => {
  const html = await (await admin(`/teacher/klassen/${klasseId}`)).text();
  assert.match(html, new RegExp(`href="/teacher/faecher/${matheId}/einstellungen"[^>]*>⚙</a>`));
  assert.match(html, /unterfaecher-liste/, 'Unterfächer stehen weiter in der Übersicht');
  assert.match(html, /<details class="card" id="verrechnung">/, 'Verrechnungs-Übersicht bleibt');
  assert.match(html, /1\. → 2\.: 10 %/);
  for (const weg of ['Halbjahre des Fachs ändern', 'Halbjahre des Unterfachs ändern', 'Unterfach hinzufügen', 'Unterfach löschen', 'data-verrechnung-dialog', 'Verrechnung einstellen"']) {
    assert.equal(html.includes(weg), false, `${weg} ist entfernt`);
  }
  // Lehrkraft ohne Verwaltungsrecht sieht kein Zahnrad
  assert.doesNotMatch(await (await lehrer(`/teacher/klassen/${klasseId}`)).text(), /faecher\/\d+\/einstellungen/);
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
