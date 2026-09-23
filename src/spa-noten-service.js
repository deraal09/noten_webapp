/**
 * SPA-Berechnungsservice: verdrahtet den reinen Rechenkern (spa-grade-calc.js)
 * und die feste Konfiguration (spa-schema.js) mit der DB -- lädt Eingaben,
 * injiziert externe Werte (Blockpraxis → Praxis, FHR-Prüfung → Englisch/
 * Mathematik) und liefert Vorwerte für die ausgegraute Anzeige in der
 * Eingabemaske. Angelehnt an dclausen01/notentabellen-spa,
 * packages/server/src/services/berechnung.ts, aber vereinfacht auf das
 * konsolidierte Eingaben-Schema aus src/db.js (feste statt DB-konfigurierte
 * Bewertungsschemata, siehe Klärung mit dem Nutzer -- daher entfällt hier
 * insbesondere die separate "importierte_endnote"-Injektion: die liegt
 * schon direkt auf der spa_eingaben-Zeile).
 *
 * Einzige Ausnahme von "feste Konfiguration": Rest-Anteil-Komponenten
 * einzelner Lernfelder (z. B. LF3: Kunst/Spiel/Musik/Bewegung) lassen sich
 * je Klasse ein-/ausschalten (spaKomponentenKonfig/spaSetzeKomponenteAktiv,
 * Tabelle spa_deaktivierte_komponenten) -- angelehnt an
 * packages/server/src/db/komponenten.ts im Original. spaSchemaFuerFach()
 * ist die einzige Stelle, die diese Deaktivierung anwendet; jede Berechnung
 * und jede Anzeige des Schemas muss darüber laufen (nicht direkt
 * spaSchemaFuer() aus spa-schema.js), sonst sehen Eingabemaske und
 * Berechnung unterschiedliche Komponenten.
 */

import { spaSchemaFuer, spaFachName, spaFaecherFuerBildungsgang } from './spa-schema.js';
import { berechneFach, tendenzAusEndpunkten, STANDARD_NOTENSKALA } from './spa-grade-calc.js';
import { seedeTeilnehmerAusKlasse } from './fach-teilnehmer.js';

/**
 * @typedef {import('./spa-grade-calc.js').ErgebnisHalbjahr} ErgebnisHalbjahr
 */

function bildungsgangVonKlasse(db, klasseId) {
  return db.prepare('SELECT spa_bildungsgang FROM klassen WHERE id = ?').get(klasseId)?.spa_bildungsgang ?? null;
}

function fachIdInKlasse(db, klasseId, fachSchluessel) {
  return db.prepare('SELECT id FROM faecher WHERE klasse_id = ? AND spa_fach_key = ?')
    .get(klasseId, fachSchluessel)?.id ?? null;
}

/** Je (Halbjahr, Komponente) deaktivierte Rest-Komponenten eines Fachs, als Menge "halbjahr:schluessel". */
function ladeDeaktivierteKomponenten(db, fachId) {
  const rows = db.prepare('SELECT halbjahr, komponente_schluessel FROM spa_deaktivierte_komponenten WHERE fach_id = ?')
    .all(fachId);
  return new Set(rows.map((r) => `${r.halbjahr}:${r.komponente_schluessel}`));
}

/**
 * Bewertungsschema eines konkreten SPA-Fachs (Klasse × Fach), mit den für
 * DIESE Klasse deaktivierten Rest-Komponenten (spa_deaktivierte_komponenten)
 * bereits herausgefiltert -- die einzig korrekte Quelle sowohl für die
 * Berechnung als auch für die Eingabemaske, damit beide immer dieselben
 * Komponenten sehen. Nur Komponenten mit restAnteil=true können überhaupt
 * deaktiviert sein (feste Gewichte bleiben unberührt, siehe
 * spaKomponentenKonfig/spaSetzeKomponenteAktiv).
 * @param {import('better-sqlite3').Database} db
 * @param {number} fachId
 * @returns {{ fach: {id: number, klasse_id: number, spa_fach_key: string}|null, bildungsgang: string|null, schema: import('./spa-grade-calc.js').SchemaHalbjahr[] }}
 */
