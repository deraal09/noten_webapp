/**
 * Kurs anlegen (gemeinsam für die Oberfläche und die API): ein Kurs ist ein Fach (ist_kurs = 1) in einer unsichtbaren „Kurs-Hülle“-Klasse
 * (klassen.ist_kurs_huelle) und startet ohne Teilnehmer; die anlegende Lehrkraft wird ihm zugeordnet. Standard-Notenschlüssel: BG.
 */

import { getDb } from './db.js';
import { DEFAULT_NS_CSV } from './grade-calc.js';
import { makeToken } from './auth.js';

export const KURS_NOTENSCHLUESSEL = ['IHK', 'BG'];

/** Notenschlüssel für einen neuen Kurs: IHK oder BG, sonst (und ohne Angabe) BG. */
export function kursNotenschluessel(roh) {
  const ns = String(roh || 'BG');
  return KURS_NOTENSCHLUESSEL.includes(ns) ? ns : 'BG';
}

/**
 * @returns {{ok: true, fachId: number} | {ok: false, fehler: string}}
 */
export function legeKursAn({ userId, schuljahrId, name, notenschluessel }) {
  const n = String(name || '').trim();
  if (!schuljahrId || !n) return { ok: false, fehler: 'Schuljahr und Name sind erforderlich.' };
  if (n.length > 100) return { ok: false, fehler: 'Der Name ist zu lang (höchstens 100 Zeichen).' };
  const ns = kursNotenschluessel(notenschluessel);
  const db = getDb();
  try {
    return db.transaction(() => {
      const huelle = db.prepare(`
        INSERT INTO klassen (schuljahr_id, name, notenschluessel, notenschluessel_csv, ist_kurs_huelle)
        VALUES (?, ?, ?, ?, 1)
      `).run(schuljahrId, `__kurshuelle_${makeToken()}`, ns, DEFAULT_NS_CSV[ns] || '');
      const info = db.prepare('INSERT INTO faecher (klasse_id, name, ist_kurs) VALUES (?, ?, 1)').run(huelle.lastInsertRowid, n);
      db.prepare('INSERT OR IGNORE INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)').run(userId, info.lastInsertRowid);
      return { ok: true, fachId: Number(info.lastInsertRowid) };
    })();
  } catch {
    return { ok: false, fehler: 'Kurs konnte nicht angelegt werden -- bitte Schuljahr prüfen.' };
  }
}
