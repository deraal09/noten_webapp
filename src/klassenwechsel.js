/**
 * Klassenwechsel einzelner Schüler/innen und Klasse löschen, ohne die
 * Personen zu verlieren.
 *
 * Noten (aktuelle wie historische) hängen am Schüler-Datensatz, nicht an
 * der Klasse -- ein Versetzen ändert deshalb nur die Klassenzuordnung der
 * Person. Die Teilnahmen an den Fächern der bisherigen Klasse bleiben
 * bewusst bestehen (wie beim Abgang, siehe /schueler/:id/abgang), damit
 * Notentafeln, die Notenhistorie und das Abgangszeugnis nichts verlieren.
 */

import { getDb } from './db.js';
import { DEFAULT_NS_CSV } from './grade-calc.js';
import { holeSchuelerId } from './schueler-utils.js';

export const ABLAGE_KLASSENNAME = 'Ohne Klasse';

/**
 * Sammelklasse "Ohne Klasse" des Schuljahres -- wird bei Bedarf angelegt.
 * Sie hat nie Fächer, der Notenschlüssel ist daher nur ein Platzhalter.
 */
export function findeOderLegeAblageKlasseAn(schuljahrId) {
  const db = getDb();
  const vorhanden = db.prepare('SELECT * FROM klassen WHERE schuljahr_id = ? AND ist_ablage = 1').get(schuljahrId);
  if (vorhanden) return vorhanden;
  // Der Name ist pro Schuljahr eindeutig: eine echte Klasse, die schon so
  // heißt, bekommt einen Zähler angehängt statt die Anlage scheitern zu lassen.
  let name = ABLAGE_KLASSENNAME;
  for (let i = 2; db.prepare('SELECT 1 FROM klassen WHERE schuljahr_id = ? AND name = ?').get(schuljahrId, name); i += 1) {
    name = `${ABLAGE_KLASSENNAME} ${i}`;
  }
  const info = db.prepare(`
    INSERT INTO klassen (schuljahr_id, name, notenschluessel, notenschluessel_csv, ist_ablage)
    VALUES (?, ?, 'IHK', ?, 1)
  `).run(schuljahrId, name, DEFAULT_NS_CSV.IHK || '');
  return db.prepare('SELECT * FROM klassen WHERE id = ?').get(info.lastInsertRowid);
}

/**
 * Darf eine Person von `quelle` nach `ziel` wechseln? Die Sammelklasse "Ohne
 * Klasse" ist mit jeder Klasse verträglich (auch SPA), da sie keine Fächer
 * und Noten hat. Zwischen echten Klassen müssen Notenschlüssel -- bei SPA
 * zusätzlich der Bildungsgang -- übereinstimmen.
 */
function verschiebbar(quelle, ziel) {
  if (quelle.ist_ablage || ziel.ist_ablage) return true;
  if (quelle.notenschluessel !== ziel.notenschluessel) return false;
  return quelle.notenschluessel !== 'SPA' || (quelle.spa_bildungsgang ?? '') === (ziel.spa_bildungsgang ?? '');
}

/**
 * Klassen, in die Personen aus `quellKlasse` versetzt werden können: alle
 * verträglichen echten Klassen (auch anderer Schuljahre, siehe verschiebbar)
 * plus die Sammelklasse "Ohne Klasse".
 */
export function ladeVersetzZiele(quellKlasse) {
  return getDb().prepare(`
    SELECT k.id, k.name, k.ist_ablage, k.notenschluessel, k.spa_bildungsgang, s.bezeichnung AS schuljahr_bezeichnung
    FROM klassen k JOIN schuljahre s ON s.id = k.schuljahr_id
    WHERE k.ist_kurs_huelle = 0 AND k.id != ?
    ORDER BY s.bezeichnung DESC, k.name
  `).all(quellKlasse.id).filter((k) => verschiebbar(quellKlasse, k));
}

/**
 * Versetzt eine Person in eine andere Klasse. `zielKlasseId` darf
 * 'ohne-klasse' sein: dann wird die Sammelklasse des Schuljahres der
 * bisherigen Klasse verwendet.
 *
 * @returns {{ok: true, zielKlasseId: number} | {ok: false, fehler: string}}
 */
