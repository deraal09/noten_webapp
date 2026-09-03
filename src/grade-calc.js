/**
 * Notenberechnung – 1:1 portiert aus src/grade_calc.py
 * (gleiche Logik wie Desktop-App und alte Python-Webapp).
 */

export const HALBJAHRE = ['1. Halbjahr', '2. Halbjahr'];
export const FEHLZEIT_TYPEN = ['entschuldigt', 'unentschuldigt', 'betrieblich'];
export const NOTE_TYPEN = ['muendlich', 'schriftlich'];
export const DEFAULT_GEWICHTUNG = 60; // % mündliche Unterrichtsleistungen

// Standard-Notenbereiche
export const NOTENSCHLUESSEL = { IHK: [1, 6], BG: [0, 15] };

// Standard-Notenschlüssel CSV (Prozent,Note;…) – 1:1 aus src/constants.py
export const DEFAULT_NS_CSV = {
  IHK:
    '100,1;99,1.1;98,1.1;97,1.2;96,1.2;95,1.3;94,1.3;93,1.4;92,1.4;91,1.5;90,1.6;' +
    '89,1.7;88,1.8;87,1.9;86,2;85,2;84,2.1;83,2.2;82,2.3;81,2.4;80,2.5;79,2.6;' +
    '78,2.7;77,2.7;76,2.8;75,2.9;74,2.9;73,3;72,3.1;71,3.1;70,3.2;69,3.3;68,3.3;' +
    '67,3.4;66,3.5;65,3.6;64,3.6;63,3.7;62,3.7;61,3.8;60,3.9;59,3.9;58,4;57,4;' +
    '56,4.1;55,4.1;54,4.2;53,4.3;52,4.3;51,4.4;50,4.4;49,4.5;48,4.6;47,4.6;46,4.7;' +
    '45,4.7;44,4.8;43,4.8;42,4.9;41,4.9;40,5;39,5;38,5;37,5.1;36,5.1;35,5.2;34,5.2;' +
    '33,5.3;32,5.3;31,5.4;30,5.4;29,5.5;28,5.6;27,5.6;26,5.6;25,5.6;24,5.6;23,5.6;' +
    '22,5.7;21,5.7;20,5.7;19,5.7;18,5.7;17,5.7;16,5.8;15,5.8;14,5.8;13,5.8;12,5.8;' +
    '11,5.9;10,5.9;9,5.9;8,5.9;7,5.9;6,5.9;5,6;4,6;3,6;2,6;1,6;0,6',
  BG:
    '100,15;99,15;98,15;97,15;96,15;95,15;94,14;93,14;92,14;91,14;90,14;89,13;88,13;' +
    '87,13;86,13;85,13;84,12;83,12;82,12;81,12;80,12;79,11;78,11;77,11;76,11;75,11;' +
    '74,10;73,10;72,10;71,10;70,10;69,9;68,9;67,9;66,9;65,9;64,8;63,8;62,8;61,8;' +
    '60,8;59,7;58,7;57,7;56,7;55,7;54,6;53,6;52,6;51,6;50,6;49,5;48,5;47,5;46,5;' +
    '45,5;44,4;43,4;42,4;41,4;40,4;39,3;38,3;37,3;36,3;35,3;34,3;33,3;32,2;31,2;' +
    '30,2;29,2;28,2;27,2;26,1;25,1;24,1;23,1;22,1;21,1;20,1;19,0;18,0;17,0;16,0;' +
    '15,0;14,0;13,0;12,0;11,0;10,0;9,0;8,0;7,0;6,0;5,0;4,0;3,0;2,0;1,0;0,0',
};

/**
 * Parst den CSV-String in (Prozent, Note)-Paare (absteigend sortiert).
 */
export function nsCsvParse(csvStr) {
  if (!csvStr) return [];
  const entries = [];
  for (const pair of csvStr.split(';')) {
    const parts = pair.trim().split(',');
    if (parts.length === 2) {
      const p = Number(parts[0].trim());
      const n = Number(parts[1].trim());
      if (Number.isFinite(p) && Number.isFinite(n)) entries.push([p, n]);
    }
  }
  entries.sort((a, b) => b[0] - a[0]);
  return entries;
}

/**
 * Liefert die Note für den gegebenen Prozentwert anhand des Schlüssels.
 */
export function nsCsvLookup(prozent, csvStr) {
  const entries = nsCsvParse(csvStr);
  if (!entries.length) return null;
  for (const [p, n] of entries) {
    if (prozent >= p) return n;
  }
  return entries[entries.length - 1][1];
}

const roundPct = (p) => Math.round(p);

/**
 * Berechnet die Note aus erreichten/maximalen Punkten einer Klausur/UL.
 */
export function noteAusPunkten(punkte, maxPunkte, csvStr) {
  if (!Array.isArray(punkte) || punkte.length === 0) return null;
  if (punkte.some((p) => p === null || p === undefined)) return null;
  if (punkte.length !== maxPunkte.length) return null;
  const maxP = maxPunkte.reduce((a, b) => a + b, 0);
  if (maxP === 0) return null;
  const prozent = roundPct((punkte.reduce((a, b) => a + b, 0) / maxP) * 100);
  return nsCsvLookup(prozent, csvStr);
}

