/**
 * Textliche Zusammensetzung eines Fachs für die Halbjahres- und die Abschluss-/Abgangsübersicht:
 *  - normales Fach mit Unterfächern: die Unterfächer mit ihrem Anteil an der Fachnote (je Halbjahr) bzw. mit
 *    ihren Halbjahren (Abschlussübersicht über alle Halbjahre),
 *  - SPA-Fach mit Komponenten (z. B. LF3): die im Halbjahr aktiven Komponenten mit ihrem Gewicht bzw.
 *    (Abschlussübersicht) alle Komponenten.
 * Leer, wenn das Fach direkt bewertet wird.
 */

import { getDb } from './db.js';
import { unterfaecherDesHalbjahrs, unterfachGewicht } from './noten-service.js';
import { ladeUnterfaecher } from './unterfaecher.js';
import { spaSchemaFuerFach } from './spa-noten-service.js';
import { KOMPONENTEN_NAMEN } from './spa-schema.js';
import { halbjahrText, fachHalbjahrNummern, klassenLaufzeit } from './klassen-jahre.js';
import { berechneGesamtnoten } from './noten-service.js';
import { ladeEingabeAnzeige } from './spa-noten-service.js';
import { gesamtnoteJahr, formatNote } from './grade-calc.js';

const prozent = (x) => `${String(Math.round(x * 10) / 10).replace('.', ',')} %`;

/** "3.–4." bzw. "1., 3." aus Halbjahr-Nummern. */
function hjKurz(nummern) {
  if (!nummern.length) return '';
  const zusammenhaengend = nummern[nummern.length - 1] - nummern[0] + 1 === nummern.length;
  if (nummern.length === 1) return `${nummern[0]}.`;
  return zusammenhaengend ? `${nummern[0]}.–${nummern[nummern.length - 1]}.` : nummern.map((n) => `${n}.`).join(', ');
}

/** Zusammensetzung im Halbjahr (Nummer) als Text, oder '' wenn das Fach direkt bewertet wird. */
export function zusammensetzungImHalbjahr(fach, nr) {
  if (fach.spa_fach_key) {
    const schemaHj = spaSchemaFuerFach(getDb(), fach.id).schema.find((s) => s.halbjahr === nr);
    if (!schemaHj || schemaHj.halbjahrModus !== 'komponenten_gewichtet' || !schemaHj.komponenten.length) return '';
    const fest = schemaHj.komponenten.reduce((a, k) => a + (k.gewichtFix ?? 0), 0);
    const rest = schemaHj.komponenten.filter((k) => k.restAnteil);
    const restAnteil = rest.length ? Math.max(0, 1 - fest) / rest.length : 0;
    return schemaHj.komponenten
      .map((k) => `${KOMPONENTEN_NAMEN[k.schluessel] || k.schluessel} ${prozent((k.gewichtFix ?? restAnteil) * 100)}`).join(' · ');
  }
  const kinder = unterfaecherDesHalbjahrs(fach, halbjahrText(nr));
  if (!kinder.length) return '';
  const summe = kinder.reduce((a, u) => a + unterfachGewicht(u), 0);
  return kinder.map((u) => `${u.kurzname || u.name} ${prozent((unterfachGewicht(u) / summe) * 100)}`).join(' · ');
}

/** Zusammensetzung über alle Halbjahre (Abschlussübersicht): Unterfächer/Komponenten mit ihren Halbjahren. */
export function zusammensetzungGesamt(fach) {
  const laufzeit = klassenLaufzeit(fach.klasse_id);
  if (fach.spa_fach_key) {
    const namen = new Map();
    for (const s of spaSchemaFuerFach(getDb(), fach.id).schema) {
      if (s.halbjahrModus !== 'komponenten_gewichtet') continue;
      for (const k of s.komponenten) namen.set(k.schluessel, [...(namen.get(k.schluessel) ?? []), s.halbjahr]);
    }
    return [...namen].map(([k, hj]) => `${KOMPONENTEN_NAMEN[k] || k}${hj.length < 4 ? ` (${hjKurz(hj)} Hj.)` : ''}`).join(' · ');
  }
  return ladeUnterfaecher(fach.id)
    .map((u) => {
      const hj = fachHalbjahrNummern(u, laufzeit);
      return `${u.kurzname || u.name}${hj.length < laufzeit.anzahlHalbjahre ? ` (${hjKurz(hj)} Hj.)` : ''}`;
    }).join(' · ');
}

/** Wert einer SPA-Komponente (Punkte) im Halbjahr: von Hand eingetragen, sonst aus den Leistungen des Komponenten-Unterfachs. */
function komponentenWert(anzeige, schluessel) {
  return anzeige.komponenten?.[schluessel] ?? anzeige.komponentenLeistung?.[schluessel] ?? null;
}

