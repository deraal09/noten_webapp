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
 */

import { spaSchemaFuer, spaFachName } from './spa-schema.js';
import { berechneFach } from './spa-grade-calc.js';

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
  const fach = db.prepare('SELECT id, klasse_id, spa_fach_key FROM faecher WHERE id = ?').get(fachId);
  if (!fach || !fach.spa_fach_key) return [];
  const bildungsgang = bildungsgangVonKlasse(db, fach.klasse_id);
  if (!bildungsgang) return [];
  const schema = spaSchemaFuer(fach.spa_fach_key, bildungsgang);
  if (schema.length === 0) return [];

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
