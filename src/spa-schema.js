/**
 * Feste Bewertungskonfiguration der SPA-Bildungsgänge — 1:1 portiert aus
 * dclausen01/notentabellen-spa, packages/server/src/seed/konfiguration.ts.
 *
 * Bewusst als Code statt DB-Konfiguration (siehe Klärung mit dem Nutzer):
 * die Lernfelder/Fächer/Komponenten/Gewichte sind hier fest hinterlegt statt
 * per Admin-Oberfläche pflegbar — spätere Änderungen brauchen einen Deploy,
 * dafür ist die Umsetzung deutlich schlanker.
 *
 * @typedef {import('./spa-grade-calc.js').SchemaHalbjahr} SchemaHalbjahr
 * @typedef {import('./spa-grade-calc.js').KomponenteDef} KomponenteDef
 */

/** @type {Array<{schluessel: string, bezeichnung: string}>} */
export const BILDUNGSGAENGE = [
  { schluessel: 'SPA_REGULAR', bezeichnung: 'SPA (regulär)' },
  { schluessel: 'SPA_PIA', bezeichnung: 'SPA PiA' },
];

/** Standard-Wahlpflichtkurse -- weitere können frei als Text eingetragen werden. */
export const WPK_KURSE = ['Krippe (U3)', 'Nahrungsmittelzubereitung'];

/**
 * Alle Fächer/Lernfelder, in dieser Reihenfolge auch für die Klassenanlage
 * verwendet (Fach-Anlegereihenfolge = Anzeigereihenfolge).
 * @type {Array<{schluessel: string, name: string, typ: 'LF'|'FACH'}>}
 */
export const SPA_FAECHER = [
  { schluessel: 'LF1', name: 'Lernfeld 1', typ: 'LF' },
  { schluessel: 'LF2', name: 'Lernfeld 2', typ: 'LF' },
  { schluessel: 'LF3', name: 'Lernfeld 3', typ: 'LF' },
  { schluessel: 'LF4', name: 'Lernfeld 4', typ: 'LF' },
  { schluessel: 'PRAXIS', name: 'Praxis', typ: 'FACH' },
  { schluessel: 'BLOCKPRAXIS', name: 'Blockpraxis', typ: 'FACH' },
  { schluessel: 'DEUTSCH', name: 'Deutsch', typ: 'FACH' },
  { schluessel: 'ENGLISCH', name: 'Englisch', typ: 'FACH' },
  { schluessel: 'WIPO', name: 'WiPo', typ: 'FACH' },
  { schluessel: 'RELIGION', name: 'Religion', typ: 'FACH' },
  { schluessel: 'MATHEMATIK', name: 'Mathematik', typ: 'FACH' },
  { schluessel: 'WPK', name: 'Wahlpflichtkurs', typ: 'FACH' },
];

/** @param {string} schluessel @returns {string} */
export function spaFachName(schluessel) {
  return SPA_FAECHER.find((f) => f.schluessel === schluessel)?.name ?? schluessel;
}

const ALLE_HJ = [1, 2, 3, 4];
const BEIDE = ['SPA_REGULAR', 'SPA_PIA'];

/**
 * LF3-Komponenten je Halbjahr (Spec 6.2): 1./4. Hj. Pädagogik fix 40 %, Rest
 * gleichmäßig auf Kunst/Spiel/Musik/Bewegung; 2./3. Hj. zusätzlich Bericht
 * fix 20 % (Pädagogik dann nur noch 20 %).
 * @param {number} hj
 * @returns {KomponenteDef[]}
 */
function lf3Komponenten(hj) {
  const rest = (schluessel) => ({ schluessel, restAnteil: true });
  if (hj === 2 || hj === 3) {
    return [
      { schluessel: 'paedagogik', gewichtFix: 0.2 },
      { schluessel: 'bericht', gewichtFix: 0.2 },
      rest('bewegung'), rest('spiel'), rest('kunst'), rest('musik'),
    ];
  }
  return [
    { schluessel: 'paedagogik', gewichtFix: 0.4 },
    rest('kunst'), rest('spiel'), rest('musik'), rest('bewegung'),
  ];
}

