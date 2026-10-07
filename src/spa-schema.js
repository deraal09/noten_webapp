/**
 * Feste Bewertungskonfiguration der SPA-Bildungsgänge — 1:1 portiert aus
 * dclausen01/notentabellen-spa, packages/server/src/seed/konfiguration.ts.
 *
 * Diese Konfiguration ist der STANDARD: Fächer/Komponenten/Gewichte lassen sich
 * als SPA-Vorlage kopieren und vollständig bearbeiten (src/spa-vorlagen.js, am
 * Ende dieser Datei: standardKonfig/pruefeKonfig). Jede Klasse speichert die
 * Schemata ihrer Fächer als Kopie (faecher.spa_schema); ältere Klassen ohne
 * Kopie folgen weiter diesem Standard.
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

// ---------------------------------------------------------------------------
// Editierbare Fächervorgabe (Vorlagen)
//
// Die feste Konfiguration oben ist nur noch der Standard: eine Konfiguration
// ("Konfig") ist eine Liste von Fach-Definitionen
//   { schluessel, name, typ: 'LF'|'FACH', schema: SchemaHalbjahr[4] }
// und lässt sich als Vorlage speichern (src/spa-vorlagen.js). Jedes angelegte
// SPA-Fach trägt sein Schema als Kopie (faecher.spa_schema); Fächer ohne Kopie
// (ältere Klassen) nutzen weiter den Standard.
// ---------------------------------------------------------------------------

const KUMULATIONSMODI = ['keine', 'fortlaufend_50_50', 'gewichtet_vorgaenger', 'mittelwert_halbjahre'];
const HALBJAHRMODI = ['direkt', 'komponenten_gewichtet'];
const runde = (x) => Math.round(x * 1000) / 1000;

/** Anzeigename einer Komponente (eigene Komponenten nutzen ihren Namen als Schlüssel). */
export function komponentenName(schluessel) {
  return KOMPONENTEN_NAMEN[schluessel] || schluessel;
}

/**
 * Standardkonfiguration eines Bildungsgangs als tiefe Kopie.
 * @param {string} bildungsgang
 * @returns {Array<{schluessel: string, name: string, typ: 'LF'|'FACH', schema: SchemaHalbjahr[]}>}
 */
export function standardKonfig(bildungsgang) {
  return spaFaecherFuerBildungsgang(bildungsgang).map((f) => ({
    schluessel: f.schluessel, name: f.name, typ: f.typ,
    schema: spaSchemaFuer(f.schluessel, bildungsgang).map(({ fach, bildungsgang: bg, ...rest }) => JSON.parse(JSON.stringify(rest))),
  }));
}

/** Gültiger Schlüssel einer eigenen Komponente: Buchstaben, Ziffern, Leerzeichen, . _ - ( ). */
export function istKomponentenSchluessel(s) {
  return typeof s === 'string' && /^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,39}$/u.test(s) && s === s.trim();
}

/** Schlüssel eines Fachs (ohne ':', weil Zeugnispositionen "SCHLUESSEL:HALBJAHR" heißen). */
export function istFachSchluessel(s) {
  return typeof s === 'string' && /^[A-Z0-9_]{1,30}$/.test(s);
}

/**
 * Prüft und bereinigt ein Schema (4 Halbjahre) eines Fachs. `fachSchluessel` ist der eigene Schlüssel,
 * `alleSchluessel` die Fächer, auf die sich "anderes Fach" beziehen darf.
 * @returns {{ok: true, schema: SchemaHalbjahr[]} | {ok: false, fehler: string}}
 */