export function spaSchemaFuerFach(db, fachId) {
  const fach = db.prepare('SELECT id, klasse_id, spa_fach_key FROM faecher WHERE id = ?').get(fachId);
  if (!fach || !fach.spa_fach_key) return { fach: null, bildungsgang: null, schema: [] };
  const bildungsgang = bildungsgangVonKlasse(db, fach.klasse_id);
  if (!bildungsgang) return { fach, bildungsgang: null, schema: [] };
  const basisSchema = spaSchemaFuer(fach.spa_fach_key, bildungsgang);
  const deaktiviert = ladeDeaktivierteKomponenten(db, fachId);
  const schema = deaktiviert.size === 0 ? basisSchema : basisSchema.map((s) => ({
    ...s,
    komponenten: s.komponenten.filter((k) => !(k.restAnteil && deaktiviert.has(`${s.halbjahr}:${k.schluessel}`))),
  }));
  return { fach, bildungsgang, schema };
}

/**
 * Schaltbare (Rest-Anteil-)Komponenten eines SPA-Fachs für ein Halbjahr, mit
 * aktuellem Aktiv-Status -- Grundlage für die Klassenleitungs-Einstellung
 * "Zusammensetzung der Fächer" (nur Komponenten mit restAnteil=true, z. B.
 * bei LF3: Kunst/Spiel/Musik/Bewegung, sind überhaupt schaltbar; feste
 * Gewichte wie Pädagogik/Bericht bleiben immer aktiv). Leer, wenn das Fach/
 * Halbjahr keine Rest-Komponenten hat (z. B. Direktwert-Fächer, LF2).
 * @param {import('better-sqlite3').Database} db
 * @param {number} fachId
 * @param {import('./spa-grade-calc.js').Halbjahr} halbjahr
 * @returns {Array<{schluessel: string, aktiv: boolean}>}
 */
export function spaKomponentenKonfig(db, fachId, halbjahr) {
  const fach = db.prepare('SELECT id, klasse_id, spa_fach_key FROM faecher WHERE id = ?').get(fachId);
  if (!fach || !fach.spa_fach_key) return [];
  const bildungsgang = bildungsgangVonKlasse(db, fach.klasse_id);
  if (!bildungsgang) return [];
  const schemaHj = spaSchemaFuer(fach.spa_fach_key, bildungsgang).find((s) => s.halbjahr === halbjahr);
  const restKomponenten = (schemaHj?.komponenten ?? []).filter((k) => k.restAnteil);
  if (restKomponenten.length === 0) return [];
  const deaktiviert = ladeDeaktivierteKomponenten(db, fachId);
  return restKomponenten.map((k) => ({
    schluessel: k.schluessel,
    aktiv: !deaktiviert.has(`${halbjahr}:${k.schluessel}`),
  }));
}

/**
 * Schaltet eine Rest-Komponente für ein SPA-Fach/Halbjahr an oder aus.
 * Lehnt eine unbekannte oder nicht schaltbare (feste) Komponente ab, statt
 * sie stillschweigend zu ignorieren. Wirkt sofort auf alle künftigen
 * Berechnungen dieses Fachs (siehe spaSchemaFuerFach).
 * @param {import('better-sqlite3').Database} db
 * @param {number} fachId
 * @param {import('./spa-grade-calc.js').Halbjahr} halbjahr
 * @param {string} komponenteSchluessel
 * @param {boolean} aktiv
 * @returns {boolean} true bei Erfolg, false bei unbekannter/nicht schaltbarer Komponente
 */
export function spaSetzeKomponenteAktiv(db, fachId, halbjahr, komponenteSchluessel, aktiv) {
  const gueltig = spaKomponentenKonfig(db, fachId, halbjahr).some((k) => k.schluessel === komponenteSchluessel);
  if (!gueltig) return false;
  if (aktiv) {
    db.prepare('DELETE FROM spa_deaktivierte_komponenten WHERE fach_id = ? AND halbjahr = ? AND komponente_schluessel = ?')
      .run(fachId, halbjahr, komponenteSchluessel);
  } else {
    db.prepare(`
      INSERT INTO spa_deaktivierte_komponenten (fach_id, halbjahr, komponente_schluessel)
      VALUES (?, ?, ?)
      ON CONFLICT(fach_id, halbjahr, komponente_schluessel) DO NOTHING
    `).run(fachId, halbjahr, komponenteSchluessel);
  }
  return true;
}

