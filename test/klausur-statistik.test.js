/**
 * Klausur-Statistik (static/js/klausur-statistik.js): Rechenlogik ohne Browser geprüft; Einbindung auf der Fachseite (Schalter,
 * standardmäßig aus), „Neu hinzufügen“ statt „+“ bei Klausuren und Unterrichtsleistung, Datum der Datumstabelle mit heute vorbelegt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-klausurstat-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-klausurstatistik-bitte-lang-genug-xx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
test.after(async () => { await fastify.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });

const fenster = {};
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'static/js/klausur-statistik.js'), 'utf8'), { window: fenster });
const { berechne, korrelation, median, RICHTWERTE } = fenster.klausurStatistik;
const nah = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('Rechenlogik: Lösungsgrad, volle Punktzahl, Nullen, Abweichung zum Schnitt', () => {
  const e = berechne({ max: [10, 10], werte: [[10, 0], [8, 2], [6, 4], [10, 0]] });
  assert.equal(e.n, 4);
  assert.equal(e.maxSumme, 20);
  nah(e.mittel, 10);
  nah(e.grad, 0.5);
  assert.equal(e.median, 10);
  const [a1, a2] = e.aufgaben;
  nah(a1.mittel, 8.5); nah(a1.grad, 0.85); assert.equal(a1.schwierigkeit, 'zu-leicht');
  nah(a2.mittel, 1.5); nah(a2.grad, 0.15); assert.equal(a2.schwierigkeit, 'zu-schwer');
  nah(a1.volle, 0.5); nah(a1.nullen, 0);
  nah(a2.volle, 0); nah(a2.nullen, 0.5);
  nah(a1.abweichung, 0.35); nah(a2.abweichung, -0.35);
  assert.equal(e.kleineGruppe, true);
  assert.equal(e.trennschaerfeMoeglich, false);
  assert.equal(a1.trennschaerfe, null, 'unter 10 Personen keine Trennschärfe');
});

test('Leere Felder zählen als 0; Personen ganz ohne Eintrag zählen nicht mit', () => {
  const e = berechne({ max: [10, 10], werte: [[10, null], [null, null], [4, 6]] });
  assert.equal(e.n, 2);
  nah(e.aufgaben[1].mittel, 3);
  nah(e.aufgaben[0].mittel, 7);
  assert.equal(berechne({ max: [10], werte: [[null], [null]] }).n, 0);
  assert.equal(berechne({ max: [10], werte: [] }).aufgaben[0].mittel, null);
});

test('Ausgeschlossene Aufgaben (z. B. Inhalt-/Sprache-Noten) und Aufgaben ohne Höchstpunkte werden nicht ausgewertet', () => {
  const e = berechne({ max: [10, 6, 6, 0], werte: [[5, 3, 2, 0], [7, 4, 1, 0]], ausgeschlossen: [1, 2] });
  assert.deepEqual(Array.from(e.aufgaben, (a) => a.index), [0]);
  assert.equal(e.maxSumme, 10);
});

test('Trennschärfe (Item-Rest-Korrelation): ab 10 Personen, Vorzeichen und Stufen stimmen', () => {
  // A1, A2 und A4 steigen mit der Gesamtleistung, A3 läuft gegen den Trend
  const werte = [];
  for (let i = 0; i < 12; i++) werte.push([i, i + (i % 2), 12 - i, i]);
  const e = berechne({ max: [12, 14, 12, 12], werte });
  assert.equal(e.n, 12);
  assert.equal(e.trennschaerfeMoeglich, true);
  const [a1, a2, a3] = e.aufgaben;
  assert.ok(a1.trennschaerfe > 0.3 && a1.trennschaerfeStufe === 'gut', String(a1.trennschaerfe));
  assert.ok(a2.trennschaerfe > 0.3);
  assert.ok(a3.trennschaerfe < 0 && a3.trennschaerfeStufe === 'negativ', String(a3.trennschaerfe));
  assert.equal(e.kleineGruppe, true);
});

test('Trennschärfe: keine Streuung oder nur eine Aufgabe -> keine Zahl; Korrelation und Median einzeln', () => {
  const gleich = berechne({ max: [10, 10], werte: Array.from({ length: 12 }, () => [5, 5]) });
  assert.equal(gleich.aufgaben[0].trennschaerfe, null);
  assert.equal(berechne({ max: [10], werte: Array.from({ length: 12 }, (_, i) => [i]) }).aufgaben[0].trennschaerfe, null, 'eine Aufgabe: kein Rest');
  nah(korrelation([1, 2, 3, 4], [2, 4, 6, 8]), 1);
  nah(korrelation([1, 2, 3, 4], [8, 6, 4, 2]), -1);
  assert.equal(korrelation([1, 1, 1], [1, 2, 3]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

test('Richtwerte sind die dokumentierten', () => {
  assert.equal(RICHTWERTE.zuSchwer, 0.3);
  assert.equal(RICHTWERTE.zuLeicht, 0.85);
  assert.equal(RICHTWERTE.minPersonenTrennschaerfe, 10);
});

// ---------- Einbindung in die Fachseite ----------
function client() {
  const cookies = new Map();
  return async function req(url, opts = {}) {
    const headers = { ...opts.headers };
    if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(base + url, { ...opts, headers, redirect: 'manual' });
    for (const raw of r.headers.getSetCookie?.() ?? []) { const [k, ...v] = raw.split(';')[0].split('='); cookies.set(k.trim(), v.join('=').trim()); }
    return r;
  };
}
const form = (req, url, body) => req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
const admin = client(); const lehrer = client();
let fachId;

test('Fachseite: Statistik-Schalter, Bereich standardmäßig versteckt, „Neu hinzufügen“, Datum mit heute vorbelegt', async () => {
  await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;
  await form(admin, '/admin/einladungen/neu', { display_name: 'Lehrer', ttl_days: '14' });
  const inv = getDb().prepare('SELECT token FROM invitations').get();
  await form(lehrer, `/einladung/${inv.token}`, { username: 'lehrer', display_name: 'Lehrer', password: 'passwort1234', password2: 'passwort1234' });
  getDb().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'lehrer'").run();
  await form(lehrer, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '11A', notenschluessel: 'IHK' });
  const klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '11A'").get().id;
  await form(lehrer, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Physik' });
  fachId = getDb().prepare("SELECT id FROM faecher WHERE name = 'Physik'").get().id;
  await form(lehrer, `/teacher/fach/${fachId}/klausuren/neu`, { name: 'K1', aufgaben: '3', halbjahr: '1. Halbjahr' });
  const html = await (await lehrer(`/teacher/fach/${fachId}`)).text();
  assert.match(html, /<input type="checkbox" data-statistik-schalter> 📊 Statistik/);
  assert.match(html, /<div class="klausur-statistik card" data-klausur-statistik data-an="" data-klausur="\d+" data-ausschluss="\[\]"[^>]* hidden>/, 'standardmäßig ausgeblendet');
  assert.match(html, /\/static\/js\/klausur-statistik\.js\?v=/);
  assert.equal((await fetch(`${base}/static/js/klausur-statistik.js`)).status, 200);
  assert.equal((html.match(/＋ Neu hinzufügen/g) || []).length, 2, 'Klausuren und Unterrichtsleistung');
  assert.doesNotMatch(html, /aria-label="Klausur anlegen">\+<\/button>/);
  assert.match(html, /<input type="date" name="datum" value="2025-10-01" required/, 'Datumstabelle: heute (in Tests 1.10.2025) vorbelegt');
});
