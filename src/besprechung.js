/**
 * Notenbesprechung: Auswahl mehrerer Fächer und die Würfelrunde (zufällige Reihenfolge, jede Person genau einmal).
 *
 * Die Würfelrunde liegt in der Sitzung der Lehrkraft (session.besprechungsrunde): die Schlüssel-Zeichenkette aus Fächern
 * und Halbjahr und die Personen in der Reihenfolge, in der sie aufgerufen wurden. Die Zählung (3 / 24) folgt dieser
 * Reihenfolge, läuft also linear weiter, auch wenn die Namen zufällig kommen.
 */

import crypto from 'node:crypto';

/** Fach-IDs aus dem Parameter `faecher` ("2,3" oder ["2","3"]): ganze Zahlen ohne Duplikate. */
export function parseFaecherIds(roh) {
  const teile = (Array.isArray(roh) ? roh : [roh]).flatMap((x) => String(x ?? '').split(','));
  const ids = [];
  for (const t of teile) {
    const n = Number.parseInt(t, 10);
    if (Number.isInteger(n) && n > 0 && !ids.includes(n)) ids.push(n);
  }
  return ids;
}

/** Schlüssel einer Besprechung: gleiche Fächer + Halbjahr = dieselbe Würfelrunde. */
export function rundenSchluessel(fachIds, halbjahr) {
  return `${[...fachIds].sort((a, b) => a - b).join(',')}|${halbjahr}`;
}

/** Die laufende Würfelrunde für diesen Schlüssel (oder null). */
export function aktuelleRunde(session, schluessel) {
  const r = session?.besprechungsrunde;
  return r && r.schluessel === schluessel && Array.isArray(r.gerufen) ? r : null;
}

export function starteRunde(session, schluessel) {
  session.besprechungsrunde = { schluessel, gerufen: [] };
  return session.besprechungsrunde;
}

export function beendeRunde(session) {
  delete session.besprechungsrunde;
}

/** Eine zufällige noch nicht aufgerufene Person (kryptografisch gleichverteilt) -- null, wenn alle dran waren. */
export function waehleZufaellig(alleIds, gerufen, zufall = (n) => crypto.randomInt(n)) {
  const offen = alleIds.filter((id) => !gerufen.includes(id));
  if (!offen.length) return null;
  return offen[zufall(offen.length)];
}

/**
 * Zustand für die Anzeige: Position in der Aufrufreihenfolge (1-basiert) bzw. null, wenn die Person nicht in der Runde ist,
 * dazu Vorherige/Nächste in der Aufrufreihenfolge und wie viele noch kommen.
 */
export function rundenAnsicht(runde, alleIds, schuelerId) {
  if (!runde) return null;
  const idx = runde.gerufen.indexOf(schuelerId);
  return {
    gerufen: runde.gerufen.length,
    uebrig: alleIds.filter((id) => !runde.gerufen.includes(id)).length,
    imRundenmodus: idx !== -1,
    position: idx === -1 ? null : idx + 1,
    vorherigeId: idx > 0 ? runde.gerufen[idx - 1] : null,
    naechsteId: idx !== -1 && idx < runde.gerufen.length - 1 ? runde.gerufen[idx + 1] : null,
  };
}
