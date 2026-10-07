/**
 * Fachabschluss: Ein Fach gilt als abgeschlossen, sobald sein letztes Halbjahr
 * (siehe faecher.halbjahre) vergangen ist -- ohne Knopfdruck. Die
 * Fachabschlussnote je Schüler/in ist der Mittelwert aus allen Halbjahren,
 * in denen das Fach gilt --
 * aus Klausuren/Unterrichtsleistung berechnet oder per direkter Endnote
 * eingetragen (siehe src/halbjahr-endnoten.js).
 */

import { sortiereNachName } from './format.js';
import { lehrkraefteDesFachs } from './unterfaecher.js';
import { getDb } from './db.js';
import { berechneGesamtnoten, ladeFaecherFuerKlassenleitung } from './noten-service.js';
import { gesamtnoteJahr, NTG } from './grade-calc.js';
import { mitAbschlussStatus, klassenLaufzeit, schuljahrDesHalbjahrs, fachHalbjahrNummern, halbjahrText } from './klassen-jahre.js';
import { ladeEndnoten } from './halbjahr-endnoten.js';
import { parseSchuljahr } from './schuljahr-utils.js';
import { berechneFachFuerSchueler as berechneSpaFachFuerSchueler } from './spa-noten-service.js';

/**
 * Fachabschlussnoten als Map<schueler_id, note>: Mittelwert aus allen
 * Halbjahren des Fachs (berechnet oder direkt eingetragen), live berechnet.
 * `fach` braucht id, klasse_id und halbjahre.
 */
export function ladeAbschlussnoten(fach) {
  const db = getDb();
  const schuelerListe = db.prepare('SELECT schueler_id AS id FROM fach_teilnehmer WHERE fach_id = ?').all(fach.id);
  const laufzeit = klassenLaufzeit(fach.klasse_id);
  const hjNotenMaps = fachHalbjahrNummern(fach, laufzeit).map((nr) => berechneGesamtnoten(fach.id, halbjahrText(nr)));
  return new Map(schuelerListe.map((s) => [s.id, gesamtnoteJahr(hjNotenMaps.map((m) => m.get(s.id) ?? null))]));
}

/**
 * Beschriftung der Halbjahre eines Fachs, wenn es nicht in allen Halbjahren
 * der Klasse gilt (z. B. "3.–4. Halbjahr, 2026/27"); sonst null.
 */
function fachHalbjahrLabel(fach, laufzeit) {
  const nummern = fachHalbjahrNummern(fach, laufzeit);
  if (nummern.length === laufzeit.anzahlHalbjahre) return null;
  const von = nummern[0];
  const bis = nummern[nummern.length - 1];
  const zusammenhaengend = bis - von + 1 === nummern.length;
  const bereich = zusammenhaengend ? (von === bis ? `${von}. Halbjahr` : `${von}.–${bis}. Halbjahr`) : nummern.map((n) => `${n}.`).join(', ') + ' Halbjahr';
  const sjVon = schuljahrDesHalbjahrs(laufzeit, von);
  const sjBis = schuljahrDesHalbjahrs(laufzeit, bis);
  return `${bereich}, ${sjVon === sjBis ? sjVon : `${sjVon}–${sjBis}`}`;
}

/**
 * Daten für die Abschluss-/Abgangsübersicht einer Klasse -- zeigt die
 * Fachabschlussnote je Schüler/in und Fach (nur für bereits abgeschlossene
 * Fächer) plus einen Notenschnitt. Ausgelagert aus routes/teacher.js, damit
 * sowohl die eigenständige Seite (/teacher/klassen/:id/abschluss) als auch
 * der gleichnamige Reiter auf der Klassenleitungsübersicht (routes/
 * klassenlehrer.js) dieselbe Logik verwenden.
 *
 * Zeigt ALLE Fächer der Klasse über die gesamte Laufzeit (auch solche, die
 * nur in einzelnen Halbjahren gelten, mit Beschriftung der Halbjahre).
 */
