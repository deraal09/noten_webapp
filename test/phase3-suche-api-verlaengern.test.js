/**
 * Phase 3: Suche „Was möchtest du tun?“ (auch ausgeschaltete Funktionen), „Erste Schritte“-Checkliste, Admin-Standardprofil für neue
 * Lehrkräfte; dazu „Verlängern“ für API-Schlüssel (nur in der App, nie über die API).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-phase3-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-phase3-bitte-lang-genug-xxxxxxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { suche } = await import('../src/suche.js');
const { ersteSchritte } = await import('../src/erste-schritte.js');
const { funktionenFuer, setzeStandardProfil, standardProfil } = await import('../src/funktionen.js');
const { verlaengereSchluessel, gueltigkeitInTagen } = await import('../src/api-keys.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
const json = async (r) => (await r).json();
const uid = (n) => getDb().prepare('SELECT id FROM users WHERE username = ?').get(n).id;

const admin = client(); const nina = client(); const olaf = client();
let sjId;

test('Vorbereitung: Admin, zwei Lehrkräfte (LDAP)', async () => {
  await form(admin, '/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await form(admin, '/admin/schuljahre/neu', { bezeichnung: '2025/26' });
  sjId = getDb().prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;
  for (const n of ['nina', 'olaf']) await form(admin, '/admin/einladungen/neu', { display_name: n, ttl_days: '14' });
  const invs = getDb().prepare('SELECT token FROM invitations ORDER BY id').all();
  for (const [i, [c, n]] of [[nina, 'nina'], [olaf, 'olaf']].entries()) {
    await form(c, `/einladung/${invs[i].token}`, { username: n, display_name: n, password: 'passwort1234', password2: 'passwort1234' });
  }
  getDb().prepare("UPDATE users SET auth_source = 'ldap' WHERE username IN ('nina', 'olaf')").run();
});

// ---------- Suche ----------
const ctxLehrkraft = (extra = {}) => ({ istAdmin: false, ldap: true, kannEinladen: false, funktionen: null, ...extra });

test('Suche: Seiten/Aktionen und Hilfe-Artikel, Umlaute egal, Vorschläge ohne Eingabe', () => {
  const r = suche('klasse anlegen', ctxLehrkraft());
  assert.equal(r.aktionen[0].id, 'klasse-anlegen');
  assert.equal(r.aktionen[0].href, '/teacher/klassen#panel-klasse-anlegen');
  assert.ok(r.hilfe.length > 0);
  assert.ok(r.hilfe.every((h) => h.href.startsWith('/hilfe/')));
  assert.equal(suche('passwort', ctxLehrkraft({ ldap: false })).aktionen[0].id, 'passwort');
  assert.ok(!suche('passwort', ctxLehrkraft({ ldap: true })).aktionen.some((a) => a.id === 'passwort'), 'Schulkonten haben kein lokales Passwort');
  assert.ok(suche('wiederherstellen', ctxLehrkraft()).aktionen.some((a) => a.id === 'papierkorb'));
  assert.deepEqual(suche('', ctxLehrkraft()).aktionen.map((a) => a.id), ['noteneingabe', 'klasse-anlegen', 'funktionen', 'feedback', 'hilfe']);
  assert.deepEqual(suche('xyzqq', ctxLehrkraft()), { aktionen: [], hilfe: [] });
  assert.equal(suche('x', ctxLehrkraft()).aktionen.length, 5, 'zu kurze Eingabe: es bleiben die Vorschläge');
});

test('Suche findet auch ausgeschaltete Funktionen und kennzeichnet sie; Rollen und Bedingungen werden beachtet', () => {
  const aus = { sitzplan: false, notenbesprechung: true, api: false };
  const r = suche('sitzplan', ctxLehrkraft({ funktionen: aus }));
  assert.equal(r.aktionen[0].id, 'sitzplan');
  assert.equal(r.aktionen[0].aus, true);
  assert.equal(r.aktionen[0].funktion, 'sitzplan');
  assert.equal(suche('besprechung', ctxLehrkraft({ funktionen: aus })).aktionen[0].aus, false);
  assert.equal(suche('api schlüssel', ctxLehrkraft({ funktionen: aus })).aktionen[0].aus, true);
  assert.ok(!suche('api schlüssel', ctxLehrkraft({ ldap: false })).aktionen.some((a) => a.id === 'api'), 'API nur für Schulkonten');
  // Admin sieht Admin-Seiten, keine Lehrkraft-Seiten; Lehrkraft keine Admin-Seiten
  assert.equal(suche('aktivität', ctxLehrkraft({ istAdmin: true })).aktionen[0].id, 'admin-aktivitaet');
  assert.ok(!suche('aktivität', ctxLehrkraft()).aktionen.some((a) => a.id.startsWith('admin')));
  assert.ok(!suche('sitzplan', ctxLehrkraft({ istAdmin: true })).aktionen.some((a) => a.id === 'sitzplan'));
  assert.ok(suche('einladung', ctxLehrkraft({ kannEinladen: true })).aktionen.some((a) => a.id === 'einladungen'));
  assert.ok(!suche('einladung', ctxLehrkraft({ kannEinladen: false })).aktionen.some((a) => a.id === 'einladungen'));
});

test('GET /suche: nur angemeldet, JSON; „einschalten und öffnen“ schaltet die Funktion ein und leitet weiter', async () => {
  assert.ok([302, 401].includes((await fetch(`${base}/suche?q=hilfe`, { redirect: 'manual' })).status), 'ohne Anmeldung keine Treffer');
  const r = await json(nina('/suche?q=zeugnis'));
  assert.equal(r.aktionen[0].id, 'klassenleitung');
  // Profil „einfach“: Sitzpläne ausgeschaltet -> aus
  await form(olaf, '/konto/funktionen/profil', { profil: 'einfach' });
  const aus = await json(olaf('/suche?q=sitzplan'));
  assert.equal(aus.aktionen[0].aus, true);
  const e = await form(olaf, '/konto/funktionen/einschalten', { funktion: 'sitzplan', weiter: '/teacher/sitzplaene' });
  assert.equal(e.status, 302);
  assert.equal(e.headers.get('location'), '/teacher/sitzplaene');
  assert.equal(funktionenFuer({ id: uid('olaf') }).sitzplan, true);
  assert.equal(funktionenFuer({ id: uid('olaf') }).statistik, false, 'andere Funktionen bleiben aus');
  assert.equal((await json(olaf('/suche?q=sitzplan'))).aktionen[0].aus, false);
  // kein offener Weiterleiter, unbekannte Funktion wird ignoriert
  assert.equal((await form(olaf, '/konto/funktionen/einschalten', { funktion: 'gibts-nicht', weiter: '//evil.example' })).headers.get('location'), '/start');
  // Anker bleibt erhalten
  assert.equal((await form(olaf, '/konto/funktionen/einschalten', { funktion: 'api', weiter: '/teacher/klassen#panel-klasse-anlegen' })).headers.get('location'), '/teacher/klassen#panel-klasse-anlegen');
});

test('Suche in der Kopfzeile: Knopf, Dialog, Skript; Tastenkürzel im Skript', async () => {
  const html = await text(nina('/start'));
  assert.match(html, /<button type="button" class="suche-knopf" id="suche-oeffnen"/);
  assert.match(html, /<dialog id="suche-dialog" class="notiz-dialog suche-dialog"/);
  assert.match(html, /\/static\/js\/suche\.js\?v=/);
  assert.doesNotMatch(await text(fetch(`${base}/login`)), /suche-oeffnen/, 'nicht ohne Anmeldung');
  const js = fs.readFileSync(path.join(ROOT, 'static/js/suche.js'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(js));
  for (const teil of ["e.key === 'k'", "e.key === '/'", 'ArrowDown', '/konto/funktionen/einschalten', "'/suche?q='"]) assert.ok(js.includes(teil), teil);
});

// ---------- Erste Schritte ----------
test('Erste Schritte: Checkliste für neue Lehrkräfte, schrittweise erledigt, verschwindet am Ende', async () => {
  let s = ersteSchritte({ id: uid('nina'), isAdmin: false, authSource: 'ldap' });
  assert.equal(s.erledigt, 0);
  assert.deepEqual(s.schritte.map((x) => x.id), ['klasse', 'fach', 'schueler', 'klausur']);
  assert.equal(s.schritte[0].href, '/teacher/klassen#panel-klasse-anlegen');
  assert.equal(s.schritte[1].href, null, 'Fach braucht erst eine Klasse');
  let html = await text(nina('/start'));
  assert.match(html, /Erste Schritte <small class="hint">\(0 von 4 erledigt\)/);
  assert.doesNotMatch(html, /class="kachel"/, 'ganz neu: Checkliste statt Kacheln');
  assert.match(html, /href="\/teacher\/klassen">Meine Klassen<\/a>/);

  await form(nina, '/teacher/klassen/neu', { schuljahr_id: String(sjId), name: '11A', notenschluessel: 'IHK' });
  const klasseId = getDb().prepare("SELECT id FROM klassen WHERE name = '11A'").get().id;
  s = ersteSchritte({ id: uid('nina'), isAdmin: false, authSource: 'ldap' });
  assert.deepEqual(s.schritte.map((x) => x.erledigt), [true, false, false, false]);
  assert.equal(s.schritte[1].href, `/teacher/klassen/${klasseId}`);
  html = await text(nina('/start'));
  assert.match(html, /\(1 von 4 erledigt\)/);
  assert.match(html, /class="kachel"/, 'sobald etwas erledigt ist, gibt es wieder die Kacheln');

  await form(nina, `/teacher/klassen/${klasseId}/faecher/neu`, { name: 'Physik' });
  await form(nina, `/teacher/klassen/${klasseId}/schueler/neu`, { nachname: 'Adler', vorname: 'Anna' });
  s = ersteSchritte({ id: uid('nina'), isAdmin: false, authSource: 'ldap' });
  assert.deepEqual(s.schritte.map((x) => x.erledigt), [true, true, true, false]);
  const fachId = getDb().prepare('SELECT id FROM faecher WHERE name = ?').get('Physik').id;
  assert.equal(s.schritte[3].href, `/teacher/fach/${fachId}`);
  await form(nina, `/teacher/fach/${fachId}/klausuren/neu`, { name: 'K1', aufgaben: '2', halbjahr: '1. Halbjahr' });
  assert.equal(ersteSchritte({ id: uid('nina'), isAdmin: false, authSource: 'ldap' }), null, 'alles erledigt: keine Checkliste mehr');
  assert.doesNotMatch(await text(nina('/start')), /id="erste-schritte"/);
});

test('Erste Schritte: nicht für Admins und nicht für Konten, die weder Klassen haben noch anlegen dürfen', () => {
  assert.equal(ersteSchritte({ id: uid('admin'), isAdmin: true, authSource: 'lokal' }), null);
  assert.equal(ersteSchritte({ id: uid('olaf'), isAdmin: false, authSource: 'lokal' }), null);
});

// ---------- Admin-Standardprofil ----------
test('Standardprofil: gilt nur für neue Konten ohne eigene Wahl, bestehende bleiben unverändert; Admin-Seite', async () => {
  assert.equal(standardProfil(), null);
  assert.equal((await nina('/admin/funktionen')).status, 403);
  assert.match(await text(admin('/admin/funktionen')), /Startprofil für neue Lehrkräfte/);
  // „seit“ liegt in der Vergangenheit, damit das neue Konto sicher später angelegt gilt
  getDb().prepare("INSERT INTO app_einstellungen (key, value) VALUES ('standardprofil_seit', '2000-01-01 00:00:00')").run();
  const r = await form(admin, '/admin/funktionen', { profil: 'einfach' });
  assert.equal(r.status, 302);
  assert.equal(standardProfil().profil, 'einfach');
  // Bestehende Konten ohne Wahl (angelegt VOR dem Festlegen) behalten die Ansicht „alles“
  getDb().prepare("UPDATE users SET created_at = '1999-01-01 00:00:00' WHERE username = 'nina'").run();
  getDb().prepare('DELETE FROM user_funktionen').run();
  const alt = funktionenFuer({ id: uid('nina') });
  assert.equal(alt.gewaehlt, false); assert.equal(alt.sitzplan, true);
  // Ein neu angelegtes Konto startet mit dem Standardprofil, ohne die Auswahl-Frage
  await form(admin, '/admin/einladungen/neu', { display_name: 'paula', ttl_days: '14' });
  const inv = getDb().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
  const paula = client();
  await form(paula, `/einladung/${inv.token}`, { username: 'paula', display_name: 'paula', password: 'passwort1234', password2: 'passwort1234' });
  getDb().prepare("UPDATE users SET created_at = datetime('now', '+1 minute') WHERE username = 'paula'").run();
  const neu = funktionenFuer({ id: uid('paula') });
  assert.equal(neu.profil, 'einfach'); assert.equal(neu.vomAdmin, true); assert.equal(neu.gewaehlt, true);
  assert.equal(neu.sitzplan, false);
  const start = await text(paula('/start'));
  assert.doesNotMatch(start, /Wie möchtest du die Notenverwaltung nutzen/);
  assert.doesNotMatch(start, /href="\/teacher\/sitzplaene"/);
  // Eigene Wahl hat Vorrang
  await form(paula, '/konto/funktionen/profil', { profil: 'alles' });
  assert.equal(funktionenFuer({ id: uid('paula') }).sitzplan, true);
  // Zurücksetzen
  await form(admin, '/admin/funktionen', { profil: '' });
  assert.equal(standardProfil(), null);
  assert.equal(setzeStandardProfil('gibts-nicht'), false);
});

// ---------- API-Schlüssel verlängern ----------
async function schluessel(c, name, tage, scope = 'schreiben') {
  const r = await text(form(c, '/konto/api', { name, scope, gueltig_tage: String(tage) }));
  return /nk_[A-Za-z0-9_-]{20,}/.exec(r)[0];
}

test('Verlängern: Gültigkeit wird auf die eingestellte Dauer ab heute gesetzt – nur in der App, eigene Schlüssel, nicht kürzer', async () => {
  const key = await schluessel(olaf, 'Agent', 30);
  const id = getDb().prepare("SELECT id FROM api_keys WHERE name = 'Agent'").get().id;
  assert.equal(getDb().prepare('SELECT gueltig_tage FROM api_keys WHERE id = ?').get(id).gueltig_tage, 30);
  const jetzt = Date.now();
  // läuft in 3 Tagen ab
  getDb().prepare("UPDATE api_keys SET expires_at = datetime('now', '+3 days') WHERE id = ?").run(id);
  const seite = await text(olaf('/konto/api'));
  assert.match(seite, new RegExp(`action="/konto/api/${id}/verlaengern"`));
  assert.match(seite, /läuft bald ab/);
  const r = await form(olaf, `/konto/api/${id}/verlaengern`, {});
  assert.equal(r.status, 302);
  const neu = new Date(getDb().prepare('SELECT expires_at FROM api_keys WHERE id = ?').get(id).expires_at).getTime();
  assert.ok(Math.abs(neu - (jetzt + 30 * 86400000)) < 120000, 'ab heute 30 Tage');
  // nochmal sofort: nichts zu verlängern, Ablauf unverändert
  const nochmal = await form(olaf, `/konto/api/${id}/verlaengern`, {});
  assert.equal(nochmal.status, 302);
  assert.equal(new Date(getDb().prepare('SELECT expires_at FROM api_keys WHERE id = ?').get(id).expires_at).getTime(), neu);
  // abgelaufene Schlüssel lassen sich per Klick wieder verlängern (und funktionieren danach)
  getDb().prepare("UPDATE api_keys SET expires_at = datetime('now', '-2 days') WHERE id = ?").run(id);
  assert.equal((await fetch(`${base}/api/v1/me`, { headers: { authorization: `Bearer ${key}` } })).status, 401, 'abgelaufen');
  await form(olaf, `/konto/api/${id}/verlaengern`, {});
  assert.equal((await fetch(`${base}/api/v1/me`, { headers: { authorization: `Bearer ${key}` } })).status, 200, 'nach Verlängern wieder gültig');
});

test('Verlängern: fremde, widerrufene und gesperrte Schlüssel nicht; Schlüssel ohne gespeicherte Dauer (alt) bekommen sie aus dem Zeitraum', async () => {
  const id = getDb().prepare("SELECT id FROM api_keys WHERE name = 'Agent'").get().id;
  const vorher = getDb().prepare('SELECT expires_at FROM api_keys WHERE id = ?').get(id).expires_at;
  getDb().prepare("UPDATE api_keys SET expires_at = datetime('now', '+1 day') WHERE id = ?").run(id);
  await form(nina, `/konto/api/${id}/verlaengern`, {});
  assert.equal(getDb().prepare("SELECT expires_at FROM api_keys WHERE id = ? AND expires_at < datetime('now', '+2 days')").get(id) !== undefined, true, 'fremde Person kann nicht verlängern');
  getDb().prepare('UPDATE api_keys SET gesperrt_at = datetime(\'now\') WHERE id = ?').run(id);
  assert.equal(verlaengereSchluessel(id, uid('olaf')).ok, false);
  getDb().prepare('UPDATE api_keys SET gesperrt_at = NULL, revoked_at = datetime(\'now\') WHERE id = ?').run(id);
  assert.equal(verlaengereSchluessel(id, uid('olaf')).ok, false);
  assert.equal(verlaengereSchluessel(99999, uid('olaf')).ok, false);
  assert.equal(gueltigkeitInTagen({ gueltig_tage: null, created_at: '2026-01-01 00:00:00', expires_at: '2026-04-01T00:00:00.000Z' }), 90);
  assert.equal(gueltigkeitInTagen({ gueltig_tage: null, created_at: '2020-01-01 00:00:00', expires_at: '2030-01-01T00:00:00.000Z' }), 365, 'höchstens ein Jahr');
  assert.equal(gueltigkeitInTagen({ gueltig_tage: 30 }), 30);
  void vorher;
});

test('Die API kann Schlüssel NICHT verlängern: Bearer-Schlüssel erreichen /konto/api nicht, die OpenAPI hat keinen solchen Endpunkt', async () => {
  const key = await schluessel(nina, 'Schreibend', 30);
  const id = getDb().prepare("SELECT id FROM api_keys WHERE name = 'Schreibend'").get().id;
  getDb().prepare("UPDATE api_keys SET expires_at = datetime('now', '+2 days') WHERE id = ?").run(id);
  const vorher = getDb().prepare('SELECT expires_at FROM api_keys WHERE id = ?').get(id).expires_at;
  for (const [methode, url] of [['POST', `/konto/api/${id}/verlaengern`], ['POST', `/api/v1/konto/api/${id}/verlaengern`], ['PUT', `/api/v1/schluessel/${id}`], ['POST', `/api/v1/schluessel/${id}/verlaengern`]]) {
    const r = await fetch(base + url, { method: methode, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: '{}', redirect: 'manual' });
    assert.ok([302, 401, 403, 404, 405].includes(r.status), `${methode} ${url}: ${r.status}`);
    assert.notEqual(r.status, 200);
  }
  assert.equal(getDb().prepare('SELECT expires_at FROM api_keys WHERE id = ?').get(id).expires_at, vorher, 'Ablauf unverändert');
  const spec = await json(fetch(`${base}/api/v1/openapi.json`));
  assert.ok(!Object.keys(spec.paths).some((p) => /verl[aä]ng|api-?key|\/keys?\b|konto/i.test(p)), 'kein Schlüssel-Endpunkt in der API');
  const doku = fs.readFileSync(path.join(ROOT, 'docs/API.md'), 'utf8');
  assert.match(doku, /nur in der App.*nicht über die API/s);
});
