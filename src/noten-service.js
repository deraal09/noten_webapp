/**
 * Gemeinsame Notenberechnungs-Helfer, die sowohl die Live-Notentafel
 * (routes/teacher.js) als auch der Sync-Mechanismus (noten-sync.js)
 * brauchen. Ausgelagert, damit beide dieselbe Logik verwenden.
 */

import { getDb } from './db.js';
import {
  noteAusPunkten, gesamtnoteHj, teilNote, unterrichtsleistungNote, nichtBestanden,
  klausurNote, klausurTeilNoten, parseKlausurTeile,
  DEFAULT_GEWICHTUNG, DEFAULT_NS_CSV,
} from './grade-calc.js';
import { muendlichProzentFuerHalbjahr, verrechnungsProzent, wendeVerrechnungAn, halbjahrNr, halbjahrText } from './klassen-jahre.js';
import { ladeEndnoten } from './halbjahr-endnoten.js';
import { unterfaecherImHalbjahr } from './unterfaecher.js';

/** Lädt Unterrichtstermine + eingetragene Noten für ein Fach+Halbjahr (Datumstabelle). */
function ladeUnterrichtTermine(fachId, halbjahr) {
  const db = getDb();
  const termine = db.prepare(
    'SELECT * FROM unterricht_termine WHERE fach_id = ? AND halbjahr = ? ORDER BY datum, id'
  ).all(fachId, halbjahr);
  const noten = new Map(); // schueler_id -> Map<termin_id, wert>
  const na = new Map(); // schueler_id -> Set<termin_id> mit "n.a." (nicht anwesend)
  if (termine.length) {
    const rows = db.prepare(`
      SELECT un.termin_id, un.schueler_id, un.wert, un.nicht_anwesend
      FROM unterricht_noten un
      JOIN unterricht_termine ut ON ut.id = un.termin_id
      WHERE ut.fach_id = ? AND ut.halbjahr = ?
    `).all(fachId, halbjahr);
    for (const r of rows) {
      if (!noten.has(r.schueler_id)) noten.set(r.schueler_id, new Map());
      noten.get(r.schueler_id).set(r.termin_id, r.wert);
      if (r.nicht_anwesend) {
        if (!na.has(r.schueler_id)) na.set(r.schueler_id, new Set());
        na.get(r.schueler_id).add(r.termin_id);
      }
    }
  }
  return { termine, noten, na };
}

/** Eingetragene Datumstabellen-Werte eines/einer Schüler/in (ohne Lücken). */
function datumsWerteFuerSchueler(schuelerId, termine, notenMap) {
  const eigene = notenMap.get(schuelerId);
  if (!eigene) return [];
  const werte = [];
  for (const t of termine) {
    const w = eigene.get(t.id);
    if (w !== null && w !== undefined) werte.push(w);
  }
  return werte;
}

export function ladeFachMitUmfeld(id) {
  return getDb().prepare(`
    SELECT f.*, k.name AS klasse_name, k.schuljahr_id, k.notenschluessel, k.spa_bildungsgang,
           s.bezeichnung AS schuljahr_bezeichnung
    FROM faecher f
    JOIN klassen k ON k.id = f.klasse_id
    JOIN schuljahre s ON s.id = k.schuljahr_id
    WHERE f.id = ?
  `).get(id);
}

/**
 * Fächer, an denen mindestens einer der Schüler/innen dieser Klasse
 * teilnimmt -- für die Klassenleitungs-Übersicht/Abschlussübersicht.
 * Deckt neben den Fächern der eigenen Klasse auch klassenübergreifende
 * Kurse ab, an denen eigene Schüler/innen als Teilnehmer/innen eingetragen
 * sind (siehe fach_teilnehmer), auch wenn deren Heimat-Klasse eine andere
 * ist.
 *
 * Fächer einer FREMDEN Klasse zählen nur im selben Schuljahr (so sind
 * klassenübergreifende Kurse definiert) -- sonst würden die alten Fächer
 * einer versetzten Person (siehe src/klassenwechsel.js) als Spalten in der
 * Übersicht ihrer neuen Klasse auftauchen.
 */