/**
 * Untertabelle der Halbjahresübersicht: die Noten der Unterfächer (bzw. die Punkte der SPA-Komponenten) je Person im Halbjahr.
 * @returns {{ spalten: Array<{ name: string, anteil: string }>, werte: Map<number, Array<number|null>> } | null}
 *   null, wenn das Fach im Halbjahr direkt bewertet wird.
 */
export function teiltabelleImHalbjahr(fach, halbjahr, schuelerIds) {
  const nr = Number.parseInt(halbjahr, 10);
  const werte = new Map();
  if (fach.spa_fach_key) {
    const schemaHj = spaSchemaFuerFach(getDb(), fach.id).schema.find((s) => s.halbjahr === nr);
    if (!schemaHj || schemaHj.halbjahrModus !== 'komponenten_gewichtet' || !schemaHj.komponenten.length) return null;
    const fest = schemaHj.komponenten.reduce((a, k) => a + (k.gewichtFix ?? 0), 0);
    const rest = schemaHj.komponenten.filter((k) => k.restAnteil);
    const restAnteil = rest.length ? Math.max(0, 1 - fest) / rest.length : 0;
    for (const id of schuelerIds) {
      const anzeige = ladeEingabeAnzeige(getDb(), fach.id, id, nr, schemaHj);
      werte.set(id, schemaHj.komponenten.map((k) => komponentenWert(anzeige, k.schluessel)));
    }
    return {
      spalten: schemaHj.komponenten.map((k) => ({ name: KOMPONENTEN_NAMEN[k.schluessel] || k.schluessel, anteil: prozent((k.gewichtFix ?? restAnteil) * 100) })),
      werte,
    };
  }
  const kinder = unterfaecherDesHalbjahrs(fach, halbjahr);
  if (!kinder.length) return null;
  const summe = kinder.reduce((a, u) => a + unterfachGewicht(u), 0);
  const proKind = kinder.map((u) => berechneGesamtnoten(u.id, halbjahr));
  for (const id of schuelerIds) werte.set(id, proKind.map((m) => m.get(id) ?? null));
  return {
    spalten: kinder.map((u) => ({ name: u.kurzname || u.name, anteil: prozent((unterfachGewicht(u) / summe) * 100) })),
    werte,
  };
}

/**
 * Untertabelle der Abschlussübersicht: je Unterfach/Komponente der Durchschnitt über seine Halbjahre; der Tooltip
 * (`titel`) nennt die Werte der einzelnen Halbjahre.
 * @returns {{ spalten: Array<{ name: string, anteil: string }>, werte: Map<number, Array<{ wert: number|null, titel: string }>> } | null}
 */
export function teiltabelleGesamt(fach, schuelerIds) {
  const laufzeit = klassenLaufzeit(fach.klasse_id);
  const db = getDb();
  /** @type {Array<{ name: string, halbjahre: number[], wert: (hjNr: number, id: number) => number|null }>} */
  let spalten;
  if (fach.spa_fach_key) {
    const schema = spaSchemaFuerFach(db, fach.id).schema.filter((s) => s.halbjahrModus === 'komponenten_gewichtet');
    const keys = [...new Set(schema.flatMap((s) => s.komponenten.map((k) => k.schluessel)))];
    const cache = new Map();
    const anzeige = (nr, id) => {
      const key = `${nr}:${id}`;
      if (!cache.has(key)) cache.set(key, ladeEingabeAnzeige(db, fach.id, id, nr, schema.find((s) => s.halbjahr === nr)));
      return cache.get(key);
    };
    spalten = keys.map((k) => ({
      name: KOMPONENTEN_NAMEN[k] || k,
      halbjahre: schema.filter((s) => s.komponenten.some((c) => c.schluessel === k)).map((s) => s.halbjahr),
      wert: (nr, id) => komponentenWert(anzeige(nr, id), k),
    }));
  } else {
    spalten = ladeUnterfaecher(fach.id).map((u) => {
      const cache = new Map();
      return {
        name: u.kurzname || u.name,
        halbjahre: fachHalbjahrNummern(u, laufzeit),
        wert: (nr) => {
          if (!cache.has(nr)) cache.set(nr, berechneGesamtnoten(u.id, halbjahrText(nr)));
          return cache.get(nr);
        },
      };
    });
  }
  if (!spalten.length) return null;
  const werte = new Map();
  for (const id of schuelerIds) {
    werte.set(id, spalten.map((sp) => {
      const proHj = sp.halbjahre.map((nr) => {
        const w = sp.wert(nr, id);
        return { nr, wert: w instanceof Map ? (w.get(id) ?? null) : w };
      });
      return {
        wert: gesamtnoteJahr(proHj.map((h) => h.wert)),
        titel: proHj.map((h) => `${h.nr}. Hj.: ${h.wert === null ? '–' : formatNote(h.wert)}`).join(' · '),
      };
    }));
  }
  return { spalten: spalten.map((sp) => ({ name: sp.name, anteil: '' })), werte };
}