export function ladeAbschlussuebersicht(klasseId) {
  const db = getDb();
  const schueler = db.prepare('SELECT * FROM schueler WHERE klasse_id = ? ORDER BY nachname, vorname').all(klasseId);
  const laufzeit = klassenLaufzeit(klasseId);
  const faecher = ladeFaecherFuerKlassenleitung(klasseId).map((f) => ({ ...f, schuljahrLabel: fachHalbjahrLabel(f, laufzeit), lehrkraefte: lehrkraefteDesFachs(f, null, laufzeit) }));
  const abschlussByFach = new Map(faecher.map((f) => [f.id, f.abgeschlossen ? ladeAbschlussnoten(f) : new Map()]));

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
 * Sortierschlüssel eines Zeugnis-Eintrags: Startjahr des Schuljahres, dann
 * Halbjahr -- Einträge ohne erkennbares Schuljahr landen am Ende.
 */
function zeugnisSortierschluessel(schuljahr, halbjahrNr) {
  return [parseSchuljahr(schuljahr)?.startJahr ?? Infinity, halbjahrNr];
}

/**
 * Alle Fächer, die zum Zeugnis einer Person gehören -- über alle Schuljahre:
 *  - Fächer, an denen sie (auch in einer früheren Klasse) teilnimmt,
 * Mit Klasse und Schuljahr des Fachs (klasse_name, schuljahr_bezeichnung).
 */
export function ladeFaecherEinerPerson(schuelerId) {
  return sortiereNachName(getDb().prepare(`
    SELECT f.*, k.name AS klasse_name, k.notenschluessel, sj.bezeichnung AS schuljahr_bezeichnung
    FROM faecher f
    JOIN klassen k ON k.id = f.klasse_id
    JOIN schuljahre sj ON sj.id = k.schuljahr_id
    WHERE f.id IN (SELECT fach_id FROM fach_teilnehmer WHERE schueler_id = ?)
      AND f.parent_fach_id IS NULL
  `).all(schuelerId).map(mitAbschlussStatus));
}

/**
 * Einzelnoten einer Person in EINEM Fach (chronologisch), der aktuelle Stand
 * (Mittelwert wie beim Fach-Abschluss) und -- bei abgeschlossenem Fach -- die
 * Abschlussnote. `fach` braucht schuljahr_bezeichnung (siehe ladeFaecherEinerPerson).
 * 1./2. Halbjahr des laufenden Schuljahres werden live berechnet, bei
 * SPA-Fächern kommen die Halbjahres-Endpunkte (Punkte 0-15, `spa: true`).
 */
export function ladeFachNotenEintraege(fach, schuelerId) {
  const db = getDb();
  const eintraege = [];
  if (fach.spa_fach_key) {
    for (const e of berechneSpaFachFuerSchueler(db, fach.id, schuelerId)) {
      if (e.endpunkte === null) continue;
      eintraege.push({
        label: `${e.halbjahr}. Halbjahr (SPA, ${fach.schuljahr_bezeichnung})`,
        note: e.endpunkte, anzeige: `${e.endpunkte.toFixed(2)} (${e.tendenz})`, spa: true,
        sortierung: zeugnisSortierschluessel(fach.schuljahr_bezeichnung, e.halbjahr),
      });
    }
  } else {
    // Je Halbjahr, in dem das Fach gilt: berechnete bzw. direkt eingetragene Endnote ("ntg" = nicht teilgenommen).
    const laufzeit = klassenLaufzeit(fach.klasse_id);
    for (const nr of fachHalbjahrNummern(fach, laufzeit)) {
      const hj = halbjahrText(nr);
      let note = berechneGesamtnoten(fach.id, hj).get(schuelerId) ?? null;
      if (note === null && ladeEndnoten(fach.id, hj).get(schuelerId)?.ntg) note = NTG;
      if (note === null) continue;
      const schuljahr = schuljahrDesHalbjahrs(laufzeit, nr) ?? fach.schuljahr_bezeichnung;
      eintraege.push({
        label: `${hj} ${schuljahr}`, note, anzeige: null, spa: false,
        sortierung: zeugnisSortierschluessel(schuljahr, nr),
      });
    }
  }
  eintraege.sort((a, b) => (a.sortierung[0] - b.sortierung[0]) || (a.sortierung[1] - b.sortierung[1]) || 0);

  // SPA-Endpunkte haben keinen Mittelwert über Halbjahre, dort gibt es keinen "Stand".
  const stand = fach.spa_fach_key ? null : gesamtnoteJahr(eintraege.map((e) => e.note));
  const abschlussnote = fach.abgeschlossen ? (ladeAbschlussnoten(fach).get(schuelerId) ?? null) : null;
  return { eintraege, stand, abschlussnote };
}

/**
 * Alle Noten einer einzelnen Person über ALLE Fächer und ALLE Schuljahre --
 * Grundlage des Abgangs-/Abschlusszeugnisses (siehe routes/teacher.js
 * /schueler/:id/abgangszeugnis). Je Fach gibt es die Einzelnoten plus den
 * aktuellen Stand; ein bereits abgeschlossenes Fach zählt nur mit seiner
 * Abschlussnote (siehe ladeFachNotenEintraege). Bleibt bewusst unabhängig
 * vom schueler.status: Noten verschwinden nie, auch nicht nach einem Abgang
 * aus der Klasse (siehe schueler.status in src/db.js).
 */
export function ladeAbgangszeugnisDaten(schuelerIdParam) {
  const db = getDb();
  // Kommt üblicherweise als String aus request.params -- die Gesamtnoten-Maps
  // sind aber mit dem numerischen schueler_id aus der DB geschlüsselt
  // (Map.get() vergleicht strikt, "1" würde 1 dort NIE treffen).
  const schuelerId = Number(schuelerIdParam);
  const schueler = db.prepare('SELECT s.*, k.name AS klasse_name FROM schueler s JOIN klassen k ON k.id = s.klasse_id WHERE s.id = ?').get(schuelerId);
  if (!schueler) return null;
  const zeilen = ladeFaecherEinerPerson(schuelerId)
    .map((fach) => ({ fach, ...ladeFachNotenEintraege(fach, schuelerId) }));
  return { schueler, zeilen };
}
