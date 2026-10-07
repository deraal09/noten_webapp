/**
 * Direkte Endnoteneingabe: je Fach, Schüler/in und Halbjahr kann eine Endnote
 * von Hand eingetragen werden (Tabelle halbjahr_endnoten). Sie ersetzt die aus
 * Klausuren/Unterrichtsleistung berechnete Halbjahresnote, siehe
 * berechneGesamtnoten/ladeNotenuebersicht in src/noten-service.js.
 */

import { getDb } from './db.js';

export const NTG_TEXT = 'ntg';

/** Notenbereich (min, max) des Notenschlüssels einer Klasse: IHK 1-6, BG/SPA 0-15. */
export function notenBereich(notenschluessel) {
  return notenschluessel === 'IHK' || !notenschluessel ? [1, 6] : [0, 15];
}

/** Endnoten eines Fachs und Halbjahres als Map<schueler_id, {note, ntg}>. */
export function ladeEndnoten(fachId, halbjahr) {
  const rows = getDb().prepare(
    'SELECT schueler_id, note, ntg FROM halbjahr_endnoten WHERE fach_id = ? AND halbjahr = ?'
  ).all(fachId, halbjahr);
  return new Map(rows.map((r) => [r.schueler_id, { note: r.note, ntg: Boolean(r.ntg) }]));
}

/**
 * Liest eine Eingabe ("2,3", "ntg", "") -- null bei ungültigem Wert.
 * @returns {{ leer: true } | { ntg: true } | { note: number } | null}
 */
export function parseEndnoteEingabe(roh, [min, max]) {
  const text = String(roh ?? '').trim();
  if (text === '') return { leer: true };
  if (text.toLowerCase() === NTG_TEXT) return { ntg: true };
  if (!/^[+-]?\d+([.,]\d+)?$/.test(text)) return null;
  const zahl = Number(text.replace(',', '.'));
  if (!Number.isFinite(zahl) || zahl < min || zahl > max) return null;
  return { note: zahl };
}

/**
 * Speichert (oder löscht bei leerer Eingabe) die Endnote.
 * @returns {{ ok: true, note: number|null, ntg: boolean } | { ok: false, fehler: string }}
 */
export function setzeEndnote(fachId, schuelerId, halbjahr, roh, bereich, userId) {
  const geparst = parseEndnoteEingabe(roh, bereich);
  if (geparst === null) return { ok: false, fehler: `Ungültige Endnote (erlaubt: Zahl von ${bereich[0]} bis ${bereich[1]}, "ntg" oder leer).` };
  const db = getDb();
  if (geparst.leer) {
    db.prepare('DELETE FROM halbjahr_endnoten WHERE fach_id = ? AND schueler_id = ? AND halbjahr = ?').run(fachId, schuelerId, halbjahr);
    return { ok: true, note: null, ntg: false };
  }
  const note = geparst.ntg ? null : geparst.note;
  const ntg = geparst.ntg ? 1 : 0;
  db.prepare(`
    INSERT INTO halbjahr_endnoten (fach_id, schueler_id, halbjahr, note, ntg, eingetragen_von_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(fach_id, schueler_id, halbjahr) DO UPDATE SET
      note = excluded.note, ntg = excluded.ntg, eingetragen_von_id = excluded.eingetragen_von_id, eingetragen_am = datetime('now')
  `).run(fachId, schuelerId, halbjahr, note, ntg, userId);
  return { ok: true, note, ntg: Boolean(ntg) };
}