/**
 * Legt für eine SPA-Klasse die feste Fächerstruktur ihres Bildungsgangs an
 * (siehe spaFaecherFuerBildungsgang) und weist sie der anlegenden Person zu
 * -- SPA-Klassen haben kein manuelles "Fach anlegen" wie IHK/BG-Klassen.
 * Befüllt außerdem die Teilnehmerliste jedes neuen Fachs aus den zu diesem
 * Zeitpunkt bereits vorhandenen Schüler/innen der Klasse (wichtig für den
 * Fall, dass eine Klasse mit bereits vorhandenen Schüler/innen nachträglich
 * per Admin auf SPA umgestellt wird -- beim Neuanlegen einer leeren Klasse
 * ist diese Liste ohnehin leer).
 * @param {import('better-sqlite3').Database} db
 * @param {number} klasseId
 * @param {string} bildungsgang
 * @param {number} userId
 */
export function seedeSpaFaecher(db, klasseId, bildungsgang, userId) {
  const insert = db.prepare('INSERT INTO faecher (klasse_id, name, spa_fach_key) VALUES (?, ?, ?)');
  const zuweisen = db.prepare('INSERT OR IGNORE INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)');
  const tx = db.transaction(() => {
    for (const fach of spaFaecherFuerBildungsgang(bildungsgang)) {
      const info = insert.run(klasseId, fach.name, fach.schluessel);
      zuweisen.run(userId, info.lastInsertRowid);
      seedeTeilnehmerAusKlasse(info.lastInsertRowid, klasseId);
    }
  });
  tx();
}

/**
 * Lädt die Eingaben eines Fachs/einer Person für alle Halbjahre des
 * Schemas, im vom Rechenkern erwarteten Format (EingabeHalbjahr[]).
 * @param {import('better-sqlite3').Database} db
 * @param {number} fachId
 * @param {number} schuelerId
 * @param {import('./spa-grade-calc.js').SchemaHalbjahr[]} schema
 * @returns {import('./spa-grade-calc.js').EingabeHalbjahr[]}
 */
function ladeEingaben(db, fachId, schuelerId, schema) {
  const eingabenRows = db.prepare('SELECT * FROM spa_eingaben WHERE fach_id = ? AND schueler_id = ?')
    .all(fachId, schuelerId);
  const komponentenRows = db.prepare('SELECT * FROM spa_komponenten_noten WHERE fach_id = ? AND schueler_id = ?')
    .all(fachId, schuelerId);

  return schema.map((s) => {
    const row = eingabenRows.find((r) => r.halbjahr === s.halbjahr);
    const eingabe = {
      halbjahr: s.halbjahr,
      istNa: !!row?.ist_na,
      direktwert: row?.direktwert ?? null,
      importierteEndnote: row?.importierte_endnote ?? null,
    };
    if (s.halbjahrModus === 'komponenten_gewichtet') {
      const komponenten = {};
      for (const k of s.komponenten) {
        const kr = komponentenRows.find((r) => r.halbjahr === s.halbjahr && r.komponente_schluessel === k.schluessel);
        komponenten[k.schluessel] = kr?.punkte ?? null;
      }
      eingabe.komponenten = komponenten;
    }
    return eingabe;
  });
}

/**
 * Befüllt `externerWert` der Eingaben, wenn ein Halbjahr seine Endnote aus
 * einem ANDEREN Fach (Praxis PiA 4. Hj. ← Blockpraxis 3. Hj.) oder aus der
 * eigenen Prüfungsnote (Englisch/Mathematik FHR 4. Hj.) mitbezieht.
 * @param {import('better-sqlite3').Database} db
 * @param {{ id: number, klasse_id: number, spa_fach_key: string }} fach
 * @param {string} bildungsgang
 * @param {number} schuelerId
 * @param {import('./spa-grade-calc.js').SchemaHalbjahr[]} schema
 * @param {import('./spa-grade-calc.js').EingabeHalbjahr[]} eingaben
 */
