/**
 * Rechenkern der SPA-Notenberechnung (Sozialpädagogische Assistenz) —
 * 1:1 portiert aus dclausen01/notentabellen-spa, packages/core/src/
 * (engine.ts + notenskala.ts + types.ts), Stand siehe README dort.
 *
 * Bewusst als eigenständiges Modul ohne Abhängigkeit zu grade-calc.js: die
 * SPA-Berechnung hat ein völlig anderes Modell (Komponenten mit Restbudget,
 * fortlaufende Kumulation über 4 Halbjahre/2 Schuljahre hinweg, Notenskala
 * mit Tendenz +/-) als die reguläre Klausuren/Unterrichtsleistungs-Note
 * (IHK/BG). Absichtlich Punkt für Punkt am Original bleiben, damit sich
 * Änderungen dort leicht nachziehen lassen und die Golden-Master-Tests
 * (siehe test/spa-grade-calc.test.js) exakt übereinstimmen.
 *
 * @typedef {1|2|3|4} Halbjahr
 * @typedef {'komponenten_gewichtet'|'direkt'} HalbjahrModus
 * @typedef {'fortlaufend_50_50'|'keine'|'gewichtet_vorgaenger'|'mittelwert_halbjahre'} KumulationModus
 *
 * @typedef {Object} KomponenteDef
 * @property {string} schluessel
 * @property {number} [gewichtFix]
 * @property {boolean} [restAnteil]
 *
 * @typedef {Object} SchemaHalbjahr
 * @property {Halbjahr} halbjahr
 * @property {boolean} aktiv
 * @property {HalbjahrModus} halbjahrModus
 * @property {KumulationModus} kumulationModus
 * @property {boolean} deaktivierbar
 * @property {KomponenteDef[]} komponenten
 * @property {Halbjahr[]} [mittelwertHalbjahre]
 * @property {number} [gewichtAktuell]
 * @property {number} [gewichtExtern]
 *
 * @typedef {number|null} Wert
 *
 * @typedef {Object} EingabeHalbjahr
 * @property {Halbjahr} halbjahr
 * @property {boolean} istNa
 * @property {Record<string, Wert>} [komponenten]
 * @property {Wert} [direktwert]
 * @property {Wert} [externerWert]
 * @property {Wert} [importierteEndnote]
 *
 * @typedef {Object} ErgebnisHalbjahr
 * @property {Halbjahr} halbjahr
 * @property {boolean} aktiv
 * @property {number|null} zwischennote
 * @property {number|null} endpunkte
 * @property {string|null} tendenz
 *
 * @typedef {Map<number, string>} Notenskala
 */

const HALBJAHRE = /** @type {const} */ ([1, 2, 3, 4]);

/**
 * Zentrale Notenskala: Punkte 0–15 → Schulnote.
 * @type {Notenskala}
 */
export const STANDARD_NOTENSKALA = new Map([
  [15, '1+'], [14, '1'], [13, '1-'],
  [12, '2+'], [11, '2'], [10, '2-'],
  [9, '3+'], [8, '3'], [7, '3-'],
  [6, '4+'], [5, '4'], [4, '4-'],
  [3, '5+'], [2, '5'], [1, '5-'],
  [0, '6'],
]);

/** „Keine Note" / nicht belegt. */
export const KEINE_NOTE = '-';

/**
 * Kaufmännische Rundung (round half away from zero). Für die hier
 * auftretenden nicht-negativen Punktwerte (0–15) identisch zu Excels
 * ROUND(x, 0).
 * @param {number} x
 * @returns {number}
 */
export function kaufmaennischRunden(x) {
  return Math.sign(x) * Math.round(Math.abs(x));
}

/**
 * Endpunkte (ungerundet) → Tendenznote über die Notenskala.
 * @param {number|null} endpunkte
 * @param {Notenskala} skala
 * @returns {string|null}
 */
