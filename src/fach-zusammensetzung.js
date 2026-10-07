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
