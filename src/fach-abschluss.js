/**
 * Fachabschluss: optionales Abschließen eines Fachs (manche Fächer laufen
 * über mehrere Schuljahre und werden nie abgeschlossen). Beim Abschließen
 * wird je Schüler/in eine Fachabschlussnote als Mittelwert aus allen
 * vorhandenen Halbjahren dieses Fachs berechnet — den aktuellen 1./2.
 * Halbjahr (live berechnet) UND allen historischen Halbjahren (siehe
 * historische_halbjahre/-noten, für Noten von vor Einführung dieser App).
 */

import { getDb } from './db.js';
import { berechneGesamtnoten } from './noten-service.js';
import { HALBJAHRE, gesamtnoteJahr } from './grade-calc.js';

/** Historische Halbjahre eines Fachs, älteste zuerst. */
export function ladeHistorischeHalbjahre(fachId) {
  return getDb().prepare(
    'SELECT * FROM historische_halbjahre WHERE fach_id = ? ORDER BY reihenfolge, id'
  ).all(fachId);
}

/** Historische Noten eines historischen Halbjahrs als Map<schueler_id, note>. */
export function ladeHistorischeNoten(historischesHalbjahrId) {
  const rows = getDb().prepare(
    'SELECT schueler_id, note FROM historische_noten WHERE historisches_halbjahr_id = ?'
  ).all(historischesHalbjahrId);
  return new Map(rows.map((r) => [r.schueler_id, r.note]));
}

/** Fachabschlussnoten (eingefroren) als Map<schueler_id, note>. */
export function ladeAbschlussnoten(fachId) {
  const rows = getDb().prepare('SELECT schueler_id, note FROM fach_abschlussnoten WHERE fach_id = ?').all(fachId);
  return new Map(rows.map((r) => [r.schueler_id, r.note]));
}

/**
 * Berechnet und speichert die Fachabschlussnote je Schüler/in und markiert
 * das Fach als abgeschlossen. Erneutes Aufrufen (z. B. nach einer Korrektur)
 * überschreibt die zuvor gespeicherten Werte.
 */
export function schliesseFachAb(fachId, userId) {
  const db = getDb();
  const fach = db.prepare('SELECT * FROM faecher WHERE id = ?').get(fachId);
  if (!fach) throw new Error('Fach nicht gefunden');
  const schuelerListe = db.prepare('SELECT id FROM schueler WHERE klasse_id = ?').all(fach.klasse_id);

  const hjNotenMaps = HALBJAHRE.map((hj) => berechneGesamtnoten(fachId, hj));
  const historischeHalbjahre = ladeHistorischeHalbjahre(fachId);
  const historischeNotenMaps = historischeHalbjahre.map((hh) => ladeHistorischeNoten(hh.id));

  const upsert = db.prepare(`
    INSERT INTO fach_abschlussnoten (fach_id, schueler_id, note)
    VALUES (?, ?, ?)
    ON CONFLICT(fach_id, schueler_id) DO UPDATE SET note = excluded.note
  `);
  const tx = db.transaction(() => {
    for (const s of schuelerListe) {
      const werte = [
        ...hjNotenMaps.map((m) => m.get(s.id) ?? null),
        ...historischeNotenMaps.map((m) => m.get(s.id) ?? null),
      ];
      upsert.run(fachId, s.id, gesamtnoteJahr(werte));
    }
    db.prepare(`
      UPDATE faecher SET abgeschlossen = 1, abgeschlossen_am = datetime('now'), abgeschlossen_von_id = ?
      WHERE id = ?
    `).run(userId, fachId);
  });
  tx();
}

/** Öffnet ein abgeschlossenes Fach wieder (Korrektur). Die zuvor berechneten
 * Abschlussnoten bleiben gespeichert, bis das Fach erneut abgeschlossen wird. */
export function oeffneFach(fachId) {
  getDb().prepare('UPDATE faecher SET abgeschlossen = 0 WHERE id = ?').run(fachId);
}