export function pruefeSchema(rohSchema, fachName, fachSchluessel, alleSchluessel) {
  const fehler = (text) => ({ ok: false, fehler: `${fachName}: ${text}` });
  if (!Array.isArray(rohSchema)) return fehler('Ungültiges Schema.');
  const schema = [];
  // Ein Halbjahr darf fehlen: das Fach gilt dann dort nicht (z. B. Blockpraxis PiA nur im 3. Halbjahr).
  for (let hj = 1; hj <= 4; hj++) {
    const r = rohSchema.find((s) => s && s.halbjahr === hj);
    if (!r) continue;
    const f = (text) => fehler(`${hj}. Halbjahr: ${text}`);
    const s = { halbjahr: hj, aktiv: Boolean(r.aktiv), halbjahrModus: r.halbjahrModus, kumulationModus: r.kumulationModus, deaktivierbar: Boolean(r.deaktivierbar), komponenten: [] };
    if (!HALBJAHRMODI.includes(s.halbjahrModus)) return f('Unbekannte Bewertungsart.');
    if (!KUMULATIONSMODI.includes(s.kumulationModus)) return f('Unbekannte Verrechnung.');
    if (s.halbjahrModus === 'komponenten_gewichtet') {
      const gesehen = new Set();
      for (const k of Array.isArray(r.komponenten) ? r.komponenten : []) {
        if (!istKomponentenSchluessel(k?.schluessel)) return f(`Ungültiger Komponentenname „${k?.schluessel ?? ''}“.`);
        if (gesehen.has(k.schluessel)) return f(`Komponente „${k.schluessel}“ kommt doppelt vor.`);
        gesehen.add(k.schluessel);
        if (k.restAnteil) s.komponenten.push({ schluessel: k.schluessel, restAnteil: true });
        else {
          const g = Number(k.gewichtFix);
          if (!Number.isFinite(g) || g <= 0 || g > 1) return f(`Gewicht von „${k.schluessel}“ muss zwischen 0 und 100 % liegen.`);
          s.komponenten.push({ schluessel: k.schluessel, gewichtFix: runde(g) });
        }
      }
      if (!s.komponenten.length) return f('Bei „Komponenten gewichtet“ braucht es mindestens eine Komponente.');
      if (s.komponenten.reduce((a, k) => a + (k.gewichtFix ?? 0), 0) > 1.0001) return f('Die festen Gewichte ergeben mehr als 100 %.');
    }
    if (s.kumulationModus === 'mittelwert_halbjahre') {
      const hjs = [...new Set((Array.isArray(r.mittelwertHalbjahre) ? r.mittelwertHalbjahre : []).map(Number))].filter((h) => h >= 1 && h <= 4).sort();
      if (!hjs.length) return f('Für den Mittelwert mindestens ein Halbjahr wählen.');
      s.mittelwertHalbjahre = hjs;
    }
    if (s.kumulationModus === 'gewichtet_vorgaenger' && (r.gewichtExtern !== undefined || r.gewichtAktuell !== undefined)) {
      const ge = Number(r.gewichtExtern);
      if (!Number.isFinite(ge) || ge <= 0 || ge >= 1) return f('Der Anteil der zweiten Quelle muss zwischen 0 und 100 % liegen.');
      s.gewichtExtern = runde(ge);
      s.gewichtAktuell = runde(1 - ge);
      if (r.externFach) {
        if (!alleSchluessel.includes(r.externFach) || r.externFach === fachSchluessel) return f('Das andere Fach muss ein anderes Fach der Vorlage sein.');
        const ehj = Number(r.externHalbjahr);
        if (!Number.isInteger(ehj) || ehj < 1 || ehj > 4) return f('Halbjahr des anderen Fachs ungültig.');
        s.externFach = r.externFach;
        s.externHalbjahr = ehj;
      } else if (!r.pruefungVerrechnen) {
        return f('Bitte angeben, mit welcher Quelle verrechnet wird.');
      }
    }
    s.abschlussZeigen = Boolean(r.abschlussZeigen);
    s.pruefung = Boolean(r.pruefung);
    s.pruefungVerrechnen = Boolean(r.pruefungVerrechnen) && s.gewichtExtern !== undefined && !s.externFach;
    if (r.pruefungVerrechnen && !s.pruefungVerrechnen) return f('„Prüfung verrechnen“ braucht die Verrechnung „gewichtet“ mit Prüfungs-Anteil.');
    if (s.pruefungVerrechnen) s.pruefung = true;
    s.kommaNote = Boolean(r.kommaNote);
    schema.push(s);
  }
  if (!schema.length) return fehler('Das Fach muss in mindestens einem Halbjahr gelten.');
  return { ok: true, schema };
}

/**
 * Prüft eine ganze Konfiguration (Namen, Schlüssel, Schemata, keine Verrechnungs-Kreise zwischen Fächern).
 * @returns {{ok: true, faecher: Array<{schluessel: string, name: string, typ: 'LF'|'FACH', schema: SchemaHalbjahr[]}>} | {ok: false, fehler: string}}
 */
export function pruefeKonfig(roh) {
  const liste = Array.isArray(roh) ? roh : roh?.faecher;
  if (!Array.isArray(liste)) return { ok: false, fehler: 'Ungültige Fächervorgabe.' };
  const schluessel = liste.map((f) => f?.schluessel);
  const namen = new Set();
  const faecher = [];
  for (const f of liste) {
    const name = String(f?.name ?? '').trim().slice(0, 100);
    if (!name) return { ok: false, fehler: 'Jedes Fach braucht einen Namen.' };
    if (namen.has(name.toLowerCase())) return { ok: false, fehler: `Der Fachname „${name}“ kommt doppelt vor.` };
    namen.add(name.toLowerCase());
    if (!istFachSchluessel(f.schluessel) || schluessel.filter((x) => x === f.schluessel).length > 1) return { ok: false, fehler: `${name}: ungültiger oder doppelter Schlüssel.` };
    const res = pruefeSchema(f.schema, name, f.schluessel, schluessel);
    if (!res.ok) return res;
    faecher.push({ schluessel: f.schluessel, name, typ: f.typ === 'LF' ? 'LF' : 'FACH', schema: res.schema });
  }
  // Fach A verrechnet mit Fach B, B mit A: würde sich bei der Berechnung endlos aufrufen.
  const kanten = new Map(faecher.map((f) => [f.schluessel, [...new Set(f.schema.map((s) => s.externFach).filter(Boolean))]]));
  const besucht = new Set();
  const imPfad = new Set();
  const hatKreis = (k) => {
    if (imPfad.has(k)) return true;
    if (besucht.has(k)) return false;
    besucht.add(k); imPfad.add(k);
    const kreis = (kanten.get(k) ?? []).some(hatKreis);
    imPfad.delete(k);
    return kreis;
  };
  if (faecher.some((f) => hatKreis(f.schluessel))) return { ok: false, fehler: 'Fächer dürfen sich nicht gegenseitig (im Kreis) verrechnen.' };
  return { ok: true, faecher };
}
