/**
 * Verknüpfungsanfragen: Legt jemand eine Klasse an, deren Name in diesem
 * Schuljahr schon vergeben ist (siehe routes/teacher.js POST /klassen/neu),
 * entsteht statt einer zweiten, doppelten Klasse eine Anfrage an alle bereits
 * mit der Klasse verbundenen Personen. Erst wenn ALLE zustimmen, wird das
 * vorgeschlagene Fach angelegt (falls es das noch nicht gibt) und die
 * anfragende Person diesem Fach zugewiesen — eine einzige Ablehnung beendet
 * die Anfrage.
 *
 * Ist niemand mit der Klasse verbunden (z. B. eine leere, nur vom Admin
 * angelegte Klassenhülle), ist keine Zustimmung nötig — direkter Beitritt.
 */

import { getDb } from './db.js';

/** Alle User-IDs, die bereits mit der Klasse verbunden sind (müssen einer Verknüpfung zustimmen). */
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
 * Startet eine Verknüpfungsanfrage oder gewährt direkten Zugriff, falls
 * niemand zustimmen muss. Gibt { direkterBeitritt: true, fachId } oder
 * { direkterBeitritt: false, anfrageId } zurück.
 */
export function starteVerknuepfung({ klasseId, angefragtVonId, vorgeschlagenesFach }) {
  const db = getDb();
  const verbundene = ermittleVerbundenePersonen(klasseId);
  verbundene.delete(angefragtVonId); // falls die Person selbst schon verbunden ist, nichts zu klären

  if (verbundene.size === 0) {
    const fachId = fachAnlegenOderFinden(klasseId, vorgeschlagenesFach);
    db.prepare('INSERT OR IGNORE INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)')
      .run(angefragtVonId, fachId);
    return { direkterBeitritt: true, fachId };
  }

  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO klassen_verknuepfungsanfragen (ziel_klasse_id, angefragt_von_id, vorgeschlagenes_fach)
      VALUES (?, ?, ?)
    `).run(klasseId, angefragtVonId, vorgeschlagenesFach);
    const insAntwort = db.prepare(
      'INSERT INTO klassen_verknuepfungsantworten (anfrage_id, user_id) VALUES (?, ?)'
    );
    for (const userId of verbundene) insAntwort.run(info.lastInsertRowid, userId);
    return info.lastInsertRowid;
  });
  return { direkterBeitritt: false, anfrageId: tx() };
}

function fachAnlegenOderFinden(klasseId, name) {
  const db = getDb();
  const bestehend = db.prepare('SELECT id FROM faecher WHERE klasse_id = ? AND name = ?').get(klasseId, name);
  if (bestehend) return bestehend.id;
  return db.prepare('INSERT INTO faecher (klasse_id, name) VALUES (?, ?)').run(klasseId, name).lastInsertRowid;
}

/**
 * Trägt die Antwort einer zustimmungspflichtigen Person ein. Bei Ablehnung
 * wird die Anfrage sofort beendet; sind alle Antworten positiv, wird das
 * Fach angelegt/gefunden und die anfragende Person zugewiesen.
 */
export function beantworteVerknuepfung({ anfrageId, userId, zustimmung }) {
  const db = getDb();
  const anfrage = db.prepare('SELECT * FROM klassen_verknuepfungsanfragen WHERE id = ?').get(anfrageId);
  if (!anfrage || anfrage.status !== 'offen') return null;
  const antwort = db.prepare('SELECT * FROM klassen_verknuepfungsantworten WHERE anfrage_id = ? AND user_id = ?')
    .get(anfrageId, userId);
  if (!antwort) return null; // diese Person muss dieser Anfrage gar nicht zustimmen

  db.prepare(`UPDATE klassen_verknuepfungsantworten SET zustimmung = ?, entschieden_at = datetime('now')
    WHERE id = ?`).run(zustimmung ? 1 : 0, antwort.id);

  if (!zustimmung) {
    db.prepare(`UPDATE klassen_verknuepfungsanfragen SET status = 'abgelehnt', entschieden_at = datetime('now')
      WHERE id = ?`).run(anfrageId);
    return { status: 'abgelehnt' };
  }

  const offene = db.prepare(
    'SELECT COUNT(*) AS c FROM klassen_verknuepfungsantworten WHERE anfrage_id = ? AND zustimmung IS NULL'
  ).get(anfrageId).c;
  if (offene > 0) return { status: 'offen' };

  const fachId = fachAnlegenOderFinden(anfrage.ziel_klasse_id, anfrage.vorgeschlagenes_fach);
  db.prepare('INSERT OR IGNORE INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)')
    .run(anfrage.angefragt_von_id, fachId);
  db.prepare(`UPDATE klassen_verknuepfungsanfragen SET status = 'angenommen', entschieden_at = datetime('now')
    WHERE id = ?`).run(anfrageId);
  return { status: 'angenommen', fachId };
}
