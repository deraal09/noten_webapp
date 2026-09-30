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
import { HALBJAHRE, gesamtnoteJahr, parseTendenzNote, NTG } from './grade-calc.js';
import { userHatFachZgriff, userIstKlassenlehrer } from './auth.js';
import { holeSchuelerId } from './schueler-utils.js';
import { parseSchuljahr } from './schuljahr-utils.js';
import { berechneFachFuerSchueler as berechneSpaFachFuerSchueler } from './spa-noten-service.js';

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
 * Fügt für die EXPLIZIT GENANNTEN Fächer/Lernfelder ein vergangenes
 * Schuljahr hinzu -- je Fach zwei historische Halbjahre ("1./2. Halbjahr
 * <Bezeichnung>"), bereit für die Noteneingabe auf der jeweiligen Fach-Seite
 * (Reiter "Historische Halbjahre"). Die aktuellen Fächer der Klasse werden
 * NICHT automatisch übernommen -- ein vergangenes Schuljahr hatte oft einen
 * ganz anderen Fächerkanon (andere Lernfelder) als das laufende, und ein
 * automatisches Übertragen würde sonst falsche/unerwünschte historische
 * Halbjahre für Fächer anlegen, die es damals gar nicht gab (und die
 * zugehörigen, dafür extra angelegten "rein historischen" Fächer würden
 * fälschlich im laufenden Schuljahr auftauchen, siehe faecher.nur_historisch
 * in src/db.js).
 *
 * Jeder genannte Name wird, falls er zu einem bereits vorhandenen Fach der
 * Klasse passt (egal ob aktuell oder schon früher rein historisch angelegt,
 * z. B. weil dasselbe Lernfeld schon für ein anderes vergangenes Schuljahr
 * genannt wurde), diesem Fach zugeordnet, statt ein Duplikat anzulegen.
 * Fehlt ein passendes Fach, wird es neu als rein historisch angelegt
 * (faecher.nur_historisch = 1). Ein Fach, das dieses Schuljahr schon hat
 * (z. B. weil eine Fachlehrkraft es zuvor selbst für ihr Fach angelegt hat,
 * siehe userDarfHistorischeNotenBearbeiten), wird übersprungen statt
 * Duplikate zu erzeugen.
 *
 * Lehnt ab, wenn gar keine Fächer/Lernfelder genannt wurden, oder wenn es
 * für WIRKLICH JEDES genannte Fach schon existiert (nichts zu tun).
 * @returns {{ok: true, angelegtFuer: string[], uebersprungenFuer: string[], neuAngelegteFaecher: string[]} | {ok: false, fehler: 'bereits-vorhanden'|'keine-faecher'}}
 */
export function fuegeVergangenesSchuljahrHinzu(klasseId, schuljahrBezeichnung, userId, faecherNamen = []) {
  const db = getDb();
  const labels = halbjahrBezeichnungen(schuljahrBezeichnung);

  const namenBereinigt = [...new Set((faecherNamen || []).map((n) => String(n || '').trim()).filter(Boolean))];
  if (namenBereinigt.length === 0) return { ok: false, fehler: 'keine-faecher' };

  const alleFaecher = db.prepare('SELECT id, name FROM faecher WHERE klasse_id = ? ORDER BY name').all(klasseId);
  const neueNamen = namenBereinigt.filter((n) => !alleFaecher.some((f) => f.name === n));
  const kandidaten = namenBereinigt
    .filter((n) => !neueNamen.includes(n))
    .map((n) => alleFaecher.find((f) => f.name === n));

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
  // berechneGesamtnoten in noten-service.js. Ausnahme: ein rein historisches
  // Fach (nur_historisch) hat absichtlich KEINE Teilnehmerliste (siehe
  // fuelleFachTeilnehmerAuf in src/db.js) -- seine historischen Noten hängen
  // stattdessen an allen aktuellen Schüler/innen der Klasse, genau wie beim
  // Eintragen selbst (siehe /historie/:id/speichern).
  const schuelerListe = fach.nur_historisch
    ? db.prepare('SELECT id FROM schueler WHERE klasse_id = ?').all(fach.klasse_id)
    : db.prepare(
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
 * Zu welchen Schuljahren gehören die historischen Halbjahre eines rein
 * historischen Fachs -- neuestes zuerst. Ein Fach wird beim Anlegen eines
 * vergangenen Schuljahres/beim Noten-Import per Name wiederverwendet (siehe
 * fuegeVergangenesSchuljahrHinzu/importiereHistorischeNoten), kann also
 * historische Halbjahre aus MEHREREN Schuljahren tragen -- deshalb eine
 * Liste statt eines einzelnen Schuljahres.
 */
function schuljahreEinesFachs(historischeHalbjahre) {
  const schuljahre = new Set();
  for (const hh of historischeHalbjahre) {
    const treffer = /^[12]\. Halbjahr (.+)$/.exec(hh.bezeichnung);
    schuljahre.add(treffer ? treffer[1] : hh.bezeichnung);
  }
  return Array.from(schuljahre).sort((a, b) => (parseSchuljahr(b)?.startJahr ?? -Infinity) - (parseSchuljahr(a)?.startJahr ?? -Infinity));
}

/**
 * Daten für die Abschluss-/Abgangsübersicht einer Klasse -- zeigt die
 * Fachabschlussnote je Schüler/in und Fach (nur für bereits abgeschlossene
 * Fächer) plus einen Notenschnitt. Ausgelagert aus routes/teacher.js, damit
 * sowohl die eigenständige Seite (/teacher/klassen/:id/abschluss) als auch
 * der gleichnamige Reiter auf der Klassenleitungsübersicht (routes/
 * klassenlehrer.js) dieselbe Logik verwenden.
 *
 * Zeigt bewusst ALLE Fächer der Klasse über die gesamte Schullaufbahn --
 * die aktuellen (laufendes Schuljahr) UND alle rein historischen Fächer
 * vergangener Schuljahre (siehe "Vergangenes Schuljahr hinzufügen"/Noten-
 * Import): eine Fachabschlussnote aus einem vergangenen Schuljahr soll hier
 * genauso erscheinen wie eine aus dem laufenden, statt beim Abgang/Abschluss
 * unvollständig zu wirken. Rein historische Fächer tragen zusätzlich das/die
 * Schuljahr(e) ihrer historischen Halbjahre als Beschriftung.
 */
export function ladeAbschlussuebersicht(klasseId) {
  const db = getDb();
  const schueler = db.prepare('SELECT * FROM schueler WHERE klasse_id = ? ORDER BY nachname, vorname').all(klasseId);
  const aktuelleFaecher = ladeFaecherFuerKlassenleitung(klasseId).map((f) => ({ ...f, schuljahrLabel: null }));

  const historischeHalbjahreProFach = new Map();
  for (const r of db.prepare(`
    SELECT hh.fach_id, hh.bezeichnung FROM historische_halbjahre hh
    JOIN faecher f ON f.id = hh.fach_id
    WHERE f.klasse_id = ? AND f.nur_historisch = 1
  `).all(klasseId)) {
    if (!historischeHalbjahreProFach.has(r.fach_id)) historischeHalbjahreProFach.set(r.fach_id, []);
    historischeHalbjahreProFach.get(r.fach_id).push(r);
  }
  const historischeFaecher = db.prepare('SELECT * FROM faecher WHERE klasse_id = ? AND nur_historisch = 1 ORDER BY name')
    .all(klasseId)
    .map((f) => {
      const schuljahre = schuljahreEinesFachs(historischeHalbjahreProFach.get(f.id) ?? []);
      const schuljahrLabel = schuljahre.length > 1
        ? `${schuljahre[schuljahre.length - 1]}–${schuljahre[0]}`
        : (schuljahre[0] ?? null);
      return { ...f, schuljahrLabel };
    });

  const faecher = [...aktuelleFaecher, ...historischeFaecher];
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
 * Sortierschlüssel eines Zeugnis-Eintrags: Startjahr des Schuljahres, dann
 * Halbjahr -- Einträge ohne erkennbares Schuljahr landen am Ende.
 */
function zeugnisSortierschluessel(schuljahr, halbjahrNr) {
  return [parseSchuljahr(schuljahr)?.startJahr ?? Infinity, halbjahrNr];
}

/**
 * Alle Noten einer einzelnen Person über ALLE Fächer und ALLE Schuljahre --
 * Grundlage des Abgangs-/Abschlusszeugnisses (siehe routes/teacher.js
 * /schueler/:id/abgangszeugnis). Enthalten sind
 *  - alle Fächer, an denen die Person (auch in einer früheren Klasse) teilnimmt,
 *  - alle rein historischen Fächer ihrer Klasse (vergangene Schuljahre) sowie
 *    alle, zu denen sie historische Noten hat.
 * Je Fach gibt es die Einzelnoten (1./2. Halbjahr des laufenden Schuljahres
 * live berechnet, historische Halbjahre, bei SPA-Fächern die Halbjahres-
 * Endpunkte) sowie den aktuellen Stand (Mittelwert wie beim Fach-Abschluss).
 * Ein bereits abgeschlossenes Fach zählt nur mit seiner Abschlussnote.
 * Bleibt bewusst unabhängig vom schueler.status: Noten verschwinden nie,
 * auch nicht nach einem Abgang aus der Klasse (siehe schueler.status in
 * src/db.js).
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
    SELECT f.*, k.name AS klasse_name, sj.bezeichnung AS schuljahr_bezeichnung
    FROM faecher f
    JOIN klassen k ON k.id = f.klasse_id
    JOIN schuljahre sj ON sj.id = k.schuljahr_id
    WHERE f.id IN (
      SELECT fach_id FROM fach_teilnehmer WHERE schueler_id = ?
      UNION SELECT id FROM faecher WHERE klasse_id = ? AND nur_historisch = 1
      UNION SELECT hh.fach_id FROM historische_halbjahre hh
            JOIN historische_noten hn ON hn.historisches_halbjahr_id = hh.id
            WHERE hn.schueler_id = ?
    )
    ORDER BY f.name
  `).all(schuelerId, schueler.klasse_id, schuelerId);

  const zeilen = faecher.map((fach) => {
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
    } else if (!fach.nur_historisch) {
      HALBJAHRE.forEach((hj, i) => {
        const note = berechneGesamtnoten(fach.id, hj).get(schuelerId) ?? null;
        if (note === null) return;
        eintraege.push({
          label: `${hj} ${fach.schuljahr_bezeichnung}`, note, anzeige: null, spa: false,
          sortierung: zeugnisSortierschluessel(fach.schuljahr_bezeichnung, i + 1),
        });
      });
    }
    for (const hh of ladeHistorischeHalbjahre(fach.id)) {
      const note = ladeHistorischeNoten(hh.id).get(schuelerId);
      if (note === undefined || note === null) continue;
      const treffer = /^([12])\. Halbjahr (.+)$/.exec(hh.bezeichnung);
      eintraege.push({
        label: hh.bezeichnung, note, anzeige: null, spa: false,
        sortierung: treffer ? zeugnisSortierschluessel(treffer[2], Number(treffer[1])) : [Infinity, 0],
      });
    }
    eintraege.sort((a, b) => (a.sortierung[0] - b.sortierung[0]) || (a.sortierung[1] - b.sortierung[1]) || 0);

    // SPA-Endpunkte haben keinen Mittelwert über Halbjahre, dort gibt es keinen "Stand".
    const stand = fach.spa_fach_key ? null : gesamtnoteJahr(eintraege.map((e) => e.note));
    const abschlussnote = fach.abgeschlossen ? (ladeAbschlussnoten(fach.id).get(schuelerId) ?? null) : null;
    return { fach, eintraege, stand, abschlussnote };
  });
  return { schueler, zeilen };
}

/**
 * Massenimport historischer Noten für EIN historisches Halbjahr (ein
 * Schuljahr, 1. oder 2. Halbjahr) über MEHRERE Fächer auf einen Schlag, aus
 * einer per Text eingefügten oder als CSV hochgeladenen Tabelle (siehe
 * src/csv-import.js: parseNotenTabelle) -- Spalten sind Nachname/Vorname
 * gefolgt von je einer Spalte pro Fach, z. B. aus einem alten Word-/Excel-
 * Notenspiegel kopiert. Tendenzen ("3+", "2-") werden verworfen (siehe
 * parseTendenzNote in grade-calc.js), da sie im Zeugnis nicht auftauchen.
 *
 * Für jede Fach-Spalte wird das Fach (per Name) und das historische
 * Halbjahr bei Bedarf angelegt -- wie bei fuegeVergangenesSchuljahrHinzu ein
 * neues Fach als nur_historisch, falls es unter diesem Namen noch nicht
 * existiert. Ein Fach, dessen Halbjahr bereits von einer Fachlehrkraft
 * angelegt wurde (siehe userDarfHistorischeNotenBearbeiten), wird
 * übersprungen statt ihre Noten zu überschreiben. Schüler/innen werden per
 * Nachname+Vorname der Klasse zugeordnet (siehe holeSchuelerId) --
 * Namen ohne Treffer werden gemeldet, statt automatisch neue Schüler/innen
 * anzulegen (das ist Sache der normalen Schüler-Verwaltung, nicht dieses
 * reinen Noten-Imports).
 *
 * @returns {{ok: true, faecherNeu: string[], faecherUebersprungen: string[],
 *   notenGespeichert: number, nichtGefundeneSchueler: string[], ungueltigeWerte: string[]}}
 */
export function importiereHistorischeNoten(klasseId, schuljahrBezeichnung, halbjahrNr, tabelle, user) {
  const db = getDb();
  const bezeichnung = `${halbjahrNr}. Halbjahr ${schuljahrBezeichnung}`;
  const klasse = db.prepare('SELECT notenschluessel FROM klassen WHERE id = ?').get(klasseId);
  const [min, max] = klasse.notenschluessel === 'BG' ? [0, 15] : [1, 6];

  const holeFach = db.prepare('SELECT * FROM faecher WHERE klasse_id = ? AND name = ?');
  const insertFach = db.prepare('INSERT INTO faecher (klasse_id, name, nur_historisch) VALUES (?, ?, 1)');
  const holeHalbjahr = db.prepare('SELECT * FROM historische_halbjahre WHERE fach_id = ? AND bezeichnung = ?');
  const zaehleHalbjahre = db.prepare('SELECT COUNT(*) AS c FROM historische_halbjahre WHERE fach_id = ?');
  const insertHalbjahr = db.prepare(`
    INSERT INTO historische_halbjahre (fach_id, bezeichnung, reihenfolge, erstellt_von_id, erstellt_als_fachlehrkraft)
    VALUES (?, ?, ?, ?, ?)
  `);
  const upsertNote = db.prepare(`
    INSERT INTO historische_noten (historisches_halbjahr_id, schueler_id, note)
    VALUES (?, ?, ?)
    ON CONFLICT(historisches_halbjahr_id, schueler_id) DO UPDATE SET note = excluded.note
  `);

  const faecherNeu = [];
  const faecherUebersprungen = [];
  const ungueltigeWerte = [];
  const nichtGefundeneSchueler = new Set();
  let notenGespeichert = 0;

  const tx = db.transaction(() => {
    const spalten = tabelle.fachSpalten.map((name) => {
      let fach = holeFach.get(klasseId, name);
      if (!fach) {
        const info = insertFach.run(klasseId, name);
        fach = { id: info.lastInsertRowid, klasse_id: klasseId, name, nur_historisch: 1 };
        faecherNeu.push(name);
      }
      let hh = holeHalbjahr.get(fach.id, bezeichnung);
      if (!hh) {
        const reihenfolge = zaehleHalbjahre.get(fach.id).c;
        const alsFachlehrkraft = userHatFachZgriff(user, fach.id) ? 1 : 0;
        const info = insertHalbjahr.run(fach.id, bezeichnung, reihenfolge, user.id, alsFachlehrkraft);
        hh = { id: info.lastInsertRowid, fach_id: fach.id, bezeichnung, erstellt_als_fachlehrkraft: alsFachlehrkraft };
      }
      const darfBearbeiten = userDarfHistorischeNotenBearbeiten(user, fach, hh);
      if (!darfBearbeiten) faecherUebersprungen.push(name);
      return { name, hh, darfBearbeiten };
    });

    for (const zeile of tabelle.zeilen) {
      const schuelerId = holeSchuelerId(klasseId, zeile.nachname, zeile.vorname);
      if (!schuelerId) {
        nichtGefundeneSchueler.add(`${zeile.vorname} ${zeile.nachname}`.trim());
        continue;
      }
      for (const spalte of spalten) {
        if (!spalte.darfBearbeiten) continue;
        const roh = zeile.noten[spalte.name];
        const wert = parseTendenzNote(roh);
        if (wert === null) continue; // leer/nicht lesbar -- unverändert lassen
        if (wert !== NTG && (wert < min || wert > max)) {
          ungueltigeWerte.push(`${spalte.name} bei ${zeile.vorname} ${zeile.nachname}: "${roh}"`);
          continue;
        }
        upsertNote.run(spalte.hh.id, schuelerId, wert);
        notenGespeichert++;
      }
    }
  });
  tx();

  return {
    ok: true,
    faecherNeu,
    faecherUebersprungen: [...new Set(faecherUebersprungen)],
    notenGespeichert,
    nichtGefundeneSchueler: [...nichtGefundeneSchueler],
    ungueltigeWerte,
  };
}

/**
 * Historische Entsprechung von ladeHalbjahresuebersicht (noten-sync.js) für
 * die Schuljahr-Auswahl in der Klassenleitungsübersicht: statt des
 * synchronisierten Live-Standes zeigt sie die historischen Noten (siehe
 * historische_halbjahre/-noten) für EIN vergangenes SCHULJAHR -- über BEIDE
 * Halbjahre hinweg (je eine Spalte pro Fach UND Halbjahr, mit Daten), damit
 * die Klassenleitung nicht extra zwischen 1./2. Halbjahr umschalten muss wie
 * bei der laufenden Notentafel. Deckt alle Fächer ab, die für dieses
 * Schuljahr historische Daten haben (aktuelle wie rein historische, siehe
 * faecher.nur_historisch). Rein lesend: Sync-Stand, Sperren, Notizen und
 * Konferenzmodus gibt es für historische Halbjahre nicht, die Bearbeitung
 * läuft weiterhin über die jeweilige Fach-Seite (Reiter "Historische
 * Halbjahre" bzw. /klassenlehrer/fach/:id/historie).
 */
export function ladeHistorischeHalbjahresuebersicht(klasseId, schuljahrBezeichnung) {
  const db = getDb();
  const labels = halbjahrBezeichnungen(schuljahrBezeichnung);
  const schueler = db.prepare('SELECT * FROM schueler WHERE klasse_id = ? ORDER BY nachname, vorname').all(klasseId);
  const halbjahre = db.prepare(`
    SELECT hh.id AS hh_id, hh.bezeichnung, f.id AS fach_id, f.name AS fach_name
    FROM historische_halbjahre hh
    JOIN faecher f ON f.id = hh.fach_id
    WHERE f.klasse_id = ? AND hh.bezeichnung IN (?, ?)
    ORDER BY f.name, hh.bezeichnung
  `).all(klasseId, labels[0], labels[1]);
  // Eine Spalte je (Fach, Halbjahr)-Kombination, für die es tatsächlich ein
  // historisches Halbjahr gibt -- ein Fach mit nur einem der beiden
  // Halbjahre bekommt entsprechend auch nur eine Spalte.
  const spalten = halbjahre.map((h) => ({
    hh_id: h.hh_id, fach_id: h.fach_id, fach_name: h.fach_name,
    hjKurz: h.bezeichnung.startsWith('1.') ? '1. Hj' : '2. Hj',
  }));

  const notenByHh = new Map();
  if (spalten.length) {
    const rows = db.prepare(`
      SELECT historisches_halbjahr_id, schueler_id, note FROM historische_noten
      WHERE historisches_halbjahr_id IN (${spalten.map(() => '?').join(',')})
    `).all(...spalten.map((s) => s.hh_id));
    for (const r of rows) {
      if (!notenByHh.has(r.historisches_halbjahr_id)) notenByHh.set(r.historisches_halbjahr_id, new Map());
      notenByHh.get(r.historisches_halbjahr_id).set(r.schueler_id, r.note);
    }
  }

  const zeilen = schueler.map((s) => {
    const noten = spalten.map((sp) => ({ note: notenByHh.get(sp.hh_id)?.get(s.id) ?? null }));
    // typeof-Filter statt nur null/undefined: "ntg" (siehe NTG in
    // grade-calc.js) zählt wie eine fehlende Note nicht in den Schnitt.
    const vorhanden = noten.map((n) => n.note).filter((n) => typeof n === 'number');
    const schnitt = vorhanden.length ? vorhanden.reduce((a, b) => a + b, 0) / vorhanden.length : null;
    return { schueler: s, noten, schnitt };
  });

  return { spalten, zeilen };
}