export function tendenzAusEndpunkten(endpunkte, skala) {
  if (endpunkte === null) return null;
  const punkte = kaufmaennischRunden(endpunkte);
  return skala.get(punkte) ?? KEINE_NOTE;
}

/**
 * Zwischennote eines Halbjahres (Spec 5.1).
 *
 * - `direkt`: der eingetragene Punktwert.
 * - `komponenten_gewichtet`: Σ(Gewicht_i · Punkte_i) über die belegten
 *   (nicht-n/a-) Komponenten. Feste Gewichte werden direkt übernommen; das
 *   Restbudget (1 − Σ feste Gewichte aktiver Komponenten) wird gleichmäßig
 *   auf die aktiven Restanteil-Komponenten verteilt.
 *
 * Gibt `null` zurück, wenn keine belegte Komponente/kein Wert vorliegt.
 *
 * @param {SchemaHalbjahr} schema
 * @param {EingabeHalbjahr|undefined} eingabe
 * @returns {number|null}
 */
export function berechneZwischennote(schema, eingabe) {
  if (!schema.aktiv) return null;
  if (eingabe?.istNa) return null;

  if (schema.halbjahrModus === 'direkt') {
    const wert = eingabe?.direktwert;
    return wert === null || wert === undefined ? null : wert;
  }

  // komponenten_gewichtet
  const werte = eingabe?.komponenten ?? {};
  const aktive = schema.komponenten.filter((k) => {
    const w = werte[k.schluessel];
    return w !== null && w !== undefined;
  });
  if (aktive.length === 0) return null;

  const festeSumme = aktive.reduce((s, k) => s + (k.gewichtFix ?? 0), 0);
  const restKomponenten = aktive.filter((k) => k.restAnteil);
  const restBudget = Math.max(0, 1 - festeSumme);
  const restGewicht = restKomponenten.length > 0 ? restBudget / restKomponenten.length : 0;

  let summe = 0;
  for (const k of aktive) {
    const gewicht = k.gewichtFix ?? (k.restAnteil ? restGewicht : 0);
    summe += gewicht * /** @type {number} */ (werte[k.schluessel]);
  }
  return summe;
}

/**
 * @param {SchemaHalbjahr[]} schema
 * @param {Halbjahr} hj
 * @returns {SchemaHalbjahr|undefined}
 */
function schemaFuer(schema, hj) {
  return schema.find((s) => s.halbjahr === hj);
}

/**
 * @param {SchemaHalbjahr[]} schema
 * @param {Halbjahr} hj
 * @returns {Halbjahr|null}
 */
function letztesAktivesVorHalbjahr(schema, hj) {
  for (let h = hj - 1; h >= 1; h--) {
    const s = schemaFuer(schema, /** @type {Halbjahr} */ (h));
    if (s?.aktiv) return /** @type {Halbjahr} */ (h);
  }
  return null;
}

/**
 * Berechnet ein Fach über alle Halbjahre (Spec 5.2/5.3).
 *
 * Es wird durchgängig mit ungerundeten Endpunkten kumuliert; gerundet wird
 * ausschließlich für die Tendenznote. Inaktive Halbjahre liefern kein
 * Ergebnis.
 *
 * @param {{ schema: SchemaHalbjahr[], eingaben: EingabeHalbjahr[], notenskala?: Notenskala }} input
 * @returns {ErgebnisHalbjahr[]}
 */
