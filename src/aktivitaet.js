/**
 * ANONYME Nutzungsstatistik für die Administration (Admin → Aktivität).
 *
 * Datenschutz-Grundsätze:
 *  - Es wird KEIN Konto, kein Name und keine Konto-Nummer gespeichert. Pro Person gibt es nur ein `profil`: einen nicht
 *    umkehrbaren Wert (HMAC-SHA-256 mit einem Schlüssel aus der Umgebung, nicht aus der Datenbank). Er dient allein dazu,
 *    „an wie vielen verschiedenen Tagen war dieselbe Person aktiv?“ zu zählen, ohne zu wissen, wer es ist.
 *  - Je Profil wird nur der TAG festgehalten (nie die Uhrzeit). Tageszeiten stehen nur als Summe über alle Personen.
 *  - Die Auswertung zeigt ausschließlich Zahlen und Gruppen, keine Listen einzelner Personen.
 *  - Keine Adressen, keine Inhalte, keine Noten. Alles wird nach 400 Tagen gelöscht.
 * Gesammelt wird im Speicher, alle 30 Sekunden wird in einem Schwung geschrieben.
 *
 * TESTPHASE: Die Admin-Seite kann zusätzlich eine Liste der Konten mit Namen zeigen (`personenAnsichtAktiv()`, an solange die
 * Umgebungsvariable AKTIVITAET_PERSONEN nicht auf 0 steht). Gespeichert wird dafür NICHTS Neues: Die Zuordnung entsteht erst beim
 * Anzeigen, indem der Zählwert jedes aktiven Kontos mit dem Server-Schlüssel neu berechnet wird (nur Tage, nie Uhrzeiten je Person).
 * Zum Beenden der Testphase AKTIVITAET_PERSONEN=0 setzen (oder die Konstante unten ändern).
 */

import crypto from 'node:crypto';
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
/** Zuletzt aktiv vor … (Obergrenze in Tagen, einschließlich). */
export const ABSTAENDE = [
  { id: 'a7', titel: 'in den letzten 7 Tagen', bis: 7 },
  { id: 'a30', titel: 'vor 8–30 Tagen', bis: 30 },
  { id: 'a90', titel: 'vor 31–90 Tagen', bis: 90 },
  { id: 'a400', titel: 'vor mehr als 90 Tagen', bis: Infinity },
];
export const WOCHENTAGE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

/** Testphase: Personenansicht (Konten mit Namen) auf der Admin-Seite. Aus mit AKTIVITAET_PERSONEN=0. */
export function personenAnsichtAktiv() {
  return process.env.AKTIVITAET_PERSONEN !== '0';
}

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

// Schlüssel nur aus der Umgebung (nicht aus der Datenbank): Wer nur die Datenbank (oder eine Sicherung) sieht, kann ein Profil
// keinem Konto zuordnen. Ohne SECRET (nur Entwicklung) gilt ein Zufallswert je Prozessstart.
const SCHLUESSEL = crypto.createHash('sha256').update(`nutzung-v1|${process.env.SECRET || crypto.randomBytes(32).toString('hex')}`).digest();

/** Nicht umkehrbarer Zählwert je Person (kein Bezug zum Konto in der Datenbank). */
export function profilFuer(userId) {
  return crypto.createHmac('sha256', SCHLUESSEL).update(`profil:${userId}`).digest('hex').slice(0, 20);
}

const tageBuffer = new Map(); // "profil|tag" -> { profil, tag, anfragen, eingaben }
const stundenBuffer = new Map(); // "tag|stunde" -> { tag, stunde, anfragen, eingaben }
const stundenNutzer = new Map(); // "tag|stunde" -> Set(profil): verschiedene Personen in dieser Stunde (nur im Speicher)