function injiziereExterneWerte(db, fach, bildungsgang, schuelerId, schema, eingaben) {
  for (const s of schema) {
    const eingabe = eingaben.find((e) => e.halbjahr === s.halbjahr);
    if (!eingabe) continue;

    if (s.externFach && s.externHalbjahr) {
      const quellFachId = fachIdInKlasse(db, fach.klasse_id, s.externFach);
      let wert = null;
      if (quellFachId) {
        const quelle = berechneFachFuerSchueler(db, quellFachId, schuelerId);
        wert = quelle.find((e) => e.halbjahr === s.externHalbjahr)?.endpunkte ?? null;
      }
      eingabe.externerWert = wert;
    } else if (s.pruefungVerrechnen) {
      // Ohne gesetzte Gewichte würde der Engine-Externmodus nicht greifen und
      // die Prüfung still ignoriert werden. Lieber laut scheitern.
      if (s.gewichtAktuell == null || s.gewichtExtern == null) {
        throw new Error(
          `Schema-Fehler: ${fach.spa_fach_key} (${bildungsgang}) ${s.halbjahr}. Hj. hat pruefungVerrechnen, `
          + 'aber gewichtAktuell/gewichtExtern fehlen.',
        );
      }
      const row = db.prepare('SELECT pruefungswert FROM spa_eingaben WHERE fach_id = ? AND schueler_id = ? AND halbjahr = ?')
        .get(fach.id, schuelerId, s.halbjahr);
      eingabe.externerWert = row?.pruefungswert ?? null;
    }
  }
}

/**
 * Berechnet ein SPA-Fach für eine Person über alle (aktiven) Halbjahre.
 * `fachId` ist die Zeile in `faecher` (mit gesetztem spa_fach_key) -- daraus
 * werden Klasse und Bildungsgang, und damit das passende feste Schema,
 * ermittelt. Liefert `[]`, wenn das Fach kein SPA-Fach ist oder die Klasse
 * keinen Bildungsgang hat.
 * @param {import('better-sqlite3').Database} db
 * @param {number} fachId
 * @param {number} schuelerId
 * @returns {ErgebnisHalbjahr[]}
 */
export function berechneFachFuerSchueler(db, fachId, schuelerId) {
  const { fach, bildungsgang, schema } = spaSchemaFuerFach(db, fachId);
  if (!fach || !bildungsgang || schema.length === 0) return [];

  const eingaben = ladeEingaben(db, fachId, schuelerId, schema);
  injiziereExterneWerte(db, fach, bildungsgang, schuelerId, schema, eingaben);
  return berechneFach({ schema, eingaben });
}

/**
 * @typedef {Object} VorwertZeile
 * @property {number} schuelerId
 * @property {number|null} endpunkte
 * @property {string|null} tendenz
 * @typedef {Object} VorwertInfo
 * @property {string|null} label
 * @property {VorwertZeile[]} werte
 */

/**
 * Ermittelt zur Orientierung den Wert, der aus einem anderen Halbjahr/Fach in
 * die Endnote des gewählten Halbjahres einfließt (für die ausgegraute
 * Anzeige in der Eingabemaske, z. B. „Endnote 3. Hj. — fließt zu 50 % ein").
 * Liefert `{ label: null, werte: [] }`, wenn es für dieses Halbjahr keinen
 * Vorwert gibt (z. B. 1. Hj., oder kumulationModus 'keine').
 * @param {import('better-sqlite3').Database} db
 * @param {number} klasseId
 * @param {string} fachSchluessel
 * @param {import('./spa-grade-calc.js').Halbjahr} halbjahr
 * @returns {VorwertInfo}
 */
