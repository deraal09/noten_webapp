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
import { userHatFachZgriff, userIstKlassenlehrer } from './auth.js';

/** Historische Halbjahre eines Fachs, älteste zuerst. */
export function ladeHistorischeHalbjahre(fachId) {
  return getDb().prepare(
    'SELECT * FROM historische_halbjahre WHERE fach_id = ? ORDER BY reihenfolge, id'
  ).all(fachId);
}

/**
 * Darf diese Person die Noten EINES BESTIMMTEN historischen Halbjahres
 * eintragen? Eine dem Fach zugewiesene Lehrkraft darf das immer. Die
 * Klassenleitung nur, wenn sie dieses Halbjahr klassenweit angelegt hat
 * ("Vergangenes Schuljahr hinzufügen", erstellt_als_fachlehrkraft = 0) --
 * hat stattdessen eine Fachlehrkraft es für ihr eigenes Fach selbst
 * angelegt, sieht die Klassenleitung es nur noch an, ändert aber nichts
 * mehr daran (siehe historische_halbjahre in src/db.js).
 */
export function userDarfHistorischeNotenBearbeiten(user, fach, historischesHalbjahr) {
  if (userHatFachZgriff(user, fach.id)) return true;
  if (!userIstKlassenlehrer(user, fach.klasse_id)) return false;
  return !historischesHalbjahr.erstellt_als_fachlehrkraft;
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
 * Funktion), werden unverändert als eigener Eintrag geführt. Je Fach zeigt
 * `erstelltAlsFachlehrkraft`, ob eine Fachlehrkraft es selbst angelegt hat
 * (die Klassenleitung sieht die Noten dann nur noch an, siehe
 * userDarfHistorischeNotenBearbeiten) -- oder ob es aus der klassenweiten
 * "Vergangenes Schuljahr hinzufügen"-Aktion stammt (dann bleibt es für die
 * Klassenleitung eintragbar).
 */
