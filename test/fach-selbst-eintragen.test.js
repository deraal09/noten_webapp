/**
 * Fächer der Klasse in der Noteneingabe für alle mit Klassenzugriff (ausblendbar, für die Klassenleitung dauerhaft),
 * mit den Lehrkräften; Fächer ohne Lehrkraft können sich andere Lehrkräfte selbst eintragen und wieder austragen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-selbst-eintragen-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-selbst-eintragen-bitte-lang-genug-xxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const U = await import('../src/unterfaecher.js');

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

const admin = client();
const [anna, bernd, carla, dora] = [client(), client(), client(), client()];
const db = () => getDb();
const uid = (n) => db().prepare('SELECT id FROM users WHERE username = ?').get(n).id;
let klasseId, mathe, sport, deutsch;
const zuw = (fachId) => db().prepare('SELECT fz.*, u.username FROM fach_zuweisungen fz JOIN users u ON u.id = fz.user_id WHERE fz.fach_id = ? ORDER BY fz.id').all(fachId);
const fachRow = (id) => db().prepare('SELECT * FROM faecher WHERE id = ?').get(id);

test('Vorbereitung: Anna legt 10K an (Mathe, Sport, Deutsch); Bernd hat nur Deutsch; Carla hat keinen Zugriff', async () => {
  await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sj = db().prepare('SELECT id FROM schuljahre').get().id;
  for (const [c, name] of [[anna, 'anna'], [bernd, 'bernd'], [carla, 'carla'], [dora, 'dora']]) {
    await form(admin, '/admin/einladungen/neu', { display_name: name, ttl_days: '14' });
    const inv = db().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
    await form(c, `/einladung/${inv.token}`, { username: name, display_name: name, password: 'passwort123', password2: 'passwort123' });
    db().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = ?").run(name);
  }
  await form(anna, '/teacher/klassen/neu', { schuljahr_id: String(sj), name: '10K', notenschluessel: 'IHK', einschulung_jahr: '2023' });
  klasseId = db().prepare("SELECT id FROM klassen WHERE name = '10K'").get().id;
  for (const n of ['Mathe', 'Sport', 'Deutsch']) await form(anna, `/teacher/klassen/${klasseId}/faecher/neu`, { name: n });
  const id = (n) => db().prepare('SELECT id FROM faecher WHERE klasse_id = ? AND name = ?').get(klasseId, n).id;
  [mathe, sport, deutsch] = [id('Mathe'), id('Sport'), id('Deutsch')];
  // Sport und Deutsch haben keine Lehrkraft; Bernd bekommt Zugriff auf die Klasse über Deutsch (von der Klassenleitung vergeben)
  db().prepare('DELETE FROM fach_zuweisungen WHERE fach_id IN (?, ?)').run(sport, deutsch);
  db().prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)').run(uid('bernd'), deutsch);
  assert.deepEqual(zuw(mathe).map((z) => z.username), ['anna']);
});

test('Noteneingabe zeigt Bernd die Fächer der Klasse mit Lehrkräften; ausblendbar; freie Fächer zum Eintragen', async () => {
  const html = await (await bernd('/teacher')).text();
  assert.match(html, /Weitere Fächer der Klasse/);
  assert.match(html, /weitere-schalter/, 'ausblendbar');
  assert.doesNotMatch(html, /als Klassenleitung immer sichtbar/);
  const weitere = html.slice(html.indexOf('class="weitere-faecher"'));
  assert.match(weitere, /Mathe[\s\S]*?🎓 anna/);
  assert.match(weitere, /Sport/);
  // Sport ist frei (Eintragen), Mathe hat eine Lehrkraft (kein Knopf)
  assert.match(weitere, new RegExp(`/teacher/faecher/${sport}/selbst-eintragen`));
  assert.doesNotMatch(weitere, new RegExp(`/teacher/faecher/${mathe}/selbst-eintragen`));
  assert.match(html, /id="lehrkraefte-schalter"/);
  // Carla (kein Zugriff) sieht die Klasse nicht
  assert.doesNotMatch(await (await carla('/teacher')).text(), /10K/);
});

test('Frei = ohne Lehrkraft in noch nicht vergangenen Halbjahren', () => {
  // 10K läuft seit 2023: im Testzeitraum (Okt. 2025) ist das 5. Halbjahr aktuell
  assert.deepEqual(U.freieHalbjahre(fachRow(sport)), [5, 6]);
  assert.deepEqual(U.freieHalbjahre(fachRow(mathe)), []);
});

test('Sich eintragen (ohne Zugriff verboten), nur freie Fächer, danach wieder austragen -- Fach ist wieder frei', async () => {
  assert.equal((await form(carla, `/teacher/faecher/${sport}/selbst-eintragen`)).status, 403);
  assert.equal(zuw(sport).length, 0);
  // belegtes Fach: keine Eintragung
  await form(bernd, `/teacher/faecher/${mathe}/selbst-eintragen`);
  assert.deepEqual(zuw(mathe).map((z) => z.username), ['anna']);
  // freies Fach
  const r = await form(bernd, `/teacher/faecher/${sport}/selbst-eintragen`, { zurueck: 'noteneingabe' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `/teacher#klasse-${klasseId}`);
  assert.deepEqual(zuw(sport).map((z) => [z.username, z.selbst_eingetragen]), [['bernd', 1]]);
  // jetzt vergeben: Dora (mit Zugriff) kann es nicht auch noch nehmen
  db().prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)').run(uid('dora'), deutsch);
  await form(dora, `/teacher/faecher/${sport}/selbst-eintragen`);
  assert.deepEqual(zuw(sport).map((z) => z.username), ['bernd']);
  assert.match(await (await bernd('/teacher')).text(), /Austragen/);
  // Bernd darf Sport jetzt bearbeiten
  assert.equal((await bernd(`/teacher/fach/${sport}`)).status, 200);
  // Austragen: nur die eigene
  const z = zuw(sport)[0];
  assert.equal((await form(dora, `/teacher/zuweisungen/${z.id}/selbst-austragen`)).status, 403);
  assert.equal(zuw(sport).length, 1);
  await form(bernd, `/teacher/zuweisungen/${z.id}/selbst-austragen`);
  assert.equal(zuw(sport).length, 0);
  assert.deepEqual(U.freieHalbjahre(fachRow(sport)), [5, 6]);
  assert.equal((await bernd(`/teacher/fach/${sport}`)).status, 403, 'kein Zugriff mehr');
  // Danach kann Dora übernehmen
  await form(dora, `/teacher/faecher/${sport}/selbst-eintragen`);
  assert.deepEqual(zuw(sport).map((x) => x.username), ['dora']);
  await form(dora, `/teacher/zuweisungen/${zuw(sport)[0].id}/selbst-austragen`);
});

test('Eine von der Klassenleitung vergebene Zuordnung kann man nicht selbst aufheben; Teil-Halbjahre werden ergänzt', async () => {
  // Anna wurde beim Anlegen von Mathe eingetragen: nicht selbst eingetragen -> Austragen wirkungslos
  const ann = zuw(mathe)[0];
  await form(anna, `/teacher/zuweisungen/${ann.id}/selbst-austragen`);
  assert.equal(zuw(mathe).length, 1);
  // Sport nur im 5. Halbjahr vergeben (von der Klassenleitung): Bernd bekommt das freie 6. dazu, bleibt aber "nicht selbst"
  db().prepare('INSERT INTO fach_zuweisungen (user_id, fach_id, halbjahre) VALUES (?, ?, ?)').run(uid('bernd'), sport, '[5]');
  assert.deepEqual(U.freieHalbjahre(fachRow(sport)), [6]);
  await form(bernd, `/teacher/faecher/${sport}/selbst-eintragen`);
  const z = zuw(sport)[0];
  assert.deepEqual(JSON.parse(z.halbjahre ?? 'null') ?? 'alle', [5, 6]);
  assert.equal(z.selbst_eingetragen, 0);
  await form(bernd, `/teacher/zuweisungen/${z.id}/selbst-austragen`);
  assert.equal(zuw(sport).length, 1, 'Klassenleitungs-Zuordnung bleibt');
});

test('Klassenleitung sieht alle Fächer der Klasse dauerhaft (nicht ausblendbar), auch ohne eigenes Fach', async () => {
  db().prepare('DELETE FROM fach_zuweisungen WHERE user_id = ?').run(uid('dora'));
  db().prepare('INSERT INTO klassenleitung (klasse_id, user_id) VALUES (?, ?)').run(klasseId, uid('dora'));
  const html = await (await dora('/teacher')).text();
  assert.match(html, /Fächer der Klasse/);
  assert.match(html, /als Klassenleitung immer sichtbar/);
  assert.doesNotMatch(html, /class="weitere-schalter"/);
  for (const n of ['Mathe', 'Sport', 'Deutsch']) assert.match(html, new RegExp(`kachel-titel-klein">${n}<`));
  assert.match(html, /🎓 anna/);
  // Bernd (keine Klassenleitung) kann weiter ausblenden
  assert.match(await (await bernd('/teacher')).text(), /class="weitere-schalter"/);
});

test('Klassenseite: Eintragen-Knopf bei freien Fächern, Austragen bei der eigenen Selbst-Eintragung; Zuordnen anderer nur durch die Klassenleitung', async () => {
  db().prepare('DELETE FROM fach_zuweisungen WHERE fach_id = ?').run(sport);
  let html = await (await bernd(`/teacher/klassen/${klasseId}`)).text();
  assert.match(html, new RegExp(`/teacher/faecher/${sport}/selbst-eintragen`));
  await form(bernd, `/teacher/faecher/${sport}/selbst-eintragen`);
  html = await (await bernd(`/teacher/klassen/${klasseId}`)).text();
  assert.match(html, /selbst-austragen/);
  assert.doesNotMatch(html, /\/teacher\/zuweisungen\/\d+\/loeschen/, 'Bernd entfernt keine anderen');
  // andere eintragen/entfernen: nur Klassenleitung
  assert.equal((await form(bernd, `/teacher/klassen/${klasseId}/zuweisungen/neu`, { user_id: String(uid('carla')), fach_id: String(mathe) })).status, 403);
  assert.equal((await form(bernd, `/teacher/zuweisungen/${zuw(mathe)[0].id}/loeschen`)).status, 403);
  assert.equal((await form(dora, `/teacher/zuweisungen/${zuw(sport)[0].id}/loeschen`)).status, 302, 'Klassenleitung darf entfernen');
  assert.equal(zuw(sport).length, 0);
});

test('Stift (Halbjahre des Fachs ändern) nur für die Klassenleitung bzw. -- ohne Klassenleitung -- die erstellende Lehrkraft', async () => {
  const STIFT = /Halbjahre des Fachs ändern/;
  // dora ist Klassenleitung (aus dem vorigen Test), anna hat die Klasse erstellt, bernd hat nur ein Fach
  assert.match(await (await dora(`/teacher/klassen/${klasseId}`)).text(), STIFT);
  assert.doesNotMatch(await (await anna(`/teacher/klassen/${klasseId}`)).text(), STIFT, 'Erstellerin verliert es mit einer Klassenleitung');
  assert.doesNotMatch(await (await bernd(`/teacher/klassen/${klasseId}`)).text(), STIFT);
  assert.equal((await form(bernd, `/teacher/faecher/${deutsch}/halbjahre`, { halbjahre: ['1', '2'] })).status, 403, 'auch nicht per Direktaufruf');
  assert.equal((await form(anna, `/teacher/faecher/${deutsch}/halbjahre`, { halbjahre: ['1', '2'] })).status, 403);
  // ohne Klassenleitung: die erstellende Lehrkraft sieht und darf es, andere weiterhin nicht
  db().prepare('DELETE FROM klassenleitung WHERE klasse_id = ?').run(klasseId);
  assert.match(await (await anna(`/teacher/klassen/${klasseId}`)).text(), STIFT);
  assert.doesNotMatch(await (await bernd(`/teacher/klassen/${klasseId}`)).text(), STIFT);
  assert.equal((await form(anna, `/teacher/faecher/${deutsch}/halbjahre`, { halbjahre: ['1', '2'] })).status, 302);
  assert.equal((await form(anna, `/teacher/faecher/${deutsch}/halbjahre`, { halbjahre: ['1', '2', '3', '4', '5', '6'] })).status, 302);
  db().prepare('INSERT INTO klassenleitung (klasse_id, user_id) VALUES (?, ?)').run(klasseId, uid('dora'));
});

test('Beitritt zu einer freigegebenen Klasse: Fach ohne Lehrkraft übernehmen statt abgewiesen zu werden', async () => {
  db().prepare('UPDATE klassen SET offen_fuer_beitritt = 1 WHERE id = ?').run(klasseId);
  db().prepare('DELETE FROM fach_zuweisungen WHERE fach_id = ?').run(sport);
  const [emil, finn] = [client(), client()];
  for (const [c, name] of [[emil, 'emil'], [finn, 'finn']]) {
    await form(admin, '/admin/einladungen/neu', { display_name: name, ttl_days: '14' });
    const inv = db().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
    await form(c, `/einladung/${inv.token}`, { username: name, display_name: name, password: 'passwort123', password2: 'passwort123' });
    db().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = ?").run(name);
  }
  // Die Beitrittsseite bietet die Fächer ohne Lehrkraft direkt an
  const seite = await (await emil(`/teacher/klassen/${klasseId}/verknuepfen`)).text();
  assert.match(seite, /Fächer ohne Lehrkraft/);
  assert.match(seite, /Sport übernehmen/);
  assert.doesNotMatch(seite, /Mathe übernehmen/, 'Mathe hat eine Lehrkraft');
  // Fach mit Lehrkraft: weiterhin abgewiesen
  await form(finn, `/teacher/klassen/${klasseId}/verknuepfen`, { fach: 'Mathe' });
  assert.equal(zuw(mathe).some((z) => z.username === 'finn'), false);
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM fach_zuweisungen WHERE user_id = ?').get(uid('finn')).c, 0);
  // freies Fach: übernommen, als selbst eingetragen (wieder austragbar), Zugriff auf die Klasse
  const r = await form(emil, `/teacher/klassen/${klasseId}/verknuepfen`, { fach: 'Sport' });
  assert.equal(r.status, 302);
  assert.deepEqual(zuw(sport).map((z) => [z.username, z.selbst_eingetragen]), [['emil', 1]]);
  assert.equal((await emil(`/teacher/klassen/${klasseId}`)).status, 200);
  // ein neues, noch nicht vorhandenes Fach geht weiterhin
  await form(finn, `/teacher/klassen/${klasseId}/verknuepfen`, { fach: 'Physik' });
  assert.ok(db().prepare("SELECT 1 FROM faecher f JOIN fach_zuweisungen fz ON fz.fach_id = f.id WHERE f.name = 'Physik' AND fz.user_id = ?").get(uid('finn')));
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
