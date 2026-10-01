/**
 * SPA: Klausuren und Unterrichtsleistung wie bei IHK -- sie haben Einfluss
 * auf die Note des Fachs. Je Halbjahr entsteht aus Klausuren/UL (gleiche
 * Berechnung wie IHK, siehe berechneGesamtnoteEinerPerson) eine Note 1-6, die
 * in SPA-Punkte (0-15) umgerechnet wird und
 *  - bei Fächern mit einem Punktwert je Halbjahr (halbjahrModus 'direkt') den
 *    Direktwert ersetzt,
 *  - bei Fächern mit Komponenten (z. B. LF2/LF3) die Komponente füttert, die
 *    pro Fach und Halbjahr gewählt ist (spa_leistung_ziele).
 * Ein von Hand eingetragener Wert hat immer Vorrang. Nur die Zeugnisnoten
 * folgen danach dem eigenen SPA-Bewertungssystem (src/spa-grade-calc.js).
 */

import { berechneGesamtnoteEinerPerson } from './noten-service.js';

/** Schulnote (1-6) -> Punkte 0-15 der SPA-Notenskala (1 = 14, 2 = 11, ... 6 = 0), auf zwei Stellen. */
export function noteZuSpaPunkten(note) {
  const punkte = Math.max(0, Math.min(15, 17 - 3 * note));
  return Math.round(punkte * 100) / 100;
}

/** Leistungsnote einer Person in einem SPA-Fach/Halbjahr (1-4) in Punkten -- oder null, wenn nichts benotet ist. */
export function leistungsPunkte(db, fachId, halbjahrNr, schuelerId) {
  const note = berechneGesamtnoteEinerPerson(fachId, `${halbjahrNr}. Halbjahr`, schuelerId);
  return note === null ? null : noteZuSpaPunkten(note);
}

/** Gewählte Komponente, in die die Leistungsnote bei Fächern mit Komponenten einfließt (oder null). */
export function leistungsZiel(db, fachId, halbjahrNr) {
  return db.prepare('SELECT komponente_schluessel FROM spa_leistung_ziele WHERE fach_id = ? AND halbjahr = ?')
    .get(fachId, halbjahrNr)?.komponente_schluessel ?? null;
}

/** Setzt/entfernt (leerer Wert) die Ziel-Komponente. */
export function setzeLeistungsZiel(db, fachId, halbjahrNr, komponente) {
  if (!komponente) {
    db.prepare('DELETE FROM spa_leistung_ziele WHERE fach_id = ? AND halbjahr = ?').run(fachId, halbjahrNr);
    return;
  }
  db.prepare(`
    INSERT INTO spa_leistung_ziele (fach_id, halbjahr, komponente_schluessel) VALUES (?, ?, ?)
    ON CONFLICT(fach_id, halbjahr) DO UPDATE SET komponente_schluessel = excluded.komponente_schluessel
  `).run(fachId, halbjahrNr, komponente);
}
