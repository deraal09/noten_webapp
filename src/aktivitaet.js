/**
 * Nutzungsstatistik für die Administration (Admin → Aktivität).
 *
 * Erfasst wird NUR ein Zähler je Person, Tag und Stunde (Ortszeit Europe/Berlin): wie viele Seitenaufrufe/API-Anfragen
 * es waren und wie viele davon etwas geändert haben (POST/PUT/PATCH/DELETE). Keine Adressen, keine Inhalte, keine Noten.
 * Die Zähler werden im Speicher gesammelt und alle 30 Sekunden in einem Schwung in die Datenbank geschrieben
 * (Noteneingabe speichert viele kleine Anfragen); Daten älter als 400 Tage werden gelöscht.
 */

import { getDb } from './db.js';

export const AUFBEWAHRUNG_TAGE = 400;
export const ZEITRAEUME = [30, 90, 365];
/** Einteilung nach aktiven Tagen im gewählten Zeitraum (untere Grenze je Stufe). */
export const STUFEN = [
  { id: 'keine', titel: 'Keine Aktivität', min: 0, text: 'im Zeitraum kein einziger Besuch' },
  { id: 'einmalig', titel: 'Einmal reingeschaut', min: 1, text: 'an genau 1 Tag aktiv' },
  { id: 'wenig', titel: 'Wenig aktiv', min: 2, text: 'an 2–4 Tagen aktiv' },
  { id: 'regelmaessig', titel: 'Regelmäßig', min: 5, text: 'an 5–19 Tagen aktiv' },
  { id: 'intensiv', titel: 'Intensiv', min: 20, text: 'an mindestens 20 Tagen aktiv' },
];
export const WOCHENTAGE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

const FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
});

/** Ortszeit als { tag: 'YYYY-MM-DD', stunde: 0–23 }. */
export function ortszeit(datum = new Date()) {
  const t = Object.fromEntries(FORMAT.formatToParts(datum).map((p) => [p.type, p.value]));
  return { tag: `${t.year}-${t.month}-${t.day}`, stunde: parseInt(t.hour, 10) % 24 };
}

/** Kalendertag um n Tage verschieben (n darf negativ sein). */
export function tagPlus(tag, n) {
  const d = new Date(`${tag}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Wochentag 0 = Montag … 6 = Sonntag für einen Kalendertag. */
export function wochentag(tag) {
  return (new Date(`${tag}T12:00:00Z`).getUTCDay() + 6) % 7;
}

const puffer = new Map(); // "userId|tag|stunde" -> { userId, tag, stunde, anfragen, eingaben }

/** Zählt eine Anfrage der Person (im Speicher; `speichere()` schreibt sie in die Datenbank). */
export function erfasse(userId, { eingabe = false, jetzt = new Date() } = {}) {
  if (!userId) return;
  const { tag, stunde } = ortszeit(jetzt);
  const key = `${userId}|${tag}|${stunde}`;
  let e = puffer.get(key);
  if (!e) { e = { userId, tag, stunde, anfragen: 0, eingaben: 0 }; puffer.set(key, e); }
  e.anfragen += 1;
  if (eingabe) e.eingaben += 1;
}

/** Schreibt die gesammelten Zähler in die Datenbank (addiert zu vorhandenen Zeilen). */
export function speichere() {
  if (puffer.size === 0) return;
  const eintraege = [...puffer.values()];
  puffer.clear();
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO nutzer_aktivitaet (user_id, tag, stunde, anfragen, eingaben) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, tag, stunde) DO UPDATE SET anfragen = anfragen + excluded.anfragen, eingaben = eingaben + excluded.eingaben
  `);
  try {
    db.transaction(() => {
      for (const e of eintraege) {
        // Konto zwischenzeitlich gelöscht? Dann keinen Fremdschlüsselfehler riskieren.
        if (db.prepare('SELECT 1 FROM users WHERE id = ?').get(e.userId)) stmt.run(e.userId, e.tag, e.stunde, e.anfragen, e.eingaben);
      }
    })();
  } catch (err) {
    console.warn('[aktivitaet] Speichern fehlgeschlagen:', err.message);
  }
}

