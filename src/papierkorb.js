/**
 * Papierkorb für Klassen.
 *
 * "Klasse löschen" blendet die Klasse nur für die löschende Lehrkraft aus (Tabelle klassen_geloescht) und legt sie in ihren
 * Papierkorb; dort kann sie jede Lehrkraft für sich wiederherstellen. Endgültig gelöscht wird erst, wenn ALLE Lehrkräfte der
 * Klasse sie gelöscht haben: ab dann läuft eine Frist von 30 Tagen (klassen.papierkorb_ab), danach werden Fächer, Klausuren und
 * Noten unwiderruflich entfernt (die Personen selbst landen wie bisher in der Sammelklasse "Ohne Klasse", siehe
 * src/klassenwechsel.js). Stellt in der Frist jemand die Klasse wieder her -- oder wird eine neue Lehrkraft eingetragen --,
 * entfällt die Frist.
 *
 * Lehrkräfte einer Klasse: Ersteller/in, Lehrkräfte mit Fach-Zuweisung, Klassenleitung (beide Tabellen). Admins zählen nicht
 * mit (sie löschen direkt).
 */

import { getDb } from './db.js';
import { jetzt } from './klassen-jahre.js';
import { loescheKlasseMitSchuelerUebernahme } from './klassenwechsel.js';

export const FRIST_TAGE = 30;
const TAG_MS = 24 * 60 * 60 * 1000;

/** User-IDs der Lehrkräfte (ohne Admins), die der Klasse angehören. */
export function lehrkraefteDerKlasse(klasseId) {
  return getDb().prepare(`
    SELECT DISTINCT u.id FROM users u WHERE u.role != 'admin' AND u.id IN (
      SELECT created_by_id FROM klassen WHERE id = @k AND created_by_id IS NOT NULL
      UNION SELECT fz.user_id FROM fach_zuweisungen fz JOIN faecher f ON f.id = fz.fach_id WHERE f.klasse_id = @k
      UNION SELECT user_id FROM klassen_lehrkraefte WHERE klasse_id = @k
      UNION SELECT user_id FROM klassenleitung WHERE klasse_id = @k
    )
  `).all({ k: klasseId }).map((r) => r.id);
}

/** Lehrkräfte, die die Klasse noch nicht gelöscht haben. */
export function aktiveLehrkraefte(klasseId) {
  const geloescht = new Set(getDb().prepare('SELECT user_id FROM klassen_geloescht WHERE klasse_id = ?').all(klasseId).map((r) => r.user_id));
  return lehrkraefteDerKlasse(klasseId).filter((id) => !geloescht.has(id));
}

/**
 * Setzt oder entfernt die 30-Tage-Frist je nach Stand: keine aktive Lehrkraft mehr (und mindestens eine hat gelöscht) -> Frist
 * läuft ab jetzt; sonst keine Frist. Eine bereits laufende Frist wird nicht neu gestartet.
 * @returns {string|null} papierkorb_ab nach der Aktualisierung
 */
export function aktualisiereFrist(klasseId, heute = jetzt()) {
  const db = getDb();
  const klasse = db.prepare('SELECT papierkorb_ab FROM klassen WHERE id = ?').get(klasseId);
  if (!klasse) return null;
  const hatGeloescht = db.prepare('SELECT 1 FROM klassen_geloescht WHERE klasse_id = ?').get(klasseId) !== undefined;
  const alleDurch = hatGeloescht && aktiveLehrkraefte(klasseId).length === 0;
  if (alleDurch && !klasse.papierkorb_ab) {
    db.prepare('UPDATE klassen SET papierkorb_ab = ? WHERE id = ?').run(heute.toISOString(), klasseId);
    return heute.toISOString();
  }
  if (!alleDurch && klasse.papierkorb_ab) {
    db.prepare('UPDATE klassen SET papierkorb_ab = NULL WHERE id = ?').run(klasseId);
    return null;
  }
  return klasse.papierkorb_ab;
}

/** Datum, ab dem eine Klasse mit Frist ab `papierkorbAb` endgültig gelöscht wird. */
export function ablaufDatum(papierkorbAb) {
  return new Date(new Date(papierkorbAb).getTime() + FRIST_TAGE * TAG_MS);
}

