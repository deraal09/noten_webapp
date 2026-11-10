/**
 * Schuljahre laufen automatisch weiter: Ein neues Schuljahr beginnt jedes Jahr am 1. August (siehe aktuellesStartjahr in
 * src/schuljahr-utils.js). Das aktuelle Schuljahr wird beim Start und danach höchstens einmal am Tag geprüft und -- falls es
 * noch fehlt -- angelegt, sodass die Administration es nicht von Hand erfassen muss. Bereits vorhandene Schuljahre bleiben
 * unberührt. In Tests (NODE_ENV=test) bleibt das aus, damit sie ihre Schuljahre selbst anlegen; NOTEN_SCHULJAHR_AUTO=1 schaltet
 * es dort ein.
 */

import { getDb } from './db.js';
import { DEFAULT_GEWICHTUNG } from './grade-calc.js';
import { aktuellesStartjahr, baueSchuljahrBezeichnung } from './schuljahr-utils.js';
import { jetzt } from './klassen-jahre.js';

/** Bezeichnung des heute laufenden Schuljahres, z. B. "2026/27" (ab 1. August). */
export function aktuellesSchuljahrBezeichnung(heute = jetzt()) {
  return baueSchuljahrBezeichnung(aktuellesStartjahr(heute));
}

/** Legt das aktuelle Schuljahr an, falls es fehlt. @returns {boolean} true, wenn es neu angelegt wurde */
export function sorgeFuerAktuellesSchuljahr(heute = jetzt()) {
  const bez = aktuellesSchuljahrBezeichnung(heute);
  const r = getDb().prepare('INSERT OR IGNORE INTO schuljahre (bezeichnung, gewichtung_muendlich) VALUES (?, ?)').run(bez, DEFAULT_GEWICHTUNG);
  return r.changes > 0;
}

let zuletztGeprueftAm = null;

/** Wie sorgeFuerAktuellesSchuljahr, aber höchstens einmal je Kalendertag (für jeden Request billig). */
export function pruefeSchuljahrEinmalProTag(heute = jetzt()) {
  if (process.env.NODE_ENV === 'test' && process.env.NOTEN_SCHULJAHR_AUTO !== '1') return false;
  const tag = heute.toISOString().slice(0, 10) + '|' + (process.env.DB_PFAD || '');
  if (zuletztGeprueftAm === tag) return false;
  const neu = sorgeFuerAktuellesSchuljahr(heute);
  zuletztGeprueftAm = tag;
  return neu;
}
