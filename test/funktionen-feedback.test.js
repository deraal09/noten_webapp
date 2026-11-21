/**
 * „Meine Funktionen“ (Startprofile, Funktionen ein-/ausschalten), anonyme Funktionsnutzung für die Administration, Feedback der
 * Nutzer:innen und das Aufräumen der Oberfläche (Fachseite, Noteneingabe, Meine Klassen, Klassenseite).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-funktionen-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-funktionen-bitte-lang-genug-xxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { funktionFuerAnfrage, auswertung } = await import('../src/aktivitaet.js');
const { funktionenFuer, PROFILE, FUNKTION_IDS } = await import('../src/funktionen.js');
const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
test.after(async () => { await fastify.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });

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
const text = async (r) => (await r).text();

const admin = client(); const anna = client(); const ben = client();
let klasseId, fachId;

test('Vorbereitung: Klasse mit Fach und Klausur, zwei Lehrkräfte, Klassenleitung', async () => {
  await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  const sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;
  for (const n of ['anna', 'ben']) await form(admin, '/admin/einladungen/neu', { display_name: n, ttl_days: '14' });
  const invs = getDb().prepare('SELECT token FROM invitations ORDER BY id').all();
  for (const [i, [c, n]] of [[anna, 'anna'], [ben, 'ben']].entries()) {
    await form(c, `/einladung/${invs[i].token}`, { username: n, display_name: n, password: 'passwort1234', password2: 'passwort1234' });
  }
  getDb().prepare("UPDATE users SET auth_source = 'ldap' WHERE username IN ('anna', 'ben')").run();
  await form(anna, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '11A', notenschluessel: 'IHK' });
  klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '11A'").get().id;
  await form(anna, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Physik' });
  fachId = getDb().prepare("SELECT id FROM faecher WHERE name = 'Physik'").get().id;
  await form(anna, `/teacher/fach/${fachId}/klausuren/neu`, { name: 'K1', aufgaben: '2', halbjahr: '1. Halbjahr' });
  await form(anna, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
  // Ben ist Fachlehrkraft im Physik-Fach, Anna wird Klassenleitung
  getDb().prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) SELECT id, ? FROM users WHERE username = ?').run(fachId, 'ben');
});

// ---------- Meine Funktionen ----------
test('Ohne Auswahl sieht man alles und die Start-Seite fragt nach dem Profil', async () => {
  assert.equal(funktionenFuer({ id: getDb().prepare("SELECT id FROM users WHERE username = 'ben'").get().id }).gewaehlt, false);
  const start = await text(ben('/start'));
  assert.match(start, /Wie möchtest du die Notenverwaltung nutzen\?/);
  assert.match(start, /href="\/teacher\/sitzplaene"/, 'bis zur Wahl bleibt alles sichtbar');
  for (const id of Object.keys(PROFILE)) assert.match(start, new RegExp(`name="profil" value="${id}"`));
  const nav = /<nav class="topnav"[\s\S]*?<\/nav>/.exec(start)[0];
  assert.match(nav, />Sitzpläne</);
});

test('Profil „Nur Klassen und Noten“: Sitzpläne, Klassenleitung, API, Sterne und Statistik verschwinden – nichts ist gesperrt', async () => {
  const r = await form(ben, '/konto/funktionen/profil', { profil: 'einfach', weiter: '/start' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/start');
  const start = await text(ben('/start'));
  assert.doesNotMatch(start, /Wie möchtest du die Notenverwaltung nutzen/);
  assert.doesNotMatch(start, /href="\/teacher\/sitzplaene"/);
  assert.doesNotMatch(start, /href="\/klassenlehrer"/);
  const nav = /<nav class="topnav"[\s\S]*?<\/nav>/.exec(start)[0];
  assert.doesNotMatch(nav, /Sitzpläne|Klassenleitung/);
  assert.match(nav, /Noteneingabe/);
  assert.doesNotMatch(start, /href="\/konto\/api"/);
  assert.match(start, /href="\/konto\/funktionen"/, 'Meine Funktionen bleibt erreichbar');
  assert.match(start, /href="\/feedback"/);
  // Fachseite: kein Sitzplan/Notenbesprechung im Menü, keine Statistik, Synchronisation nur mit Klassenleitung
  const fach = await text(ben(`/teacher/fach/${fachId}`));
  assert.doesNotMatch(fach, /Sitzplan<\/a>|Notenbesprechung starten/);
  assert.doesNotMatch(fach, /data-statistik-schalter/);
  assert.doesNotMatch(fach, /data-target="panel-sync"/, 'Klasse ohne Klassenleitung: keine Synchronisation');
  // Noteneingabe: keine Sterne
  assert.doesNotMatch(await text(ben('/teacher')), /class="stern/);
  // Die Seiten selbst bleiben erreichbar
  assert.equal((await ben(`/teacher/klassen/${klasseId}/sitzplan`)).status, 200);
});

test('Klassenleitung erscheint von selbst, ebenso die Synchronisation an Klassen mit Klassenleitung', async () => {
  getDb().prepare('INSERT OR IGNORE INTO klassenleitung (klasse_id, user_id) SELECT ?, id FROM users WHERE username = ?').run(klasseId, 'anna');
  const fach = await text(ben(`/teacher/fach/${fachId}`));
  assert.match(fach, /data-target="panel-sync"/, 'Klasse hat jetzt eine Klassenleitung');
  assert.match(fach, /<div class="reiter-mehr-wrapper">/);
  await form(anna, '/konto/funktionen/profil', { profil: 'einfach' });
  const startAnna = await text(anna('/start'));
  assert.match(startAnna, /href="\/klassenlehrer"/, 'als Klassenleitung eingetragen: immer sichtbar');
  assert.doesNotMatch(startAnna, /href="\/teacher\/sitzplaene"/);
});

test('Einzelne Funktionen einschalten; unbekannte Namen und Profile werden ignoriert; Weiterleitung nur intern', async () => {
  await ben('/konto/funktionen', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams([['funktion', 'sitzplan'], ['funktion', 'statistik'], ['funktion', 'gibt-es-nicht']]) });
  const uid = getDb().prepare("SELECT id FROM users WHERE username = 'ben'").get().id;
  const f = funktionenFuer({ id: uid });
  assert.equal(f.sitzplan, true); assert.equal(f.statistik, true); assert.equal(f.favoriten, false); assert.equal(f.api, false);
  const nav = /<nav class="topnav"[\s\S]*?<\/nav>/.exec(await text(ben('/start')))[0];
  assert.match(nav, /Sitzpläne/);
  const fach = await text(ben(`/teacher/fach/${fachId}`));
  assert.match(fach, /data-statistik-schalter/);
  assert.match(fach, /<div class="klausur-statistik card"[^>]* hidden>/, 'Statistik ist ausgeschaltet, bis man sie mit dem Schalter zeigt');
  const r = await form(ben, '/konto/funktionen/profil', { profil: 'gibtsnicht' });
  assert.equal(r.headers.get('location'), '/konto/funktionen');
  const r2 = await form(ben, '/konto/funktionen/profil', { profil: 'alles', weiter: '//evil.example/x' });
  assert.equal(r2.headers.get('location'), '/start', 'kein offener Weiterleiter');
  assert.deepEqual(FUNKTION_IDS.filter((id) => funktionenFuer({ id: uid })[id]), FUNKTION_IDS, 'Profil „alles“ schaltet alles ein');
  const seite = await text(ben('/konto/funktionen'));
  assert.match(seite, /Meine Funktionen/);
  assert.match(seite, /name="funktion" value="sitzplan" checked/);
});

// ---------- Funktionsnutzung (anonym) ----------
test('Zuordnung Anfrage -> Funktion', () => {
  const f = funktionFuerAnfrage;
  assert.equal(f('GET', '/teacher'), 'noteneingabe');
  assert.equal(f('GET', '/teacher/'), 'noteneingabe');
  assert.equal(f('GET', '/teacher/fach/:id'), 'fach');
  assert.equal(f('POST', '/teacher/klausuren/:id/punkte'), 'punkte');
  assert.equal(f('POST', '/teacher/fach/:id/klausuren/neu'), 'klausur-anlegen');
  assert.equal(f('GET', '/teacher/klassen/:id/sitzplan'), 'sitzplan');
  assert.equal(f('GET', '/teacher/fach/:id/besprechung/:schuelerId'), 'notenbesprechung');
  assert.equal(f('POST', '/teacher/faecher/:id/favorit'), 'favoriten');
  assert.equal(f('POST', '/funktion-genutzt'), 'statistik');
  assert.equal(f('GET', '/klassenlehrer/klasse/:id'), 'klassenleitung');
  assert.equal(f('GET', '/static/*'), null);
  assert.equal(f('GET', undefined), null);
});

test('Funktionsnutzung wird anonym gezählt (Personen, Aufrufe) und erscheint in der Auswertung und auf der Admin-Seite', async () => {
  await ben('/teacher');
  await ben('/teacher');
  await anna('/teacher');
  await ben(`/teacher/klassen/${klasseId}/sitzplan`);
  assert.equal((await form(ben, '/funktion-genutzt', { funktion: 'statistik' })).status, 204);
  assert.equal((await form(ben, '/funktion-genutzt', { funktion: 'etwas-anderes' })).status, 400);
  const a = auswertung(30);
  const zeile = (id) => a.funktionen.find((x) => x.id === id);
  assert.equal(zeile('noteneingabe').personen, 2);
  assert.ok(zeile('noteneingabe').aufrufe >= 3);
  assert.equal(zeile('sitzplan').personen, 1);
  assert.equal(zeile('statistik').personen, 1);
  assert.equal(zeile('export').personen, 0);
  // keine Konto-Bezüge in der Tabelle
  const spalten = getDb().prepare('PRAGMA table_info(nutzung_funktionen)').all().map((c) => c.name);
  assert.deepEqual(spalten, ['profil', 'tag', 'funktion', 'aufrufe']);
  const seite = await text(admin('/admin/aktivitaet'));
  assert.match(seite, /Welche Funktionen werden genutzt\?/);
  assert.match(seite, /Sitzpläne/);
  assert.match(seite, /Was haben die Lehrkräfte eingeschaltet\?/);
});

// ---------- Feedback ----------
test('Feedback senden: anonym ohne Häkchen, mit Namen nur auf ausdrücklichen Wunsch', async () => {
  const seite = await text(ben('/feedback'));
  assert.match(seite, /Meinen Namen mitsenden/);
  for (const art of ['lob', 'wunsch', 'problem']) assert.match(seite, new RegExp(`name="art" value="${art}"`));
  let r = await form(ben, '/feedback', { art: 'wunsch', text: 'Bitte einen Export der Statistik.', funktion: 'statistik', seite: '/teacher/fach/12?hj=1' });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Danke für deine Rückmeldung/);
  const z = getDb().prepare('SELECT * FROM feedback ORDER BY id DESC').get();
  assert.equal(z.art, 'wunsch'); assert.equal(z.user_id, null, 'anonym'); assert.equal(z.funktion, 'statistik'); assert.equal(z.seite, '/teacher/fach/…', 'Zahlen und Parameter werden entfernt');
  r = await form(anna, '/feedback', { art: 'lob', text: 'Sehr übersichtlich geworden!', mit_name: '1' });
  assert.equal(r.status, 200);
  assert.equal(getDb().prepare('SELECT user_id FROM feedback ORDER BY id DESC').get().user_id, getDb().prepare("SELECT id FROM users WHERE username = 'anna'").get().id);
});

test('Feedback prüft Eingaben: Art, Mindest- und Höchstlänge, Tageslimit', async () => {
  const n = () => getDb().prepare('SELECT COUNT(*) AS c FROM feedback').get().c;
  const vorher = n();
  assert.equal((await form(ben, '/feedback', { art: 'unsinn', text: 'Genug Text hier.' })).status, 400);
  assert.equal((await form(ben, '/feedback', { art: 'lob', text: 'ab' })).status, 400);
  assert.equal((await form(ben, '/feedback', { art: 'lob', text: 'x'.repeat(2001) })).status, 400);
  assert.equal(n(), vorher);
  let letzter = 200;
  for (let i = 0; i < 12; i++) letzter = (await form(ben, '/feedback', { art: 'lob', text: `Nochmal Lob Nummer ${i}` })).status;
  assert.equal(letzter, 400, 'höchstens 10 je Konto und Tag');
});

test('Feedback in der Administration: nur Admin, Namen nur bei Freigabe, Status ändern, löschen, Zähler in der Navigation', async () => {
  assert.equal((await ben('/admin/feedback')).status, 403);
  const html = await text(admin('/admin/feedback'));
  assert.match(html, /Bitte einen Export der Statistik\./);
  assert.match(html, /Von: anna/);
  assert.match(html, /anonym/);
  assert.match(html, /<a href="\/admin\/feedback">Feedback \(\d+\)<\/a>/, 'Anzahl neuer Rückmeldungen in der Leiste');
  const id = getDb().prepare("SELECT id FROM feedback WHERE art = 'wunsch'").get().id;
  await form(admin, `/admin/feedback/${id}/status`, { status: 'erledigt' });
  assert.equal(getDb().prepare('SELECT status FROM feedback WHERE id = ?').get(id).status, 'erledigt');
  assert.match(await text(admin('/admin/feedback?status=erledigt')), /Bitte einen Export/);
  assert.doesNotMatch(await text(admin('/admin/feedback?status=neu')), /Bitte einen Export/);
  await form(admin, `/admin/feedback/${id}/loeschen`, {});
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM feedback WHERE id = ?').get(id).c, 0);
  // Link im Fußbereich
  assert.match(await text(ben('/start')), /<a href="\/feedback">Feedback<\/a> · <a href="\/datenschutz">/);
});

// ---------- Aufgeräumte Oberfläche ----------
test('Fachseite: Eingabe vorn (Klausuren · Unterrichtsleistung · Notenübersicht), Klausur-Einstellungen offen bis Punkte da sind', async () => {
  let fach = await text(anna(`/teacher/fach/${fachId}`));
  assert.ok(fach.indexOf('data-target="panel-klausuren"') < fach.indexOf('data-target="panel-uls"'));
  assert.ok(fach.indexOf('data-target="panel-uls"') < fach.indexOf('data-target="panel-uebersicht"'));
  assert.match(fach, /<div id="panel-klausuren" class="reiter-panel active">/);
  assert.match(fach, /<details class="klausur-einstellungen" open>/, 'ohne Punkte: Einstellungen offen');
  const kid = getDb().prepare('SELECT id FROM klausuren WHERE fach_id = ?').get(fachId).id;
  const sid = getDb().prepare('SELECT id FROM schueler').get().id;
  await form(anna, `/teacher/klausuren/${kid}/maxpunkte`, { anzahl_aufgaben: '2', mp_0: '10', mp_1: '10', halbjahr: '1. Halbjahr' });
  await form(anna, `/teacher/klausuren/${kid}/punkte`, { schueler_id: String(sid), aufgabe_idx: '0', wert: '5' });
  fach = await text(anna(`/teacher/fach/${fachId}`));
  assert.match(fach, /<details class="klausur-einstellungen">/, 'mit Punkten: eingeklappt');
});

test('Noteneingabe-Kachel ohne Rauschen; Meine Klassen mit einem Hauptknopf; Klassenseite: Einstellungen im Menü', async () => {
  const kacheln = await text(anna('/teacher'));
  assert.doesNotMatch(kacheln, /0 Klausur\(en\)|0 UL\(s\)/);
  assert.doesNotMatch(kacheln, /id="klassenfilter"/, 'bei einer Klasse kein Filter');
  const liste = await text(anna('/teacher/klassen'));
  assert.match(liste, /<button type="button" data-target="panel-klasse-anlegen">\+ Neue Klasse anlegen<\/button>/);
  assert.match(liste, /class="sekundaer" data-target="panel-kurs-anlegen"/);
  const klasse = await text(anna(`/teacher/klassen/${klasseId}`));
  assert.match(klasse, /<button type="button" hidden data-target="panel-klasse-einstellungen">/, 'kein sichtbarer Einstellungen-Reiter mehr');
  assert.match(klasse, /data-zeige="panel-klasse-einstellungen"[^>]*>⚙ Klasse einstellen</);
  assert.match(klasse, /data-klick-auf="vorlage-import-knopf"/);
  assert.match(klasse, /<button type="button" hidden id="vorlage-import-knopf">/);
  assert.match(klasse, /<details class="info-ausklapp"><summary>ⓘ Hinweise zu Fächern und Lehrkräften/);
  // Fach-Einstellungen: Erweitert eingeklappt
  const einst = await text(anna(`/teacher/faecher/${fachId}/einstellungen`));
  assert.match(einst, /<details class="erweitert">\s*<summary>Erweitert: Unterfächer und Verrechnung der Halbjahre<\/summary>/);
});