const LF2_KOMPONENTEN = [
  { schluessel: 'gesundheit', gewichtFix: 0.4 },
  { schluessel: 'erziehung', gewichtFix: 0.3 },
  { schluessel: 'entwicklung', gewichtFix: 0.3 },
];

/** Komponenten-Anzeigenamen (für die Eingabemaske). */
export const KOMPONENTEN_NAMEN = {
  gesundheit: 'Gesundheit', erziehung: 'Erziehung', entwicklung: 'Entwicklung',
  paedagogik: 'Pädagogik', bericht: 'Bericht', bewegung: 'Bewegung',
  spiel: 'Spiel', kunst: 'Kunst', musik: 'Musik',
};

/**
 * Baut das komplette Bewertungsschema (Fach × Bildungsgang × Halbjahr).
 * Struktur: schemata.get(fachSchluessel).get(bildungsgang) -> SchemaHalbjahr[4]
 * @returns {Map<string, Map<string, SchemaHalbjahr[]>>}
 */
function baueSchemata() {
  /** @type {Array<SchemaHalbjahr & {fach: string, bildungsgang: string}>} */
  const flach = [];

  // --- Lernfelder ---
  for (const bg of BEIDE) {
    for (const hj of ALLE_HJ) {
      const istVierte = hj === 4;
      flach.push({
        fach: 'LF1', bildungsgang: bg, halbjahr: hj, halbjahrModus: 'direkt',
        kumulationModus: 'fortlaufend_50_50', deaktivierbar: false, aktiv: true, komponenten: [],
        abschlussZeigen: istVierte,
      });
      flach.push({
        fach: 'LF2', bildungsgang: bg, halbjahr: hj, halbjahrModus: 'komponenten_gewichtet',
        kumulationModus: 'fortlaufend_50_50', deaktivierbar: false, aktiv: true,
        komponenten: LF2_KOMPONENTEN, abschlussZeigen: istVierte, pruefung: istVierte,
      });
      flach.push({
        fach: 'LF3', bildungsgang: bg, halbjahr: hj, halbjahrModus: 'komponenten_gewichtet',
        kumulationModus: 'fortlaufend_50_50', deaktivierbar: false, aktiv: true,
        komponenten: lf3Komponenten(hj), abschlussZeigen: istVierte, pruefung: istVierte,
      });
      flach.push({
        fach: 'LF4', bildungsgang: bg, halbjahr: hj, halbjahrModus: 'direkt',
        kumulationModus: 'fortlaufend_50_50', deaktivierbar: bg === 'SPA_PIA', aktiv: true,
        komponenten: [], abschlussZeigen: istVierte,
      });
    }
  }

  // --- Allgemeine Fächer: Deutsch/Englisch/WiPo/Religion/Mathematik ---
  const allgFaecher = ['DEUTSCH', 'ENGLISCH', 'WIPO', 'RELIGION', 'MATHEMATIK'];
  const istFhrFach = (f) => f === 'ENGLISCH' || f === 'MATHEMATIK';
  for (const bg of BEIDE) {
    for (const fach of allgFaecher) {
      for (const hj of ALLE_HJ) {
        const istVierte = hj === 4;
        const fhr = istVierte && istFhrFach(fach);
        flach.push({
          fach, bildungsgang: bg, halbjahr: hj, halbjahrModus: 'direkt',
          // Englisch/Mathe 4. Hj.: FHR-Prüfung fließt zu 40 % ein (externer Modus).
          kumulationModus: fhr ? 'gewichtet_vorgaenger' : 'keine',
          deaktivierbar: false, aktiv: true, komponenten: [],
          abschlussZeigen: istVierte,
          pruefung: istVierte && (fach === 'DEUTSCH' || fhr),
          pruefungVerrechnen: fhr,
          ...(fhr ? { gewichtAktuell: 0.6, gewichtExtern: 0.4 } : {}),
        });
      }
    }
  }

  // --- Praxis (PiA: 2./4. Hj. verrechnet mit Blockpraxis 3. Hj.; regulär: 2./3. Hj. getrennt) ---
  for (const hj of ALLE_HJ) {
    const istVierte = hj === 4;
    flach.push({
      fach: 'PRAXIS', bildungsgang: 'SPA_PIA', halbjahr: hj, halbjahrModus: 'direkt',
      kumulationModus: istVierte ? 'gewichtet_vorgaenger' : 'keine',
      deaktivierbar: false, aktiv: hj === 2 || hj === 4, komponenten: [],
      abschlussZeigen: hj === 2 || hj === 4,
      ...(istVierte ? { gewichtAktuell: 0.7, gewichtExtern: 0.3, externFach: 'BLOCKPRAXIS', externHalbjahr: 3 } : {}),
    });
  }
  flach.push({
    fach: 'BLOCKPRAXIS', bildungsgang: 'SPA_PIA', halbjahr: 3, halbjahrModus: 'direkt',
    kumulationModus: 'keine', deaktivierbar: false, aktiv: true, komponenten: [], abschlussZeigen: true,
  });
  for (const hj of ALLE_HJ) {
    flach.push({
      fach: 'PRAXIS', bildungsgang: 'SPA_REGULAR', halbjahr: hj, halbjahrModus: 'direkt',
      kumulationModus: 'keine', deaktivierbar: false, aktiv: hj === 2 || hj === 3, komponenten: [],
      abschlussZeigen: hj === 2 || hj === 3,
    });
  }

  // --- WPK: nur 1./2. Hj., Zeugnisnote = Mittelwert, als Komma-Note ausgewiesen ---
  for (const bg of BEIDE) {
    for (const hj of ALLE_HJ) {
      flach.push({
        fach: 'WPK', bildungsgang: bg, halbjahr: hj, halbjahrModus: 'direkt',
        kumulationModus: hj === 2 ? 'mittelwert_halbjahre' : 'keine',
        deaktivierbar: false, aktiv: hj === 1 || hj === 2, komponenten: [], kommaNote: true,
        ...(hj === 2 ? { mittelwertHalbjahre: [1, 2], abschlussZeigen: true } : {}),
      });
    }
  }

  /** @type {Map<string, Map<string, SchemaHalbjahr[]>>} */
  const schemata = new Map();
  for (const s of flach) {
    if (!schemata.has(s.fach)) schemata.set(s.fach, new Map());
    const proBildungsgang = schemata.get(s.fach);
    if (!proBildungsgang.has(s.bildungsgang)) proBildungsgang.set(s.bildungsgang, []);
    proBildungsgang.get(s.bildungsgang).push(s);
  }
  return schemata;
}

const SCHEMATA = baueSchemata();

/**
 * Bewertungsschema eines Fachs für einen Bildungsgang, alle 4 Halbjahre
 * (leer, wenn das Fach in diesem Bildungsgang nicht existiert, z. B.
 * Blockpraxis bei SPA_REGULAR).
 * @param {string} fachSchluessel
 * @param {string} bildungsgang
 * @returns {SchemaHalbjahr[]}
 */
export function spaSchemaFuer(fachSchluessel, bildungsgang) {
  return SCHEMATA.get(fachSchluessel)?.get(bildungsgang) ?? [];
}

/**
 * Alle Fächer, die für einen Bildungsgang existieren (irgendwo im Schema
 * vorkommen) -- Reihenfolge wie SPA_FAECHER, für das Auto-Anlegen beim
 * Erstellen einer SPA-Klasse.
 * @param {string} bildungsgang
 * @returns {Array<{schluessel: string, name: string, typ: 'LF'|'FACH'}>}
 */
export function spaFaecherFuerBildungsgang(bildungsgang) {
  return SPA_FAECHER.filter((f) => (SCHEMATA.get(f.schluessel)?.get(bildungsgang) ?? []).length > 0);
}
