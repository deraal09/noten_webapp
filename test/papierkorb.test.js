/**
 * Papierkorb für Klassen: Löschen blendet eine Klasse nur für die löschende Lehrkraft aus; erst wenn alle Lehrkräfte der Klasse
 * sie gelöscht haben, läuft eine Frist von 30 Tagen, danach wird endgültig gelöscht. Wiederherstellen geht jederzeit für sich selbst.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-papierkorb-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-papierkorb-bitte-lang-genug-xxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { loescheAbgelaufeneKlassen, pruefePapierkorbEinmalProTag, lehrkraefteDerKlasse, aktiveLehrkraefte } = await import('../src/papierkorb.js');
const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
test.after(() => fastify.close());

function client() {
  const cookies = new Map();
  return async function req(url, body) {
    const headers = {};
    if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    const opts = { headers, redirect: 'manual' };
    if (body) { opts.method = 'POST'; headers['content-type'] = 'application/x-www-form-urlencoded'; opts.body = new URLSearchParams(body); }
    const r = await fetch(base + url, opts);
    for (const raw of r.headers.getSetCookie?.() ?? []) { const [k, ...v] = raw.split(';')[0].split('='); cookies.set(k.trim(), v.join('=').trim()); }
    return r;
  };
}
const admin = client();
const anna = client(); // legt die Klasse an
const ben = client(); // hat ein Fach in der Klasse
const cora = client(); // gehört (zunächst) nicht dazu
let klasseId; let fachId; let benId; let coraId; let sjId;
const db = () => getDb();
const klasse = () => db().prepare('SELECT * FROM klassen WHERE id = ?').get(klasseId);
const meineKlassen = async (c) => (await c('/teacher/klassen')).text();
const papierkorb = async (c) => (await c('/teacher/papierkorb')).text();

test('Vorbereitung: Klasse 10A von Anna, Ben mit eigenem Fach, Cora ohne Bezug', async () => {
  await admin('/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await admin('/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  sjId = db().prepare('SELECT id FROM schuljahre').get().id;
  for (const [c, n] of [[anna, 'anna'], [ben, 'ben'], [cora, 'cora']]) {
    await admin('/admin/einladungen/neu', { display_name: n, ttl_days: '14' });
    const inv = db().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
    await c(`/einladung/${inv.token}`, { username: n, display_name: n, password: 'passwort123', password2: 'passwort123' });
  }
  db().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'anna'").run();
  await anna('/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '10A', notenschluessel: 'IHK', einschulung_jahr: '2025' });
  klasseId = db().prepare("SELECT id FROM klassen WHERE name = '10A'").get().id;
  await anna(`/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Mathe' });
  fachId = db().prepare('SELECT id FROM faecher WHERE klasse_id = ?').get(klasseId).id;
  await anna(`/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Physik' });
  const physik = db().prepare("SELECT id FROM faecher WHERE name = 'Physik'").get().id;
  benId = db().prepare("SELECT id FROM users WHERE username = 'ben'").get().id;
  coraId = db().prepare("SELECT id FROM users WHERE username = 'cora'").get().id;
  db().prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)').run(benId, physik);
  assert.equal(lehrkraefteDerKlasse(klasseId).length, 2, 'Anna (Ersteller/in, Mathe) und Ben (Physik); der Admin zählt nicht');
  assert.match(await meineKlassen(anna), /10A/);
  assert.match(await meineKlassen(ben), /10A/);
});

test('Nur Lehrkräfte der Klasse dürfen löschen; Cora bekommt 403', async () => {
  assert.equal((await cora(`/teacher/klassen/${klasseId}/loeschen`, {})).status, 403);
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM klassen_geloescht').get().c, 0);
});

test('Anna löscht: die Klasse ist für sie ausgeblendet (Meine Klassen, Noteneingabe), Ben sieht sie weiter; Papierkorb: noch keine Ablaufzeit', async () => {
  const r = await anna(`/teacher/klassen/${klasseId}/loeschen`, {});
  assert.equal(r.status, 302);
  assert.ok(klasse(), 'Klasse bleibt bestehen');
  assert.doesNotMatch(await meineKlassen(anna), />10A</, 'für Anna ausgeblendet');
  assert.doesNotMatch(await (await anna('/teacher')).text(), /Mathe/, 'auch in der Noteneingabe');
  assert.match(await meineKlassen(ben), /10A/, 'Ben sieht sie weiter');
  assert.match(await meineKlassen(anna), /Papierkorb \(1\)/);
  const pk = await papierkorb(anna);
  assert.match(pk, /10A/);
  assert.match(pk, /noch keine Ablaufzeit/);
  assert.match(pk, /1 Lehrkraft nutzt die Klasse noch/);
  assert.equal(klasse().papierkorb_ab, null);
  assert.deepEqual(aktiveLehrkraefte(klasseId), [benId]);
});

test('Ben löscht als Letzter: die Frist läuft (30 Tage), beide sehen das Ablaufdatum', async () => {
  assert.equal((await ben(`/teacher/klassen/${klasseId}/loeschen`, {})).status, 302);
  assert.ok(klasse().papierkorb_ab, 'Frist beginnt');
  // Testdatum (jetzt() in Tests) ist der 01.10.2025 -> Ablauf 31.10.2025
  for (const c of [anna, ben]) {
    const pk = await papierkorb(c);
    assert.match(pk, /31\.10\.2025/);
    assert.match(pk, /noch 30 Tage/);
    assert.doesNotMatch(pk, /noch keine Ablaufzeit/);
  }
  assert.doesNotMatch(await meineKlassen(ben), />10A</);
});

test('Vor Ablauf der Frist bleibt die Klasse; im Normalbetrieb (ohne Einschalten) läuft die tägliche Prüfung in Tests nicht', async () => {
  assert.deepEqual(loescheAbgelaufeneKlassen(new Date('2025-10-30T12:00:00')), []);
  assert.deepEqual(pruefePapierkorbEinmalProTag(new Date('2030-01-01T12:00:00')), [], 'in Tests aus');
  assert.ok(klasse());
});

test('Ben stellt wieder her: die Frist entfällt, die Klasse steht wieder bei ihm; bei Anna bleibt sie im Papierkorb ("noch keine Ablaufzeit")', async () => {
  const r = await ben(`/teacher/papierkorb/${klasseId}/wiederherstellen`, {});
  assert.equal(r.status, 302);
  assert.equal(klasse().papierkorb_ab, null);
  assert.match(await meineKlassen(ben), /10A/);
  assert.doesNotMatch(await meineKlassen(anna), />10A</);
  const pk = await papierkorb(anna);
  assert.match(pk, /noch keine Ablaufzeit/);
  assert.doesNotMatch(await papierkorb(ben), /10A/, 'bei Ben nicht mehr im Papierkorb');
  assert.deepEqual(loescheAbgelaufeneKlassen(new Date('2025-12-31T12:00:00')), [], 'auch viel später: Ben nutzt die Klasse');
  assert.ok(klasse());
});

test('Eine neu eingetragene Lehrkraft hält die Klasse am Leben: die Frist wird zurückgesetzt statt zu löschen', async () => {
  await ben(`/teacher/klassen/${klasseId}/loeschen`, {});
  assert.ok(klasse().papierkorb_ab, 'beide haben gelöscht -> Frist');
  db().prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)').run(coraId, fachId); // Cora wird eingetragen
  assert.deepEqual(loescheAbgelaufeneKlassen(new Date('2025-12-31T12:00:00')), [], 'Cora nutzt die Klasse');
  assert.ok(klasse(), 'nicht gelöscht');
  assert.equal(klasse().papierkorb_ab, null, 'Frist zurückgesetzt');
  assert.match(await papierkorb(anna), /noch keine Ablaufzeit/);
});

test('Wenn auch Cora gelöscht hat und 30 Tage um sind, wird die Klasse endgültig gelöscht', async () => {
  await cora(`/teacher/klassen/${klasseId}/loeschen`, {});
  assert.ok(klasse().papierkorb_ab);
  assert.deepEqual(loescheAbgelaufeneKlassen(new Date('2025-11-15T12:00:00')), [klasseId]);
  assert.equal(klasse(), undefined);
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM klassen_geloescht WHERE klasse_id = ?').get(klasseId).c, 0, 'Papierkorb-Einträge sind weg');
  assert.doesNotMatch(await papierkorb(anna), /10A/);
});

test('Der Admin löscht weiterhin sofort und endgültig', async () => {
  await anna('/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '10B', notenschluessel: 'IHK', einschulung_jahr: '2025' });
  const id = db().prepare("SELECT id FROM klassen WHERE name = '10B'").get().id;
  assert.equal((await admin(`/teacher/klassen/${id}/loeschen`, {})).status, 302);
  assert.equal(db().prepare('SELECT 1 FROM klassen WHERE id = ?').get(id), undefined);
});

test('Seite "Klasse" zeigt jeder Lehrkraft den Löschen-Knopf mit Erklärung zum Papierkorb', async () => {
  await anna('/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '10C', notenschluessel: 'IHK', einschulung_jahr: '2025' });
  const id = db().prepare("SELECT id FROM klassen WHERE name = '10C'").get().id;
  const html = await (await anna(`/teacher/klassen/${id}`)).text();
  assert.match(html, /🗑 Klasse löschen/);
  assert.match(html, /liegt im Papierkorb, wo du sie wiederherstellen kannst/);
  assert.match(await papierkorb(anna), /Papierkorb/);
});

test('Die tägliche Prüfung löscht abgelaufene Klassen (eingeschaltet) -- höchstens einmal am Tag', async () => {
  process.env.NOTEN_PAPIERKORB_AUTO = '1';
  try {
    await anna('/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '10D', notenschluessel: 'IHK', einschulung_jahr: '2025' });
    const id = db().prepare("SELECT id FROM klassen WHERE name = '10D'").get().id;
    await anna(`/teacher/klassen/${id}/loeschen`, {}); // Anna ist die einzige Lehrkraft -> Frist läuft ab 01.10.2025
    assert.deepEqual(pruefePapierkorbEinmalProTag(new Date('2025-10-20T12:00:00')), [], 'noch nicht abgelaufen');
    assert.deepEqual(pruefePapierkorbEinmalProTag(new Date('2025-10-20T18:00:00')), [], 'am selben Tag nicht erneut');
    assert.deepEqual(pruefePapierkorbEinmalProTag(new Date('2025-11-05T12:00:00')), [id], 'am nächsten geprüften Tag abgelaufen -> gelöscht');
    assert.equal(db().prepare('SELECT 1 FROM klassen WHERE id = ?').get(id), undefined);
  } finally {
    delete process.env.NOTEN_PAPIERKORB_AUTO;
  }
});
