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
 * Klasse, zweites Fach) unnötig lange. Ein schon vorhandenes Fach wird beim
 * Beitritt aber nicht einfach übernommen (siehe starteVerknuepfung unten).
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
 *
 * Gibt es das gewünschte Fach in der Klasse schon, wird man ihm NUR
 * zugeordnet, wenn noch niemand anderes mit der Klasse verbunden ist (leere
 * Klassenhülle vom Admin) oder man ihm ohnehin schon zugeordnet ist. In einer
 * bloß freigegebenen Klasse gehört ein bestehendes Fach einer anderen
 * Lehrkraft — eine Zuweisung gäbe vollen Fach-Zugriff (Klausuren löschen,
 * Punkte ändern, Teilnehmer/innen entfernen) allein über die Wahl desselben
 * Fachnamens. Die Zuordnung zu einem fremden Fach bleibt Sache der
 * Klassenleitung bzw. des Admins.
 *
 * Gibt { direkterBeitritt: true, fachId }, { direkterBeitritt: false,
 * fachExistiert: true } oder { direkterBeitritt: false } zurück.
 */
export function starteVerknuepfung({ klasseId, angefragtVonId, vorgeschlagenesFach }) {
  const db = getDb();
  const klasse = db.prepare('SELECT offen_fuer_beitritt FROM klassen WHERE id = ?').get(klasseId);
  const verbundene = ermittleVerbundenePersonen(klasseId);
  verbundene.delete(angefragtVonId); // falls die Person selbst schon verbunden ist, ohnehin kein Thema

  if (verbundene.size === 0 || klasse?.offen_fuer_beitritt) {
    const bestehend = db.prepare('SELECT id FROM faecher WHERE klasse_id = ? AND name = ?')
      .get(klasseId, vorgeschlagenesFach);
    if (bestehend) {
      const schonZugeordnet = db.prepare('SELECT 1 FROM fach_zuweisungen WHERE user_id = ? AND fach_id = ?')
        .get(angefragtVonId, bestehend.id);
      if (schonZugeordnet) return { direkterBeitritt: true, fachId: bestehend.id };
      if (verbundene.size > 0) return { direkterBeitritt: false, fachExistiert: true };
      db.prepare('INSERT OR IGNORE INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)')
        .run(angefragtVonId, bestehend.id);
      return { direkterBeitritt: true, fachId: bestehend.id };
    }
    const fachId = fachAnlegen(klasseId, vorgeschlagenesFach);
    db.prepare('INSERT OR IGNORE INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)')
      .run(angefragtVonId, fachId);
    return { direkterBeitritt: true, fachId };
  }

  return { direkterBeitritt: false };
}

function fachAnlegen(klasseId, name) {
  const info = getDb().prepare('INSERT INTO faecher (klasse_id, name) VALUES (?, ?)').run(klasseId, name);
  seedeTeilnehmerAusKlasse(info.lastInsertRowid, klasseId);
  return info.lastInsertRowid;
}