/** Zählt eine Anfrage (im Speicher; `speichere()` schreibt sie in die Datenbank). */
export function erfasse(userId, { eingabe = false, jetzt = new Date() } = {}) {
  if (!userId) return;
  const { tag, stunde } = ortszeit(jetzt);
  const profil = profilFuer(userId);
  const e = eingabe ? 1 : 0;

  const tKey = `${profil}|${tag}`;
  const t = tageBuffer.get(tKey) || { profil, tag, anfragen: 0, eingaben: 0 };
  t.anfragen += 1; t.eingaben += e;
  tageBuffer.set(tKey, t);

  const sKey = `${tag}|${stunde}`;
  const s = stundenBuffer.get(sKey) || { tag, stunde, anfragen: 0, eingaben: 0 };
  s.anfragen += 1; s.eingaben += e;
  stundenBuffer.set(sKey, s);
  if (!stundenNutzer.has(sKey)) stundenNutzer.set(sKey, new Set());
  stundenNutzer.get(sKey).add(profil);
}

/** Schreibt die gesammelten Zähler in die Datenbank (addiert zu vorhandenen Zeilen). */
export function speichere() {
  speichereFunktionen();
  if (tageBuffer.size === 0 && stundenBuffer.size === 0) return;
  const tage = [...tageBuffer.values()];
  const stunden = [...stundenBuffer.values()].map((s) => ({ ...s, nutzer: stundenNutzer.get(`${s.tag}|${s.stunde}`)?.size || 0 }));
  tageBuffer.clear();
  stundenBuffer.clear();
  const jetzt = ortszeit();
  for (const key of stundenNutzer.keys()) { // Mengen vergangener Stunden werden nicht mehr gebraucht
    const [tag, stunde] = key.split('|');
    if (tag < jetzt.tag || (tag === jetzt.tag && Number(stunde) < jetzt.stunde)) stundenNutzer.delete(key);
  }
  const db = getDb();
  const tStmt = db.prepare(`
    INSERT INTO nutzung_tage (profil, tag, anfragen, eingaben) VALUES (?, ?, ?, ?)
    ON CONFLICT(profil, tag) DO UPDATE SET anfragen = anfragen + excluded.anfragen, eingaben = eingaben + excluded.eingaben
  `);
  const sStmt = db.prepare(`
    INSERT INTO nutzung_stunden (tag, stunde, anfragen, eingaben, nutzer) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(tag, stunde) DO UPDATE SET anfragen = anfragen + excluded.anfragen, eingaben = eingaben + excluded.eingaben,
      nutzer = MAX(nutzer, excluded.nutzer)
  `);
  try {
    db.transaction(() => {
      for (const t of tage) tStmt.run(t.profil, t.tag, t.anfragen, t.eingaben);
      for (const s of stunden) sStmt.run(s.tag, s.stunde, s.anfragen, s.eingaben, s.nutzer);
    })();
  } catch (err) {
    console.warn('[aktivitaet] Speichern fehlgeschlagen:', err.message);
  }
}

