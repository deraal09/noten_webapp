/**
 * Verhindert doppelte Schüler-Einträge in einer Klasse — wird beim
 * Einzeleingabe-Formular, Sammel-Einfügen, CSV-Upload, Untis-Import und der
 * Klassen-Übertragung genutzt. Verglichen wird Nachname/Vorname
 * unabhängig von Groß-/Kleinschreibung und Leerzeichen am Rand, damit ein
 * mehrfacher Import (z. B. erneuter Untis-Import derselben Klasse oder ein
 * erneut hochgeladenes CSV) niemanden doppelt anlegt.
 */

import { getDb } from './db.js';

export function schuelerExistiertBereits(klasseId, nachname, vorname) {
  const n = String(nachname || '').trim().toLowerCase();
  const v = String(vorname || '').trim().toLowerCase();
  const zeile = getDb().prepare(`
    SELECT id FROM schueler
    WHERE klasse_id = ? AND LOWER(TRIM(nachname)) = ? AND LOWER(TRIM(vorname)) = ?
  `).get(klasseId, n, v);
  return !!zeile;
}

/** Legt Schüler/in an, außer es gibt in der Klasse schon jemanden mit gleichem Namen. Gibt true zurück, wenn tatsächlich angelegt wurde. */
export function fuegeSchuelerHinzuFallsNeu(klasseId, nachname, vorname) {
  if (schuelerExistiertBereits(klasseId, nachname, vorname)) return false;
  getDb().prepare('INSERT INTO schueler (klasse_id, nachname, vorname) VALUES (?, ?, ?)')
    .run(klasseId, nachname, vorname);
  return true;
}
