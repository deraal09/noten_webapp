/**
 * Löschschutz für Noten anderer Lehrkräfte.
 *
 * Ein Fach, eine Schüler/in oder eine Klasse zu löschen entfernt per
 * ON DELETE CASCADE alle zugehörigen Noten unwiderruflich. Die Klassenleitung
 * verwaltet die Klasse -- und als Klassenleitung kann sich jede Lehrkraft mit
 * eigenem Fach eintragen (siehe userDarfSichAlsKlassenleitungEintragen). Sie
 * soll deshalb nichts löschen können, woran Noten ANDERER Lehrkräfte hängen;
 * das bleibt dem Admin vorbehalten.
 *
 * "Eigene" Noten: Noten in einem Fach, dem genau diese Lehrkraft (und niemand
 * sonst) zugeordnet ist. Ein Fach mit Noten, aber ohne zugeordnete Lehrkraft,
 * zählt als fremd -- sonst ginge "Zuordnung entfernen, dann löschen".
 */

import { getDb } from './db.js';

// Jede Zeile ist ein echter Eintrag (Note, Punkte, Anwesenheit …) zu (fach_id, schueler_id).
const NOTEN_EINTRAEGE = `
  SELECT k.fach_id, e.schueler_id FROM klausur_ergebnisse e JOIN klausuren k ON k.id = e.klausur_id WHERE e.punkte != '[]'
  UNION ALL SELECT u.fach_id, e.schueler_id FROM ul_ergebnisse e JOIN unterrichtsleistungen u ON u.id = e.ul_id WHERE e.punkte != '[]'
  UNION ALL SELECT t.fach_id, n.schueler_id FROM unterricht_noten n JOIN unterricht_termine t ON t.id = n.termin_id
  UNION ALL SELECT fach_id, schueler_id FROM halbjahr_endnoten
  UNION ALL SELECT fach_id, schueler_id FROM spa_eingaben
  UNION ALL SELECT fach_id, schueler_id FROM spa_komponenten_noten
  UNION ALL SELECT fach_id, schueler_id FROM fach_abschlussnoten
  UNION ALL SELECT fach_id, schueler_id FROM noten
`;

/** Das Fach samt aller Unterfächer (die beim Löschen per CASCADE mitgehen). */
function fachMitUnterfaechern(fachId) {
  return getDb().prepare(`
    WITH RECURSIVE baum(id) AS (SELECT ? UNION SELECT f.id FROM faecher f JOIN baum b ON f.parent_fach_id = b.id)
    SELECT id FROM baum
  `).all(fachId).map((r) => r.id);
}

/** Gehören die Noten dieses Fachs allein dem User (er ist die einzige zugeordnete Lehrkraft)? */
function istEigenesFach(user, fachId) {
  const ids = getDb().prepare('SELECT DISTINCT user_id FROM fach_zuweisungen WHERE fach_id = ?').all(fachId).map((r) => r.user_id);
  return ids.length === 1 && ids[0] === user.id;
}

/** Fächer (ids) unter `fachIds`, in denen Noten stehen, die nicht allein dem User gehören. */
function faecherMitFremdenNoten(user, fachIds, schuelerId = null) {
  if (!fachIds.length) return [];
  const platzhalter = fachIds.map(() => '?').join(', ');
  const mitNoten = getDb().prepare(`
    SELECT DISTINCT fach_id FROM (${NOTEN_EINTRAEGE})
    WHERE fach_id IN (${platzhalter}) ${schuelerId === null ? '' : 'AND schueler_id = ?'}
  `).all(...fachIds, ...(schuelerId === null ? [] : [schuelerId])).map((r) => r.fach_id);
  return mitNoten.filter((id) => !istEigenesFach(user, id));
}

const fachNamen = (ids) => (ids.length
  ? getDb().prepare(`SELECT name FROM faecher WHERE id IN (${ids.map(() => '?').join(', ')}) ORDER BY name`).all(...ids).map((r) => r.name)
  : []);

/** Stehen in dem Fach (oder einem Unterfach) überhaupt Noten? */
export function fachHatNoten(fachId) {
  const ids = fachMitUnterfaechern(fachId);
  return getDb().prepare(`SELECT 1 FROM (${NOTEN_EINTRAEGE}) WHERE fach_id IN (${ids.map(() => '?').join(', ')}) LIMIT 1`).get(...ids) !== undefined;
}

/** Namen der Fächer, deren fremde Noten beim Löschen dieses Fachs verloren gingen (leer = darf). */
export function fremdeNotenImFach(user, fachId) {
  if (user.isAdmin) return [];
  return fachNamen(faecherMitFremdenNoten(user, fachMitUnterfaechern(fachId)));
}

/** Namen der Fächer, deren fremde Noten beim Löschen der ganzen Klasse verloren gingen (leer = darf). */
export function fremdeNotenInKlasse(user, klasseId) {
  if (user.isAdmin) return [];
  const ids = getDb().prepare('SELECT id FROM faecher WHERE klasse_id = ?').all(klasseId).map((r) => r.id);
  return fachNamen(faecherMitFremdenNoten(user, ids));
}

/** Namen der Fächer, in denen die Person Noten anderer Lehrkräfte hat (leer = darf gelöscht werden). */
export function fremdeNotenDerPerson(user, schuelerId) {
  if (user.isAdmin) return [];
  const ids = getDb().prepare(`SELECT DISTINCT fach_id FROM (${NOTEN_EINTRAEGE}) WHERE schueler_id = ?`).all(schuelerId).map((r) => r.fach_id);
  return fachNamen(faecherMitFremdenNoten(user, ids, schuelerId));
}