export function versetzeSchueler(schuelerId, zielKlasseId) {
  const db = getDb();
  const schueler = db.prepare('SELECT * FROM schueler WHERE id = ?').get(schuelerId);
  if (!schueler) return { ok: false, fehler: 'schueler-unbekannt' };
  if (schueler.status === 'abgang') return { ok: false, fehler: 'abgang' };
  const quelle = db.prepare('SELECT * FROM klassen WHERE id = ?').get(schueler.klasse_id);

  const ziel = zielKlasseId === 'ohne-klasse'
    ? findeOderLegeAblageKlasseAn(quelle.schuljahr_id)
    : db.prepare('SELECT * FROM klassen WHERE id = ? AND ist_kurs_huelle = 0').get(zielKlasseId);
  if (!ziel) return { ok: false, fehler: 'ziel-unbekannt' };
  if (ziel.id === quelle.id) return { ok: false, fehler: 'gleiche-klasse' };
  if (!verschiebbar(quelle, ziel)) return { ok: false, fehler: 'notenschluessel' };
  if (holeSchuelerId(ziel.id, schueler.nachname, schueler.vorname) !== null) {
    return { ok: false, fehler: 'name-vergeben' };
  }

  db.transaction(() => {
    db.prepare('UPDATE schueler SET klasse_id = ? WHERE id = ?').run(ziel.id, schueler.id);
    // Wie bei einer neu angelegten Person: Teilnehmer/in aller aktuellen
    // Fächer der neuen Klasse.
    const ins = db.prepare('INSERT OR IGNORE INTO fach_teilnehmer (fach_id, schueler_id) VALUES (?, ?)');
    for (const f of db.prepare('SELECT id FROM faecher WHERE klasse_id = ? AND nur_historisch = 0').all(ziel.id)) {
      ins.run(f.id, schueler.id);
    }
  })();
  return { ok: true, zielKlasseId: ziel.id };
}

/**
 * Löscht eine Klasse samt Fächern und Noten, rettet aber vorher alle
 * Schüler/innen (nur die Person selbst, keine Noten der gelöschten Fächer)
 * in die Sammelklasse "Ohne Klasse" des Schuljahres. Die Sammelklasse selbst
 * wird ohne Rettung gelöscht.
 *
 * @returns {{gerettet: number, ablageKlasseId: number | null}}
 */
export function loescheKlasseMitSchuelerUebernahme(klasseId, userId) {
  const db = getDb();
  const klasse = db.prepare('SELECT * FROM klassen WHERE id = ?').get(klasseId);
  if (!klasse) return { gerettet: 0, ablageKlasseId: null };

  return db.transaction(() => {
    let gerettet = 0;
    let ablageKlasseId = null;
    if (!klasse.ist_ablage) {
      const anzahl = db.prepare('SELECT COUNT(*) AS c FROM schueler WHERE klasse_id = ?').get(klasseId).c;
      if (anzahl > 0) {
        const ablage = findeOderLegeAblageKlasseAn(klasse.schuljahr_id);
        ablageKlasseId = ablage.id;
        // Wer die Klasse löscht, muss die Geretteten auch weiterverschieben
        // können -- dafür wird die Person Klassenleitung der Sammelklasse.
        if (userId) db.prepare('INSERT OR IGNORE INTO klassenleitung (klasse_id, user_id) VALUES (?, ?)').run(ablage.id, userId);
        gerettet = db.prepare('UPDATE schueler SET klasse_id = ? WHERE klasse_id = ?').run(ablage.id, klasseId).changes;
      }
    }
    db.prepare('DELETE FROM klassen WHERE id = ?').run(klasseId);
    return { gerettet, ablageKlasseId };
  })();
}

/**
 * Alle Personen, die aktuell in einer Sammelklasse "Ohne Klasse" stehen
 * (über alle Schuljahre) -- Auswahlliste für den Reiter "Aus Ohne Klasse
 * übernehmen" auf der Klassenseite.
 */
export function ladeAblagePersonen() {
  return getDb().prepare(`
    SELECT s.id, s.nachname, s.vorname, s.status, sj.bezeichnung AS schuljahr_bezeichnung
    FROM schueler s
    JOIN klassen k ON k.id = s.klasse_id
    JOIN schuljahre sj ON sj.id = k.schuljahr_id
    WHERE k.ist_ablage = 1
    ORDER BY s.nachname, s.vorname, sj.bezeichnung
  `).all();
}

/**
 * Übernimmt ausgewählte Personen aus einer Sammelklasse in die Zielklasse
 * (wie versetzeSchueler, aber nur für Personen, die tatsächlich in einer
 * Sammelklasse stehen -- über diesen Weg darf keine Person aus einer echten
 * fremden Klasse gezogen werden).
 *
 * @returns {{uebernommen: number, fehler: string[]}} fehler: Namen der nicht übernommenen Personen
 */
export function uebernehmeAusAblage(zielKlasseId, schuelerIds) {
  const db = getDb();
  let uebernommen = 0;
  const fehler = [];
  for (const id of schuelerIds) {
    const person = db.prepare(`
      SELECT s.* FROM schueler s JOIN klassen k ON k.id = s.klasse_id
      WHERE s.id = ? AND k.ist_ablage = 1
    `).get(id);
    if (!person) continue;
    const ergebnis = versetzeSchueler(person.id, zielKlasseId);
    if (ergebnis.ok) uebernommen += 1;
    else fehler.push(`${person.nachname}, ${person.vorname}`);
  }
  return { uebernommen, fehler };
}
