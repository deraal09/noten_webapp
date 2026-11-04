/**
 * Übergeordnete Notenschlüssel: der Admin passt IHK/BG zentral an (Admin → Notenschlüssel), alle Klassen ohne eigenen
 * Schlüssel folgen ihm, Lehrkräfte, die ihn nutzen, sehen einen Hinweis; ansehen können ihn alle, ändern nur der Admin.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-ns-global-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-ns-global-bitte-lang-genug-xxxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { getNotenschluesselCsv } = await import('../src/noten-service.js');
const { pruefeCsv } = await import('../src/notenschluessel.js');
const { DEFAULT_NS_CSV } = await import('../src/grade-calc.js');
const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
test.after(() => fastify.close());

function client() {
  const cookies = new Map();
  return async function req(url, body) {
    const headers = {};
    if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    const opts = { headers, redirect: 'manual' };
    if (body) {
      opts.method = 'POST';
      headers['content-type'] = 'application/x-www-form-urlencoded';
      opts.body = new URLSearchParams(body);
    }
    const r = await fetch(base + url, opts);
    for (const raw of r.headers.getSetCookie?.() ?? []) {
      const [k, ...v] = raw.split(';')[0].split('=');
      cookies.set(k.trim(), v.join('=').trim());
    }
    return r;
  };
}
const admin = client();
const anna = client(); // nutzt IHK
const ben = client(); // nutzt BG
const cora = client(); // hat keine Klasse
const NEU_IHK = '100,1;90,1.5;50,4;0,6';
const NEU_BG = '100,15;80,12;50,6;0,0';

const klasseVon = (name) => getDb().prepare('SELECT * FROM klassen WHERE name = ?').get(name);

test('Vorbereitung: Admin, drei Lehrkräfte, zwei Klassen (IHK, BG)', async () => {
  await admin('/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await admin('/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sj = getDb().prepare('SELECT id FROM schuljahre').get().id;
  for (const [c, n] of [[anna, 'anna'], [ben, 'ben'], [cora, 'cora']]) {
    await admin('/admin/einladungen/neu', { display_name: n, ttl_days: '14' });
    const inv = getDb().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
    await c(`/einladung/${inv.token}`, { username: n, display_name: n, password: 'passwort123', password2: 'passwort123' });
  }
  getDb().prepare("UPDATE users SET auth_source = 'ldap' WHERE username IN ('anna', 'ben')").run();
  await anna('/teacher/klassen/neu', { schuljahr_id: String(sj), name: '11I', notenschluessel: 'IHK', einschulung_jahr: '2025' });
  await ben('/teacher/klassen/neu', { schuljahr_id: String(sj), name: '11B', notenschluessel: 'BG', einschulung_jahr: '2025' });
  assert.ok(klasseVon('11I') && klasseVon('11B'));
});

test('Ohne Anpassung gilt die Vorgabe; keine Hinweise', async () => {
  assert.equal(getNotenschluesselCsv({ klasse_id: klasseVon('11I').id }), DEFAULT_NS_CSV.IHK);
  assert.equal(getNotenschluesselCsv({ klasse_id: klasseVon('11B').id }), DEFAULT_NS_CSV.BG);
  assert.doesNotMatch(await (await anna('/start')).text(), /ns-hinweis/);
});

test('Nur der Admin darf bearbeiten', async () => {
  const r = await anna('/admin/notenschluessel/IHK', { csv: NEU_IHK });
  assert.notEqual(r.status, 200);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM notenschluessel_global').get().c, 0);
  const g = await anna('/admin/notenschluessel');
  assert.notEqual(g.status, 200);
});

test('Ungültige Definitionen werden abgelehnt', async () => {
  assert.equal(pruefeCsv('IHK', '100,1;50,4').ok, false, 'endet nicht bei 0');
  assert.equal(pruefeCsv('IHK', '100,7;0,6').ok, false, 'Note außerhalb');
  assert.equal(pruefeCsv('IHK', '100,1;50,4;50,3;0,6').ok, false, 'doppelter Prozentwert');
  assert.equal(pruefeCsv('IHK', '100,4;50,1;0,6').ok, false, 'mit weniger Prozent besser');
  assert.equal(pruefeCsv('BG', '100,5;50,10;0,0').ok, false, 'BG: mit weniger Prozent mehr Punkte');
  assert.equal(pruefeCsv('IHK', 'quatsch').ok, false);
  const r = await admin('/admin/notenschluessel/IHK', { csv: '100,4;50,1;0,6' });
  assert.equal(r.status, 400);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM notenschluessel_global').get().c, 0);
});

test('Admin passt IHK an: gilt für die Klasse, nur IHK-Nutzende bekommen den Hinweis', async () => {
  const r = await admin('/admin/notenschluessel/IHK', { csv: NEU_IHK, hinweis: 'Note 4 erst ab 50 %' });
  assert.equal(r.status, 302);
  assert.equal(getNotenschluesselCsv({ klasse_id: klasseVon('11I').id }), NEU_IHK);
  assert.equal(getNotenschluesselCsv({ klasse_id: klasseVon('11B').id }), DEFAULT_NS_CSV.BG);

  const html = await (await anna('/start')).text();
  assert.match(html, /ns-hinweis/);
  assert.match(html, /Note 4 erst ab 50 %/);
  assert.doesNotMatch(await (await ben('/start')).text(), /ns-hinweis/, 'BG-Nutzende nicht betroffen');
  assert.doesNotMatch(await (await cora('/start')).text(), /ns-hinweis/, 'ohne Klasse kein Hinweis');
  assert.doesNotMatch(await (await admin('/start')).text(), /ns-hinweis/, 'Admin bekommt keinen Hinweis');
});

test('Unveränderte Eingabe zählt nicht als Änderung', async () => {
  await admin('/admin/notenschluessel/IHK', { csv: NEU_IHK, hinweis: 'egal' });
  assert.equal(getDb().prepare("SELECT version FROM notenschluessel_global WHERE typ = 'IHK'").get().version, 1);
});

test('Ansehen (alle, nur lesend) bestätigt den Hinweis', async () => {
  const html = await (await anna('/notenschluessel')).text();
  assert.match(html, /Notenschlüssel/);
  assert.match(html, /1,5/);
  assert.doesNotMatch(html, /<textarea/, 'kein Formular zum Ändern');
  assert.doesNotMatch(html, /ns-hinweis/);
  assert.doesNotMatch(await (await anna('/start')).text(), /ns-hinweis/, 'danach kein Hinweis mehr');
  assert.equal((await cora('/notenschluessel')).status, 200, 'auch ohne Klasse einsehbar');
  assert.equal((await anna('/notenschluessel/IHK', { csv: NEU_IHK })).status, 404);
});

test('Erneute Änderung zeigt den Hinweis wieder; "Verstanden" blendet ihn aus', async () => {
  await admin('/admin/notenschluessel/IHK', { csv: '100,1;92,1.5;50,4;0,6', hinweis: '' });
  assert.match(await (await anna('/start')).text(), /ns-hinweis/);
  const r = await anna('/notenschluessel/gelesen', { typ: 'IHK', weiter: '/start' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/start');
  assert.doesNotMatch(await (await anna('/start')).text(), /ns-hinweis/);
  const offen = await anna('/notenschluessel/gelesen', { typ: 'IHK', weiter: 'https://boese.example/' });
  assert.equal(offen.headers.get('location'), '/start', 'kein Open Redirect');
});

test('Früher hinterlegte eigene Definition bleibt, bis sie zurückgesetzt wird; die Zahlen pro Klasse lassen sich nicht mehr eingeben', async () => {
  const k = klasseVon('11B');
  const eigen = '100,15;70,10;50,6;0,0';
  getDb().prepare('UPDATE klassen SET notenschluessel_csv = ? WHERE id = ?').run(eigen, k.id); // Altbestand
  assert.equal(getNotenschluesselCsv({ klasse_id: k.id }), eigen);
  await admin('/admin/notenschluessel/BG', { csv: NEU_BG, hinweis: '' });
  assert.equal(getNotenschluesselCsv({ klasse_id: k.id }), eigen, 'eigener Schlüssel bleibt');
  assert.doesNotMatch(await (await ben('/start')).text(), /ns-hinweis/, 'eigener Schlüssel: kein Hinweis');
  const seite = await (await admin(`/admin/klassen/${k.id}/notenschluessel`)).text();
  assert.match(seite, /eigene, abweichende Definition/);
  assert.doesNotMatch(seite, /<textarea/, 'keine Eingabe der Zahlen pro Klasse');

  // Eine Eingabe im Feld "csv" wird ignoriert
  await admin(`/admin/klassen/${k.id}/notenschluessel`, { notenschluessel: 'BG', csv: '100,15;60,9;0,0' });
  assert.equal(getNotenschluesselCsv({ klasse_id: k.id }), eigen);

  // Zurücksetzen: folgt dem übergeordneten Schlüssel
  await admin(`/admin/klassen/${k.id}/notenschluessel`, { notenschluessel: 'BG', aktion: 'zuruecksetzen' });
  assert.equal(getDb().prepare('SELECT notenschluessel_csv AS c FROM klassen WHERE id = ?').get(k.id).c, '');
  assert.equal(getNotenschluesselCsv({ klasse_id: k.id }), NEU_BG);
  await admin('/admin/notenschluessel/BG', { csv: '100,15;75,11;50,6;0,0' });
  assert.match(await (await ben('/start')).text(), /ns-hinweis/);
});

test('Zurücksetzen auf Standard; Admin-Seite zeigt beide Schlüssel', async () => {
  const seite = await (await admin('/admin/notenschluessel')).text();
  assert.match(seite, /IHK/);
  assert.match(seite, /BG/);
  assert.match(seite, /zuruecksetzen/);
  await admin('/admin/notenschluessel/IHK', { aktion: 'zuruecksetzen', csv: 'x' });
  assert.equal(getNotenschluesselCsv({ klasse_id: klasseVon('11I').id }), DEFAULT_NS_CSV.IHK);
});

test('SPA hat einen eigenen, editierbaren Schlüssel (Vorgabe wie IHK, unabhängig davon)', async () => {
  const sj = getDb().prepare('SELECT id FROM schuljahre').get().id;
  const id = Number(getDb().prepare("INSERT INTO klassen (schuljahr_id, name, notenschluessel, notenschluessel_csv, spa_bildungsgang) VALUES (?, 'SPA1', 'SPA', '', 'SPA')").run(sj).lastInsertRowid);
  assert.equal(getNotenschluesselCsv({ klasse_id: id }), DEFAULT_NS_CSV.IHK, 'Vorgabe = IHK-Werte');
  const neuSpa = '100,1;85,2;60,4;0,6';
  assert.match(await (await admin('/admin/notenschluessel')).text(), /id="ns-SPA"/);
  assert.equal((await admin('/admin/notenschluessel/SPA', { csv: neuSpa, hinweis: 'SPA angepasst' })).status, 302);
  assert.equal(getNotenschluesselCsv({ klasse_id: id }), neuSpa);
  assert.equal(getNotenschluesselCsv({ klasse_id: klasseVon('11I').id }), DEFAULT_NS_CSV.IHK, 'IHK bleibt unberührt');
  assert.equal(pruefeCsv('SPA', '100,4;50,1;0,6').ok, false);
  await admin('/admin/notenschluessel/SPA', { aktion: 'zuruecksetzen' });
  assert.equal(getNotenschluesselCsv({ klasse_id: id }), DEFAULT_NS_CSV.IHK);
  await admin('/admin/notenschluessel/SPA', { csv: neuSpa });
});

test('Übersicht: Schlüssel sind eingeklappt, SPA zeigt Prozent → Note → Punkte → Tendenz aus dem SPA-Schlüssel', async () => {
  const html = await (await cora('/notenschluessel')).text();
  for (const typ of ['IHK', 'BG', 'SPA']) assert.match(html, new RegExp(`<details class="card ns-karte" id="ns-${typ}">`), typ);
  assert.doesNotMatch(html, /<details[^>]* open/, 'standardmäßig eingeklappt');
  assert.match(html, /Punkte = 17 − 3 × Note/);
  // SPA-Schlüssel aus dem vorigen Test: 100 % = 1 -> 14 Punkte (Tendenz 1); 60 % = 4 -> 5 Punkte (Tendenz 4); 85 % = 2 -> 11 (Tendenz 2)
  assert.match(html, /<tr><td>100 %<\/td><td>1<\/td><td>14<\/td><td>14<\/td><td>1<\/td><\/tr>/);
  assert.match(html, /<tr><td>60 %<\/td><td>4<\/td><td>5<\/td><td>5<\/td><td>4<\/td><\/tr>/);
  assert.match(html, /<tr><td>85 %<\/td><td>2<\/td><td>11<\/td><td>11<\/td><td>2<\/td><\/tr>/);
  assert.match(html, /<tr><td>15<\/td><td>1\+<\/td><\/tr>/, 'Punkteskala 15 = 1+');
  const admHtml = await (await admin('/admin/notenschluessel')).text();
  assert.doesNotMatch(admHtml, /<details[^>]* open/, 'auch im Adminbereich eingeklappt');
});
