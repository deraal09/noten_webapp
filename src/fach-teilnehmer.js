/**
 * Explizite Teilnehmerliste eines Fachs (fach_teilnehmer, siehe src/db.js) --
 * ermöglicht klassenübergreifende Kurse mit nur einem Teil der Schüler/innen
 * einer oder mehrerer Klassen, ohne dass die Kurslehrkraft dafür eine eigene
 * Fake-Klasse anlegen muss. Ein Fach bleibt administrativ an eine
 * "Heimat-Klasse" gebunden (Anlegerecht, Notenschlüssel) — nur die
 * Teilnehmerliste kann über die Heimat-Klasse hinausgehen.
 *
 * ABSICHERUNG GEGEN GEMISCHTE NOTENSCHLÜSSEL: alle Teilnehmer/innen eines
 * Fachs müssen denselben Notenschlüssel (IHK/BG) haben wie die Heimat-Klasse
 * — sonst wären z. B. Klausurpunkte nicht einheitlich in eine Note
 * umrechenbar. Wird beim Hinzufügen geprüft, nicht nachträglich.
 */

import { getDb } from './db.js';
import { DEFAULT_NS_CSV } from './grade-calc.js';
import { findeOderLegeSchuelerAn } from './schueler-utils.js';

/** Befüllt die Teilnehmerliste eines frisch angelegten Fachs mit allen Schüler/innen seiner Heimat-Klasse. */
export function seedeTeilnehmerAusKlasse(fachId, klasseId) {
  const db = getDb();
  const schuelerIds = db.prepare('SELECT id FROM schueler WHERE klasse_id = ?').all(klasseId).map((r) => r.id);
  const ins = db.prepare('INSERT OR IGNORE INTO fach_teilnehmer (fach_id, schueler_id) VALUES (?, ?)');
  for (const id of schuelerIds) ins.run(fachId, id);
}

/**
 * Aktuelle Teilnehmerliste eines Fachs, mit Herkunfts-Klasse je Person.
 * `fremd` ist true, wenn die Person NICHT aus der Heimat-Klasse des Fachs
 * stammt (klassenübergreifender Kurs).
 */
export function ladeTeilnehmerMitHerkunft(fach) {
  return getDb().prepare(`
    SELECT s.id, s.nachname, s.vorname, s.klasse_id, k.name AS klasse_name,
           (s.klasse_id != ?) AS fremd
    FROM fach_teilnehmer ft
    JOIN schueler s ON s.id = ft.schueler_id
    JOIN klassen k ON k.id = s.klasse_id
    WHERE ft.fach_id = ?
    ORDER BY s.nachname, s.vorname
  `).all(fach.klasse_id, fach.id).map((r) => ({ ...r, fremd: Boolean(r.fremd) }));
}

/** Notenschlüssel einer Klasse (für den Mix-Check). */
function notenschluesselVonKlasse(klasseId) {
  return getDb().prepare('SELECT notenschluessel FROM klassen WHERE id = ?').get(klasseId)?.notenschluessel;
}

/**
 * Fügt eine bereits existierende Schüler/in (aus beliebiger Klasse desselben
 * Schuljahres) als Teilnehmer/in hinzu. Lehnt bei unterschiedlichem
 * Notenschlüssel ab, statt Klausurpunkte inkompatibel zu mischen.
 */
export function fuegeTeilnehmerHinzu(fach, schuelerId) {
  const db = getDb();
  const schueler = db.prepare('SELECT * FROM schueler WHERE id = ?').get(schuelerId);
  if (!schueler) return { ok: false, fehler: 'nicht-gefunden' };
  const klasse = db.prepare('SELECT * FROM klassen WHERE id = ?').get(schueler.klasse_id);
  if (klasse.schuljahr_id !== fach.schuljahr_id) return { ok: false, fehler: 'anderes-schuljahr' };
  if (notenschluesselVonKlasse(schueler.klasse_id) !== fach.notenschluessel) {
    return { ok: false, fehler: 'notenschluessel' };
  }
  const bereits = db.prepare('SELECT 1 FROM fach_teilnehmer WHERE fach_id = ? AND schueler_id = ?')
    .get(fach.id, schuelerId);
  if (bereits) return { ok: false, fehler: 'bereits-teilnehmer' };
  db.prepare('INSERT INTO fach_teilnehmer (fach_id, schueler_id) VALUES (?, ?)').run(fach.id, schuelerId);
  return { ok: true };
}

/** Entfernt eine Person aus der Teilnehmerliste (löscht NICHT den Schüler-Datensatz selbst). */
export function entferneTeilnehmer(fachId, schuelerId) {
  getDb().prepare('DELETE FROM fach_teilnehmer WHERE fach_id = ? AND schueler_id = ?').run(fachId, schuelerId);
}

/**
 * Suche nach Name ODER Klasse über alle Klassen desselben Schuljahres wie
 * das Fach — für "Teilnehmer/in hinzufügen". Bereits Teilnehmende werden
 * ausgeblendet, Klassen mit abweichendem Notenschlüssel werden mitangezeigt
 * (aber beim Hinzufügen von fuegeTeilnehmerHinzu() abgelehnt), damit die
 * Fehlermeldung nachvollziehbar ist statt der Person einfach zu fehlen.
 */