export function vorwerteFuer(db, klasseId, fachSchluessel, halbjahr) {
  const leer = { label: null, werte: [] };
  const bildungsgang = bildungsgangVonKlasse(db, klasseId);
  if (!bildungsgang) return leer;

  const schema = spaSchemaFuer(fachSchluessel, bildungsgang);
  const aktuell = schema.find((s) => s.halbjahr === halbjahr);
  if (!aktuell || !aktuell.aktiv) return leer;

  let label = null;
  let quellFachSchluessel = fachSchluessel;
  let quellHalbjahr = null;

  if (aktuell.kumulationModus === 'fortlaufend_50_50') {
    const vor = schema.filter((s) => s.aktiv && s.halbjahr < halbjahr).map((s) => s.halbjahr).sort((a, b) => b - a)[0];
    if (vor !== undefined) {
      quellHalbjahr = vor;
      label = `Endnote ${vor}. Hj. — fließt zu 50 % ein`;
    }
  } else if (aktuell.kumulationModus === 'mittelwert_halbjahre') {
    const andere = (aktuell.mittelwertHalbjahre ?? [])
      .filter((h) => h !== halbjahr && schema.find((s) => s.halbjahr === h)?.aktiv);
    if (andere[0] !== undefined) {
      quellHalbjahr = andere[0];
      label = `${andere[0]}. Hj. — Mittelwert mit diesem Halbjahr`;
    }
  } else if (aktuell.kumulationModus === 'gewichtet_vorgaenger' && aktuell.externFach && aktuell.externHalbjahr) {
    quellFachSchluessel = aktuell.externFach;
    quellHalbjahr = aktuell.externHalbjahr;
    const prozent = Math.round((aktuell.gewichtExtern ?? 0.3) * 100);
    label = `${spaFachName(aktuell.externFach)} ${aktuell.externHalbjahr}. Hj. — fließt zu ${prozent} % ein`;
  }

  if (label === null || quellHalbjahr === null) return leer;

  const aktuellFachId = fachIdInKlasse(db, klasseId, fachSchluessel);
  const quellFachId = fachIdInKlasse(db, klasseId, quellFachSchluessel);
  if (!aktuellFachId || !quellFachId) return leer;

  // Bewusst ohne status='aktiv'-Filter: die Teilnehmerliste (fach_teilnehmer)
  // ist auch sonst in der App die maßgebliche Personenliste eines Fachs
  // (siehe ladeTeilnehmerMitHerkunft in fach-teilnehmer.js), unabhängig vom
  // Abgang-Status der Heimat-Klasse.
  const schueler = db.prepare(`
    SELECT s.id FROM schueler s
    JOIN fach_teilnehmer ft ON ft.schueler_id = s.id
    WHERE ft.fach_id = ?
    ORDER BY s.nachname, s.vorname
  `).all(aktuellFachId);

  const werte = schueler.map((s) => {
    const erg = berechneFachFuerSchueler(db, quellFachId, s.id);
    const zelle = erg.find((e) => e.halbjahr === quellHalbjahr);
    return { schuelerId: s.id, endpunkte: zelle?.endpunkte ?? null, tendenz: zelle?.tendenz ?? null };
  });
  return { label, werte };
}

/**
 * Rohdaten einer Eingabe für die Anzeige/Vorbefüllung der Eingabemaske
 * (im Unterschied zu berechneFachFuerSchueler, das nur das Rechenergebnis
 * liefert). `schemaHalbjahr` (aus spaSchemaFuer) bestimmt, ob/welche
 * Komponentenwerte mitgeladen werden.
 * @param {import('better-sqlite3').Database} db
 * @param {number} fachId
 * @param {number} schuelerId
 * @param {import('./spa-grade-calc.js').Halbjahr} halbjahr
 * @param {import('./spa-grade-calc.js').SchemaHalbjahr|undefined} schemaHalbjahr
 */
export function ladeEingabeAnzeige(db, fachId, schuelerId, halbjahr, schemaHalbjahr) {
  const row = db.prepare('SELECT * FROM spa_eingaben WHERE fach_id = ? AND schueler_id = ? AND halbjahr = ?')
    .get(fachId, schuelerId, halbjahr);
  const ergebnis = {
    direktwert: row?.direktwert ?? null,
    pruefungswert: row?.pruefungswert ?? null,
    importierteEndnote: row?.importierte_endnote ?? null,
    istNa: !!row?.ist_na,
    komponenten: null,
  };
  if (schemaHalbjahr?.halbjahrModus === 'komponenten_gewichtet') {
    const rows = db.prepare(`
      SELECT komponente_schluessel, punkte FROM spa_komponenten_noten
      WHERE fach_id = ? AND schueler_id = ? AND halbjahr = ?
    `).all(fachId, schuelerId, halbjahr);
    const komponenten = {};
    for (const k of schemaHalbjahr.komponenten) komponenten[k.schluessel] = null;
    for (const r of rows) komponenten[r.komponente_schluessel] = r.punkte;
    ergebnis.komponenten = komponenten;
  }
  return ergebnis;
}

