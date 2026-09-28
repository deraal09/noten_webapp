/**
 * Massenimport historischer Noten über mehrere Fächer auf einen Schlag
 * (Klassenleitungsübersicht → "Vergangene Schuljahre" → "Noten importieren"):
 * eine per Text eingefügte oder als CSV hochgeladene Tabelle (Nachname,
 * Vorname, dann eine Spalte je Fach/Lernfeld) wird für EIN historisches
 * Halbjahr in einem Rutsch gespeichert, statt Fach für Fach und Schüler für
 * Schüler von Hand einzutippen. Tendenzen ("3+", "2-") werden entfernt.
 *
 * Deckt die reinen Parser-/Service-Funktionen (src/csv-import.js:
 * parseNotenTabelle, src/grade-calc.js: parseTendenzNote,
 * src/fach-abschluss.js: importiereHistorischeNoten) sowie die echten Routen
 * (POST /klassenlehrer/klasse/:id/historische-noten-import/text und /csv) ab.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { parseNotenTabelle } from '../src/csv-import.js';
import { parseTendenzNote } from '../src/grade-calc.js';

test('parseTendenzNote: entfernt eine Tendenz und liefert die reine Zahl', () => {
  assert.equal(parseTendenzNote('3+'), 3);
  assert.equal(parseTendenzNote('2-'), 2);
  assert.equal(parseTendenzNote('1'), 1);
  assert.equal(parseTendenzNote('5,5'), 5.5);
  assert.equal(parseTendenzNote('5,5+'), 5.5);
  assert.equal(parseTendenzNote('  4-  '), 4);
  assert.equal(parseTendenzNote(''), null);
  assert.equal(parseTendenzNote('   '), null);
  assert.equal(parseTendenzNote('-'), null);
  assert.equal(parseTendenzNote('abc'), null);
  assert.equal(parseTendenzNote(undefined), null);
});

test('parseNotenTabelle: lehnt zu wenig Zeilen ab', () => {
  assert.deepEqual(parseNotenTabelle(''), { fehler: 'keine-daten' });
  assert.deepEqual(parseNotenTabelle('Nachname\tVorname\tLF4'), { fehler: 'keine-daten' });
});

test('parseNotenTabelle: verlangt eine erkennbare Kopfzeile', () => {
  const ergebnis = parseNotenTabelle('3\t2\n1\t2');
  assert.deepEqual(ergebnis, { fehler: 'keine-kopfzeile' });
});

test('parseNotenTabelle: lehnt eine Kopfzeile ohne Fach-Spalten ab', () => {
  const ergebnis = parseNotenTabelle('Nachname\tVorname\nAdler\tAnna');
  assert.deepEqual(ergebnis, { fehler: 'keine-faecher' });
});

test('parseNotenTabelle: liest eine tabgetrennte Tabelle mit mehreren Fach-Spalten', () => {
  const text = 'Nachname\tVorname\tLF4\tLF6\tWiPo\n'
    + 'Adler\tAnna\t3+\t2-\t2\n'
    + 'Berger\tBen\t2\t2-\t \n';
  const ergebnis = parseNotenTabelle(text);
  assert.deepEqual(ergebnis.fachSpalten, ['LF4', 'LF6', 'WiPo']);
  assert.equal(ergebnis.zeilen.length, 2);
  assert.deepEqual(ergebnis.zeilen[0], { nachname: 'Adler', vorname: 'Anna', noten: { LF4: '3+', LF6: '2-', WiPo: '2' } });
  assert.deepEqual(ergebnis.zeilen[1], { nachname: 'Berger', vorname: 'Ben', noten: { LF4: '2', LF6: '2-', WiPo: '' } });
});

test('parseNotenTabelle: erkennt Semikolon als Trennzeichen (CSV) und Vorname-vor-Nachname', () => {
  const text = 'Vorname;Nachname;Deutsch\nAnna;Adler;2\n';
  const ergebnis = parseNotenTabelle(text);
  assert.deepEqual(ergebnis.fachSpalten, ['Deutsch']);
  assert.deepEqual(ergebnis.zeilen, [{ nachname: 'Adler', vorname: 'Anna', noten: { Deutsch: '2' } }]);
});

// ---------------------------------------------------------------------------
// Routen-Tests
// ---------------------------------------------------------------------------

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-historische-noten-import-test-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-historische-noten-import-test-bitte-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');

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
async function formData(req, url, fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v instanceof Blob) fd.append(k, v, 'import.csv');
    else fd.append(k, v);
  }
  return req(url, { method: 'POST', body: fd });
}

const admin = client();
const lehrerA = client();
const lehrerFremd = client();
let klasseId, deutschId, mathId, annaId, benId;

test('Vorbereitung: Klasse 12A mit zwei Fächern und zwei Schüler/innen, Lehrer A als Klassenleitung', async () => {
  await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2026/27' });
  const sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2026/27'").get().id;
  await form(admin, `/admin/schuljahre/${sjId}/klassen/neu`, { name: '12A' });
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '12A'").get().id;
  await form(admin, `/admin/klassen/${klasseId}/faecher/neu`, { name: 'Deutsch' });
  await form(admin, `/admin/klassen/${klasseId}/faecher/neu`, { name: 'Mathematik' });
  deutschId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Deutsch'").get(klasseId).id;
  mathId = getDb().prepare("SELECT id FROM faecher WHERE klasse_id = ? AND name = 'Mathematik'").get(klasseId).id;
  await form(admin, `/admin/klassen/${klasseId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
  await form(admin, `/admin/klassen/${klasseId}/schueler/neu`, { nachname: 'Berger', vorname: 'Ben' });
  annaId = getDb().prepare("SELECT id FROM schueler WHERE klasse_id = ? AND nachname = 'Adler'").get(klasseId).id;
  benId = getDb().prepare("SELECT id FROM schueler WHERE klasse_id = ? AND nachname = 'Berger'").get(klasseId).id;

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

test('GET .../historische-noten-import: nur die Klassenleitung darf', async () => {
  let r = await lehrerFremd(`/klassenlehrer/klasse/${klasseId}/historische-noten-import`);
  assert.equal(r.status, 403);
  r = await lehrerA(`/klassenlehrer/klasse/${klasseId}/historische-noten-import`);
  assert.equal(r.status, 200);
});

test('POST .../historische-noten-import/text: ungültiges Schuljahr-Format wird abgelehnt', async () => {
  const r = await form(lehrerA, `/klassenlehrer/klasse/${klasseId}/historische-noten-import/text`, {
    bezeichnung: 'irgendwas', halbjahr: '1', text: 'Nachname\tVorname\tDeutsch\nAdler\tAnna\t2',
  });
  assert.equal(r.status, 302);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM historische_noten').get().c, 0);
});

test('POST .../historische-noten-import/text: nur die Klassenleitung darf', async () => {
  const r = await form(lehrerFremd, `/klassenlehrer/klasse/${klasseId}/historische-noten-import/text`, {
    bezeichnung: '2022/23', halbjahr: '1', text: 'Nachname\tVorname\tDeutsch\nAdler\tAnna\t2',
  });
  assert.equal(r.status, 403);
});

test('POST .../historische-noten-import/text: importiert Noten über mehrere Fächer, legt fehlende Fächer als nur_historisch an, entfernt Tendenzen', async () => {
  const text = 'Nachname\tVorname\tDeutsch\tMathematik\tLF5 Fachpraxis\n'
    + 'Adler\tAnna\t3+\t2-\t2\n'
    + 'Berger\tBen\t2\t1-\t4+\n';
  const r = await form(lehrerA, `/klassenlehrer/klasse/${klasseId}/historische-noten-import/text`, {
    bezeichnung: '2022/23', halbjahr: '1', text,
  });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `/klassenlehrer/klasse/${klasseId}/historische-noten-import`);

  const lf5 = getDb().prepare("SELECT * FROM faecher WHERE klasse_id = ? AND name = 'LF5 Fachpraxis'").get(klasseId);
  assert.ok(lf5);
  assert.equal(lf5.nur_historisch, 1);

  for (const [fachId, name] of [[deutschId, 'Deutsch'], [mathId, 'Mathematik'], [lf5.id, 'LF5 Fachpraxis']]) {
    const hh = getDb().prepare("SELECT * FROM historische_halbjahre WHERE fach_id = ? AND bezeichnung = '1. Halbjahr 2022/23'").get(fachId);
    assert.ok(hh, `historisches Halbjahr für ${name} fehlt`);
  }

  const hhDeutsch = getDb().prepare("SELECT id FROM historische_halbjahre WHERE fach_id = ? AND bezeichnung = '1. Halbjahr 2022/23'").get(deutschId);
  const hhMath = getDb().prepare("SELECT id FROM historische_halbjahre WHERE fach_id = ? AND bezeichnung = '1. Halbjahr 2022/23'").get(mathId);
  const hhLf5 = getDb().prepare("SELECT id FROM historische_halbjahre WHERE fach_id = ? AND bezeichnung = '1. Halbjahr 2022/23'").get(lf5.id);

  const noteDeutschAnna = getDb().prepare('SELECT note FROM historische_noten WHERE historisches_halbjahr_id = ? AND schueler_id = ?').get(hhDeutsch.id, annaId);
  assert.equal(noteDeutschAnna.note, 3); // "3+" -> 3
  const noteMathAnna = getDb().prepare('SELECT note FROM historische_noten WHERE historisches_halbjahr_id = ? AND schueler_id = ?').get(hhMath.id, annaId);
  assert.equal(noteMathAnna.note, 2); // "2-" -> 2
  const noteLf5Ben = getDb().prepare('SELECT note FROM historische_noten WHERE historisches_halbjahr_id = ? AND schueler_id = ?').get(hhLf5.id, benId);
  assert.equal(noteLf5Ben.note, 4); // "4+" -> 4
  const noteMathBen = getDb().prepare('SELECT note FROM historische_noten WHERE historisches_halbjahr_id = ? AND schueler_id = ?').get(hhMath.id, benId);
  assert.equal(noteMathBen.note, 1); // "1-" -> 1
});

test('POST .../historische-noten-import/text: nicht gefundene Schüler/innen werden gemeldet, nicht angelegt', async () => {
  const vorherAnzahlSchueler = getDb().prepare('SELECT COUNT(*) AS c FROM schueler WHERE klasse_id = ?').get(klasseId).c;
  const text = 'Nachname\tVorname\tDeutsch\nUnbekannt\tXaver\t2\n';
  const r = await form(lehrerA, `/klassenlehrer/klasse/${klasseId}/historische-noten-import/text`, {
    bezeichnung: '2021/22', halbjahr: '1', text,
  });
  assert.equal(r.status, 302);
  const nachherAnzahlSchueler = getDb().prepare('SELECT COUNT(*) AS c FROM schueler WHERE klasse_id = ?').get(klasseId).c;
  assert.equal(nachherAnzahlSchueler, vorherAnzahlSchueler); // kein neuer Schüler angelegt
});

test('POST .../historische-noten-import/text: Werte außerhalb des Notenschlüssels werden übersprungen', async () => {
  const text = 'Nachname\tVorname\tDeutsch\nAdler\tAnna\t9\n';
  const r = await form(lehrerA, `/klassenlehrer/klasse/${klasseId}/historische-noten-import/text`, {
    bezeichnung: '2020/21', halbjahr: '1', text,
  });
  assert.equal(r.status, 302);
  const hh = getDb().prepare("SELECT id FROM historische_halbjahre WHERE fach_id = ? AND bezeichnung = '1. Halbjahr 2020/21'").get(deutschId);
  const note = getDb().prepare('SELECT note FROM historische_noten WHERE historisches_halbjahr_id = ? AND schueler_id = ?').get(hh.id, annaId);
  assert.equal(note, undefined); // ungültiger Wert "9" wurde nicht gespeichert
});

test('POST .../historische-noten-import/text: ein von einer Fachlehrkraft verwaltetes Halbjahr wird nicht überschrieben', async () => {
  // Lehrer Fremd bekommt Zugriff auf Mathematik und legt dort selbst ein
  // vergangenes Halbjahr an (erstellt_als_fachlehrkraft = 1).
  getDb().prepare('INSERT INTO fach_zuweisungen (fach_id, user_id) VALUES (?, (SELECT id FROM users WHERE username = ?))')
    .run(mathId, 'lehrerfremd');
  await form(lehrerFremd, `/teacher/fach/${mathId}/historie/neu`, { bezeichnung: '1. Halbjahr 2019/20' });
  const hh = getDb().prepare("SELECT * FROM historische_halbjahre WHERE fach_id = ? AND bezeichnung = '1. Halbjahr 2019/20'").get(mathId);
  assert.equal(hh.erstellt_als_fachlehrkraft, 1);
  await form(lehrerFremd, `/teacher/historie/${hh.id}/speichern`, { ['note_' + annaId]: '1' });

  const text = 'Nachname\tVorname\tMathematik\nAdler\tAnna\t5\n';
  const r = await form(lehrerA, `/klassenlehrer/klasse/${klasseId}/historische-noten-import/text`, {
    bezeichnung: '2019/20', halbjahr: '1', text,
  });
  assert.equal(r.status, 302);

  const note = getDb().prepare('SELECT note FROM historische_noten WHERE historisches_halbjahr_id = ? AND schueler_id = ?').get(hh.id, annaId);
  assert.equal(note.note, 1); // unverändert -- Klassenleitung durfte hier nicht überschreiben
});

test('POST .../historische-noten-import/csv: importiert Noten aus einer hochgeladenen CSV-Datei', async () => {
  const csv = 'Nachname;Vorname;Deutsch\r\nAdler;Anna;1-\r\n';
  const r = await formData(lehrerA, `/klassenlehrer/klasse/${klasseId}/historische-noten-import/csv`, {
    bezeichnung: '2018/19', halbjahr: '2', datei: new Blob([csv], { type: 'text/csv' }),
  });
  assert.equal(r.status, 302);
  const hh = getDb().prepare("SELECT id FROM historische_halbjahre WHERE fach_id = ? AND bezeichnung = '2. Halbjahr 2018/19'").get(deutschId);
  assert.ok(hh);
  const note = getDb().prepare('SELECT note FROM historische_noten WHERE historisches_halbjahr_id = ? AND schueler_id = ?').get(hh.id, annaId);
  assert.equal(note.note, 1); // "1-" -> 1
});

test('POST .../historische-noten-import/csv: ohne Datei kommt eine Fehlermeldung statt eines Absturzes', async () => {
  const r = await formData(lehrerA, `/klassenlehrer/klasse/${klasseId}/historische-noten-import/csv`, {
    bezeichnung: '2017/18', halbjahr: '1',
  });
  assert.equal(r.status, 302);
});

test.after(async () => {
  await fastify.close();
});
