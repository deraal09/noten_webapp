/**
 * Beitritt zu einer bereits bestehenden Klasse: Legt jemand eine Klasse mit
 * einem Namen an, der in diesem Schuljahr schon vergeben ist (siehe
 * routes/teacher.js POST /klassen/neu), entsteht statt einer zweiten,
 * doppelten Klasse ein direkter Beitritt mit eigenem Fach — sofern
 * entweder noch niemand mit der Klasse verbunden ist (z. B. eine leere,
 * nur vom Admin angelegte Klassenhülle) ODER die Klasse beim Anlegen für
 * automatischen Beitritt freigegeben wurde (klassen.offen_fuer_beitritt).
 *
 * Ersetzt die frühere Verknüpfungsanfrage mit Einstimmigkeitszwang aller
 * bereits verbundenen Personen — die brauchte für den Normalfall (dieselbe
 * Klasse, zweites Fach) unnötig lange, und Absicherung gegen ein doppelt
 * angelegtes Fach übernimmt ohnehin schon fachAnlegenOderFinden() unten
 * (UNIQUE(klasse_id, name) auf faecher).
 */

import { getDb } from './db.js';
import { seedeTeilnehmerAusKlasse } from './fach-teilnehmer.js';

/** Alle User-IDs, die bereits mit der Klasse verbunden sind. */
export function ermittleVerbundenePersonen(klasseId) {
  const db = getDb();
  const ids = new Set();
  const klasse = db.prepare('SELECT created_by_id FROM klassen WHERE id = ?').get(klasseId);
  if (klasse?.created_by_id) ids.add(klasse.created_by_id);
  for (const r of db.prepare('SELECT user_id FROM klassenleitung WHERE klasse_id = ?').all(klasseId)) {
    ids.add(r.user_id);
  }
  for (const r of db.prepare('SELECT user_id FROM klassen_lehrkraefte WHERE klasse_id = ?').all(klasseId)) {
    ids.add(r.user_id);
  }
  for (const r of db.prepare(`
    SELECT DISTINCT fz.user_id FROM fach_zuweisungen fz
    JOIN faecher f ON f.id = fz.fach_id WHERE f.klasse_id = ?
  `).all(klasseId)) {
    ids.add(r.user_id);
  }
  return ids;
}

/**
 * Gewährt direkten Zugriff (neues Fach + Zuweisung), falls die Klasse leer
 * oder für Beitritt freigegeben ist, sonst Ablehnung.
 * Gibt { direkterBeitritt: true, fachId } oder { direkterBeitritt: false } zurück.
 */
export function starteVerknuepfung({ klasseId, angefragtVonId, vorgeschlagenesFach }) {
  const db = getDb();
  const klasse = db.prepare('SELECT offen_fuer_beitritt FROM klassen WHERE id = ?').get(klasseId);
  const verbundene = ermittleVerbundenePersonen(klasseId);
  verbundene.delete(angefragtVonId); // falls die Person selbst schon verbunden ist, ohnehin kein Thema

  if (verbundene.size === 0 || klasse?.offen_fuer_beitritt) {
    const fachId = fachAnlegenOderFinden(klasseId, vorgeschlagenesFach);
    db.prepare('INSERT OR IGNORE INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)')
      .run(angefragtVonId, fachId);
    return { direkterBeitritt: true, fachId };
  }

  return { direkterBeitritt: false };
}

function fachAnlegenOderFinden(klasseId, name) {
  const db = getDb();
  const bestehend = db.prepare('SELECT id FROM faecher WHERE klasse_id = ? AND name = ?').get(klasseId, name);
  if (bestehend) return bestehend.id;
  const info = db.prepare('INSERT INTO faecher (klasse_id, name) VALUES (?, ?)').run(klasseId, name);
  seedeTeilnehmerAusKlasse(info.lastInsertRowid, klasseId);
  return info.lastInsertRowid;
}
