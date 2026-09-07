/**
 * Notensperre: nach der Notenkonferenz kann die Klassenleitung die Noten
 * einer/eines Schüler:in klassenweit für ein Halbjahr sperren (siehe
 * Konferenzmodus). Betroffene Fachlehrkräfte können dann keine Punkte/Noten
 * mehr für diese Person eintragen (Durchsetzung in routes/teacher.js),
 * können aber eine Aufhebung anfragen statt selbst zu entsperren.
 */

import { getDb } from './db.js';

export function holeSperre(klasseId, schuelerId, halbjahr) {
  return getDb().prepare(
    'SELECT * FROM notensperren WHERE klasse_id = ? AND schueler_id = ? AND halbjahr = ?'
  ).get(klasseId, schuelerId, halbjahr) || null;
}

export function istGesperrt(klasseId, schuelerId, halbjahr) {
  return Boolean(holeSperre(klasseId, schuelerId, halbjahr));
}

/**
 * Wie istGesperrt(), löst klasse_id aber selbst über die/den Schüler:in
 * auf (Komfort für die Notentafel-Routen) -- bewusst NICHT über das Fach:
 * bei einem klassenübergreifenden Kurs (siehe fach_teilnehmer) kann eine
 * teilnehmende Person aus einer anderen Klasse stammen als der
 * Heimat-Klasse des Fachs, gesperrt wird aber immer über die EIGENE
 * Klassenleitung dieser Person.
 */
export function istSchuelerGesperrtInFach(fachId, schuelerId, halbjahr) {
  const schueler = getDb().prepare('SELECT klasse_id FROM schueler WHERE id = ?').get(schuelerId);
  if (!schueler) return false;
  return istGesperrt(schueler.klasse_id, schuelerId, halbjahr);
}

export function sperren(klasseId, schuelerId, halbjahr, userId) {
  getDb().prepare(`
    INSERT INTO notensperren (klasse_id, schueler_id, halbjahr, gesperrt_von_id, gesperrt_am)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(klasse_id, schueler_id, halbjahr) DO UPDATE SET
      gesperrt_von_id = excluded.gesperrt_von_id, gesperrt_am = excluded.gesperrt_am,
      aufhebung_angefragt = 0, aufhebung_angefragt_von_id = NULL,
      aufhebung_angefragt_am = NULL, aufhebung_grund = NULL
  `).run(klasseId, schuelerId, halbjahr, userId);
}

export function entsperren(klasseId, schuelerId, halbjahr) {
  getDb().prepare(
    'DELETE FROM notensperren WHERE klasse_id = ? AND schueler_id = ? AND halbjahr = ?'
  ).run(klasseId, schuelerId, halbjahr);
}

/** true, wenn eine bestehende Sperre gefunden und markiert wurde. */
export function aufhebungAnfragen(klasseId, schuelerId, halbjahr, userId, grund) {
  const info = getDb().prepare(`
    UPDATE notensperren SET aufhebung_angefragt = 1, aufhebung_angefragt_von_id = ?,
      aufhebung_angefragt_am = datetime('now'), aufhebung_grund = ?
    WHERE klasse_id = ? AND schueler_id = ? AND halbjahr = ?
  `).run(userId, grund || null, klasseId, schuelerId, halbjahr);
  return info.changes > 0;
}

/** Alle Sperren einer Klasse/eines Halbjahrs als Map<schueler_id, Sperre>. */
export function ladeSperrenFuerKlasse(klasseId, halbjahr) {
  const rows = getDb().prepare(`
    SELECT n.*, u1.display_name AS gesperrt_von_name, u1.username AS gesperrt_von_username,
           u2.display_name AS angefragt_von_name, u2.username AS angefragt_von_username
    FROM notensperren n
    LEFT JOIN users u1 ON u1.id = n.gesperrt_von_id
    LEFT JOIN users u2 ON u2.id = n.aufhebung_angefragt_von_id
    WHERE n.klasse_id = ? AND n.halbjahr = ?
  `).all(klasseId, halbjahr);
  return new Map(rows.map((r) => [r.schueler_id, r]));
}

/**
 * Wie ladeSperrenFuerKlasse(), aber für eine beliebige Liste von
 * Schüler-IDs statt einer einzelnen Klasse -- für die Notentafel eines
 * Fachs mit klassenübergreifenden Teilnehmer/innen (fach_teilnehmer),
 * deren Sperren jeweils bei der eigenen Klasse liegen.
 */
export function ladeSperrenFuerSchueler(schuelerIds, halbjahr) {
  if (!schuelerIds.length) return new Map();
  const rows = getDb().prepare(`
    SELECT n.*, u1.display_name AS gesperrt_von_name, u1.username AS gesperrt_von_username,
           u2.display_name AS angefragt_von_name, u2.username AS angefragt_von_username
    FROM notensperren n
    LEFT JOIN users u1 ON u1.id = n.gesperrt_von_id
    LEFT JOIN users u2 ON u2.id = n.aufhebung_angefragt_von_id
    WHERE n.halbjahr = ? AND n.schueler_id IN (${schuelerIds.map(() => '?').join(',')})
  `).all(halbjahr, ...schuelerIds);
  return new Map(rows.map((r) => [r.schueler_id, r]));
}