/** Die Lehrkraft blendet die Klasse für sich aus (Papierkorb). @returns {{letzte: boolean, ablauf: Date|null}} */
export function loescheFuerMich(userId, klasseId, heute = jetzt()) {
  getDb().prepare('INSERT OR IGNORE INTO klassen_geloescht (klasse_id, user_id, geloescht_at) VALUES (?, ?, ?)')
    .run(klasseId, userId, heute.toISOString());
  const ab = aktualisiereFrist(klasseId, heute);
  return { letzte: Boolean(ab), ablauf: ab ? ablaufDatum(ab) : null };
}

/** Die Lehrkraft holt die Klasse für sich zurück; eine laufende Frist entfällt. */
export function stelleWiederHer(userId, klasseId, heute = jetzt()) {
  const r = getDb().prepare('DELETE FROM klassen_geloescht WHERE klasse_id = ? AND user_id = ?').run(klasseId, userId);
  if (r.changes) aktualisiereFrist(klasseId, heute);
  return r.changes > 0;
}

/** Hat die Lehrkraft die Klasse ausgeblendet? */
export function istFuerMichGeloescht(userId, klasseId) {
  return getDb().prepare('SELECT 1 FROM klassen_geloescht WHERE klasse_id = ? AND user_id = ?').get(klasseId, userId) !== undefined;
}

/**
 * Papierkorb einer Lehrkraft: ihre ausgeblendeten Klassen mit Stand der Frist. `ablauf` ist null, solange noch Lehrkräfte die
 * Klasse nutzen (`nochAktiv` = wie viele).
 */
export function ladePapierkorb(userId, heute = jetzt()) {
  const rows = getDb().prepare(`
    SELECT k.id, k.name, k.notenschluessel, s.bezeichnung AS schuljahr_bezeichnung, g.geloescht_at
    FROM klassen_geloescht g
    JOIN klassen k ON k.id = g.klasse_id
    JOIN schuljahre s ON s.id = k.schuljahr_id
    WHERE g.user_id = ? AND k.ist_kurs_huelle = 0
    ORDER BY g.geloescht_at DESC, k.name
  `).all(userId);
  return rows.map((r) => {
    const ab = aktualisiereFrist(r.id, heute);
    const ablauf = ab ? ablaufDatum(ab) : null;
    return {
      ...r,
      nochAktiv: ab ? 0 : aktiveLehrkraefte(r.id).length,
      ablauf,
      resttage: ablauf ? Math.max(0, Math.ceil((ablauf.getTime() - heute.getTime()) / TAG_MS)) : null,
    };
  });
}

export function anzahlImPapierkorb(userId) {
  return getDb().prepare(`
    SELECT COUNT(*) AS c FROM klassen_geloescht g JOIN klassen k ON k.id = g.klasse_id WHERE g.user_id = ? AND k.ist_kurs_huelle = 0
  `).get(userId).c;
}

/**
 * Löscht alle Klassen endgültig, deren 30-Tage-Frist abgelaufen ist. Vorher wird der Stand erneut geprüft: ist inzwischen
 * wieder eine Lehrkraft aktiv (z. B. neu eingetragen), entfällt die Frist stattdessen.
 * @returns {number[]} IDs der gelöschten Klassen
 */
export function loescheAbgelaufeneKlassen(heute = jetzt()) {
  const geloescht = [];
  const kandidaten = getDb().prepare('SELECT id FROM klassen WHERE papierkorb_ab IS NOT NULL').all();
  for (const { id } of kandidaten) {
    const ab = aktualisiereFrist(id, heute);
    if (!ab) continue;
    if (ablaufDatum(ab).getTime() <= heute.getTime()) {
      loescheKlasseMitSchuelerUebernahme(id);
      geloescht.push(id);
    }
  }
  return geloescht;
}

let zuletztGeprueftAm = null;

/** Wie loescheAbgelaufeneKlassen, aber höchstens einmal je Kalendertag; in Tests nur mit NOTEN_PAPIERKORB_AUTO=1. */
export function pruefePapierkorbEinmalProTag(heute = jetzt()) {
  if (process.env.NODE_ENV === 'test' && process.env.NOTEN_PAPIERKORB_AUTO !== '1') return [];
  const tag = heute.toISOString().slice(0, 10) + '|' + (process.env.DB_PFAD || '');
  if (zuletztGeprueftAm === tag) return [];
  zuletztGeprueftAm = tag;
  return loescheAbgelaufeneKlassen(heute);
}
