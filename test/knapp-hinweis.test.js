/**
 * Pädagogischer Hinweis in der Klausurtabelle: Fehlen nur höchstens 2 Punkte bis zur nächsten besseren Note, steht „▲ x“ neben der Note.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-knapp-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-knapp-bitte-lang-genug-xxxxxxxxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { punkteZurBesserenNote, knappZurBesserenNote, DEFAULT_NS_CSV, noteAusPunkten, KNAPP_MAX_PUNKTE } = await import('../src/grade-calc.js');
const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
test.after(async () => { await fastify.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });

const IHK = DEFAULT_NS_CSV.IHK;
const BG = DEFAULT_NS_CSV.BG;

test('BG (ganze Notenpunkte): Punkte bis zur nächsten besseren Stufe', () => {
  // max 25: 15 Punkte = 60 % = 8 Punkte; 9 Punkte beginnen bei 65 % -> 16,125 Punkte nötig (gerundet ab 64,5 %)
  const r = punkteZurBesserenNote([15], [25], BG);
  assert.equal(r.jetzt, 8);
  assert.equal(r.ziel, 9);
  assert.equal(r.prozent, 65);
  assert.equal(r.fehlend, 1.13);
  // mit den fehlenden Punkten ist die bessere Note tatsächlich erreicht – mit weniger nicht
  assert.equal(noteAusPunkten([15 + r.fehlend], [25], BG), 9);
  assert.equal(noteAusPunkten([15 + r.fehlend - 0.01], [25], BG), 8);
  assert.equal(punkteZurBesserenNote([14], [25], BG).fehlend, 0.88);
});

test('IHK (Dezimalnoten): nächste bessere GANZE Note wie bei „ganze Note“ (2,5 -> 3)', () => {
  // 40 von 50 = 80 % = 2,5 (ganze Note 3); Note 2 beginnt bei 81 % (2,4)
  const r = punkteZurBesserenNote([30, 10], [30, 20], IHK);
  assert.equal(r.jetzt, 2.5);
  assert.equal(r.ziel, 2);
  assert.equal(r.prozent, 81);
  assert.equal(r.fehlend, 0.25);
  assert.equal(Math.round(noteAusPunkten([40.25], [50], IHK)), 2);
  assert.equal(Math.round(noteAusPunkten([40.24], [50], IHK)), 3);
  // weiter weg: 36 von 50 = 72 % (3,1) -> 4,25 Punkte fehlen
  assert.equal(punkteZurBesserenNote([36], [50], IHK).fehlend, 4.25);
  // schlechte Noten: 5 -> 4 beginnt bei 58 % (4,0)
  const fuenf = punkteZurBesserenNote([20], [50], IHK); // 40 % = 5,0
  assert.equal(fuenf.ziel, 4);
});

test('Hinweis nur bis 2 Punkte; keiner bei bester Note, unvollständigen Punkten oder fehlendem Schlüssel', () => {
  assert.equal(KNAPP_MAX_PUNKTE, 2);
  assert.ok(knappZurBesserenNote([15], [25], BG), '1,13 Punkte');
  assert.equal(knappZurBesserenNote([36], [50], IHK), null, '4,25 Punkte sind zu viel');
  assert.ok(knappZurBesserenNote([36], [50], IHK, 0, 5), 'Grenze einstellbar');
  assert.equal(knappZurBesserenNote([25], [25], BG), null, '15 Punkte: schon die beste Note');
  assert.equal(punkteZurBesserenNote([null, 5], [10, 10], BG), null);
  assert.equal(punkteZurBesserenNote([5], [10], ''), null);
  assert.equal(punkteZurBesserenNote([], [], BG), null);
  // Extrapunkte zählen mit: 15 + 1 Extra von 25
  assert.equal(punkteZurBesserenNote([15], [25], BG, 1).fehlend, 0.13);
  // Genau an der Grenze (2 Punkte) wird noch angezeigt, knapp darüber nicht
  const exakt = punkteZurBesserenNote([13.88], [25], BG); // 55,5 % -> 7; 8 ab 60 %: 14,875
  assert.ok(exakt.fehlend > 0.9 && exakt.fehlend < 1.1);
});

// ---------- Anzeige ----------
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
const admin = client();

test('Klausurtabelle: „▲ 0,25“ bei knapp verfehlter besserer Note, nicht bei den anderen; auch in den JSON-Daten für die Live-Anzeige', async () => {
  await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;
  await form(admin, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '11A', notenschluessel: 'IHK' });
  const klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '11A'").get().id;
  await form(admin, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Physik' });
  const fachId = getDb().prepare("SELECT id FROM faecher WHERE name = 'Physik'").get().id;
  for (const [n, v] of [['Adler', 'Anna'], ['Berger', 'Ben'], ['Claus', 'Cem']]) await form(admin, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: n, vorname: v });
  const sid = Object.fromEntries(getDb().prepare('SELECT id, nachname FROM schueler').all().map((r) => [r.nachname, r.id]));
  await form(admin, `/teacher/fach/${fachId}/klausuren/neu`, { name: 'K1', aufgaben: '2', halbjahr: '1. Halbjahr' });
  const kid = getDb().prepare('SELECT id FROM klausuren').get().id;
  await form(admin, `/teacher/klausuren/${kid}/maxpunkte`, { anzahl_aufgaben: '2', mp_0: '30', mp_1: '20', halbjahr: '1. Halbjahr' });
  const punkte = async (s, a, w) => form(admin, `/teacher/klausuren/${kid}/punkte`, { schueler_id: String(s), aufgabe_idx: String(a), wert: String(w) });
  await punkte(sid.Adler, 0, 30); await punkte(sid.Adler, 1, 10);  // 40 von 50 = 80 %: 0,25 bis Note 2
  await punkte(sid.Berger, 0, 20); await punkte(sid.Berger, 1, 10); // 30 von 50 = 60 %: weit weg
  await punkte(sid.Claus, 0, 30); await punkte(sid.Claus, 1, 20);  // 50 von 50: beste Note
  const html = await (await admin(`/teacher/fach/${fachId}`)).text();
  const zelle = (s) => new RegExp(`<td class="note-cell k-note" data-sid="${s}" data-kid="${kid}">([^<]*(?:<small[\\s\\S]*?</small>)?)</td>`).exec(html)[1];
  assert.match(zelle(sid.Adler), /<small class="knapp" title="Nur noch 0,25 Punkt\(e\) bis zur Note 2 \(ab 81 %\)">▲ 0,25<\/small>/);
  assert.doesNotMatch(zelle(sid.Berger), /knapp/);
  assert.doesNotMatch(zelle(sid.Claus), /knapp/);
  assert.match(html, /▲ 1,5 = nur noch so viele Punkte \(höchstens 2\)/, 'Erklärung unter der Tabelle');
  const daten = await (await admin(`/teacher/fach/${fachId}/noten?hj=${encodeURIComponent('1. Halbjahr')}`)).json();
  const k = (s) => daten.schueler.find((x) => x.schueler_id === s).klausuren[0];
  assert.deepEqual({ ...k(sid.Adler).knapp }, { fehlend: 0.25, ziel: 2, prozent: 81, jetzt: 2.5 });
  assert.equal(k(sid.Berger).knapp, null);
  // Mehrteilige Klausuren haben keinen Hinweis
  await form(admin, `/teacher/klausuren/${kid}/teile-anzahl`, { anzahl_teile: '2' });
  const mehr = await (await admin(`/teacher/fach/${fachId}`)).text();
  assert.doesNotMatch(mehr, /<small class="knapp"/);
  assert.doesNotMatch(mehr, /knapp-erklaerung/);
});
