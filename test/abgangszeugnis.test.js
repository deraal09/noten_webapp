/**
 * Abgangs-/Abschlusszeugnis: enthält ALLE Fächer über ALLE Schuljahre
 * (auch Fächer, die nur in vergangenen Halbjahren gelten, und direkt
 * eingetragene Endnoten), zeigt bei einem
 * laufenden Fach alle Einzelnoten plus den aktuellen Stand und bei einem
 * abgeschlossenen Fach nur die Gesamtnote. "Abgang + Abgangszeugnis" trägt den
 * Abgang ein und öffnet direkt das Zeugnis.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-abgangszeugnis-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-abgangszeugnis-test-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { ladeAbgangszeugnisDaten } = await import('../src/fach-abschluss.js');

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
let klasseId, physikId, chemieId, religionId, annaId;
const HJ = (n) => `${n}. Halbjahr`;
const endnote = (fachId, sid, hj, wert) => lehrerA(`/teacher/fach/${fachId}/endnote`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ schueler_id: String(sid), halbjahr: hj, wert }),
});

test('Vorbereitung: Klasse mit Einschulung 2023 (aktuell 5. Halbjahr, 2025/26) mit Physik (laufend) und Chemie (abgeschlossen), Physik und Religion mit Endnoten aus 2023/24', async () => {
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

  await form(lehrerA, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '12A', notenschluessel: 'IHK', einschulung_jahr: '2023' });
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '12A'").get().id;
  await form(lehrerA, `/teacher/klassen/${klasseId}/klassenlehrer/eintragen`, {});
  await form(lehrerA, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
  annaId = getDb().prepare("SELECT id FROM schueler WHERE nachname = 'Adler'").get().id;

  await form(lehrerA, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Physik' });
  await form(lehrerA, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Chemie' });
  // Religion gab es nur im 1. und 2. Halbjahr (2023/24)
  const religion = new URLSearchParams();
  religion.append('name', 'Religion'); religion.append('halbjahre', '1'); religion.append('halbjahre', '2');
  await lehrerA(`/teacher/klassen/${klasseId}/faecher/neu`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: religion });
  physikId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Physik'").get(klasseId).id;
  chemieId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Chemie'").get(klasseId).id;
  religionId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Religion'").get(klasseId).id;

  // Laufende Noten 2025/26 (5./6. Halbjahr) über je eine Klausur (Gewichtung 100 %): Physik 10/10 und 5/10; Chemie 10/10
  const klausur = async (fachId, hj, punkte) => {
    await form(lehrerA, `/teacher/fach/${fachId}/klausuren/neu`, { name: 'K ' + hj, aufgaben: '1', halbjahr: hj });
    const kId = getDb().prepare('SELECT id FROM klausuren WHERE fach_id = ? AND halbjahr = ?').get(fachId, hj).id;
    await form(lehrerA, `/teacher/klausuren/${kId}/gewichtung`, { gewichtung: '100', halbjahr: hj });
    await form(lehrerA, `/teacher/klausuren/${kId}/maxpunkte`, { anzahl_aufgaben: '1', mp_0: '10', halbjahr: hj });
    await lehrerA(`/teacher/klausuren/${kId}/punkte`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ schueler_id: String(annaId), aufgabe_idx: '0', wert: String(punkte) }),
    });
  };
  await klausur(physikId, HJ(5), 10);
  await klausur(physikId, HJ(6), 5);
  await klausur(chemieId, HJ(5), 10);

  // Vergangenes Schuljahr 2023/24: direkt eingetragene Endnoten
  await endnote(physikId, annaId, HJ(1), '3');
  await endnote(religionId, annaId, HJ(1), 'ntg');
  await endnote(religionId, annaId, HJ(2), '2');

  // Chemie wird abgeschlossen -> es zählt nur noch die Gesamtnote.
  await form(lehrerA, `/teacher/fach/${chemieId}/abschliessen`, {});
});

test('ladeAbgangszeugnisDaten: alle Fächer über alle Schuljahre, Einzelnoten chronologisch, Stand als Mittelwert, abgeschlossenes Fach nur mit Abschlussnote', () => {
  const { zeilen } = ladeAbgangszeugnisDaten(annaId);
  assert.deepEqual(zeilen.map((z) => z.fach.name), ['Chemie', 'Physik', 'Religion'], 'auch das nur in vergangenen Halbjahren geltende Fach Religion ist dabei');

  const physik = zeilen.find((z) => z.fach.name === 'Physik');
  assert.deepEqual(physik.eintraege.map((e) => e.label), [
    '1. Halbjahr 2023/24', '5. Halbjahr 2025/26', '6. Halbjahr 2025/26',
  ], 'vergangene Halbjahre zuerst, dann das laufende');
  const [historisch, hj1, hj2] = physik.eintraege.map((e) => e.note);
  assert.equal(historisch, 3);
  assert.ok(typeof hj1 === 'number' && typeof hj2 === 'number' && hj1 < hj2, 'live berechnete Noten der beiden Halbjahre');
  assert.equal(physik.stand, Math.round(((historisch + hj1 + hj2) / 3) * 100) / 100, 'aktueller Stand = Mittelwert aller Halbjahre');

  const religion = zeilen.find((z) => z.fach.name === 'Religion');
  assert.deepEqual(religion.eintraege.map((e) => e.note), ['ntg', 2]);
  assert.equal(religion.stand, 2, '"ntg" zählt nicht in den Stand');

  const chemie = zeilen.find((z) => z.fach.name === 'Chemie');
  assert.equal(chemie.fach.abgeschlossen, 1);
  assert.equal(chemie.abschlussnote, chemie.eintraege[0].note, 'Abschlussnote = Note des einzigen Halbjahres');
});

test('Zeugnis-Seite: Abschlusszeugnis für aktive, abgeschlossene Fächer nur mit Gesamtnote, Fächer vergangener Halbjahre sichtbar', async () => {
  const html = await (await lehrerA(`/teacher/schueler/${annaId}/abgangszeugnis`)).text();
  assert.match(html, /<h1>Abschlusszeugnis: Adler, Anna/);
  assert.match(html, /Religion/);
  assert.match(html, /1\. Halbjahr 2023\/24: ntg/);
  assert.match(html, /2\. Halbjahr 2023\/24: 2/);
  assert.match(html, /aktueller Stand/);
  assert.match(html, /abgeschlossen -- es zählt nur die Gesamtnote/);
});

test('Abgang + Abgangszeugnis: trägt den Abgang ein und öffnet direkt das Zeugnis; "Abgang" allein bleibt auf der Klassenseite', async () => {
  await form(lehrerA, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Berger', vorname: 'Ben' });
  const benId = getDb().prepare("SELECT id FROM schueler WHERE nachname = 'Berger'").get().id;
  const html = await (await lehrerA(`/teacher/klassen/${klasseId}`)).text();
  assert.match(html, /name="zeugnis" value="1"[^>]*>🚪🎓 Abgang \+ Abgangszeugnis/);

  let r = await form(lehrerA, `/teacher/schueler/${annaId}/abgang`, { zeugnis: '0' });
  assert.equal(r.headers.get('location'), `/teacher/klassen/${klasseId}`);
  assert.equal(getDb().prepare('SELECT status FROM schueler WHERE id = ?').get(annaId).status, 'abgang');
  await form(lehrerA, `/teacher/schueler/${annaId}/reaktivieren`, {});

  r = await form(lehrerA, `/teacher/schueler/${benId}/abgang`, { zeugnis: '1' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `/teacher/schueler/${benId}/abgangszeugnis`);
  assert.equal(getDb().prepare('SELECT status FROM schueler WHERE id = ?').get(benId).status, 'abgang');
  const zeugnis = await (await lehrerA(`/teacher/schueler/${benId}/abgangszeugnis`)).text();
  assert.match(zeugnis, /<h1>Abgangszeugnis: Berger, Ben/);
});

test.after(async () => {
  await fastify.close();
});