/** Zeugnisnote als Anzeige-Tendenz: Fächer mit Schema-Flag `kommaNote` (WPK) als ganze Komma-Note ("3,0") statt Tendenz (3+/3/3-). */
function ausweisTendenz(istKomma, tendenz) {
  if (istKomma && tendenz) {
    const n = parseInt(tendenz, 10);
    if (Number.isFinite(n)) return `${n},0`;
  }
  return tendenz;
}

/** Alle SPA-Fächer einer Klasse, als Map Fach-Schlüssel -> faecher.id. */
function fachIdsInKlasse(db, klasseId) {
  const rows = db.prepare('SELECT id, spa_fach_key FROM faecher WHERE klasse_id = ? AND spa_fach_key IS NOT NULL')
    .all(klasseId);
  return new Map(rows.map((f) => [f.spa_fach_key, f.id]));
}

/** Schülerliste einer SPA-Klasse -- SPA-Fächer sind klasseneigen (kein klassenübergreifender Kurs, siehe seedeSpaFaecher), die eigene Klassenliste genügt daher. */
function schuelerFuerKlasse(db, klasseId) {
  return db.prepare('SELECT id, nachname, vorname FROM schueler WHERE klasse_id = ? ORDER BY nachname, vorname').all(klasseId);
}

/**
 * @typedef {Object} ZeugnisZelle
 * @property {string} fach
 * @property {string} label
 * @property {number|null} endpunkte
 * @property {string|null} tendenz
 * @typedef {Object} ZeugnisZeile
 * @property {number} schuelerId
 * @property {string} nachname
 * @property {string} vorname
 * @property {ZeugnisZelle[]} faecher
 * @property {ZeugnisZelle[]} [pruefungen] - nur im Abschlusszeugnis (4. Hj.)
 */

/**
 * Zeugnisübersicht einer SPA-Klasse für ein Halbjahr: je Schüler/in für
 * jedes in diesem Halbjahr aktive Fach die berechnete Endnote + Tendenz.
 * Rechnet live (keine eigene Ergebnis-Cache-Tabelle, siehe berechneFachFuerSchueler).
 * Das 4. Halbjahr liefert stattdessen das Abschlusszeugnis (siehe unten).
 * @param {import('better-sqlite3').Database} db
 * @param {number} klasseId
 * @param {import('./spa-grade-calc.js').Halbjahr} halbjahr
 * @returns {ZeugnisZeile[]}
 */
export function zeugnisFuerKlasse(db, klasseId, halbjahr) {
  const bildungsgang = bildungsgangVonKlasse(db, klasseId);
  if (!bildungsgang) return [];
  if (halbjahr === 4) return abschlusszeugnis(db, klasseId, bildungsgang);

  const fachIdVon = fachIdsInKlasse(db, klasseId);
  const aktiveFaecher = spaFaecherFuerBildungsgang(bildungsgang).filter((f) => {
    if (!fachIdVon.has(f.schluessel)) return false;
    const schemaHj = spaSchemaFuer(f.schluessel, bildungsgang).find((s) => s.halbjahr === halbjahr);
    return schemaHj?.aktiv;
  });

  return schuelerFuerKlasse(db, klasseId).map((s) => ({
    schuelerId: s.id,
    nachname: s.nachname,
    vorname: s.vorname,
    faecher: aktiveFaecher.map((f) => {
      const erg = berechneFachFuerSchueler(db, fachIdVon.get(f.schluessel), s.id);
      const zelle = erg.find((e) => e.halbjahr === halbjahr);
      const schemaHj = spaSchemaFuer(f.schluessel, bildungsgang).find((x) => x.halbjahr === halbjahr);
      return {
        fach: f.schluessel,
        label: f.name,
        endpunkte: zelle?.endpunkte ?? null,
        tendenz: ausweisTendenz(schemaHj?.kommaNote, zelle?.tendenz ?? null),
      };
    }),
  }));
}