export function sucheSchuelerFuerFach(fach, suchtext) {
  const q = String(suchtext || '').trim();
  if (!q) return [];
  const like = `%${q.toLowerCase()}%`;
  return getDb().prepare(`
    SELECT s.id, s.nachname, s.vorname, s.klasse_id, k.name AS klasse_name, k.notenschluessel
    FROM schueler s
    JOIN klassen k ON k.id = s.klasse_id
    WHERE k.schuljahr_id = ?
      AND NOT EXISTS (SELECT 1 FROM fach_teilnehmer ft WHERE ft.fach_id = ? AND ft.schueler_id = s.id)
      AND (LOWER(s.nachname) LIKE ? OR LOWER(s.vorname) LIKE ? OR LOWER(k.name) LIKE ?)
    ORDER BY s.nachname, s.vorname
    LIMIT 30
  `).all(fach.schuljahr_id, fach.id, like, like, like);
}

/**
 * Prüft, ob eine Klasse gefahrlos auf einen anderen Notenschlüssel
 * umgestellt werden kann -- d. h. ob das eine bestehende
 * klassenübergreifende Teilnahme (fach_teilnehmer) inkompatibel machen
 * würde. Zwei Richtungen sind möglich:
 *  a) Ein eigenes Fach dieser Klasse hat Teilnehmer/innen aus einer
 *     anderen Klasse mit dem BISHERIGEN (nicht dem neuen) Notenschlüssel.
 *  b) Eigene Schüler/innen dieser Klasse nehmen an einem Fach einer
 *     ANDEREN Klasse teil, deren Notenschlüssel dem neuen Wert nicht
 *     entspräche.
 * Gibt { ok: true } oder { ok: false, konflikte: string[] } zurück --
 * die Konflikte sind für eine Fehlermeldung aufbereitete Klassen-/Fachnamen.
 */
export function pruefeNotenschluesselWechsel(klasseId, neuerNotenschluessel) {
  const db = getDb();
  const konflikte = [];

  const fremdeInEigenenFaechern = db.prepare(`
    SELECT DISTINCT f.name AS fach_name, k2.name AS klasse_name
    FROM faecher f
    JOIN fach_teilnehmer ft ON ft.fach_id = f.id
    JOIN schueler s ON s.id = ft.schueler_id
    JOIN klassen k2 ON k2.id = s.klasse_id
    WHERE f.klasse_id = ? AND k2.id != ? AND k2.notenschluessel != ?
  `).all(klasseId, klasseId, neuerNotenschluessel);
  for (const r of fremdeInEigenenFaechern) {
    konflikte.push(`„${r.fach_name}" hat Teilnehmer/innen aus „${r.klasse_name}"`);
  }

  const eigeneInFremdenFaechern = db.prepare(`
    SELECT DISTINCT f.name AS fach_name, k2.name AS klasse_name
    FROM fach_teilnehmer ft
    JOIN schueler s ON s.id = ft.schueler_id
    JOIN faecher f ON f.id = ft.fach_id
    JOIN klassen k2 ON k2.id = f.klasse_id
    WHERE s.klasse_id = ? AND k2.id != ? AND k2.notenschluessel != ?
  `).all(klasseId, klasseId, neuerNotenschluessel);
  for (const r of eigeneInFremdenFaechern) {
    konflikte.push(`eigene Schüler/innen nehmen an „${r.fach_name}" (Klasse „${r.klasse_name}") teil`);
  }

  return konflikte.length ? { ok: false, konflikte } : { ok: true };
}

/**
 * Manuelles Hinzufügen: Nachname/Vorname/Klassenname. Existiert die Klasse
 * im Schuljahr des Fachs schon, wird sie (mit Notenschlüssel-Check)
 * verwendet; sonst wird sie als leere Hülle NEU angelegt (Notenschlüssel
 * vom Fach übernommen -- ein Mix kann dadurch gar nicht erst entstehen).
 * Eine später beitretende echte Klassenleitung findet diese Klasse dann
 * schon vor und muss nur noch die übrigen Schüler/innen ergänzen.
 */
export function legeManuellenTeilnehmerAn(fach, { nachname, vorname, klassenName }) {
  const n = String(nachname || '').trim();
  const v = String(vorname || '').trim();
  const kn = String(klassenName || '').trim();
  if (!n || !v || !kn) return { ok: false, fehler: 'pflichtfelder' };

  const db = getDb();
  let klasse = db.prepare('SELECT * FROM klassen WHERE schuljahr_id = ? AND name = ?')
    .get(fach.schuljahr_id, kn);
  if (klasse && klasse.notenschluessel !== fach.notenschluessel) {
    return { ok: false, fehler: 'notenschluessel' };
  }
  if (!klasse) {
    const ns = fach.notenschluessel;
    const info = db.prepare(`
      INSERT INTO klassen (schuljahr_id, name, notenschluessel, notenschluessel_csv)
      VALUES (?, ?, ?, ?)
    `).run(fach.schuljahr_id, kn, ns, DEFAULT_NS_CSV[ns] || '');
    klasse = { id: info.lastInsertRowid };
  }

  const schuelerId = findeOderLegeSchuelerAn(klasse.id, n, v);
  const bereits = db.prepare('SELECT 1 FROM fach_teilnehmer WHERE fach_id = ? AND schueler_id = ?')
    .get(fach.id, schuelerId);
  if (bereits) return { ok: false, fehler: 'bereits-teilnehmer' };
  db.prepare('INSERT INTO fach_teilnehmer (fach_id, schueler_id) VALUES (?, ?)').run(fach.id, schuelerId);
  return { ok: true, schuelerId };
}
