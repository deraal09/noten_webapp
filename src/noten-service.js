/**
 * Gemeinsame Notenberechnungs-Helfer, die sowohl die Live-Notentafel
 * (routes/teacher.js) als auch der Sync-Mechanismus (noten-sync.js)
 * brauchen. Ausgelagert, damit beide dieselbe Logik verwenden.
 */

import { getDb } from './db.js';
import { noteAusPunkten, gesamtnoteHj, DEFAULT_GEWICHTUNG, DEFAULT_NS_CSV } from './grade-calc.js';

export function ladeFachMitUmfeld(id) {
  return getDb().prepare(`
    SELECT f.*, k.name AS klasse_name, k.schuljahr_id, k.notenschluessel,
           s.bezeichnung AS schuljahr_bezeichnung
    FROM faecher f
    JOIN klassen k ON k.id = f.klasse_id
    JOIN schuljahre s ON s.id = k.schuljahr_id
    WHERE f.id = ?
  `).get(id);
}

export function getNotenschluesselCsv(fach) {
  const k = getDb().prepare('SELECT notenschluessel_csv, notenschluessel FROM klassen WHERE id = ?')
    .get(fach.klasse_id);
  if (k?.notenschluessel_csv) return k.notenschluessel_csv;
  return DEFAULT_NS_CSV[k?.notenschluessel] || '';
}

/**
 * Berechnet die Gesamtnote je Schüler/in für ein Fach + Halbjahr — dieselbe
 * Formel wie die Live-Notentafel, aber ohne die Detail-Aufschlüsselung
 * (Klausuren/ULs einzeln), die der Sync-Stand nicht braucht.
 *
 * @returns {Map<number, number|null>} schueler_id -> Gesamtnote
 */
export function berechneGesamtnoten(fachId, halbjahr) {
  const fach = ladeFachMitUmfeld(fachId);
  const ergebnis = new Map();
  if (!fach) return ergebnis;
  const db = getDb();
  const schueler = db.prepare('SELECT id FROM schueler WHERE klasse_id = ?').all(fach.klasse_id);
  const klausuren = db.prepare('SELECT * FROM klausuren WHERE fach_id = ? AND halbjahr = ? ORDER BY id').all(fachId, halbjahr);
  const uls = db.prepare('SELECT * FROM unterrichtsleistungen WHERE fach_id = ? AND halbjahr = ? ORDER BY id').all(fachId, halbjahr);
  const csvStr = getNotenschluesselCsv(fach);
  const schuljahr = db.prepare('SELECT gewichtung_muendlich FROM schuljahre WHERE id = ?').get(fach.schuljahr_id);
  const ulPct = schuljahr?.gewichtung_muendlich ?? DEFAULT_GEWICHTUNG;
  const schriftlichPct = 100 - ulPct;

  const klausurErgs = new Map();
  for (const k of klausuren) {
    const rows = db.prepare('SELECT schueler_id, punkte FROM klausur_ergebnisse WHERE klausur_id = ?').all(k.id);
    klausurErgs.set(k.id, new Map(rows.map((r) => [r.schueler_id, JSON.parse(r.punkte)])));
  }
  const ulErgs = new Map();
  for (const u of uls) {
    const rows = db.prepare('SELECT schueler_id, punkte FROM ul_ergebnisse WHERE ul_id = ?').all(u.id);
    ulErgs.set(u.id, new Map(rows.map((r) => [r.schueler_id, JSON.parse(r.punkte)])));
  }

  for (const s of schueler) {
    const klausurData = klausuren.map((k) => {
      const punkte = klausurErgs.get(k.id)?.get(s.id) || null;
      const note = punkte ? noteAusPunkten(punkte, JSON.parse(k.max_punkte_pro_aufgabe), csvStr) : null;
      return { note, gewichtung: k.gewichtung };
    });
    const ulData = uls.map((u) => {
      const punkte = ulErgs.get(u.id)?.get(s.id) || null;
      const note = punkte ? noteAusPunkten(punkte, JSON.parse(u.max_punkte_pro_aufgabe), csvStr) : null;
      return { note, gewichtung: u.gewichtung };
    });
    const gn = gesamtnoteHj(schriftlichPct, ulPct, klausurData, ulData, csvStr);
    ergebnis.set(s.id, gn);
  }
  return ergebnis;
}