/** Löscht Zähler, die älter als die Aufbewahrungsfrist sind. */
export function bereinige(jetzt = new Date()) {
  const grenze = tagPlus(ortszeit(jetzt).tag, -AUFBEWAHRUNG_TAGE);
  getDb().prepare('DELETE FROM nutzer_aktivitaet WHERE tag < ?').run(grenze);
}

let timer = null;
let letzteBereinigung = '';
/** Startet das regelmäßige Speichern (hält den Prozess nicht am Leben). */
export function starteTimer() {
  if (timer) return;
  timer = setInterval(() => {
    speichere();
    const heute = ortszeit().tag;
    if (heute !== letzteBereinigung) { letzteBereinigung = heute; try { bereinige(); } catch { /* egal */ } }
  }, 30_000);
  timer.unref?.();
}
export function stoppeTimer() {
  if (timer) clearInterval(timer);
  timer = null;
  speichere();
}

/** Trägt eine Anmeldung ein (Zeitpunkt und Zähler am Konto). */
export function registriereAnmeldung(userId, jetzt = new Date()) {
  getDb().prepare('UPDATE users SET letzter_login = ?, anmeldungen = anmeldungen + 1 WHERE id = ?').run(jetzt.toISOString(), userId);
  erfasse(userId, { jetzt });
}

export function stufeFuerTage(tage) {
  let stufe = STUFEN[0];
  for (const s of STUFEN) if (tage >= s.min) stufe = s;
  return stufe;
}