export function ladeVergangeneSchuljahre(klasseId) {
  const rows = getDb().prepare(`
    SELECT hh.bezeichnung, hh.erstellt_als_fachlehrkraft, f.id AS fach_id, f.name AS fach_name
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
    const faecherMap = proSchuljahr.get(schuljahr);
    // Ein Fach kann über beide Halbjahre hinweg vorkommen -- sobald EINES
    // davon von einer Fachlehrkraft stammt, gilt das ganze Fach als von ihr
    // verantwortet (beide Halbjahre werden ohnehin gemeinsam angelegt).
    const bisher = faecherMap.get(r.fach_id);
    faecherMap.set(r.fach_id, {
      name: r.fach_name,
      erstelltAlsFachlehrkraft: Boolean(bisher?.erstelltAlsFachlehrkraft) || Boolean(r.erstellt_als_fachlehrkraft),
    });
  }
  return Array.from(proSchuljahr.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([schuljahr, faecherMap]) => ({
      schuljahr,
      faecher: Array.from(faecherMap.entries()).map(([id, info]) => ({ id, ...info })),
    }));
}

/**
 * Fügt für die AKTUELLEN Fächer einer Klasse (nicht: bereits vorhandene rein
 * historische Fächer aus früheren Aufrufen für ANDERE Schuljahre, siehe
 * unten) ein vergangenes Schuljahr hinzu -- je Fach zwei historische
 * Halbjahre ("1./2. Halbjahr <Bezeichnung>"), bereit für die Noteneingabe
 * auf der jeweiligen Fach-Seite (Reiter "Historische Halbjahre"). Fächer,
 * die dieses Schuljahr schon haben (z. B. weil eine Fachlehrkraft es zuvor
 * selbst für ihr Fach angelegt hat, siehe userDarfHistorischeNotenBearbeiten),
 * werden übersprungen statt Duplikate zu erzeugen -- die Klassenleitung
 * ergänzt so gezielt nur die noch fehlenden Fächer.
 *
 * `neueFaecherNamen` deckt den Fall ab, dass die Klasse in diesem
 * vergangenen Schuljahr andere Fächer/Lernfelder hatte als aktuell (z. B.
 * ein inzwischen abgeschafftes Lernfeld) -- dafür werden bei Bedarf neue,
 * rein historische Fächer angelegt (faecher.nur_historisch = 1, siehe
 * src/db.js), die aus den "aktuellen Fächer"-Listen ausgeblendet bleiben.
 * Ein Name, der einem bereits vorhandenen Fach der Klasse entspricht (egal
 * ob aktuell oder rein historisch, z. B. weil dasselbe Lernfeld schon für
 * ein anderes vergangenes Schuljahr angelegt wurde), legt kein Duplikat an,
 * sondern verwendet dieses Fach für dieses Schuljahr mit weiter. Ein rein
 * historisches Fach wird dabei bewusst NUR berücksichtigt, wenn es hier
 * erneut per Name genannt wird -- sonst würde jeder weitere Aufruf (für ein
 * völlig anderes Schuljahr) versehentlich auch längst abgeschlossene
 * Lernfelder wieder aufgreifen.
 *
 * Lehnt nur ab, wenn es für WIRKLICH JEDES betroffene Fach schon existiert
 * (nichts zu tun) oder die Klasse weder aktuelle noch neu zu benennende
 * Fächer hat.
 * @returns {{ok: true, angelegtFuer: string[], uebersprungenFuer: string[], neuAngelegteFaecher: string[]} | {ok: false, fehler: 'bereits-vorhanden'|'keine-faecher'}}
 */
export function fuegeVergangenesSchuljahrHinzu(klasseId, schuljahrBezeichnung, userId, neueFaecherNamen = []) {
  const db = getDb();
  const labels = halbjahrBezeichnungen(schuljahrBezeichnung);

  const alleFaecher = db.prepare('SELECT id, name, nur_historisch FROM faecher WHERE klasse_id = ? ORDER BY name').all(klasseId);
  const aktuelleFaecher = alleFaecher.filter((f) => !f.nur_historisch);
  const alleNamen = new Set(alleFaecher.map((f) => f.name));

  const namenBereinigt = [...new Set((neueFaecherNamen || []).map((n) => String(n || '').trim()).filter(Boolean))];
  const neueNamen = namenBereinigt.filter((n) => !alleNamen.has(n));
  // Ein genannter Name, der zu einem bereits bestehenden rein historischen
  // Fach passt, greift dieses gezielt für das aktuell angefragte Schuljahr
  // wieder auf (z. B. dasselbe Lernfeld über mehrere vergangene Schuljahre
  // hinweg) -- ein bereits aktuelles Fach mit diesem Namen braucht das
  // nicht, das steckt ohnehin schon in aktuelleFaecher.
  const wiederverwendeteHistorische = namenBereinigt
    .filter((n) => !neueNamen.includes(n))
    .map((n) => alleFaecher.find((f) => f.name === n && f.nur_historisch))
    .filter(Boolean);

  const kandidaten = [...aktuelleFaecher, ...wiederverwendeteHistorische];
  if (kandidaten.length === 0 && neueNamen.length === 0) return { ok: false, fehler: 'keine-faecher' };

  const vorhandeneFachIds = new Set(db.prepare(`
    SELECT DISTINCT hh.fach_id FROM historische_halbjahre hh
    JOIN faecher f ON f.id = hh.fach_id
    WHERE f.klasse_id = ? AND hh.bezeichnung IN (?, ?)
  `).all(klasseId, labels[0], labels[1]).map((r) => r.fach_id));

  const fehlendeKandidaten = kandidaten.filter((f) => !vorhandeneFachIds.has(f.id));
  if (fehlendeKandidaten.length === 0 && neueNamen.length === 0) return { ok: false, fehler: 'bereits-vorhanden' };

  const insertFach = db.prepare('INSERT INTO faecher (klasse_id, name, nur_historisch) VALUES (?, ?, 1)');
  const insertHalbjahr = db.prepare(`
    INSERT INTO historische_halbjahre (fach_id, bezeichnung, reihenfolge, erstellt_von_id, erstellt_als_fachlehrkraft)
    VALUES (?, ?, ?, ?, 0)
  `);
  const zaehleHalbjahre = db.prepare('SELECT COUNT(*) AS c FROM historische_halbjahre WHERE fach_id = ?');

  const tx = db.transaction(() => {
    const neuAngelegteFaecher = neueNamen.map((name) => ({ id: insertFach.run(klasseId, name).lastInsertRowid, name }));
    for (const f of [...fehlendeKandidaten, ...neuAngelegteFaecher]) {
      let reihenfolge = zaehleHalbjahre.get(f.id).c;
      for (const label of labels) {
        insertHalbjahr.run(f.id, label, reihenfolge, userId);
        reihenfolge += 1;
      }
    }
    return neuAngelegteFaecher;
  });
  const neuAngelegteFaecher = tx();

  return {
    ok: true,
    angelegtFuer: [...fehlendeKandidaten.map((f) => f.name), ...neuAngelegteFaecher.map((f) => f.name)],
    uebersprungenFuer: kandidaten.filter((f) => vorhandeneFachIds.has(f.id)).map((f) => f.name),
    neuAngelegteFaecher: neuAngelegteFaecher.map((f) => f.name),
  };
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
