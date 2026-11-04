/**
 * Übergeordnete Notenschlüssel (IHK, BG): Der Admin pflegt sie zentral (Admin → Notenschlüssel), alle Klassen, die
 * keinen eigenen Schlüssel haben, folgen ihnen (auch SPA-Klassen: IHK). Ändert der Admin einen Schlüssel, bekommen alle Lehrkräfte, die ihn nutzen,
 * einmalig einen Hinweis. Ansehen (ohne ändern) können ihn alle angemeldeten Personen (/notenschluessel).
 *
 * Klassen mit eigener CSV-Definition (Admin → Klasse → Notenschlüssel, abweichend von Vorgabe und übergeordnetem
 * Schlüssel) behalten diese. SPA-Klassen bewerten Klausuren und Unterrichtsleistung nach dem IHK-Schlüssel.
 */

import { getDb } from './db.js';
import { DEFAULT_NS_CSV, nsCsvParse } from './grade-calc.js';
import { ladeMeineKlassen } from './auth.js';

export const TYPEN = ['IHK', 'BG'];
export const BEREICH = { IHK: [1, 6], BG: [0, 15] };
export const MAX_HINWEIS = 200;

/** Schlüsseltyp, dessen Tabelle eine Klasse verwendet (SPA: Klausuren/Unterrichtsleistung nach dem IHK-Schlüssel, siehe src/spa-leistung.js). */
export const schluesselTypVon = (notenschluessel) => (notenschluessel === 'SPA' ? 'IHK' : notenschluessel);

/** Der übergeordnete Schlüssel: gespeicherte Fassung oder die Vorgabe. */
export function globalerSchluessel(typ) {
  const row = getDb().prepare('SELECT * FROM notenschluessel_global WHERE typ = ?').get(typ);
  return {
    typ,
    csv: row?.csv || DEFAULT_NS_CSV[typ] || '',
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
  return !csv || csv === DEFAULT_NS_CSV[schluesselTypVon(klasse.notenschluessel)];
}

/** Die für diese Klasse geltende CSV (eigene Definition oder übergeordneter Schlüssel). */
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
  const besserBeiMehr = typ === 'BG'; // BG: mehr Prozent = mehr Punkte; IHK: mehr Prozent = kleinere (bessere) Note
  for (let i = 1; i < eintraege.length; i++) {
    const vorher = eintraege[i - 1][1];
    const jetzt = eintraege[i][1];
    if (besserBeiMehr ? jetzt > vorher : jetzt < vorher) {
      return { ok: false, fehler: `Bei ${eintraege[i][0]} % steht Note ${jetzt}, bei ${eintraege[i - 1][0]} % Note ${vorher} -- mit weniger Prozent darf die Note nicht besser werden.` };
    }
  }
  return { ok: true, csv: eintraege.map(([p, n]) => `${p},${n}`).join(';') };
}

/** Speichert einen übergeordneten Schlüssel; ohne inhaltliche Änderung bleibt die Version gleich. */
export function speichereGlobal(typ, csv, userId, hinweis = '') {
  const aktuell = globalerSchluessel(typ);
  if (aktuell.csv === csv) return { geaendert: false, version: aktuell.version };
  const version = aktuell.version + 1;
  getDb().prepare(`
    INSERT INTO notenschluessel_global (typ, csv, version, hinweis, geaendert_at, geaendert_von_id)
    VALUES (?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(typ) DO UPDATE SET csv = excluded.csv, version = excluded.version, hinweis = excluded.hinweis,
      geaendert_at = excluded.geaendert_at, geaendert_von_id = excluded.geaendert_von_id
  `).run(typ, csv, version, String(hinweis || '').trim().slice(0, MAX_HINWEIS), userId ?? null);
  return { geaendert: true, version };
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
