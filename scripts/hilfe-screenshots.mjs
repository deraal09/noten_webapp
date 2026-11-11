/**
 * Erzeugt die Screenshots der Hilfe (static/hilfe/*.jpg) aus einer Demo-Datenbank mit erfundenen Namen.
 *
 *   node scripts/hilfe-screenshots.mjs
 *
 * Voraussetzung: Playwright mit Chromium (PLAYWRIGHT_PATH = Pfad zu playwright/index.mjs, CHROMIUM_PATH = Chromium-Programm; ohne Angabe
 * werden das Paket „playwright“ und dessen Browser verwendet). Läuft mit NODE_ENV=test: Das Datum ist festgelegt (1. Oktober 2025,
 * Schuljahr 2025/26), damit die Bilder reproduzierbar sind. Die Datenbank liegt in einem temporären Ordner und wird nicht gespeichert.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'static', 'hilfe');
fs.mkdirSync(OUT, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hilfe-'));
process.env.DB_PFAD = path.join(tmp, 'demo.sqlite3');
process.env.SECRET = 'hilfe-screenshots-geheimnis-nur-fuer-die-demo-xxxxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import(path.join(ROOT, 'app.js'));
const { getDb } = await import(path.join(ROOT, 'src/db.js'));
const pw = await import(process.env.PLAYWRIGHT_PATH || 'playwright');
const chromium = pw.chromium || pw.default?.chromium;

const app = await buildApp({ logger: false });
const base = await app.listen({ port: 0, host: '127.0.0.1' });
const db = getDb();

// ---------- Hilfsfunktionen (HTTP wie ein Browser) ----------
function client() {
  const cookies = new Map();
  const req = async (url, body, liste) => {
    const headers = {};
    if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const opts = { headers, redirect: 'manual' };
    if (body || liste) {
      opts.method = 'POST';
      headers['content-type'] = 'application/x-www-form-urlencoded';
      const p = new URLSearchParams(body || {});
      for (const [k, v] of liste || []) p.append(k, v);
      opts.body = p;
    }
    const r = await fetch(base + url, opts);
    for (const raw of r.headers.getSetCookie?.() ?? []) { const [k, ...v] = raw.split(';')[0].split('='); cookies.set(k.trim(), v.join('=').trim()); }
    return r;
  };
  req.cookies = cookies;
  return req;
}
const upload = async (c, url, inhalt) => {
  const fd = new FormData();
  fd.append('datei', new Blob([inhalt], { type: 'text/csv' }), 'liste.csv');
  const headers = { cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
  return fetch(base + url, { method: 'POST', body: fd, headers, redirect: 'manual' });
};
const admin = client();
const anna = client();
const max = client();

// ---------- Demo-Daten ----------
await admin('/setup', { username: 'admin', display_name: 'Admin Demo', password: 'demo-passwort-123', password2: 'demo-passwort-123' });
await admin('/admin/schuljahre/neu', { bezeichnung: '2025/26' });
await admin('/admin/schuljahre/neu', { bezeichnung: '2024/25' });
const sj = db.prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2025/26'").get().id;
for (const [c, user, name] of [[anna, 'abeispiel', 'Anna Beispiel'], [max, 'mmuster', 'Max Muster']]) {
  await admin('/admin/einladungen/neu', { display_name: name, ttl_days: '14' });
  const inv = db.prepare('SELECT token FROM invitations ORDER BY id DESC').get();
  await c(`/einladung/${inv.token}`, { username: user, display_name: name, password: 'demo-passwort-123', password2: 'demo-passwort-123' });
}
db.prepare("UPDATE users SET auth_source = 'ldap'").run();
const uid = (n) => db.prepare('SELECT id FROM users WHERE username = ?').get(n).id;

await anna('/teacher/klassen/neu', { schuljahr_id: String(sj), name: '12BFI1', notenschluessel: 'BG', einschulung_jahr: '2025' });
const klasse = db.prepare("SELECT id FROM klassen WHERE name = '12BFI1'").get().id;
for (const f of ['Englisch', 'Mathematik', 'Politik']) await anna(`/teacher/klassen/${klasse}/faecher/neu`, { name: f });
await anna(`/teacher/klassen/${klasse}/klassenlehrer/eintragen`, {}); // braucht ein eigenes Fach in der Klasse
const fachId = (n) => db.prepare('SELECT id FROM faecher WHERE klasse_id = ? AND name = ?').get(klasse, n).id;
const eng = fachId('Englisch');
db.prepare('UPDATE fach_zuweisungen SET user_id = ? WHERE fach_id = ?').run(uid('mmuster'), fachId('Mathematik'));
const namen = [['Adler', 'Anna'], ['Berger', 'Ben'], ['Claus', 'Carla'], ['Dietz', 'David'], ['Engel', 'Emma'], ['Fuchs', 'Finn'], ['Gruber', 'Greta'], ['Hahn', 'Hannes']];
for (const [n, v] of namen) await anna(`/teacher/klassen/${klasse}/schueler/neu`, { nachname: n, vorname: v });
const schueler = db.prepare('SELECT id, nachname FROM schueler WHERE klasse_id = ? ORDER BY nachname').all(klasse);

// Klausur 1 (einteilig) und Klausur 2 (Hörverstehen + Textaufgabe)
const HJ = '1. Halbjahr';
const klausur = async (name, aufgaben, maxArr) => {
  await anna(`/teacher/fach/${eng}/klausuren/neu`, { name, aufgaben: String(aufgaben), halbjahr: HJ });
  const id = db.prepare('SELECT id FROM klausuren WHERE fach_id = ? AND name = ?').get(eng, name).id;
  await anna(`/teacher/klausuren/${id}/maxpunkte`, { anzahl_aufgaben: String(aufgaben), ...Object.fromEntries(maxArr.map((m, i) => [`mp_${i}`, String(m)])), halbjahr: HJ });
  return id;
};
const k1 = await klausur('Klausur 1', 3, [10, 10, 5]);
const punkte1 = [[10, 9, 5], [8, 7, 4], [6, 6, 3], [9, 8, 4], [5, 4, 2], [10, 10, 5], [7, 6, 3], [4, 5, 1]];
for (let i = 0; i < schueler.length; i++) for (let j = 0; j < 3; j++) await anna(`/teacher/klausuren/${k1}/punkte`, { schueler_id: String(schueler[i].id), aufgabe_idx: String(j), wert: String(punkte1[i][j]) });
const k2 = await klausur('Klausur 2 (Hörverstehen und Text)', 3, [15, 15, 15]);
await anna(`/teacher/klausuren/${k2}/teile`, null, [
  ['teil_name', 'Hörverstehen'], ['teil_art', 'hoeren'], ['teil_aufgaben', '1'], ['teil_anteil', '50'], ['teil_gewichtung', '40'],
  ['teil_name', 'Textaufgabe'], ['teil_art', 'inhalt_sprache'], ['teil_aufgaben', '2'], ['teil_anteil', '50'], ['teil_gewichtung', '60'], ['bestimmend', ''],
]);
const punkte2 = [[13, 12, 11], [10, 9, 8], [8, 8, 7], [12, 11, 12], [6, 6, 5], [14, 13, 14], [9, 10, 9], [5, 4, 5]];
for (let i = 0; i < schueler.length; i++) for (let j = 0; j < 3; j++) await anna(`/teacher/klausuren/${k2}/punkte`, { schueler_id: String(schueler[i].id), aufgabe_idx: String(j), wert: String(punkte2[i][j]) });

// Unterrichtsleistung: Datumstabelle und Referat
for (const d of ['2025-09-02', '2025-09-09', '2025-09-16', '2025-09-23']) await anna(`/teacher/fach/${eng}/unterricht/termine/neu`, { datum: d, halbjahr: HJ });
const termine = db.prepare('SELECT id FROM unterricht_termine WHERE fach_id = ? ORDER BY datum').all(eng);
const dn = [[12, 11, 13, 12], [9, 8, 10, 9], [7, 'n.a.', 8, 7], [11, 12, 11, 12], [6, 5, 6, 7], [14, 13, 14, 13], [8, 9, 8, 'n.a.'], [5, 6, 5, 6]];
for (let i = 0; i < schueler.length; i++) for (let t = 0; t < termine.length; t++) await anna(`/teacher/unterricht/termine/${termine[t].id}/note`, { schueler_id: String(schueler[i].id), wert: String(dn[i][t]) });
await anna(`/teacher/unterricht/termine/${termine[0].id}/inhalt`, { inhalt: 'Present perfect, Hörverstehen üben' });
await anna(`/teacher/fach/${eng}/auto-sync`, { aktiv: '1', halbjahr: HJ });

// Kurs mit Teilnehmerliste (CSV)
await anna('/teacher/kurse/neu', { schuljahr_id: String(sj), name: 'Philosophie AG', notenschluessel: 'BG' });
const kurs = db.prepare('SELECT id FROM faecher WHERE ist_kurs = 1').get().id;
await upload(anna, `/teacher/fach/${kurs}/teilnehmer/csv`, 'Nachname;Vorname;Klasse\nAdler;Anna;12BFI1\nBerger;Ben;12BFI1\nKern;Karla;12BFI2\nLang;Lukas;12BFI2\nMaurer;Mia;12BFI3\n');

// Eine Klasse aus dem Vorjahr: dann erscheint in der Noteneingabe die Schuljahr-Auswahl
const sjVorjahr = db.prepare("SELECT id FROM schuljahre WHERE bezeichnung = '2024/25'").get().id;
await anna('/teacher/klassen/neu', { schuljahr_id: String(sjVorjahr), name: '13BFI2', notenschluessel: 'BG', einschulung_jahr: '2024' });
await anna(`/teacher/klassen/${db.prepare("SELECT id FROM klassen WHERE name = '13BFI2'").get().id}/faecher/neu`, { name: 'Deutsch' });

// Eine gelöschte Klasse für den Papierkorb
await anna('/teacher/klassen/neu', { schuljahr_id: String(sj), name: '11X', notenschluessel: 'IHK', einschulung_jahr: '2025' });
await anna(`/teacher/klassen/${db.prepare("SELECT id FROM klassen WHERE name = '11X'").get().id}/loeschen`, {});

// SPA-Klasse
await admin('/teacher/klassen/neu', { schuljahr_id: String(sj), name: '13SPA1', notenschluessel: 'SPA', spa_bildungsgang: 'SPA_PIA', einschulung_jahr: '2025' });

// API-Schlüssel
await anna('/konto/api', { name: 'Notenassistent (KI)', scope: 'lesen', gueltig_tage: '90' });

// ---------- Aufnahmen ----------
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const kontexte = new Map();
const kontext = async (c) => {
  if (kontexte.has(c)) return kontexte.get(c);
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 1, locale: 'de-DE' });
  await ctx.addCookies([...c.cookies].map(([name, value]) => ({ name, value, url: base })));
  kontexte.set(c, ctx);
  return ctx;
};
const anonym = await browser.newContext({ viewport: { width: 1100, height: 760 }, locale: 'de-DE' });

const MARKE = 'outline: 3px solid #e53935 !important; outline-offset: 3px; border-radius: 4px;';
async function aufnahme({ datei, url, user = anna, klick = [], klickJs = [], markiere = [], ausschnitt = null, hoehe = null, warte = 150, vorher = null }) {
  const ctx = user === 'anonym' ? anonym : await kontext(user);
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.setItem('noteneingabe-reiter-1', 'panel-uebersicht'); } catch { /* egal */ } });
  await page.goto(base + url);
  for (const sel of klick) { await page.click(sel); await page.waitForTimeout(120); }
  // Reiter im Menü „Mehr“ sind nicht sichtbar -- per Skript umschalten, wie es die Seite selbst tut
  for (const sel of klickJs) { await page.evaluate((x) => document.querySelector(x)?.click(), sel); await page.waitForTimeout(150); }
  if (vorher) await vorher(page);
  if (markiere.length) {
    await page.addStyleTag({ content: markiere.map((s) => `${s} { ${MARKE} }`).join('\n') });
  }
  await page.waitForTimeout(warte);
  const opts = { path: path.join(OUT, `${datei}.jpg`), type: 'jpeg', quality: 72 };
  if (ausschnitt) {
    const el = page.locator(ausschnitt).first();
    await el.scrollIntoViewIfNeeded();
    const box = await el.boundingBox();
    if (box) { opts.clip = { x: Math.max(0, box.x - 12), y: Math.max(0, box.y - 12), width: Math.min(1100, box.width + 24), height: Math.min(hoehe || 900, box.height + 24) }; opts.fullPage = true; }
  } else if (hoehe) {
    opts.clip = { x: 0, y: 0, width: 1100, height: hoehe };
  }
  await page.screenshot(opts);
  await page.close();
  console.log('✓', datei);
}

