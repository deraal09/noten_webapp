/**
 * Übergeordnete Notenschlüssel (IHK, BG): Der Admin pflegt sie zentral (Admin → Notenschlüssel), alle Klassen, die
 * keinen eigenen Schlüssel haben, folgen ihnen. Es gibt drei: IHK (Noten 1-6), BG (Punkte 0-15) und SPA. Ändert der Admin einen Schlüssel, bekommen alle Lehrkräfte, die ihn nutzen,
 * einmalig einen Hinweis. Ansehen (ohne ändern) können ihn alle angemeldeten Personen (/notenschluessel).
 *
 * Klassen mit eigener CSV-Definition (Admin → Klasse → Notenschlüssel, abweichend von Vorgabe und übergeordnetem
 * Schlüssel) behalten diese (neu einstellen lässt sich das nicht mehr, nur auf den übergeordneten Schlüssel zurücksetzen).
 * SPA-Klassen bewerten Klausuren und Unterrichtsleistung mit dem SPA-Schlüssel: Prozent -> Note 1-6 (Vorgabe wie IHK),
 * daraus werden Leistungspunkte (0-15) und Tendenznote abgeleitet (src/spa-leistung.js).
 */

import { getDb } from './db.js';
import { DEFAULT_NS_CSV, nsCsvParse } from './grade-calc.js';
import { ladeMeineKlassen } from './auth.js';
import { klassenLaufzeit, halbjahrNr } from './klassen-jahre.js';

export const TYPEN = ['IHK', 'BG', 'SPA'];
export const BEREICH = { IHK: [1, 6], BG: [0, 15], SPA: [1, 6] };
export const MAX_HINWEIS = 200;

/** Schlüsseltyp, dessen Tabelle eine Klasse verwendet. */
export const schluesselTypVon = (notenschluessel) => notenschluessel;

/** Eingebaute Vorgabe eines Schlüssels (SPA startet mit den Werten des IHK-Schlüssels). */
export const vorgabeCsv = (typ) => DEFAULT_NS_CSV[typ] || DEFAULT_NS_CSV.IHK || '';

/** Der übergeordnete Schlüssel: gespeicherte Fassung oder die Vorgabe. */
export function globalerSchluessel(typ) {
  const row = getDb().prepare('SELECT * FROM notenschluessel_global WHERE typ = ?').get(typ);
  return {
    typ,
    csv: row?.csv || vorgabeCsv(typ),
    angepasst: Boolean(row),
    version: row?.version ?? 0,
    hinweis: row?.hinweis ?? '',
    geaendertAt: row?.geaendert_at ?? null,
    geaendertVonId: row?.geaendert_von_id ?? null,
  };
}

/** Folgt die Klasse dem übergeordneten Schlüssel? (leere oder der Vorgabe entsprechende CSV = ja) */
export function folgtGlobal(klasse) {
  const csv = (klasse?.notenschluessel_csv || '').trim();
  return !csv || csv === vorgabeCsv(klasse.notenschluessel);
}

const ANFANG = '0000-01-01 00:00:00';

/** Alle Fassungen eines übergeordneten Schlüssels, älteste zuerst. */
function fassungen(typ) {
  return getDb().prepare('SELECT csv, gueltig_ab FROM notenschluessel_fassungen WHERE typ = ? ORDER BY gueltig_ab, id').all(typ);
}

/** Ende eines Halbjahrs der Klasse (ausschließlich): 1. Hälfte bis 1. Februar, 2. Hälfte bis 1. August. */
export function halbjahrEnde(laufzeit, nr) {
  const startJahr = laufzeit.einschulungJahr + Math.floor((nr - 1) / 2);
  return nr % 2 === 1 ? `${startJahr + 1}-02-01 00:00:00` : `${startJahr + 1}-08-01 00:00:00`;
}

/**
 * Notenschlüssel für ein Halbjahr einer Klasse -- als Funktion (schuelerId) => CSV.
 *
 * Folgt die Klasse dem übergeordneten Schlüssel, gilt die Fassung, die zum Ende des Halbjahrs galt: Eine Änderung durch
 * den Admin wirkt also ab dem laufenden Halbjahr, abgeschlossene Halbjahre behalten ihre Noten. Ist eine Person für das
 * Halbjahr gesperrt (Notenkonferenz), gilt für sie die Fassung vom Zeitpunkt der Sperre -- beschlossene Noten bleiben.
 * Klassen mit eigener Definition rechnen unverändert mit dieser.
 */
