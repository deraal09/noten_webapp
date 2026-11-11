/**
 * Klasse umbenennen (gemeinsam für die Oberfläche und die API): Prüfungen und Speichern. Der Name steht nur einmal in der Klasse und
 * gilt damit sofort für alle, die in der Klasse eingetragen sind. Je Schuljahr muss er eindeutig sein.
 */

import { getDb } from './db.js';

export const MAX_KLASSENNAME = 60;

/**
 * @param {{id: number, name: string, schuljahr_id: number}} klasse
 * @param {unknown} rohName
 * @param {{speichern?: boolean}} [optionen] speichern: false = nur prüfen
 * @returns {{ok: true, alt: string, neu: string, geaendert: boolean} | {ok: false, fehler: string}}
 */
export function benenneKlasseUm(klasse, rohName, { speichern = true } = {}) {
  const name = String(rohName ?? '').trim();
  if (!name) return { ok: false, fehler: 'Bitte einen Namen angeben.' };
  if (name.length > MAX_KLASSENNAME) return { ok: false, fehler: `Der Name ist zu lang (höchstens ${MAX_KLASSENNAME} Zeichen).` };
  if (name.startsWith('__')) return { ok: false, fehler: 'Der Name darf nicht mit „__“ beginnen.' };
  if (name === klasse.name) return { ok: true, alt: klasse.name, neu: name, geaendert: false };
  if (getDb().prepare('SELECT 1 FROM klassen WHERE schuljahr_id = ? AND name = ? COLLATE NOCASE AND id != ?').get(klasse.schuljahr_id, name, klasse.id)) {
    return { ok: false, fehler: `Im Schuljahr gibt es schon eine Klasse „${name}“.` };
  }
  if (speichern) getDb().prepare('UPDATE klassen SET name = ? WHERE id = ?').run(name, klasse.id);
  return { ok: true, alt: klasse.name, neu: name, geaendert: true };
}