export function ladeFaecherFuerKlassenleitung(klasseId) {
  return getDb().prepare(`
    SELECT DISTINCT f.* FROM faecher f
    JOIN fach_teilnehmer ft ON ft.fach_id = f.id
    JOIN schueler s ON s.id = ft.schueler_id
    JOIN klassen fk ON fk.id = f.klasse_id
    JOIN klassen k ON k.id = s.klasse_id
    WHERE s.klasse_id = ?
      AND (f.klasse_id = s.klasse_id OR fk.schuljahr_id = k.schuljahr_id)
      AND f.parent_fach_id IS NULL
    ORDER BY f.name
  `).all(klasseId);
}

/** Fächer, an denen eine bestimmte Person teilnimmt (für den Konferenzmodus). */
export function ladeFaecherFuerSchueler(schuelerId) {
  return getDb().prepare(`
    SELECT f.* FROM faecher f JOIN fach_teilnehmer ft ON ft.fach_id = f.id
    WHERE ft.schueler_id = ? AND f.parent_fach_id IS NULL ORDER BY f.name
  `).all(schuelerId);
}

export function getNotenschluesselCsv(fach) {
  const k = getDb().prepare('SELECT notenschluessel_csv, notenschluessel FROM klassen WHERE id = ?')
    .get(fach.klasse_id);
  if (k?.notenschluessel_csv) return k.notenschluessel_csv;
  // SPA-Klassen bewerten Klausuren/Unterrichtsleistung in Punkten (0-15): der
  // Punkteschlüssel Prozent -> Punkte entspricht dem der BG; die Tendenznote
  // (1+ ... 6) wird erst daraus berechnet (siehe src/spa-leistung.js). Nur die
  // Zeugnisnoten haben ein eigenes Bewertungssystem.
  return DEFAULT_NS_CSV[k?.notenschluessel === 'SPA' ? 'BG' : k?.notenschluessel] || '';
}

/**
 * Berechnet die Gesamtnote je Schüler/in für ein Fach + Halbjahr — dieselbe
 * Formel wie die Live-Notentafel, aber ohne die Detail-Aufschlüsselung
 * (Klausuren/ULs einzeln), die der Sync-Stand nicht braucht.
 *
 * @returns {Map<number, number|null>} schueler_id -> Gesamtnote
 */
export function berechneGesamtnoten(fachId, halbjahr) {
  const ergebnis = berechneGesamtnotenOhneEndnoten(fachId, halbjahr);
  // Direkt eingetragene Endnoten ersetzen die berechnete Halbjahresnote.
  for (const [schuelerId, e] of ladeEndnoten(fachId, halbjahr)) {
    if (ergebnis.has(schuelerId) || e.note !== null) ergebnis.set(schuelerId, e.ntg ? null : e.note);
  }
  return ergebnis;
}

/**
 * Halbjahresnote aus Klausuren/Unterrichtsleistung INKLUSIVE Verrechnung mit
 * dem Vorhalbjahr (siehe verrechnungsProzent), aber ohne direkt eingetragene
 * Endnoten. Das Vorhalbjahr zählt mit seiner endgültigen Note (also samt
 * dessen Endnote bzw. eigener Verrechnung).
 */
export function berechneGesamtnotenOhneEndnoten(fachId, halbjahr) {
  const roh = berechneRohnoten(fachId, halbjahr);
  const fach = ladeFachMitUmfeld(fachId);
  if (!fach) return roh;
  const prozent = verrechnungsProzent(fach.klasse_id, halbjahr, fach);
  if (!prozent) return roh;
  const vorher = berechneGesamtnoten(fachId, halbjahrText(halbjahrNr(halbjahr) - 1));
  for (const [schuelerId, note] of roh) roh.set(schuelerId, wendeVerrechnungAn(note, vorher.get(schuelerId) ?? null, prozent));
  return roh;
}

