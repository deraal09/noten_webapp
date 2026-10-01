/**
 * SPA: Klausuren und Unterrichtsleistung werden wie bei IHK abgehandelt
 * (Klausuren mit Teilen, Datumstabelle, Zusatzleistungen, Gewichtung
 * schriftlich/mündlich), aber in PUNKTEN: der Punkteschlüssel übersetzt den
 * Prozentwert direkt in Punkte 0-15 (siehe getNotenschluesselCsv in
 * noten-service.js), die Tendenznote (1+ ... 6) wird daraus mit der SPA-Skala
 * berechnet. Die Leistungspunkte eines Halbjahres
 *  - ersetzen bei Fächern mit einem Punktwert je Halbjahr (halbjahrModus
 *    'direkt') den Direktwert,
 *  - füttern bei Fächern mit Komponenten (z. B. LF2/LF3) die Komponente, die
 *    pro Fach und Halbjahr gewählt ist (spa_leistung_ziele).
 * Ein von Hand eingetragener Wert hat immer Vorrang. Nur die Zeugnisnoten
 * folgen danach dem eigenen SPA-Bewertungssystem (src/spa-grade-calc.js).
 */

import { berechneGesamtnoteEinerPerson } from './noten-service.js';
import { tendenzAusEndpunkten, STANDARD_NOTENSKALA } from './spa-grade-calc.js';

/** Tendenznote (1+ ... 6) zu Punkten 0-15 nach der SPA-Notenskala; null bei fehlendem Wert. */
export function spaTendenz(punkte) {
  return punkte === null || punkte === undefined ? null : tendenzAusEndpunkten(punkte, STANDARD_NOTENSKALA);
}

/** Leistungspunkte einer Person in einem SPA-Fach/Halbjahr (1-4) -- oder null, wenn nichts bepunktet ist. */
export function leistungsPunkte(db, fachId, halbjahrNr, schuelerId) {
  const punkte = berechneGesamtnoteEinerPerson(fachId, `${halbjahrNr}. Halbjahr`, schuelerId);
  return punkte === null ? null : Math.round(punkte * 100) / 100;
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
