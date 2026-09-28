/**
 * Fachabschluss: optionales Abschließen eines Fachs (manche Fächer laufen
 * über mehrere Schuljahre und werden nie abgeschlossen). Beim Abschließen
 * wird je Schüler/in eine Fachabschlussnote als Mittelwert aus allen
 * vorhandenen Halbjahren dieses Fachs berechnet — den aktuellen 1./2.
 * Halbjahr (live berechnet) UND allen historischen Halbjahren (siehe
 * historische_halbjahre/-noten, für Noten von vor Einführung dieser App).
 */

import { getDb } from './db.js';
import { berechneGesamtnoten, ladeFaecherFuerKlassenleitung } from './noten-service.js';
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

/**
 * Bezeichnungen der beiden Halbjahre eines Schuljahres, wie sie als
 * historisches Halbjahr angelegt werden (z. B. "1. Halbjahr 2022/23").
 */
function halbjahrBezeichnungen(schuljahrBezeichnung) {
  return [`1. Halbjahr ${schuljahrBezeichnung}`, `2. Halbjahr ${schuljahrBezeichnung}`];
}

/**
 * Für eine Klasse bereits hinterlegte vergangene Schuljahre (über
 * historische Halbjahre irgendeines ihrer Fächer), samt der Fächer, für die
 * es schon eingetragen ist -- für die Übersicht in der
 * Klassenleitungsübersicht (siehe fuegeVergangenesSchuljahrHinzu). Neueste
 * zuerst. Bezeichnungen, die nicht dem "1./2. Halbjahr <Schuljahr>"-Schema
 * folgen (z. B. manuell frei eingetragene Altdaten von vor dieser
 * Funktion), werden unverändert als eigener Eintrag geführt.
 */
export function ladeVergangeneSchuljahre(klasseId) {
  const rows = getDb().prepare(`
    SELECT hh.bezeichnung, f.id AS fach_id, f.name AS fach_name
    FROM historische_halbjahre hh
    JOIN faecher f ON f.id = hh.fach_id
    WHERE f.klasse_id = ?
    ORDER BY f.name
  `).all(klasseId);

  const proSchuljahr = new Map();
  for (const r of rows) {
    const treffer = /^[12]\. Halbjahr (.+)$/.exec(r.bezeichnung);
    const schuljahr = treffer ? treffer[1] : r.bezeichnung;
    if (!proSchuljahr.has(schuljahr)) proSchuljahr.set(schuljahr, new Map());
    proSchuljahr.get(schuljahr).set(r.fach_id, r.fach_name); // Map dedupliziert über beide Halbjahre hinweg
  }
  return Array.from(proSchuljahr.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([schuljahr, faecherMap]) => ({
      schuljahr,
      faecher: Array.from(faecherMap.entries()).map(([id, name]) => ({ id, name })),
    }));
}

/**
 * Fügt für ALLE Fächer einer Klasse ein vergangenes Schuljahr auf einen
 * Schlag hinzu -- je Fach zwei historische Halbjahre ("1./2. Halbjahr
 * <Bezeichnung>"), bereit für die Noteneingabe auf der jeweiligen
 * Fach-Seite (Reiter "Historische Halbjahre"). Lehnt ab, wenn für diese
 * Klasse (bei irgendeinem ihrer Fächer) schon ein historisches Halbjahr mit
 * dieser Bezeichnung existiert, statt Duplikate oder eine inkonsistente
 * Teilabdeckung zu erzeugen.
 * @returns {{ok: true} | {ok: false, fehler: 'bereits-vorhanden'|'keine-faecher'}}
 */