/**
 * Unterfächer, aus denen sich das Fach im Halbjahr zusammensetzt (leer = Fach
 * wird direkt bewertet). Ein Unterfach selbst hat nie Unterfächer.
 */
export function unterfaecherDesHalbjahrs(fach, halbjahr) {
  // SPA-Fächer haben ein eigenes Bewertungsmodell: ihre Komponenten-Unterfächer füttern Komponenten, bilden keinen Schnitt.
  if (!fach || fach.parent_fach_id || fach.spa_fach_key) return [];
  const nr = halbjahrNr(halbjahr);
  return nr === null ? [] : unterfaecherImHalbjahr(fach, nr);
}

/** Gewicht eines Unterfachs in der Zusammensetzung (ohne Angabe = 1). */
export function unterfachGewicht(unterfach) {
  return unterfach.gewicht > 0 ? unterfach.gewicht : 1;
}

/**
 * Halbjahresnote eines Fachs mit Unterfächern: gewichteter Schnitt der
 * Unterfach-Halbjahresnoten (jeweils inkl. deren Verrechnung/Endnote); noch
 * nicht benotete Unterfächer zählen nicht mit.
 */
function berechneKompositionsnoten(fach, unterfaecher, halbjahr) {
  const proUnterfach = unterfaecher.map((u) => ({ u, noten: berechneGesamtnoten(u.id, halbjahr) }));
  const teilnehmer = getDb().prepare('SELECT schueler_id FROM fach_teilnehmer WHERE fach_id = ?').all(fach.id);
  const ergebnis = new Map();
  for (const { schueler_id: id } of teilnehmer) {
    ergebnis.set(id, teilNote(proUnterfach.map(({ u, noten }) => ({ note: noten.get(id) ?? null, gewichtung: unterfachGewicht(u) }))));
  }
  return { ergebnis, proUnterfach };
}

/** Rein aus Klausuren/Unterrichtsleistung (bzw. den Unterfächern) berechnete Halbjahresnote (ohne Verrechnung, ohne Endnoten). */
export function berechneRohnoten(fachId, halbjahr) {
  const fach = ladeFachMitUmfeld(fachId);
  const ergebnis = new Map();
  if (!fach) return ergebnis;
  const unterfaecher = unterfaecherDesHalbjahrs(fach, halbjahr);
  if (unterfaecher.length) return berechneKompositionsnoten(fach, unterfaecher, halbjahr).ergebnis;
  const db = getDb();
  // Teilnehmerliste statt "alle Schüler/innen der Klasse" -- deckt sowohl den
  // Normalfall (beim Anlegen mit der ganzen Heimat-Klasse vorbefüllt) als
  // auch klassenübergreifende Kurse mit nur einem Teil der Schüler/innen ab
  // (siehe fach_teilnehmer, src/routes/teacher.js Abschnitt "Teilnehmer").
  const schueler = db.prepare(
    'SELECT s.id FROM fach_teilnehmer ft JOIN schueler s ON s.id = ft.schueler_id WHERE ft.fach_id = ?'
  ).all(fachId);
  const klausuren = db.prepare('SELECT * FROM klausuren WHERE fach_id = ? AND halbjahr = ? ORDER BY id').all(fachId, halbjahr);
  const uls = db.prepare('SELECT * FROM unterrichtsleistungen WHERE fach_id = ? AND halbjahr = ? ORDER BY id').all(fachId, halbjahr);
  const csvStr = getNotenschluesselCsv(fach);
  const ulPct = muendlichProzentFuerHalbjahr(fach.klasse_id, halbjahr, DEFAULT_GEWICHTUNG);
  const schriftlichPct = 100 - ulPct;

  const klausurErgs = new Map();
  for (const k of klausuren) {
    const rows = db.prepare('SELECT schueler_id, punkte FROM klausur_ergebnisse WHERE klausur_id = ?').all(k.id);
    klausurErgs.set(k.id, new Map(rows.map((r) => [r.schueler_id, JSON.parse(r.punkte)])));
  }
  const ulErgs = new Map();
  for (const u of uls) {
    const rows = db.prepare('SELECT schueler_id, punkte FROM ul_ergebnisse WHERE ul_id = ?').all(u.id);
    ulErgs.set(u.id, new Map(rows.map((r) => [r.schueler_id, JSON.parse(r.punkte)])));
  }
  const { termine, noten: terminNoten } = ladeUnterrichtTermine(fachId, halbjahr);

  for (const s of schueler) {
    const klausurData = klausuren.map((k) => {
      const punkte = klausurErgs.get(k.id)?.get(s.id) || null;
      const note = punkte ? klausurNote(punkte, JSON.parse(k.max_punkte_pro_aufgabe), parseKlausurTeile(k.teile), csvStr) : null;
      return { note, gewichtung: k.gewichtung };
    });
    const zusatzleistungen = uls.map((u) => {
      const punkte = ulErgs.get(u.id)?.get(s.id) || null;
      const note = punkte ? noteAusPunkten(punkte, JSON.parse(u.max_punkte_pro_aufgabe), csvStr) : null;
      return { note, gewichtung: u.gewichtung };
    });
    const datumsWerte = datumsWerteFuerSchueler(s.id, termine, terminNoten);
    const { note: muendlicheNote } = unterrichtsleistungNote(datumsWerte, zusatzleistungen);
    const gn = gesamtnoteHj(schriftlichPct, ulPct, klausurData, [{ note: muendlicheNote, gewichtung: 1 }], csvStr);
    ergebnis.set(s.id, gn);
  }
  return ergebnis;
}