/**
 * Berechnet die Gesamtnote für ein Halbjahr aus der schriftlichen Note
 * (gewichteter Durchschnitt der Klausuren) und der mündlichen Note
 * (gewichteter Durchschnitt der ULs), kombiniert im Verhältnis
 * schriftlichPct/ulPct.
 *
 * Nur tatsächlich eingetragene Noten fließen ein: Fehlt eine ganze Seite
 * komplett (z. B. noch keine Klausur benotet), zählt die andere Seite zu
 * 100 % statt auf ihren nominalen Anteil verwässert zu werden — die
 * Gesamtnote soll nicht künstlich Richtung "ungenügend" gezogen werden, nur
 * weil ein Teilbereich noch nicht bewertet wurde. Innerhalb einer Seite
 * übernimmt teilNote() dieselbe Logik (nur benotete Items zählen, normiert
 * auf deren Gewichtungssumme).
 *
 * @param {number} schriftlichPct - Prozentanteil Schriftlich (z. B. 40)
 * @param {number} ulPct - Prozentanteil Mündlich/UL (z. B. 60)
 * @param {Array<{note: number|null, gewichtung: number}>} klausuren
 * @param {Array<{note: number|null, gewichtung: number}>} uls
 * @param {string} csvStr
 * @returns {number|null}
 */
export function gesamtnoteHj(schriftlichPct, ulPct, klausuren, uls, csvStr) {
  const schriftlicheNote = teilNote(klausuren);
  const muendlicheNote = teilNote(uls);

  if (schriftlicheNote === null && muendlicheNote === null) return null;
  if (schriftlicheNote === null) return muendlicheNote;
  if (muendlicheNote === null) return schriftlicheNote;

  const total = schriftlicheNote * (schriftlichPct / 100) + muendlicheNote * (ulPct / 100);
  return Math.round(total * 100) / 100;
}

/**
 * Gewichteter Durchschnitt einer einzelnen Gruppe (nur Klausuren ODER nur
 * ULs) — die "schriftliche Note" bzw. "mündliche Note" der Notenübersicht,
 * unabhängig vom schriftlich/mündlich-Gesamtsplit des Schuljahres.
 *
 * @param {Array<{note: number|null, gewichtung: number}>} items
 * @returns {number|null}
 */
export function teilNote(items) {
  let totalGew = 0;
  let totalWeighted = 0;
  for (const it of items) {
    if (it.note !== null && it.note !== undefined && it.gewichtung > 0) {
      totalWeighted += it.note * it.gewichtung;
      totalGew += it.gewichtung;
    }
  }
  return totalGew > 0 ? Math.round((totalWeighted / totalGew) * 100) / 100 : null;
}

/**
 * Note für die Unterrichtsleistung aus der Datumstabelle (unbewertet
 * eingetragene Noten je Unterrichtstermin, gleich gewichtet) und optionalen
 * Zusatzleistungen (z. B. Präsentationen, wie bisherige Unterrichtsleistungen
 * mit eigener Gewichtung).
 *
 * Die Gewichtung einer Zusatzleistung gilt als Anteil INNERHALB der
 * Unterrichtsleistung (nicht der Gesamtnote) -- der Rest bis 100 % dieses
 * Anteils entfällt automatisch auf den Datumstabellen-Durchschnitt. Sind
 * keine Zusatzleistungen benotet, zählt die Datumstabelle zu 100 %; ist die
 * Datumstabelle leer, zählen nur die Zusatzleistungen (gleiche
 * "nur tatsächlich Vorhandenes zählt"-Logik wie bei gesamtnoteHj/teilNote).
 *
 * @param {Array<number>} datumsWerte - eingetragene Noten der Datumstabelle (bereits ohne Lücken)
 * @param {Array<{note: number|null, gewichtung: number}>} zusatzleistungen
 * @returns {{ datumsDurchschnitt: number|null, note: number|null }}
 */
export function unterrichtsleistungNote(datumsWerte, zusatzleistungen) {
  const datumsDurchschnitt = durchschnitt(datumsWerte);
  const belegt = zusatzleistungen.reduce((summe, z) => (
    z.note !== null && z.note !== undefined && z.gewichtung > 0 ? summe + z.gewichtung : summe
  ), 0);
  const rest = Math.max(0, 100 - belegt);
  const items = [...zusatzleistungen];
  if (datumsDurchschnitt !== null && rest > 0) {
    items.push({ note: datumsDurchschnitt, gewichtung: rest });
  }
  return { datumsDurchschnitt, note: teilNote(items) };
}

export function gesamtnoteJahr(hjNoten) {
  const notes = hjNoten.filter((n) => n !== null && n !== undefined);
  if (!notes.length) return null;
  return Math.round((notes.reduce((a, b) => a + b, 0) / notes.length) * 100) / 100;
}

export function durchschnitt(noten) {
  if (!noten.length) return null;
  return Math.round((noten.reduce((a, b) => a + b, 0) / noten.length) * 100) / 100;
}

/**
 * Verteilt `prozent` gleichmäßig auf `anzahl` Items (Rundung auf 1 Nachkommastelle).
 */
export function autoDistribute(anzahl, prozent) {
  if (anzahl <= 0) return [];
  const each = prozent / anzahl;
  const result = Array.from({ length: anzahl }, () => Math.round(each * 10) / 10);
  const diff = Math.round((prozent - result.reduce((a, b) => a + b, 0)) * 10) / 10;
  if (diff !== 0 && result.length) {
    result[result.length - 1] = Math.round((result[result.length - 1] + diff) * 10) / 10;
  }
  return result;
}

export function nichtBestanden(note, nsTyp) {
  if (note === null || note === undefined) return false;
  if (nsTyp === 'BG') return note < 4;
  return note > 4.5;
}

export function formatNote(n) {
  if (n === null || n === undefined) return '—';
  // Bis zu 2 Nachkommastellen, aber eine überflüssige zweite Null abschneiden:
  // 2,5 statt 2,50 – während Durchschnitte wie 2,33 erhalten bleiben.
  return Number(n).toFixed(2).replace(/0$/, '').replace('.', ',');
}

export function formatNoteG(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toFixed(1);
}