/**
 * Abschlusszeugnis (4. Hj.): pro Fach die finale Endnote an der/den
 * konfigurierten Position(en) (`abschlussZeigen`, z. B. Praxis regulär: 2.
 * UND 3. Hj. als zwei eigene Zeugniszeilen), inkl. früher abgeschlossener
 * Fächer (WPK, Blockpraxis). Einzelpositions-Fächer ohne Wert an ihrer
 * Position (z. B. weil dort nichts eingetragen wurde) ziehen die letzte
 * vorhandene Note dieses Fachs hoch; Mehrfachpositionen (Praxis) bleiben
 * exakt an ihrer Position stehen. Zusätzlich der Prüfungsblock (`pruefung`).
 * @param {import('better-sqlite3').Database} db
 * @param {number} klasseId
 * @param {string} bildungsgang
 * @returns {ZeugnisZeile[]}
 */
function abschlusszeugnis(db, klasseId, bildungsgang) {
  const fachIdVon = fachIdsInKlasse(db, klasseId);
  const faecherDesBildungsgangs = spaFaecherFuerBildungsgang(bildungsgang).filter((f) => fachIdVon.has(f.schluessel));

  const positionen = [];
  for (const f of faecherDesBildungsgangs) {
    for (const s of spaSchemaFuer(f.schluessel, bildungsgang)) {
      if (s.abschlussZeigen) positionen.push({ fach: f.schluessel, halbjahr: s.halbjahr });
    }
  }
  const anzahlProFach = new Map();
  for (const p of positionen) anzahlProFach.set(p.fach, (anzahlProFach.get(p.fach) ?? 0) + 1);
  const posLabel = (p) => {
    const name = spaFachName(p.fach);
    return (anzahlProFach.get(p.fach) ?? 1) > 1 ? `${name} (${p.halbjahr}. Hj.)` : name;
  };

  const pruefPos = [];
  for (const f of faecherDesBildungsgangs) {
    for (const s of spaSchemaFuer(f.schluessel, bildungsgang)) {
      if (s.pruefung) pruefPos.push({ fach: f.schluessel, halbjahr: s.halbjahr });
    }
  }
  const pruefLabel = (fach) => (
    fach === 'ENGLISCH' ? 'Englisch-FHR'
      : fach === 'MATHEMATIK' ? 'Mathe-FHR'
        : `${spaFachName(fach)} (Prüfung)`
  );

  const kommaNoteFaecher = new Set(
    faecherDesBildungsgangs
      .filter((f) => spaSchemaFuer(f.schluessel, bildungsgang).some((s) => s.kommaNote))
      .map((f) => f.schluessel),
  );

  return schuelerFuerKlasse(db, klasseId).map((s) => {
    const cache = new Map();
    const ergebnisseVon = (fach) => {
      if (!cache.has(fach)) cache.set(fach, berechneFachFuerSchueler(db, fachIdVon.get(fach), s.id));
      return cache.get(fach);
    };

    const faecher = positionen.map((p) => {
      const ergebnisse = ergebnisseVon(p.fach);
      let z = ergebnisse.find((e) => e.halbjahr === p.halbjahr);
      if ((z?.endpunkte ?? null) === null && (anzahlProFach.get(p.fach) ?? 1) === 1) {
        for (let h = p.halbjahr - 1; h >= 1; h--) {
          const e = ergebnisse.find((x) => x.halbjahr === h);
          if (e && e.endpunkte != null) { z = e; break; }
        }
      }
      return {
        fach: `${p.fach}:${p.halbjahr}`,
        label: posLabel(p),
        endpunkte: z?.endpunkte ?? null,
        tendenz: ausweisTendenz(kommaNoteFaecher.has(p.fach), z?.tendenz ?? null),
      };
    });

    const pruefungen = pruefPos.map((p) => {
      const wert = db.prepare('SELECT pruefungswert FROM spa_eingaben WHERE fach_id = ? AND schueler_id = ? AND halbjahr = ?')
        .get(fachIdVon.get(p.fach), s.id, p.halbjahr)?.pruefungswert ?? null;
      return {
        fach: `PRUEF:${p.fach}:${p.halbjahr}`,
        label: pruefLabel(p.fach),
        endpunkte: wert,
        tendenz: wert == null ? null : tendenzAusEndpunkten(wert, STANDARD_NOTENSKALA),
      };
    });

    return { schuelerId: s.id, nachname: s.nachname, vorname: s.vorname, faecher, pruefungen };
  });
}