/**
 * Gesamtnote EINER Person in einem Fach + Halbjahr (Klausuren + Unterrichts-
 * leistung wie in berechneGesamtnoten, aber nur für diese Person) -- null,
 * solange nichts benotet ist. `halbjahr` ist der Text ("1. Halbjahr" ...).
 * Für SPA-Fächer (siehe src/spa-leistung.js), die für jede Person und jedes
 * der vier Halbjahre gefragt werden: ohne Klausur/UL/Termin sofort null.
 */
export function berechneGesamtnoteEinerPerson(fachId, halbjahr, schuelerId) {
  const db = getDb();
  const vorhanden = db.prepare(`
    SELECT (SELECT COUNT(*) FROM klausuren WHERE fach_id = @f AND halbjahr = @h)
         + (SELECT COUNT(*) FROM unterrichtsleistungen WHERE fach_id = @f AND halbjahr = @h)
         + (SELECT COUNT(*) FROM unterricht_termine WHERE fach_id = @f AND halbjahr = @h) AS c
  `).get({ f: fachId, h: halbjahr }).c;
  if (!vorhanden) return null;
  const fach = ladeFachMitUmfeld(fachId);
  if (!fach) return null;
  const csvStr = getNotenschluesselCsv(fach);
  const ulPct = muendlichProzentFuerHalbjahr(fach.klasse_id, halbjahr, DEFAULT_GEWICHTUNG);

  const klausuren = db.prepare('SELECT * FROM klausuren WHERE fach_id = ? AND halbjahr = ? ORDER BY id').all(fachId, halbjahr);
  const uls = db.prepare('SELECT * FROM unterrichtsleistungen WHERE fach_id = ? AND halbjahr = ? ORDER BY id').all(fachId, halbjahr);
  const punkteVon = (tabelle, spalte, id) => {
    const row = db.prepare(`SELECT punkte FROM ${tabelle} WHERE ${spalte} = ? AND schueler_id = ?`).get(id, schuelerId);
    return row ? JSON.parse(row.punkte) : null;
  };
  const klausurData = klausuren.map((k) => {
    const punkte = punkteVon('klausur_ergebnisse', 'klausur_id', k.id);
    const note = punkte ? klausurNote(punkte, JSON.parse(k.max_punkte_pro_aufgabe), parseKlausurTeile(k.teile), csvStr) : null;
    return { note, gewichtung: k.gewichtung };
  });
  const zusatzleistungen = uls.map((u) => {
    const punkte = punkteVon('ul_ergebnisse', 'ul_id', u.id);
    const note = punkte ? noteAusPunkten(punkte, JSON.parse(u.max_punkte_pro_aufgabe), csvStr) : null;
    return { note, gewichtung: u.gewichtung };
  });
  const { termine, noten: terminNoten } = ladeUnterrichtTermine(fachId, halbjahr);
  const datumsWerte = datumsWerteFuerSchueler(schuelerId, termine, terminNoten);
  const { note: muendlicheNote } = unterrichtsleistungNote(datumsWerte, zusatzleistungen);
  return gesamtnoteHj(100 - ulPct, ulPct, klausurData, [{ note: muendlicheNote, gewichtung: 1 }], csvStr);
}