export function csvRechner(klasse, halbjahr) {
  if (!klasse) return () => '';
  if (!folgtGlobal(klasse)) {
    const eigene = klasse.notenschluessel_csv.trim();
    return () => eigene;
  }
  const typ = schluesselTypVon(klasse.notenschluessel);
  if (!TYPEN.includes(typ)) return () => '';
  const verlauf = fassungen(typ);
  const aktuell = globalerSchluessel(typ).csv;
  if (verlauf.length <= 1) return () => aktuell;
  const zum = (zeitpunkt) => {
    let treffer = verlauf[0].csv;
    for (const f of verlauf) if (f.gueltig_ab < zeitpunkt) treffer = f.csv;
    return treffer;
  };
  const nr = halbjahrNr(halbjahr);
  const laufzeit = nr && klasse.id ? klassenLaufzeit(klasse.id) : null;
  const ende = laufzeit ? halbjahrEnde(laufzeit, nr) : null;
  const standard = ende ? zum(ende) : aktuell;
  const sperre = getDb().prepare(`
    SELECT n.gesperrt_am FROM notensperren n JOIN schueler s ON s.id = n.schueler_id AND s.klasse_id = n.klasse_id
    WHERE n.schueler_id = ? AND n.halbjahr = ?
  `);
  return (schuelerId = null) => {
    if (schuelerId === null || schuelerId === undefined) return standard;
    const gesperrtAm = sperre.get(schuelerId, halbjahr)?.gesperrt_am;
    if (!gesperrtAm || (ende && gesperrtAm >= ende)) return standard;
    return zum(gesperrtAm);
  };
}

/** Die für diese Klasse aktuell geltende CSV (eigene Definition oder neueste Fassung des übergeordneten Schlüssels). */
export function effektiveCsv(klasse) {
  if (!klasse) return '';
  if (!folgtGlobal(klasse)) return klasse.notenschluessel_csv.trim();
  const typ = schluesselTypVon(klasse.notenschluessel);
  return TYPEN.includes(typ) ? globalerSchluessel(typ).csv : '';
}

/** Prozent-/Noten-Tabelle zur Anzeige (absteigend). */
export function tabelle(csv) {
  return nsCsvParse(csv).map(([ab, note]) => ({ ab, note }));
}

/**
 * Prüft eine CSV-Definition ("Prozent,Note;…"): Zahlen im Bereich, keine doppelten Prozentwerte, endet bei 0 %,
 * die Note wird mit sinkender Prozentzahl nicht besser.
 * @returns {{ok: true, csv: string} | {ok: false, fehler: string}}
 */
export function pruefeCsv(typ, roh) {
  if (!TYPEN.includes(typ)) return { ok: false, fehler: 'Unbekannter Notenschlüssel.' };
  const [min, max] = BEREICH[typ];
  const teile = String(roh ?? '').split(';').map((t) => t.trim()).filter(Boolean);
  const eintraege = [];
  for (const t of teile) {
    const m = /^(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)$/.exec(t);
    if (!m) return { ok: false, fehler: `„${t}“ ist kein gültiger Eintrag -- erwartet wird Prozent,Note mit Punkt als Dezimaltrenner (z. B. 90,1.6).` };
    const p = Number(m[1]);
    const n = Number(m[2]);
    if (p > 100) return { ok: false, fehler: `Prozentwert ${p} ist größer als 100.` };
    if (n < min || n > max) return { ok: false, fehler: `Note ${n} liegt außerhalb des Bereichs ${min} bis ${max} (${typ}).` };
    eintraege.push([p, n]);
  }
  if (eintraege.length < 2) return { ok: false, fehler: 'Bitte mindestens zwei Einträge angeben.' };
  eintraege.sort((a, b) => b[0] - a[0]);
  for (let i = 1; i < eintraege.length; i++) {
    if (eintraege[i][0] === eintraege[i - 1][0]) return { ok: false, fehler: `Der Prozentwert ${eintraege[i][0]} kommt doppelt vor.` };
  }
  if (eintraege[eintraege.length - 1][0] !== 0) return { ok: false, fehler: 'Der Schlüssel muss bei 0 Prozent enden, damit jedes Ergebnis eine Note bekommt.' };
  const besserBeiMehr = typ === 'BG'; // BG: mehr Prozent = mehr Punkte; IHK/SPA: mehr Prozent = kleinere (bessere) Note
  for (let i = 1; i < eintraege.length; i++) {
    const vorher = eintraege[i - 1][1];
    const jetzt = eintraege[i][1];
    if (besserBeiMehr ? jetzt > vorher : jetzt < vorher) {
      return { ok: false, fehler: `Bei ${eintraege[i][0]} % steht Note ${jetzt}, bei ${eintraege[i - 1][0]} % Note ${vorher} -- mit weniger Prozent darf die Note nicht besser werden.` };
    }
  }
  return { ok: true, csv: eintraege.map(([p, n]) => `${p},${n}`).join(';') };
}