const L = (n) => `/teacher/klassen/${klasse}${n || ''}`;
const aufnahmen = [
  { datei: 'login', url: '/login', user: 'anonym', hoehe: 560 },
  { datei: 'start', url: '/start', hoehe: 520 },
  { datei: 'klassen-liste', url: '/teacher/klassen', hoehe: 760, markiere: ['a[href="/teacher/papierkorb"]'] },
  { datei: 'klasse-anlegen', url: '/teacher/klassen', klick: ['button[data-target="panel-klasse-anlegen"]'], hoehe: 820 },
  { datei: 'klasse-detail', url: L(), hoehe: 760, markiere: ['details.umbenennen summary'] },
  { datei: 'schueler-csv', url: L(), klick: ['button[data-target="schueler-csv"]'], ausschnitt: '#schueler-csv', warte: 200 },
  { datei: 'faecher-lehrkraefte', url: L('#faecher-lehrkraefte'), ausschnitt: '#faecher-lehrkraefte' },
  { datei: 'kurs-teilnehmer', url: `/teacher/fach/${kurs}/teilnehmer`, hoehe: 900, markiere: ['#teilnehmer-csv'] },
  { datei: 'papierkorb', url: '/teacher/papierkorb', hoehe: 460 },
  { datei: 'noteneingabe', url: '/teacher', hoehe: 700, markiere: ['#schuljahrfilter'] },
  { datei: 'fach-uebersicht', url: `/teacher/fach/${eng}?hj=${encodeURIComponent(HJ)}`, hoehe: 800, markiere: ['#gesamt-runden', '.hj-tabs'] },
  { datei: 'klausur-eintragen', url: `/teacher/fach/${eng}?hj=${encodeURIComponent(HJ)}&tab=klausuren`, klickJs: ['button[data-target="panel-klausuren"]'], hoehe: 1000, markiere: ['.maxpunkte-zeile'] },
  { datei: 'klausur-teile', url: `/teacher/fach/${eng}?hj=${encodeURIComponent(HJ)}&tab=klausuren&open=klausur-panel-${k2}`, klickJs: ['button[data-target="panel-klausuren"]', `button[data-target="klausur-panel-${k2}"]`], ausschnitt: `#klausur-panel-${k2}`, hoehe: 1100, markiere: ['select[name=teil_art]'] },
  { datei: 'datumstabelle', url: `/teacher/fach/${eng}?hj=${encodeURIComponent(HJ)}`, klickJs: ['button[data-target="panel-uls"]'], hoehe: 820, markiere: ['#datumstabelle'] },
  { datei: 'notenschluessel', url: '/notenschluessel', klick: ['#ns-SPA summary'], hoehe: 900 },
  { datei: 'besprechung', url: `/teacher/fach/${eng}/besprechung/${schueler[0].id}?hj=${encodeURIComponent(HJ)}`, hoehe: 900 },
  { datei: 'klassenleitung', url: `/klassenlehrer/klasse/${klasse}`, hoehe: 760 },
  { datei: 'api-zugang', url: '/konto/api', hoehe: 900 },
  { datei: 'api-docs', url: '/api/v1/docs', hoehe: 820 },
  { datei: 'hilfe', url: '/hilfe', hoehe: 760 },
  { datei: 'admin', url: '/admin', user: admin, hoehe: 760 },
  { datei: 'admin-notenschluessel', url: '/admin/notenschluessel', user: admin, klick: ['#ns-IHK summary'], hoehe: 760 },
];
const nur = process.argv.slice(2);
for (const a of aufnahmen) {
  if (nur.length && !nur.includes(a.datei)) continue;
  try { await aufnahme(a); } catch (e) { console.error('✗', a.datei, e.message.split('\n')[0]); }
}
await browser.close();
await app.close();
process.exit(0);