/**
 * Notenübersicht eines Fachs, das sich im Halbjahr aus Unterfächern
 * zusammensetzt: je Person die Note jedes Unterfachs und die gewichtete
 * Fachnote (inkl. Verrechnung bzw. Endnote). Die Zeilen haben dieselbe Form
 * wie bei direkt bewerteten Fächern, nur ohne Einzelleistungen.
 */
function ladeKompositionsuebersicht(fach, halbjahr, unterfaecher, schueler) {
  const { ergebnis, proUnterfach } = berechneKompositionsnoten(fach, unterfaecher, halbjahr);
  const verrechnungProzent = verrechnungsProzent(fach.klasse_id, halbjahr, fach);
  const vorhalbjahr = verrechnungProzent ? halbjahrText(halbjahrNr(halbjahr) - 1) : null;
  const vorherNoten = verrechnungProzent ? berechneGesamtnoten(fach.id, vorhalbjahr) : new Map();
  const endnoten = ladeEndnoten(fach.id, halbjahr);
  const gesamtGewicht = proUnterfach.reduce((a, { u }) => a + unterfachGewicht(u), 0);
  const rows = schueler.map((s) => {
    const ohneVerrechnung = ergebnis.get(s.id) ?? null;
    const vorherNote = vorherNoten.get(s.id) ?? null;
    const berechnet = wendeVerrechnungAn(ohneVerrechnung, vorherNote, verrechnungProzent);
    const endnote = endnoten.get(s.id) ?? null;
    const gn = endnote ? (endnote.ntg ? null : endnote.note) : berechnet;
    return {
      schueler_id: s.id, nachname: s.nachname, vorname: s.vorname,
      endnote, gesamtBerechnet: berechnet, gesamtOhneVerrechnung: ohneVerrechnung, vorhalbjahrNote: vorherNote,
      herkunftKlasse: s.klasse_id === fach.klasse_id ? null : s.herkunft_klasse_name,
      klausuren: [], uls: [], terminNoten: [], muendlich: [], schriftlich: [],
      schriftlicheNote: null, datumsDurchschnitt: null, naAnzahl: 0, muendlicheNote: null,
      unterfachNoten: proUnterfach.map(({ noten }) => noten.get(s.id) ?? null),
      gesamt: gn,
      nicht_bestanden: gn !== null ? nichtBestanden(gn, fach.notenschluessel === 'SPA' ? 'BG' : fach.notenschluessel) : false,
    };
  });
  return {
    schriftlichPct: 0, ulPct: 0, csvStr: getNotenschluesselCsv(fach), uls: [], termine: [], schueler, rows,
    verrechnung: { prozent: verrechnungProzent, vorhalbjahr }, klausuren: [],
    komposition: {
      unterfaecher: proUnterfach.map(({ u }) => ({
        id: u.id, name: u.name, kurzname: u.kurzname || u.name, gewicht: u.gewicht > 0 ? u.gewicht : null,
        anteil: gesamtGewicht ? Math.round((unterfachGewicht(u) / gesamtGewicht) * 1000) / 10 : 0,
      })),
    },
  };
}