export function berechneFach(input) {
  const skala = input.notenskala ?? STANDARD_NOTENSKALA;
  const eingabeFuer = (/** @type {Halbjahr} */ hj) => input.eingaben.find((e) => e.halbjahr === hj);

  // 1. Pass: Zwischennoten je Halbjahr. Eine übernommene Endnote gilt als
  // Zwischennote dieses Halbjahres, damit sie auch von 'mittelwert_halbjahre'
  // und vom klassischen 'gewichtet_vorgaenger' (lesen aus `zwischen`) gesehen wird.
  const zwischen = new Map();
  for (const hj of HALBJAHRE) {
    const s = schemaFuer(input.schema, hj);
    const e = eingabeFuer(hj);
    const importiert = e?.importierteEndnote ?? null;
    zwischen.set(hj, importiert ?? (s ? berechneZwischennote(s, e) : null));
  }

  // 2. Pass: Kumulation → Endpunkte.
  const ergebnisse = [];
  let vorigeEndpunkte = null; // letzte aktive Endpunkte (für 50/50, n/a-Carry)

  for (const hj of HALBJAHRE) {
    const s = schemaFuer(input.schema, hj);
    if (!s || !s.aktiv) continue;

    const eingabe = eingabeFuer(hj);
    const zw = zwischen.get(hj) ?? null;
    let endpunkte;
    let zwischennoteAusgabe = zw;

    // Übernommene Endnote (Import): hat Vorrang vor jeder Berechnung und wird
    // als Vorgängerwert für die Kumulation fortgeschrieben.
    const importiert = eingabe?.importierteEndnote ?? null;
    if (importiert !== null && importiert !== undefined) {
      endpunkte = importiert;
      zwischennoteAusgabe = importiert;
      vorigeEndpunkte = importiert;
      ergebnisse.push({
        halbjahr: hj, aktiv: true, zwischennote: zwischennoteAusgabe, endpunkte,
        tendenz: tendenzAusEndpunkten(endpunkte, skala),
      });
      continue;
    }

    switch (s.kumulationModus) {
      case 'keine':
        endpunkte = zw;
        break;

      case 'fortlaufend_50_50':
        if (s.deaktivierbar && eingabe?.istNa) {
          // Halbjahr abgeschaltet: Vorwert unverändert fortschreiben.
          endpunkte = vorigeEndpunkte;
          zwischennoteAusgabe = null;
        } else if (vorigeEndpunkte === null || zw === null) {
          endpunkte = zw;
        } else {
          endpunkte = 0.5 * vorigeEndpunkte + 0.5 * zw;
        }
        break;

      case 'gewichtet_vorgaenger': {
        if (s.gewichtAktuell !== undefined || s.gewichtExtern !== undefined) {
          // Externer Modus: aktuelle Zwischennote mit einem Wert aus einem
          // ANDEREN Fach kombinieren (Praxis PiA 4. Hj. = 0,7·Praxis(4.) +
          // 0,3·Blockpraxis(3.)). Fehlt der externe Wert, zählt nur die
          // aktuelle Note (keine künstliche Herabskalierung).
          const gA = s.gewichtAktuell ?? 0.7;
          const gE = s.gewichtExtern ?? 0.3;
          const ext = eingabe?.externerWert ?? null;
          endpunkte = zw === null ? null : ext === null ? zw : gA * zw + gE * ext;
        } else {
          // Klassischer Modus: Vorgänger-Halbjahr DESSELBEN Fachs.
          const vorHj = letztesAktivesVorHalbjahr(input.schema, hj);
          const vorZw = vorHj !== null ? (zwischen.get(vorHj) ?? null) : null;
          endpunkte = vorZw === null || zw === null ? zw : 0.3 * vorZw + 0.7 * zw;
        }
        break;
      }

      case 'mittelwert_halbjahre': {
        const hjs = s.mittelwertHalbjahre ?? [];
        const werte = hjs.map((h) => zwischen.get(h) ?? null).filter((v) => v !== null);
        endpunkte = werte.length > 0 ? werte.reduce((a, b) => a + b, 0) / werte.length : null;
        break;
      }

      default:
        endpunkte = null;
    }

    if (endpunkte !== null) vorigeEndpunkte = endpunkte;

    ergebnisse.push({
      halbjahr: hj, aktiv: true, zwischennote: zwischennoteAusgabe, endpunkte,
      tendenz: tendenzAusEndpunkten(endpunkte, skala),
    });
  }

  return ergebnisse;
}
