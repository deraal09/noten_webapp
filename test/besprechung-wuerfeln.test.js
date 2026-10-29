/**
 * Notenbesprechung: Würfelrunde (zufällige Reihenfolge, jede Person genau einmal, Zählung nach Aufrufreihenfolge)
 * und die Besprechung über mehrere Fächer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-wuerfeln-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-wuerfeln-bitte-lang-genug-xxxxxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const B = await import('../src/besprechung.js');
const { HALBJAHRE } = await import('../src/grade-calc.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
const HJ = HALBJAHRE[0];
const hjQ = `hj=${encodeURIComponent(HJ)}`;

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
const lehrer = client();
const fremd = client();
const db = () => getDb();
let klasseId, mathe, deutsch, sport;
let schueler = [];

const wuerfeln = (c, aktion, extra = {}) => c(`/teacher/fach/${mathe}/besprechung/wuerfeln`, { hj: HJ, aktion, ...extra });
const personVon = (location) => Number(/besprechung\/(\d+)\?/.exec(location)[1]);
const seite = async (c, id, q = '') => (await c(`/teacher/fach/${mathe}/besprechung/${id}?${hjQ}${q}`)).text();

test('Rechenkern: Parameter lesen, zufällig ohne Wiederholung, Aufrufreihenfolge', () => {
  assert.deepEqual(B.parseFaecherIds('3,5,x,5,-1'), [3, 5]);
  assert.deepEqual(B.parseFaecherIds(['2', '4,6']), [2, 4, 6]);
  assert.deepEqual(B.parseFaecherIds(undefined), []);
  assert.equal(B.rundenSchluessel([5, 3], HJ), `3,5|${HJ}`);
  // jede Person genau einmal, egal welche Zufallszahlen kommen
  const alle = [1, 2, 3, 4, 5];
  const gerufen = [];
  while (true) {
    const n = B.waehleZufaellig(alle, gerufen, (k) => k - 1);
    if (n === null) break;
    gerufen.push(n);
  }
  assert.deepEqual([...gerufen].sort(), alle);
  assert.equal(new Set(gerufen).size, 5);
  assert.equal(B.waehleZufaellig([1, 2], [1, 2]), null);
  const runde = { schluessel: 'x', gerufen: [4, 2, 5] };
  assert.deepEqual(B.rundenAnsicht(runde, alle, 2), { gerufen: 3, uebrig: 2, imRundenmodus: true, position: 2, vorherigeId: 4, naechsteId: 5 });
  assert.equal(B.rundenAnsicht(runde, alle, 1).imRundenmodus, false);
  assert.equal(B.rundenAnsicht(null, alle, 1), null);
});

test('Vorbereitung: Klasse mit Mathe, Deutsch, Sport und fünf Schüler/innen; Lehrkraft in Mathe und Deutsch', async () => {
  await admin('/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await admin('/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sj = db().prepare('SELECT id FROM schuljahre').get().id;
  for (const n of ['lehrer', 'fremd']) {
    await admin('/admin/einladungen/neu', { display_name: n, ttl_days: '14' });
  }
  const invs = db().prepare('SELECT token FROM invitations ORDER BY id').all();
  await lehrer(`/einladung/${invs[0].token}`, { username: 'lehrer', display_name: 'lehrer', password: 'passwort123', password2: 'passwort123' });
  await fremd(`/einladung/${invs[1].token}`, { username: 'fremd', display_name: 'fremd', password: 'passwort123', password2: 'passwort123' });
  await admin('/teacher/klassen/neu', { schuljahr_id: String(sj), name: '11A', notenschluessel: 'IHK', einschulung_jahr: '2025' });
  klasseId = db().prepare('SELECT id FROM klassen').get().id;
  for (const n of ['Mathe', 'Deutsch', 'Sport']) await admin(`/teacher/klassen/${klasseId}/faecher/neu`, { name: n });
  const id = (n) => db().prepare('SELECT id FROM faecher WHERE name = ?').get(n).id;
  [mathe, deutsch, sport] = [id('Mathe'), id('Deutsch'), id('Sport')];
  for (const n of ['Adler', 'Berger', 'Conrad', 'Dietz', 'Esser']) await admin(`/teacher/klassen/${klasseId}/schueler/neu`, { nachname: n, vorname: 'X' });
  schueler = db().prepare('SELECT id, nachname FROM schueler ORDER BY nachname').all().map((r) => r.id);
  const uid = db().prepare("SELECT id FROM users WHERE username = 'lehrer'").get().id;
  for (const f of [mathe, deutsch]) db().prepare('INSERT OR IGNORE INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)').run(uid, f);
});

test('Würfeln: jede Person genau einmal, die Zählung läuft linear nach Aufrufreihenfolge', async () => {
  const reihenfolge = [];
  for (let i = 1; i <= 5; i++) {
    const r = await wuerfeln(lehrer, i === 1 ? 'neu' : 'wuerfeln');
    assert.equal(r.status, 302);
    const id = personVon(r.headers.get('location'));
    assert.ok(!reihenfolge.includes(id), 'keine Person doppelt');
    reihenfolge.push(id);
    const html = await seite(lehrer, id);
    assert.match(html, new RegExp(`${i} / 5: `), `Position ${i}`);
    assert.match(html, new RegExp(`<strong>${i} von 5</strong> aufgerufen`));
  }
  assert.deepEqual([...reihenfolge].sort((a, b) => a - b), schueler, 'alle fünf waren dran');
  // Alle durch: weiteres Würfeln bleibt bei der letzten Person, Würfel gesperrt
  const r = await wuerfeln(lehrer, 'wuerfeln');
  assert.equal(r.headers.get('location').includes(`/besprechung/${reihenfolge[4]}?`), true);
  const letzte = await seite(lehrer, reihenfolge[4]);
  assert.match(letzte, /alle waren dran/);
  assert.match(letzte, /name="aktion" value="wuerfeln" disabled/);
  assert.match(letzte, /btn disabled">Weiter/);
  // Zurück/Weiter folgen der Aufrufreihenfolge
  const erste = await seite(lehrer, reihenfolge[0]);
  assert.match(erste, /btn disabled">← Zurück/);
  assert.match(erste, new RegExp(`/besprechung/${reihenfolge[1]}\\?[^"]*">Weiter`));
  const zweite = await seite(lehrer, reihenfolge[1]);
  assert.match(zweite, new RegExp(`/besprechung/${reihenfolge[0]}\\?[^"]*">← Zurück`));
  assert.match(zweite, /2 \/ 5: /);
});

test('Neue Runde beginnt von vorn; Runde beenden kehrt zur alphabetischen Reihenfolge zurück; andere Sitzungen sind unabhängig', async () => {
  let r = await wuerfeln(lehrer, 'neu');
  const erste = personVon(r.headers.get('location'));
  assert.match(await seite(lehrer, erste), /1 \/ 5: /);
  assert.match(await seite(lehrer, erste), /<strong>1 von 5<\/strong> aufgerufen, noch 4/);
  // eine Person, die nicht in der Runde ist, wird alphabetisch gezeigt (mit Hinweis)
  const draussen = schueler.find((id) => id !== erste);
  const html = await seite(lehrer, draussen);
  assert.match(html, /Diese Person gehört noch nicht zur Würfelrunde/);
  assert.match(html, new RegExp(`${schueler.indexOf(draussen) + 1} / 5: `));
  r = await wuerfeln(lehrer, 'ende', { schueler_id: String(draussen) });
  assert.match(r.headers.get('location'), new RegExp(`/besprechung/${draussen}\\?`));
  const ohne = await seite(lehrer, draussen);
  assert.doesNotMatch(ohne, /Würfelrunde|aufgerufen/);
  assert.match(ohne, /🎲 Würfeln/);
  // andere Sitzung (Admin) hat keine Runde
  assert.doesNotMatch(await seite(admin, schueler[0]), /aufgerufen/);
  // Rechte: ohne Zugriff auf das Fach
  assert.equal((await wuerfeln(fremd, 'neu')).status, 403);
});

test('Mehrere Fächer: Reiter zum Umschalten, nur das gewählte Fach ist zu sehen, Personen aus allen gewählten Fächern', async () => {
  // Sport gehört nicht zu den Fächern der Lehrkraft; Esser nimmt nur an Deutsch teil
  db().prepare('DELETE FROM fach_teilnehmer WHERE fach_id = ? AND schueler_id = ?').run(mathe, schueler[4]);
  let html = await seite(lehrer, schueler[0]);
  assert.match(html, /Weitere Fächer in diese Besprechung einbeziehen/);
  assert.match(html, new RegExp(`name="faecher" value="${deutsch}"`));
  assert.doesNotMatch(html, new RegExp(`name="faecher" value="${sport}"`), 'Fach ohne Zuordnung nicht wählbar');
  assert.doesNotMatch(html, /fach-tabs/, 'ein Fach: keine Fach-Reiter');
  assert.match(html, /1 \/ 4: /, 'ohne Esser nur vier Personen in Mathe');

  html = await seite(lehrer, schueler[0], `&faecher=${deutsch},${sport}`);
  assert.match(html, /<h1>Notenbesprechung: Mathe – 11A<\/h1>/);
  const reiter = html.slice(html.indexOf('class="hj-tabs fach-tabs"'), html.indexOf('</div>', html.indexOf('class="hj-tabs fach-tabs"')));
  assert.match(reiter, new RegExp(`class="hj-tab active" href="[^"]*/fach/${mathe}/besprechung/${schueler[0]}\\?[^"]*faecher=${deutsch}">Mathe`), 'Mathe aktiv, die anderen Fächer stehen im Link');
  assert.match(reiter, new RegExp(`/fach/${deutsch}/besprechung/${schueler[0]}\\?[^"]*faecher=${mathe}">Deutsch`), 'Deutsch-Reiter zeigt Mathe als weiteres Fach');
  assert.doesNotMatch(reiter, /Sport/);
  assert.match(html, /1 \/ 5: /, 'Esser kommt über Deutsch dazu');
  // Esser: im Mathe-Reiter "nimmt nicht teil", im Deutsch-Reiter die Noten
  html = await seite(lehrer, schueler[4], `&faecher=${deutsch}`);
  assert.match(html, /X nimmt an diesem Fach nicht teil/);
  assert.match(html, /5 \/ 5: Esser/);
  const deutschSeite = await (await lehrer(`/teacher/fach/${deutsch}/besprechung/${schueler[4]}?${hjQ}&faecher=${mathe}`)).text();
  assert.doesNotMatch(deutschSeite, /nimmt an diesem Fach nicht teil/);
  assert.match(deutschSeite, /<h1>Notenbesprechung: Deutsch – 11A<\/h1>/);
  assert.match(deutschSeite, /5 \/ 5: Esser/);
  // Links tragen die Fachwahl weiter
  html = await seite(lehrer, schueler[1], `&faecher=${deutsch}`);
  assert.match(html, new RegExp(`/besprechung/${schueler[2]}\\?hj=[^"]*&amp;faecher=${deutsch}">Weiter`));
  // Der Hauptfach-Zugriff bleibt Voraussetzung
  assert.equal((await fremd(`/teacher/fach/${mathe}/besprechung/${schueler[0]}?${hjQ}&faecher=${deutsch}`)).status, 403);
});

test('Würfelrunde über mehrere Fächer: eigene Runde je Fächerwahl, alle fünf Personen einmal', async () => {
  const q = { faecher: String(deutsch) };
  const reihenfolge = [];
  for (let i = 0; i < 5; i++) {
    const r = await wuerfeln(lehrer, i === 0 ? 'neu' : 'wuerfeln', q);
    const loc = r.headers.get('location');
    assert.match(loc, new RegExp(`faecher=${deutsch}$`), 'Fachwahl bleibt in der Adresse');
    reihenfolge.push(personVon(loc));
  }
  assert.equal(new Set(reihenfolge).size, 5);
  assert.deepEqual([...reihenfolge].sort((a, b) => a - b), schueler);
  // Die Runde mit der anderen Fächerwahl (nur Mathe) ist davon getrennt
  assert.doesNotMatch(await seite(lehrer, schueler[0]), /aufgerufen/);
  await wuerfeln(lehrer, 'ende', q);
});

test('Notizen gehören zum angezeigten Fach: im anderen Reiter stehen die des anderen Fachs', async () => {
  const notiz = (fachId, body) => lehrer(`/teacher/fach/${fachId}/besprechung/${schueler[0]}/notiz`, { halbjahr: HJ, typ: 'besprechung', ...body });
  let r = await notiz(deutsch, { text: 'Zu Deutsch', faecher: String(mathe) });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), new RegExp(`/fach/${deutsch}/besprechung/.*faecher=${mathe}$`));
  assert.equal(db().prepare("SELECT fach_id FROM notenbesprechung_notizen WHERE text = 'Zu Deutsch'").get().fach_id, deutsch);
  await notiz(mathe, { text: 'Zu Mathe' });
  assert.equal(db().prepare("SELECT fach_id FROM notenbesprechung_notizen WHERE text = 'Zu Mathe'").get().fach_id, mathe);
  const deutschSeite = await (await lehrer(`/teacher/fach/${deutsch}/besprechung/${schueler[0]}?${hjQ}&faecher=${mathe}`)).text();
  assert.match(deutschSeite, /Zu Deutsch/);
  assert.doesNotMatch(deutschSeite, /Zu Mathe/);
  const matheSeite = await seite(lehrer, schueler[0], `&faecher=${deutsch}`);
  assert.match(matheSeite, /Zu Mathe/);
  assert.doesNotMatch(matheSeite, /Zu Deutsch/);
  assert.doesNotMatch(matheSeite, /<select name="fach_id">/, 'keine Fachauswahl mehr im Notizformular');
});

test('Fachseite bietet „Zufällig starten“ an', async () => {
  const html = await (await lehrer(`/teacher/fach/${mathe}?${hjQ}`)).text();
  assert.match(html, /name="aktion" value="neu"[^>]*>🎲 Zufällig starten/);
  const r = await wuerfeln(lehrer, 'neu');
  assert.equal(r.status, 302);
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
