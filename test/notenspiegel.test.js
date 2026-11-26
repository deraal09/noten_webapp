/**
 * Notenspiegel und Klassendurchschnitt zu einer Klausur (static/js/notenspiegel.js), Schalter je Konto.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import vm from 'node:vm';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-spiegel-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-notenspiegel-bitte-lang-genug-12';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const fenster = {};
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'static/js/notenspiegel.js'), 'utf8'), { window: fenster });
const { berechne, liesNote } = fenster.notenspiegel;

test('Zellentext wird zur Note gelesen (mit Komma, mit ▲-Hinweis, ohne Note)', () => {
  assert.equal(liesNote('2,5'), 2.5);
  assert.equal(liesNote('3,0 ▲ 1,5'), 3);
  assert.equal(liesNote('12'), 12);
  assert.equal(liesNote('–'), null);
  assert.equal(liesNote(''), null);
});

test('IHK: Durchschnitt aus genauen Noten, Spiegel auf ganze Noten gerundet', () => {
  const e = berechne([1, 2, 2, 2.5, 3.4, 4, 6], 'IHK');
  assert.equal(e.n, 7);
  assert.equal(e.durchschnitt, 2.99, '(1+2+2+2,5+3,4+4+6)/7 = 2,9857');
  assert.equal(e.median, 2.5);
  assert.equal(e.beste, 1);
  assert.equal(e.schlechteste, 6);
  assert.deepEqual(Array.from(e.spiegel.map((z) => [z.note, z.anzahl])), [[1, 1], [2, 2], [3, 2], [4, 1], [5, 0], [6, 1]]);
});

test('BG: Notenpunkte 15 bis 0, beste = höchste Punktzahl', () => {
  const e = berechne([15, 12, 12, 7, 0], 'BG');
  assert.equal(e.spiegel.length, 16);
  assert.deepEqual([e.spiegel[0].note, e.spiegel[15].note], [15, 0]);
  assert.equal(e.spiegel.find((z) => z.note === 12).anzahl, 2);
  assert.equal(e.durchschnitt, 9.2);
  assert.equal(e.beste, 15);
  assert.equal(e.schlechteste, 0);
  assert.equal(e.median, 12);
});

test('Leere und ungültige Eingaben', () => {
  const e = berechne([], 'IHK');
  assert.deepEqual([e.n, e.durchschnitt, e.median, e.beste, e.schlechteste], [0, null, null, null, null]);
  assert.equal(berechne([NaN, undefined, 2], 'IHK').n, 1);
  assert.equal(berechne([7, 0.2], 'IHK').spiegel.find((z) => z.note === 6).anzahl, 1, 'außerhalb wird in die Randstufe gezählt');
});

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { HALBJAHRE } = await import('../src/grade-calc.js');
const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
const HJ = HALBJAHRE[0];
const cookies = new Map();
async function req(url, opts = {}) {
  const headers = { ...opts.headers };
  if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  const r = await fetch(base + url, { ...opts, headers, redirect: 'manual' });
  for (const raw of r.headers.getSetCookie()) { const [k, ...v] = raw.split(';')[0].split('='); cookies.set(k.trim(), v.join('=').trim()); }
  return r;
}
const post = (url, body) => req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
let fachId;

test('Fachseite: Schalter und Bereich je Klausur, Schlüsselart, standardmäßig ausgeblendet, Skript eingebunden', async () => {
  await post('/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  getDb().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'admin'").run();
  await post('/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sj = getDb().prepare('SELECT id FROM schuljahre').get().id;
  await post('/teacher/klassen/neu', { schuljahr_id: String(sj), name: '11B', notenschluessel: 'BG' });
  const kid = getDb().prepare('SELECT id FROM klassen').get().id;
  await post(`/teacher/klassen/${kid}/klassenlehrer/eintragen`, {});
  await post(`/teacher/klassen/${kid}/faecher/neu`, { name: 'Englisch' });
  fachId = getDb().prepare('SELECT id FROM faecher').get().id;
  await post(`/teacher/fach/${fachId}/klausuren/neu`, { name: 'K1', aufgaben: '2', halbjahr: HJ });
  const html = await (await req(`/teacher/fach/${fachId}?hj=${encodeURIComponent(HJ)}`)).text();
  assert.match(html, /<input type="checkbox" data-notenspiegel-schalter> 📈 Notenspiegel/);
  assert.match(html, /<div class="klausur-notenspiegel card" data-notenspiegel data-an="" data-klausur="\d+" data-ns="BG" hidden>/);
  assert.match(html, /Notenspiegel und Klassendurchschnitt/);
  assert.match(html, /\/static\/js\/notenspiegel\.js\?v=/);
  assert.equal((await req('/static/js/notenspiegel.js')).status, 200);
});

test('Schalter gilt je Konto: serverseitig gespeichert und beim nächsten Laden vorbelegt', async () => {
  assert.equal((await post('/konto/einstellung', { schluessel: 'notenspiegel_an', wert: '1' })).status, 200);
  assert.match(await (await req(`/teacher/fach/${fachId}?hj=${encodeURIComponent(HJ)}`)).text(), /data-notenspiegel data-an="1"/);
  await post('/konto/einstellung', { schluessel: 'notenspiegel_an', wert: '0' });
  assert.match(await (await req(`/teacher/fach/${fachId}?hj=${encodeURIComponent(HJ)}`)).text(), /data-notenspiegel data-an="0"/);
});

test('Hilfe erklärt den Notenspiegel und findet ihn über die Suche', async () => {
  const { sucheHilfe } = await import('../src/hilfe.js');
  assert.equal(sucheHilfe('Notenspiegel')[0].slug, 'klausuren');
  assert.ok(sucheHilfe('Klassendurchschnitt').some((t) => t.slug === 'klausuren'));
});

test.after(async () => { await fastify.close(); });
