/**
 * SPA: Klausuren und Unterrichtsleistung werden wie bei IHK abgehandelt
 * (Klausuren mit Teilen, Datumstabelle, Zusatzleistungen, Gewichtung
 * schriftlich/Unterrichtsleistung), aber mit Leistungspunkten: der Prozentwert wird nach dem IHK-Schlüssel in eine Note (1-6, siehe getNotenschluesselCsv in
 * noten-service.js); daraus werden die Leistungspunkte 0-15 (punkteAusIhkNote) und die
 * Tendenznote (1+ ... 6) mit der SPA-Skala abgeleitet. Die Leistungspunkte eines Halbjahres
 *  - ersetzen bei Fächern mit einem Punktwert je Halbjahr (halbjahrModus
 *    'direkt') den Direktwert,
 *  - füttern bei Fächern mit Komponenten (z. B. LF2/LF3) die Komponente, die
 *    pro Fach und Halbjahr gewählt ist (spa_leistung_ziele).
 * Ein von Hand eingetragener Wert hat immer Vorrang. Nur die Zeugnisnoten
 * folgen danach dem eigenen SPA-Bewertungssystem (src/spa-grade-calc.js).
 */

import { berechneGesamtnoteEinerPerson } from './noten-service.js';
import { tendenzAusEndpunkten, STANDARD_NOTENSKALA } from './spa-grade-calc.js';
import { verrechnungsProzent, wendeVerrechnungAn } from './klassen-jahre.js';

/**
 * IHK-Note (1-6) -> Punkte 0-15, passend zur SPA-Notenskala (1 = 14, 2 = 11, 3 = 8, 4 = 5, 5 = 2, 6 = 0;
 * 1,3 = 13 = 1-, 1,7 = 12 = 2+ usw.): Punkte = 17 - 3 x Note, auf 0-15 begrenzt, auf zwei Stellen gerundet.
 */
export function punkteAusIhkNote(note) {
  if (note === null || note === undefined) return null;
  return Math.round(Math.max(0, Math.min(15, 17 - 3 * note)) * 100) / 100;
}

/** Tendenznote einer IHK-Note (Klausur-/Unterrichtsleistungs-Gesamtnote) über die Punkte. */
export function spaTendenzAusNote(note) {
  return spaTendenz(punkteAusIhkNote(note));
}

/** Tendenznote (1+ ... 6) zu Punkten 0-15 nach der SPA-Notenskala; null bei fehlendem Wert. */
export function spaTendenz(punkte) {
  return punkte === null || punkte === undefined ? null : tendenzAusEndpunkten(punkte, STANDARD_NOTENSKALA);
}

/**
 * Leistungspunkte einer Person in einem SPA-Fach/Halbjahr (1-4) -- oder null, wenn nichts bepunktet ist.
 * Mit eingestellter Verrechnung (siehe verrechnungsProzent, je Fach) fließen zu diesem Prozentsatz die
 * (selbst schon verrechneten) Leistungspunkte des Vorhalbjahres ein.
 */
export function leistungsPunkte(db, fachId, halbjahrNr, schuelerId) {
  const fach = db.prepare('SELECT * FROM faecher WHERE id = ?').get(fachId);
  // Komponenten-Unterfach: direkt eingetragene Gesamtpunkte (Direkteingabe) ersetzen die berechneten Leistungspunkte.
  if (fach?.spa_komponente) {
    const direkt = db.prepare('SELECT note, ntg FROM halbjahr_endnoten WHERE fach_id = ? AND schueler_id = ? AND halbjahr = ?')
      .get(fachId, schuelerId, `${halbjahrNr}. Halbjahr`);
    if (direkt) return direkt.ntg || direkt.note === null ? null : Math.round(direkt.note * 100) / 100;
  }
  const punkte = punkteAusIhkNote(berechneGesamtnoteEinerPerson(fachId, `${halbjahrNr}. Halbjahr`, schuelerId));
  if (punkte === null) return null;
  const prozent = fach ? verrechnungsProzent(fach.klasse_id, `${halbjahrNr}. Halbjahr`, fach) : 0;
  const vorher = prozent ? leistungsPunkte(db, fachId, halbjahrNr - 1, schuelerId) : null;
  return Math.round(wendeVerrechnungAn(punkte, vorher, prozent) * 100) / 100;
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
