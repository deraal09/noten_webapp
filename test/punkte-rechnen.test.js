/**
 * Rechnen in den Punktefeldern (static/js/punkte-rechnen.js): sicherer Parser ohne eval; Einbindung in Klausur- und
 * Zusatzleistungs-Tabellen. Außerdem: [hidden] gewinnt immer (Banner „Neu hier?“ ließ sich nicht schließen).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-rechnen-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-rechnen-bitte-lang-genug-xxxxxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
test.after(async () => { await fastify.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });

const fenster = {};
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'static/js/punkte-rechnen.js'), 'utf8'), { window: fenster });
const { rechne, istRechnung, formatiere } = fenster.punkteRechnen;

test('Einfache Zahlen und Summen, Komma und Punkt, Leerzeichen', () => {
  assert.equal(rechne('7'), 7);
  assert.equal(rechne('7,5'), 7.5);
  assert.equal(rechne(' 7.5 '), 7.5);
  assert.equal(rechne('2+1,5+3'), 6.5);
  assert.equal(rechne('2 + 1,5 + 3'), 6.5);
  assert.equal(rechne('10-2,5'), 7.5);
  assert.equal(rechne('0,1+0,2'), 0.3, 'Gleitkomma-Rauschen wird geglättet');
});

test('Punkt vor Strich, Klammern, Malzeichen und Geteilt-Zeichen, Vorzeichen', () => {
  assert.equal(rechne('2+3*4'), 14);
  assert.equal(rechne('(2+3)*4'), 20);
  assert.equal(rechne('(4+2)/2'), 3);
  assert.equal(rechne('2×3'), 6);
  assert.equal(rechne('2·3'), 6);
  assert.equal(rechne('6÷4'), 1.5);
  assert.equal(rechne('6:4'), 1.5);
  assert.equal(rechne('-2+5'), 3);
  assert.equal(rechne('3−1'), 2, 'typografisches Minus');
  assert.equal(rechne('2*-3'), -6);
  assert.equal(rechne('1/3*3'), 1);
  assert.equal(rechne('1/3'), 0.33);
});

test('Ungültiges ergibt null: Buchstaben, offene Klammer, Divisions durch 0, halbe Rechnung, Code', () => {
  for (const s of ['', '  ', 'abc', '3+', '*3', '2*(3', '2)', '5/0', '1..2', '2 3', '2+', '()', 'alert(1)', '2**3', '1e5', 'Math.PI', '3;4', 'constructor']) {
    assert.equal(rechne(s), null, `„${s}“`);
  }
});

test('Rechnung erkennen und Anzeige mit Komma', () => {
  for (const s of ['2+3', '2*3', '(2)', '6/2', '5-2', '2×3', '6:3']) assert.equal(istRechnung(s), true, s);
  for (const s of ['7', '7,5', '7.5', '-3', ' 4 ', '']) assert.equal(istRechnung(s), false, s);
  assert.equal(formatiere(6.5), '6,5');
  assert.equal(formatiere(3), '3');
  assert.equal(formatiere(null), '');
});

test('Fachseite: Punktefelder sind Textfelder mit Komma-Anzeige, das Rechen-Skript ist eingebunden, ohne eval', async () => {
  const admin = (url, opts = {}) => fetch(base + url, { redirect: 'manual', ...opts });
  const cookies = new Map();
  const req = async (url, opts = {}) => {
    const headers = { ...opts.headers };
    if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(base + url, { ...opts, headers, redirect: 'manual' });
    for (const raw of r.headers.getSetCookie?.() ?? []) { const [k, ...v] = raw.split(';')[0].split('='); cookies.set(k.trim(), v.join('=').trim()); }
    return r;
  };
  const form = (url, body) => req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  await form('/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await form('/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;
  await form('/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '11A', notenschluessel: 'IHK' });
  const klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '11A'").get().id;
  await form(`/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Physik' });
  const fachId = getDb().prepare("SELECT id FROM faecher WHERE name = 'Physik'").get().id;
  await form(`/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
  await form(`/teacher/fach/${fachId}/klausuren/neu`, { name: 'K1', aufgaben: '2', halbjahr: '1. Halbjahr' });
  await form(`/teacher/fach/${fachId}/uls/neu`, { name: 'Referat', aufgaben: '1', halbjahr: '1. Halbjahr' });
  const kid = getDb().prepare('SELECT id FROM klausuren').get().id;
  const sid = getDb().prepare('SELECT id FROM schueler').get().id;
  await form(`/teacher/klausuren/${kid}/maxpunkte`, { anzahl_aufgaben: '2', mp_0: '10', mp_1: '10', halbjahr: '1. Halbjahr' });
  await form(`/teacher/klausuren/${kid}/punkte`, { schueler_id: String(sid), aufgabe_idx: '0', wert: '7.5' });
  const html = await (await req(`/teacher/fach/${fachId}`)).text();
  assert.match(html, /<input type="text" inputmode="decimal" autocomplete="off" class="punkt"[^>]*data-kind="k"[^>]*value="7,5"/);
  assert.match(html, /<input type="text" inputmode="decimal" autocomplete="off" class="punkt"[^>]*data-kind="u"/);
  assert.match(html, /<input type="text" inputmode="decimal" autocomplete="off" class="extrapunkt"/);
  assert.doesNotMatch(html, /<input type="number" class="punkt"/);
  assert.match(html, /\/static\/js\/punkte-rechnen\.js\?v=/);
  assert.equal((await admin('/static/js/punkte-rechnen.js')).status, 200);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'static/js/punkte-rechnen.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''), /\beval\s*\(|new Function/);
  // Server nimmt weiterhin nur fertige Zahlen (mit Punkt) und lehnt Werte über dem Maximum ab
  assert.equal((await form(`/teacher/klausuren/${kid}/punkte`, { schueler_id: String(sid), aufgabe_idx: '1', wert: '6.5' })).status, 200);
  assert.equal((await form(`/teacher/klausuren/${kid}/punkte`, { schueler_id: String(sid), aufgabe_idx: '1', wert: '16' })).status, 400);
});

test('[hidden] ist nie überschreibbar (Banner „Neu hier?“ lässt sich schließen)', async () => {
  const css = await (await fetch(`${base}/static/css/app.css`)).text();
  assert.match(css, /\[hidden\] \{ display: none !important; \}/);
  assert.match(css, /\.hilfe-banner \{[^}]*display: flex/, 'die Regel, die [hidden] früher aushebelte, existiert weiter');
});