function median(werte) {
  if (!werte.length) return 0;
  const s = [...werte].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Auswertung für die Admin-Seite. `tage` = Zeitraum bis einschließlich heute.
 * Zählt nur aktive Konten (deaktivierte Konten gehören nicht zur Grundgesamtheit).
 */
export function auswertung(tage = 90, jetzt = new Date()) {
  speichere();
  const db = getDb();
  const heute = ortszeit(jetzt).tag;
  const von = tagPlus(heute, -(tage - 1));
  const seit = db.prepare('SELECT MIN(tag) AS t FROM nutzer_aktivitaet').get().t || null;

  const konten = db.prepare(`
    SELECT id, username, display_name, role, auth_source, created_at, letzter_login, anmeldungen,
           (SELECT COUNT(DISTINCT fach_id) FROM fach_zuweisungen z WHERE z.user_id = users.id) AS faecher
    FROM users WHERE active = 1
  `).all();
  const proPerson = new Map(db.prepare(`
    SELECT user_id, COUNT(DISTINCT tag) AS tage, SUM(anfragen) AS anfragen, SUM(eingaben) AS eingaben, MAX(tag) AS letzter_tag
    FROM nutzer_aktivitaet WHERE tag >= ? GROUP BY user_id
  `).all(von).map((r) => [r.user_id, r]));
  const letzterTagGesamt = new Map(db.prepare('SELECT user_id, MAX(tag) AS t FROM nutzer_aktivitaet GROUP BY user_id').all().map((r) => [r.user_id, r.t]));

  const personen = konten.map((k) => {
    const p = proPerson.get(k.id) || { tage: 0, anfragen: 0, eingaben: 0, letzter_tag: null };
    const letzterTag = letzterTagGesamt.get(k.id) || (k.letzter_login ? ortszeit(new Date(k.letzter_login)).tag : null);
    return {
      id: k.id, name: k.display_name || k.username, username: k.username, rolle: k.role, quelle: k.auth_source,
      angelegt: k.created_at ? k.created_at.slice(0, 10) : null, anmeldungen: k.anmeldungen || 0, faecher: k.faecher,
      tage: p.tage, anfragen: p.anfragen, eingaben: p.eingaben, letzterTag,
      tageSeitLetzterAktivitaet: letzterTag ? Math.round((new Date(`${heute}T12:00:00Z`) - new Date(`${letzterTag}T12:00:00Z`)) / 86400000) : null,
      stufe: stufeFuerTage(p.tage).id,
    };
  }).sort((a, b) => (b.tage - a.tage) || (b.anfragen - a.anfragen) || a.name.localeCompare(b.name, 'de'));

  const stufen = STUFEN.map((s) => {
    const n = personen.filter((p) => p.stufe === s.id).length;
    return { ...s, anzahl: n, anteil: personen.length ? n / personen.length : 0 };
  });

  const aktive = personen.filter((p) => p.tage > 0);
  const ohneEingaben = aktive.filter((p) => p.eingaben === 0).length;
  const wiederkehrend = aktive.filter((p) => p.tage >= 2).length;
  const aktivSeit = (n) => {
    const ab = tagPlus(heute, -(n - 1));
    return personen.filter((p) => p.letzterTag && p.letzterTag >= ab).length;
  };

  // Verlauf: täglich bis 90 Tage, sonst Kalenderwochen (Montag).
  const zeilen = db.prepare('SELECT user_id, tag, SUM(anfragen) AS anfragen FROM nutzer_aktivitaet WHERE tag >= ? GROUP BY user_id, tag').all(von);
  const woche = tage > 90;
  const bucketStart = (tag) => (woche ? tagPlus(tag, -wochentag(tag)) : tag);
  const buckets = new Map();
  for (let t = von; t <= heute; t = tagPlus(t, 1)) {
    const b = bucketStart(t);
    if (!buckets.has(b)) buckets.set(b, { start: b, nutzer: new Set(), anfragen: 0 });
  }
  for (const z of zeilen) {
    const b = buckets.get(bucketStart(z.tag));
    if (b) { b.nutzer.add(z.user_id); b.anfragen += z.anfragen; }
  }
  const verlauf = [...buckets.values()].map((b) => ({ start: b.start, nutzer: b.nutzer.size, anfragen: b.anfragen }));

  // Auslastung: Wochentag × Stunde.
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  const stundenZeilen = db.prepare(`
    SELECT tag, stunde, SUM(anfragen) AS anfragen, COUNT(DISTINCT user_id) AS nutzer
    FROM nutzer_aktivitaet WHERE tag >= ? GROUP BY tag, stunde
  `).all(von);
  let spitzeNutzer = { nutzer: 0, tag: null, stunde: null };
  let spitzeAnfragen = { anfragen: 0, tag: null, stunde: null };
  const tageMitAktivitaet = new Set();
  let summeAnfragen = 0;
  let summeEingaben = 0;
  for (const z of stundenZeilen) {
    heat[wochentag(z.tag)][z.stunde] += z.anfragen;
    tageMitAktivitaet.add(z.tag);
    summeAnfragen += z.anfragen;
    if (z.nutzer > spitzeNutzer.nutzer) spitzeNutzer = { nutzer: z.nutzer, tag: z.tag, stunde: z.stunde };
    if (z.anfragen > spitzeAnfragen.anfragen) spitzeAnfragen = { anfragen: z.anfragen, tag: z.tag, stunde: z.stunde };
  }
  summeEingaben = db.prepare('SELECT COALESCE(SUM(eingaben), 0) AS e FROM nutzer_aktivitaet WHERE tag >= ?').get(von).e;
  const heatMax = Math.max(1, ...heat.flat());
  const proStunde = Array(24).fill(0);
  const proWochentag = Array(7).fill(0);
  heat.forEach((zeile, w) => zeile.forEach((v, h) => { proStunde[h] += v; proWochentag[w] += v; }));

  return {
    tage, von, bis: heute, seit, erfassungKuerzer: Boolean(seit && seit > von),
    konten: personen.length, aktiveImZeitraum: aktive.length,
    aktiv7: aktivSeit(7), aktiv30: aktivSeit(30),
    nieAktiv: personen.filter((p) => !p.letzterTag).length,
    ohneEingaben, wiederkehrend, wiederkehrQuote: aktive.length ? wiederkehrend / aktive.length : 0,
    medianTage: median(personen.map((p) => p.tage)),
    summeAnfragen, summeEingaben, aktiveTage: tageMitAktivitaet.size,
    anfragenProAktivemTag: tageMitAktivitaet.size ? Math.round(summeAnfragen / tageMitAktivitaet.size) : 0,
    spitzeNutzer, spitzeAnfragen,
    stufen, personen, verlauf, woche, heat, heatMax, proStunde, proWochentag,
  };
}