/**
 * Vollständige Notenübersicht für ein Fach + Halbjahr — von der
 * SSR-Erstladung UND der JSON-Live-API (/teacher/fach/:id/noten) genutzt,
 * damit beide exakt dieselben Werte liefern.
 *
 * @returns {{ schriftlichPct: number, ulPct: number, csvStr: string,
 *   rows: Array<{schueler_id, nachname, vorname, klausuren, uls,
 *     muendlich: number[], schriftlich: number[],
 *     schriftlicheNote: number|null, muendlicheNote: number|null,
 *     gesamt: number|null, nicht_bestanden: boolean}> }}
 */
export function ladeNotenuebersicht(fach, halbjahr) {
  const db = getDb();
  // Teilnehmerliste statt "alle Schüler/innen der Klasse" -- siehe
  // berechneGesamtnoten oben. herkunft_klasse_name wird nur für Schüler/innen
  // aus einer ANDEREN Klasse als der Heimat-Klasse des Fachs gebraucht (zur
  // Unterscheidung in der Notenübersicht bei klassenübergreifenden Kursen).
  const schueler = db.prepare(`
    SELECT s.*, k.name AS herkunft_klasse_name
    FROM fach_teilnehmer ft
    JOIN schueler s ON s.id = ft.schueler_id
    JOIN klassen k ON k.id = s.klasse_id
    WHERE ft.fach_id = ?
    ORDER BY s.nachname, s.vorname
  `).all(fach.id);
  const unterfaecher = unterfaecherDesHalbjahrs(fach, halbjahr);
  if (unterfaecher.length) return ladeKompositionsuebersicht(fach, halbjahr, unterfaecher, schueler);
  const klausuren = db.prepare('SELECT * FROM klausuren WHERE fach_id = ? AND halbjahr = ? ORDER BY id').all(fach.id, halbjahr);
  const uls = db.prepare('SELECT * FROM unterrichtsleistungen WHERE fach_id = ? AND halbjahr = ? ORDER BY id').all(fach.id, halbjahr);
  const csvStr = getNotenschluesselCsv(fach);
  const ulPct = muendlichProzentFuerHalbjahr(fach.klasse_id, halbjahr, DEFAULT_GEWICHTUNG);
  const schriftlichPct = 100 - ulPct;

  const klausurErgs = new Map();
  for (const k of klausuren) {
    const rows = db.prepare('SELECT schueler_id, punkte FROM klausur_ergebnisse WHERE klausur_id = ?').all(k.id);
    klausurErgs.set(k.id, new Map(rows.map((r) => [r.schueler_id, JSON.parse(r.punkte)])));
  }
  const ulErgs = new Map();
  for (const u of uls) {
    const rows = db.prepare('SELECT schueler_id, punkte FROM ul_ergebnisse WHERE ul_id = ?').all(u.id);
    ulErgs.set(u.id, new Map(rows.map((r) => [r.schueler_id, JSON.parse(r.punkte)])));
  }
  const notenRows = db.prepare(
    'SELECT schueler_id, typ, wert, id FROM noten WHERE fach_id = ? AND halbjahr = ? ORDER BY position, id'
  ).all(fach.id, halbjahr);
  const manuelleMap = new Map();
  for (const n of notenRows) {
    if (!manuelleMap.has(n.schueler_id)) manuelleMap.set(n.schueler_id, { muendlich: [], schriftlich: [] });
    manuelleMap.get(n.schueler_id)[n.typ].push({ id: n.id, wert: n.wert });
  }
  const { termine, noten: terminNoten, na: terminNa } = ladeUnterrichtTermine(fach.id, halbjahr);

  const endnoten = ladeEndnoten(fach.id, halbjahr);
  // Verrechnung mit dem Vorhalbjahr (Einstellung der Klasse, siehe verrechnungsProzent).
  const verrechnungProzent = verrechnungsProzent(fach.klasse_id, halbjahr, fach);
  const vorhalbjahr = verrechnungProzent ? halbjahrText(halbjahrNr(halbjahr) - 1) : null;
  const vorherNoten = verrechnungProzent ? berechneGesamtnoten(fach.id, vorhalbjahr) : new Map();
  const rows = schueler.map((s) => {
    const klausurData = klausuren.map((k) => {
      const punkte = klausurErgs.get(k.id)?.get(s.id) || null;
      const maxArr = JSON.parse(k.max_punkte_pro_aufgabe);
      const teileInfo = parseKlausurTeile(k.teile);
      const note = punkte ? klausurNote(punkte, maxArr, teileInfo, csvStr) : null;
      // Je Teil einer mehrteiligen Klausur eine eigene Note (sonst null).
      const teilNoten = teileInfo && punkte ? klausurTeilNoten(punkte, maxArr, teileInfo, csvStr) : null;
      return { id: k.id, name: k.name, gewichtung: k.gewichtung, punkte, note, teilNoten };
    });
    const ulData = uls.map((u) => {
      const punkte = ulErgs.get(u.id)?.get(s.id) || null;
      const note = punkte ? noteAusPunkten(punkte, JSON.parse(u.max_punkte_pro_aufgabe), csvStr) : null;
      return { id: u.id, name: u.name, gewichtung: u.gewichtung, punkte, note };
    });
    const manuelle = manuelleMap.get(s.id) || { muendlich: [], schriftlich: [] };
    const eigeneTerminNoten = terminNoten.get(s.id) || new Map();
    const eigeneNa = terminNa.get(s.id) || new Set();
    const terminZeile = termine.map((t) => ({ termin_id: t.id, datum: t.datum, wert: eigeneTerminNoten.get(t.id) ?? null, na: eigeneNa.has(t.id) }));
    const datumsWerte = datumsWerteFuerSchueler(s.id, termine, terminNoten);
    const { datumsDurchschnitt, note: muendlicheNote } = unterrichtsleistungNote(datumsWerte, ulData);
    const ohneVerrechnung = gesamtnoteHj(schriftlichPct, ulPct, klausurData, [{ note: muendlicheNote, gewichtung: 1 }], csvStr);
    const vorherNote = vorherNoten.get(s.id) ?? null;
    const berechnet = wendeVerrechnungAn(ohneVerrechnung, vorherNote, verrechnungProzent);
    // Direkt eingetragene Endnote (siehe src/halbjahr-endnoten.js) ersetzt die berechnete Note.
    const endnote = endnoten.get(s.id) ?? null;
    const gn = endnote ? (endnote.ntg ? null : endnote.note) : berechnet;
    return {
      schueler_id: s.id, nachname: s.nachname, vorname: s.vorname,
      endnote, gesamtBerechnet: berechnet, gesamtOhneVerrechnung: ohneVerrechnung, vorhalbjahrNote: vorherNote,
      // Nur gesetzt, wenn die Person aus einer ANDEREN Klasse als der
      // Heimat-Klasse dieses Fachs stammt (klassenübergreifender Kurs).
      herkunftKlasse: s.klasse_id === fach.klasse_id ? null : s.herkunft_klasse_name,
      klausuren: klausurData, uls: ulData, terminNoten: terminZeile,
      muendlich: manuelle.muendlich, schriftlich: manuelle.schriftlich,
      schriftlicheNote: teilNote(klausurData),
      datumsDurchschnitt,
      naAnzahl: eigeneNa.size,
      muendlicheNote,
      gesamt: gn,
      // SPA-Punkte (0-15) bestehen wie BG-Punkte ab 4.
      nicht_bestanden: gn !== null ? nichtBestanden(gn, fach.notenschluessel === 'SPA' ? 'BG' : fach.notenschluessel) : false,
    };
  });

  return {
    schriftlichPct, ulPct, csvStr, uls, termine, schueler, rows, verrechnung: { prozent: verrechnungProzent, vorhalbjahr },
    klausuren: klausuren.map((k) => ({ ...k, teileInfo: parseKlausurTeile(k.teile) })),
  };
}