export function fuegeVergangenesSchuljahrHinzu(klasseId, schuljahrBezeichnung, userId) {
  const db = getDb();
  const labels = halbjahrBezeichnungen(schuljahrBezeichnung);

  const bereitsVorhanden = db.prepare(`
    SELECT 1 FROM historische_halbjahre hh
    JOIN faecher f ON f.id = hh.fach_id
    WHERE f.klasse_id = ? AND hh.bezeichnung IN (?, ?)
  `).get(klasseId, labels[0], labels[1]);
  if (bereitsVorhanden) return { ok: false, fehler: 'bereits-vorhanden' };

  const faecher = db.prepare('SELECT id FROM faecher WHERE klasse_id = ?').all(klasseId);
  if (faecher.length === 0) return { ok: false, fehler: 'keine-faecher' };

  const insert = db.prepare(`
    INSERT INTO historische_halbjahre (fach_id, bezeichnung, reihenfolge, erstellt_von_id)
    VALUES (?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const f of faecher) {
      let reihenfolge = db.prepare('SELECT COUNT(*) AS c FROM historische_halbjahre WHERE fach_id = ?').get(f.id).c;
      for (const label of labels) {
        insert.run(f.id, label, reihenfolge, userId);
        reihenfolge += 1;
      }
    }
  });
  tx();
  return { ok: true };
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
  // Teilnehmerliste statt "alle Schüler/innen der Klasse" -- siehe
  // berechneGesamtnoten in noten-service.js.
  const schuelerListe = db.prepare(
    'SELECT s.id FROM fach_teilnehmer ft JOIN schueler s ON s.id = ft.schueler_id WHERE ft.fach_id = ?'
  ).all(fachId);

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

/**
 * Daten für die Abschluss-/Abgangsübersicht einer Klasse -- zeigt die
 * Fachabschlussnote je Schüler/in und Fach (nur für bereits abgeschlossene
 * Fächer) plus einen Notenschnitt. Ausgelagert aus routes/teacher.js, damit
 * sowohl die eigenständige Seite (/teacher/klassen/:id/abschluss) als auch
 * der gleichnamige Reiter auf der Klassenleitungsübersicht (routes/
 * klassenlehrer.js) dieselbe Logik verwenden.
 */
export function ladeAbschlussuebersicht(klasseId) {
  const db = getDb();
  const schueler = db.prepare('SELECT * FROM schueler WHERE klasse_id = ? ORDER BY nachname, vorname').all(klasseId);
  const faecher = ladeFaecherFuerKlassenleitung(klasseId);
  const abschlussByFach = new Map(faecher.map((f) => [f.id, f.abgeschlossen ? ladeAbschlussnoten(f.id) : new Map()]));

  const zeilen = schueler.map((s) => {
    const noten = faecher.map((f) => ({
      fach: f, note: abschlussByFach.get(f.id).get(s.id) ?? null,
    }));
    const vorhanden = noten.filter((n) => n.fach.abgeschlossen).map((n) => n.note).filter((n) => n !== null && n !== undefined);
    const schnitt = vorhanden.length ? Math.round((vorhanden.reduce((a, b) => a + b, 0) / vorhanden.length) * 100) / 100 : null;
    return { schueler: s, noten, schnitt };
  });

  return { faecher, zeilen };
}

/**
 * Alle Noten einer einzelnen Person über alle Fächer hinweg, in denen sie
 * (aktuell oder ehemals) Teilnehmer/in ist -- Grundlage des Abgangszeugnisses
 * (siehe routes/teacher.js /schueler/:id/abgangszeugnis). Bleibt bewusst
 * unabhängig vom schueler.status: Noten verschwinden nie, auch nicht nach
 * einem Abgang aus der Klasse (siehe schueler.status in src/db.js).
 */
export function ladeAbgangszeugnisDaten(schuelerIdParam) {
  const db = getDb();
  // Kommt üblicherweise als String aus request.params -- die Gesamtnoten-Maps
  // unten sind aber mit dem numerischen schueler_id aus der DB geschlüsselt
  // (Map.get() vergleicht strikt, "1" würde 1 dort NIE treffen).
  const schuelerId = Number(schuelerIdParam);
  const schueler = db.prepare('SELECT s.*, k.name AS klasse_name FROM schueler s JOIN klassen k ON k.id = s.klasse_id WHERE s.id = ?').get(schuelerId);
  if (!schueler) return null;
  const faecher = db.prepare(`
    SELECT f.*, k.name AS klasse_name
    FROM fach_teilnehmer ft
    JOIN faecher f ON f.id = ft.fach_id
    JOIN klassen k ON k.id = f.klasse_id
    WHERE ft.schueler_id = ?
    ORDER BY f.name
  `).all(schuelerId);
  const zeilen = faecher.map((fach) => {
    const hjNoten = HALBJAHRE.map((hj) => ({
      halbjahr: hj, note: berechneGesamtnoten(fach.id, hj).get(schuelerId) ?? null,
    }));
    const historische = ladeHistorischeHalbjahre(fach.id).map((hh) => ({
      bezeichnung: hh.bezeichnung, note: ladeHistorischeNoten(hh.id).get(schuelerId) ?? null,
    }));
    const abschlussnote = fach.abgeschlossen ? (ladeAbschlussnoten(fach.id).get(schuelerId) ?? null) : null;
    return { fach, hjNoten, historische, abschlussnote };
  });
  return { schueler, zeilen };
}