function speichereFunktionen() {
  if (funktionenBuffer.size === 0) return;
  const zeilen = [...funktionenBuffer.values()];
  funktionenBuffer.clear();
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO nutzung_funktionen (profil, tag, funktion, aufrufe) VALUES (?, ?, ?, ?)
    ON CONFLICT(profil, tag, funktion) DO UPDATE SET aufrufe = aufrufe + excluded.aufrufe
  `);
  try {
    db.transaction(() => { for (const z of zeilen) stmt.run(z.profil, z.tag, z.funktion, z.aufrufe); })();
  } catch (err) {
    console.warn('[aktivitaet] Funktionen speichern fehlgeschlagen:', err.message);
  }
}

/** Löscht Zähler, die älter als die Aufbewahrungsfrist sind. */
export function bereinige(jetzt = new Date()) {
  const grenze = tagPlus(ortszeit(jetzt).tag, -AUFBEWAHRUNG_TAGE);
  const db = getDb();
  db.prepare('DELETE FROM nutzung_tage WHERE tag < ?').run(grenze);
  db.prepare('DELETE FROM nutzung_stunden WHERE tag < ?').run(grenze);
  db.prepare('DELETE FROM nutzung_funktionen WHERE tag < ?').run(grenze);
}

// ---------- Funktionsnutzung ----------
/**
 * Welche Funktionen werden benutzt? Jede Anfrage wird anhand ihres Routenmusters („METHODE /teacher/fach/:id“) einer Funktion
 * zugeordnet. Gezählt wird – wie bei der übrigen Statistik – nur je anonymem Profil und TAG (nie Uhrzeit, keine Adressen, keine
 * Inhalte). Die Reihenfolge ist wichtig: das erste passende Muster gilt. `gruppe` ordnet die Zeilen auf der Admin-Seite.
 */
export const NUTZUNG_FUNKTIONEN = [
  { id: 'noteneingabe', gruppe: 'Kern', titel: 'Noteneingabe (Fächerliste)', re: /^GET \/teacher\/?$/ },
  { id: 'fach', gruppe: 'Kern', titel: 'Fachseite öffnen', re: /^GET \/teacher\/fach\/:id$/ },
  { id: 'klausur-anlegen', gruppe: 'Kern', titel: 'Klausur anlegen', re: /^POST \/teacher\/fach\/:id\/klausuren\/neu$/ },
  { id: 'punkte', gruppe: 'Kern', titel: 'Punkte und Noten eintragen', re: /^POST \/teacher\/(klausuren\/:id\/(punkte|extrapunkte)|uls\/:id\/punkte|unterricht\/termine\/:id\/note|fach\/:id\/(endnote|spa\/eingabe)|klassen\/:id\/endnote)$/ },
  { id: 'unterricht', gruppe: 'Kern', titel: 'Unterrichtsleistung (Datumstabelle, Zusatzleistung)', re: /^POST \/teacher\/(fach\/:id\/(uls\/neu|unterricht\/termine\/neu)|unterricht\/termine\/:id\/inhalt)$/ },
  { id: 'klassen', gruppe: 'Kern', titel: 'Meine Klassen', re: /^GET \/teacher\/klassen$/ },
  { id: 'klasse-anlegen', gruppe: 'Kern', titel: 'Klasse anlegen', re: /^POST \/teacher\/klassen\/neu$/ },
  { id: 'klasse', gruppe: 'Kern', titel: 'Klassenseite öffnen', re: /^GET \/teacher\/klassen\/:id$/ },
  { id: 'schueler', gruppe: 'Kern', titel: 'Schüler/innen anlegen oder ändern', re: /^POST \/teacher\/(klassen\/:id\/schueler\/.*|schueler\/:id\/(umbenennen|abgang|reaktivieren|versetzen|loeschen))$/ },
  { id: 'kurse', gruppe: 'Kern', titel: 'Kurse', re: /^(POST \/teacher\/(kurse\/.*|fach\/:id\/teilnehmer\/.*)|GET \/teacher\/fach\/:id\/teilnehmer.*)$/ },
  { id: 'sitzplan', gruppe: 'Funktion', titel: 'Sitzpläne', re: /^(GET|POST) \/teacher\/(klassen\/:id\/sitzplan.*|sitzplaene)$/ },
  { id: 'notenbesprechung', gruppe: 'Funktion', titel: 'Notenbesprechung', re: /^(GET|POST) \/teacher\/fach\/:id\/besprechung.*$/ },
  { id: 'statistik', gruppe: 'Funktion', titel: 'Klausur-Statistik eingeschaltet', re: /^POST \/funktion-genutzt$/ },
  { id: 'favoriten', gruppe: 'Funktion', titel: 'Favoriten (★)', re: /^POST \/teacher\/faecher\/:id\/favorit$/ },
  { id: 'fach-anlegen', gruppe: 'Kern', titel: 'Fach anlegen oder einstellen', re: /^(POST \/teacher\/(klassen\/:id\/faecher\/neu|faecher\/:id\/.*)|GET \/teacher\/faecher\/:id\/.*)$/ },
  { id: 'synchronisation', gruppe: 'Funktion', titel: 'Synchronisation mit der Klassenleitung', re: /^POST \/teacher\/fach\/:id\/(sync|auto-sync)$/ },
  { id: 'klassenleitung', gruppe: 'Funktion', titel: 'Klassenleitung (Konferenz, Zeugnisse, Fehlzeiten)', re: /^(GET|POST) \/(klassenlehrer.*|teacher\/klassen\/:id\/(konferenz.*|zeugnis.*|abschluss|uebersicht)|teacher\/schueler\/:id\/abgangszeugnis)$/ },
  { id: 'export', gruppe: 'Funktion', titel: 'CSV-Export', re: /^GET \/export\/.*$/ },
  { id: 'vorlagen', gruppe: 'Funktion', titel: 'Fächer-Vorlagen', re: /^(GET|POST) \/teacher\/(klassen\/:id\/(vorlagen|spa-vorlage)\/.*|vorlagen\/.*|spa-vorlagen.*)$/ },
  { id: 'papierkorb', gruppe: 'Funktion', titel: 'Papierkorb', re: /^(GET|POST) \/teacher\/papierkorb.*$/ },
  { id: 'einladungen', gruppe: 'Funktion', titel: 'Einladungen verschicken', re: /^(GET|POST) \/teacher\/einladungen.*$/ },
  { id: 'api', gruppe: 'Funktion', titel: 'API-Zugang (Schlüssel verwalten)', re: /^(GET|POST) \/konto\/api.*$/ },
  { id: 'funktionen', gruppe: 'Konto', titel: 'Meine Funktionen', re: /^(GET|POST) \/konto\/funktionen.*$/ },
  { id: 'suche', gruppe: 'Konto', titel: 'Suche „Was möchtest du tun?“', re: /^GET \/suche$/ },
  { id: 'hilfe', gruppe: 'Konto', titel: 'Hilfe', re: /^GET \/hilfe.*$/ },
  { id: 'feedback', gruppe: 'Konto', titel: 'Feedback geben', re: /^POST \/feedback$/ },
];

/** Ordnet eine Anfrage (Methode + Routenmuster) einer Funktion zu; null = zählt nicht als eigene Funktion. */
export function funktionFuerAnfrage(methode, muster) {
  const schluessel = `${String(methode).toUpperCase()} ${String(muster || '').replace(/(.)\/+$/, '$1')}`;
  for (const f of NUTZUNG_FUNKTIONEN) if (f.re.test(schluessel)) return f.id;
  return null;
}

const funktionenBuffer = new Map(); // "profil|tag|funktion" -> { profil, tag, funktion, aufrufe }

/** Zählt eine Nutzung einer Funktion (im Speicher; `speichere()` schreibt sie). */
export function erfasseFunktion(userId, funktion, { jetzt = new Date() } = {}) {
  if (!userId || !funktion) return;
  const { tag } = ortszeit(jetzt);
  const profil = profilFuer(userId);
  const key = `${profil}|${tag}|${funktion}`;
  const z = funktionenBuffer.get(key) || { profil, tag, funktion, aufrufe: 0 };
  z.aufrufe += 1;
  funktionenBuffer.set(key, z);
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

/** Eine Anmeldung zählt wie ein Seitenaufruf (es wird nichts am Konto vermerkt). */
export function registriereAnmeldung(userId, jetzt = new Date()) {
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
 * Auswertung für die Admin-Seite. `tage` = Zeitraum bis einschließlich heute. Das Ergebnis enthält nur Zahlen und Gruppen,
 * keine Einträge einzelner Personen. Grundgesamtheit: aktive Konten (nur die ANZAHL wird gelesen).
 */
export function auswertung(tage = 90, jetzt = new Date(), { personen: mitPersonen = personenAnsichtAktiv() } = {}) {
  speichere();
  const db = getDb();
  const heute = ortszeit(jetzt).tag;
  const von = tagPlus(heute, -(tage - 1));
  const seit = db.prepare('SELECT MIN(tag) AS t FROM nutzung_tage').get().t || null;

  const konten = db.prepare('SELECT COUNT(*) AS c FROM users WHERE active = 1').get().c;
  const proProfil = db.prepare(`
    SELECT profil, COUNT(DISTINCT tag) AS tage, SUM(anfragen) AS anfragen, SUM(eingaben) AS eingaben, MAX(tag) AS letzter_tag
    FROM nutzung_tage WHERE tag >= ? GROUP BY profil
  `).all(von);
  const aktive = proProfil.length;
  // Profile ehemaliger Konten bleiben bis zur Löschung nach 400 Tagen stehen -- die Grundgesamtheit darf nie kleiner sein als die Aktiven.
  const gesamt = Math.max(konten, aktive);

  const stufen = STUFEN.map((s) => ({ ...s, anzahl: 0 }));
  for (const p of proProfil) stufen.find((s) => s.id === stufeFuerTage(p.tage).id).anzahl += 1;
  stufen[0].anzahl = gesamt - aktive;
  for (const s of stufen) s.anteil = gesamt ? s.anzahl / gesamt : 0;

  // Zuletzt aktiv vor … (über alle gespeicherten Daten)
  const letzteTage = db.prepare('SELECT MAX(tag) AS t FROM nutzung_tage GROUP BY profil').all().map((r) => r.t);
  const abstaende = ABSTAENDE.map((x) => ({ ...x, anzahl: 0 }));
  for (const t of letzteTage) {
    const alter = Math.round((new Date(`${heute}T12:00:00Z`) - new Date(`${t}T12:00:00Z`)) / 86400000);
    abstaende.find((x) => alter <= x.bis).anzahl += 1;
  }
  const nieAktiv = Math.max(0, gesamt - letzteTage.length);
  const aktivSeit = (n) => Math.min(gesamt, db.prepare('SELECT COUNT(DISTINCT profil) AS c FROM nutzung_tage WHERE tag >= ?').get(tagPlus(heute, -(n - 1))).c);

  const ohneEingaben = proProfil.filter((p) => p.eingaben === 0).length;
  const wiederkehrend = proProfil.filter((p) => p.tage >= 2).length;

  // Verlauf: täglich bis 90 Tage, sonst Kalenderwochen (Montag).
  const woche = tage > 90;
  const bucketStart = (tag) => (woche ? tagPlus(tag, -wochentag(tag)) : tag);
  const buckets = new Map();
  for (let t = von; t <= heute; t = tagPlus(t, 1)) {
    const b = bucketStart(t);
    if (!buckets.has(b)) buckets.set(b, { start: b, nutzer: new Set(), anfragen: 0 });
  }
  for (const z of db.prepare('SELECT profil, tag, anfragen FROM nutzung_tage WHERE tag >= ?').all(von)) {
    const b = buckets.get(bucketStart(z.tag));
    if (b) { b.nutzer.add(z.profil); b.anfragen += z.anfragen; }
  }
  const verlauf = [...buckets.values()].map((b) => ({ start: b.start, nutzer: b.nutzer.size, anfragen: b.anfragen }));

  // Auslastung: Wochentag × Stunde (Summen über alle Personen).
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  let spitzeNutzer = { nutzer: 0, tag: null, stunde: null };
  let spitzeAnfragen = { anfragen: 0, tag: null, stunde: null };
  const tageMitNutzung = new Set();
  let summeAnfragen = 0;
  let summeEingaben = 0;
  for (const z of db.prepare('SELECT tag, stunde, anfragen, eingaben, nutzer FROM nutzung_stunden WHERE tag >= ?').all(von)) {
    heat[wochentag(z.tag)][z.stunde] += z.anfragen;
    tageMitNutzung.add(z.tag);
    summeAnfragen += z.anfragen;
    summeEingaben += z.eingaben;
    if (z.nutzer > spitzeNutzer.nutzer) spitzeNutzer = { nutzer: z.nutzer, tag: z.tag, stunde: z.stunde };
    if (z.anfragen > spitzeAnfragen.anfragen) spitzeAnfragen = { anfragen: z.anfragen, tag: z.tag, stunde: z.stunde };
  }

  // Testphase: Konten mit Namen. Die Zuordnung entsteht nur hier, durch Neuberechnen des Zählwerts je aktivem Konto.
  let personen = null;
  if (mitPersonen) {
    const nachProfil = new Map(proProfil.map((p) => [p.profil, p]));
    const letzterTagGesamt = new Map(db.prepare('SELECT profil, MAX(tag) AS t FROM nutzung_tage GROUP BY profil').all().map((r) => [r.profil, r.t]));
    personen = db.prepare(`
      SELECT id, username, display_name, role, auth_source, created_at,
             (SELECT COUNT(DISTINCT fach_id) FROM fach_zuweisungen z WHERE z.user_id = users.id) AS faecher
      FROM users WHERE active = 1
    `).all().map((k) => {
      const profil = profilFuer(k.id);
      const p = nachProfil.get(profil) || { tage: 0, anfragen: 0, eingaben: 0 };
      const letzterTag = letzterTagGesamt.get(profil) || null;
      return {
        id: k.id, name: k.display_name || k.username, username: k.username, rolle: k.role, quelle: k.auth_source,
        angelegt: k.created_at ? k.created_at.slice(0, 10) : null, faecher: k.faecher,
        tage: p.tage, anfragen: p.anfragen, eingaben: p.eingaben, letzterTag,
        tageSeitLetzterAktivitaet: letzterTag ? Math.round((new Date(`${heute}T12:00:00Z`) - new Date(`${letzterTag}T12:00:00Z`)) / 86400000) : null,
        stufe: stufeFuerTage(p.tage).id,
      };
    }).sort((a, b) => (b.tage - a.tage) || (b.anfragen - a.anfragen) || a.name.localeCompare(b.name, 'de'));
  }

  // Funktionen: je Funktion Aufrufe, verschiedene Personen und Tage im Zeitraum (nur Zahlen, keine Einzelpersonen).
  const nutzungF = new Map(db.prepare(`
    SELECT funktion, SUM(aufrufe) AS aufrufe, COUNT(DISTINCT profil) AS personen, COUNT(DISTINCT tag) AS tage
    FROM nutzung_funktionen WHERE tag >= ? GROUP BY funktion
  `).all(von).map((r) => [r.funktion, r]));
  const funktionen = NUTZUNG_FUNKTIONEN.map((f) => {
    const r = nutzungF.get(f.id) || { aufrufe: 0, personen: 0, tage: 0 };
    return { id: f.id, titel: f.titel, gruppe: f.gruppe, aufrufe: r.aufrufe, personen: r.personen, tage: r.tage, anteil: aktive ? r.personen / aktive : 0 };
  });

  return {
    funktionen, personen, tage, von, bis: heute, seit, erfassungKuerzer: Boolean(seit && seit > von),
    konten: gesamt, aktiveImZeitraum: aktive, kleineGruppe: gesamt < 10,
    aktiv7: aktivSeit(7), aktiv30: aktivSeit(30), nieAktiv,
    ohneEingaben, wiederkehrend, wiederkehrQuote: aktive ? wiederkehrend / aktive : 0,
    medianTage: median([...proProfil.map((p) => p.tage), ...Array(gesamt - aktive).fill(0)]),
    summeAnfragen, summeEingaben, aktiveTage: tageMitNutzung.size,
    anfragenProAktivemTag: tageMitNutzung.size ? Math.round(summeAnfragen / tageMitNutzung.size) : 0,
    spitzeNutzer, spitzeAnfragen,
    stufen, abstaende, verlauf, woche, heat, heatMax: Math.max(1, ...heat.flat()),
  };
}