/**
 * Speichert einen übergeordneten Schlüssel; ohne inhaltliche Änderung bleibt die Version gleich. Jede Änderung wird als
 * neue Fassung (gültig ab jetzt) in den Verlauf geschrieben; die bisherige Fassung gilt weiter für vergangene Halbjahre.
 */
export function speichereGlobal(typ, csv, userId, hinweis = '') {
  const aktuell = globalerSchluessel(typ);
  if (aktuell.csv === csv) return { geaendert: false, version: aktuell.version };
  const version = aktuell.version + 1;
  const db = getDb();
  db.transaction(() => {
    // Erste Änderung eines bisher nicht angepassten Schlüssels: die bisherige Fassung (Vorgabe) gilt für alles davor.
    if (!db.prepare('SELECT 1 FROM notenschluessel_fassungen WHERE typ = ?').get(typ)) {
      db.prepare('INSERT INTO notenschluessel_fassungen (typ, version, csv, gueltig_ab) VALUES (?, ?, ?, ?)').run(typ, aktuell.version, aktuell.csv, ANFANG);
    }
    db.prepare("INSERT INTO notenschluessel_fassungen (typ, version, csv, gueltig_ab) VALUES (?, ?, ?, datetime('now'))").run(typ, version, csv);
    speichereZeile(typ, csv, version, hinweis, userId);
  })();
  return { geaendert: true, version };
}

function speichereZeile(typ, csv, version, hinweis, userId) {
  getDb().prepare(`
    INSERT INTO notenschluessel_global (typ, csv, version, hinweis, geaendert_at, geaendert_von_id)
    VALUES (?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(typ) DO UPDATE SET csv = excluded.csv, version = excluded.version, hinweis = excluded.hinweis,
      geaendert_at = excluded.geaendert_at, geaendert_von_id = excluded.geaendert_von_id
  `).run(typ, csv, version, String(hinweis || '').trim().slice(0, MAX_HINWEIS), userId ?? null);
}

/** Wie viele Klassen folgen dem übergeordneten Schlüssel, wie viele haben einen eigenen? */
export function klassenZahlen(typ) {
  const klassen = getDb().prepare("SELECT notenschluessel, notenschluessel_csv FROM klassen WHERE ist_kurs_huelle = 0 AND ist_ablage = 0").all()
    .filter((k) => schluesselTypVon(k.notenschluessel) === typ);
  const folgen = klassen.filter(folgtGlobal).length;
  return { folgen, eigene: klassen.length - folgen };
}

/** Klassen der Person, die dem übergeordneten Schlüssel `typ` folgen. */
function nutztGlobal(userId, typ) {
  return ladeMeineKlassen(userId).some((k) => schluesselTypVon(k.notenschluessel) === typ && folgtGlobal(k));
}

/**
 * Hinweise auf geänderte Notenschlüssel für diese Person: nur für Schlüssel, die sie nutzt, nur für Änderungen nach der
 * Anlage ihres Kontos und nur, solange sie die aktuelle Fassung nicht als gelesen markiert hat. Admins bekommen keine.
 */
export function hinweiseFuer(user) {
  if (!user || user.isAdmin) return [];
  const db = getDb();
  const globale = db.prepare('SELECT * FROM notenschluessel_global').all();
  if (!globale.length) return [];
  const konto = db.prepare('SELECT created_at FROM users WHERE id = ?').get(user.id);
  const gelesen = new Map(db.prepare('SELECT typ, version FROM notenschluessel_gelesen WHERE user_id = ?').all(user.id).map((r) => [r.typ, r.version]));
  return globale
    .filter((g) => (gelesen.get(g.typ) ?? 0) < g.version && (!konto || g.geaendert_at >= konto.created_at) && nutztGlobal(user.id, g.typ))
    .map((g) => ({ typ: g.typ, version: g.version, hinweis: g.hinweis, geaendertAt: g.geaendert_at }));
}

/** Markiert die aktuelle Fassung eines Schlüssels (oder aller) für die Person als gelesen. */
export function markiereGelesen(userId, typ = null) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO notenschluessel_gelesen (user_id, typ, version) VALUES (?, ?, ?)
    ON CONFLICT(user_id, typ) DO UPDATE SET version = MAX(version, excluded.version)
  `);
  for (const g of db.prepare('SELECT typ, version FROM notenschluessel_global').all()) {
    if (!typ || typ === g.typ) stmt.run(userId, g.typ, g.version);
  }
}
