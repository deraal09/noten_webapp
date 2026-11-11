/**
 * Klassennamen und der Papierkorb: Eine Klasse im Papierkorb, die ALLE Lehrkräfte gelöscht haben (klassen.papierkorb_ab ist gesetzt),
 * soll ihren Namen nicht blockieren -- weder bei „Klasse anlegen“ noch beim Umbenennen. Weil der Name je Schuljahr in der Datenbank
 * eindeutig sein muss (UNIQUE (schuljahr_id, name)), bekommt die Papierkorb-Klasse bei Bedarf einen Zusatz „ (gelöscht #<id>)“;
 * im Papierkorb wird der Zusatz nicht angezeigt, und beim Wiederherstellen erhält die Klasse ihren Namen zurück (ist er inzwischen
 * vergeben, mit dem Zusatz „ (wiederhergestellt)“).
 */

import { getDb } from './db.js';

const ZUSATZ = / \(gelöscht #\d+\)$/;

/** Name ohne den technischen Zusatz für Klassen, die einem neuen Namensträger weichen mussten. */
export function anzeigeName(name) {
  return String(name ?? '').replace(ZUSATZ, '');
}

/**
 * Macht `name` im Schuljahr frei, indem Klassen im Papierkorb mit diesem Namen (ohne Unterschied bei Groß-/Kleinschreibung)
 * umbenannt werden. Klassen, die noch eine Lehrkraft nutzt, bleiben unberührt.
 * @returns {number} Anzahl umbenannter Papierkorb-Klassen
 */
export function gibKlassennamenFrei(schuljahrId, name, ausserKlasseId = null) {
  const db = getDb();
  const belegt = db.prepare('SELECT id, name FROM klassen WHERE schuljahr_id = ? AND name = ? COLLATE NOCASE AND papierkorb_ab IS NOT NULL AND id IS NOT ?')
    .all(schuljahrId, String(name).trim(), ausserKlasseId);
  for (const k of belegt) db.prepare('UPDATE klassen SET name = ? WHERE id = ?').run(`${k.name} (gelöscht #${k.id})`, k.id);
  return belegt.length;
}

/** Eine Klasse verlässt den Papierkorb: ursprünglichen Namen zurückgeben, soweit er frei ist. */
export function stelleKlassennamenWiederHer(klasseId) {
  const db = getDb();
  const k = db.prepare('SELECT id, name, schuljahr_id FROM klassen WHERE id = ?').get(klasseId);
  if (!k || !ZUSATZ.test(k.name)) return k?.name ?? null;
  const frei = (n) => !db.prepare('SELECT 1 FROM klassen WHERE schuljahr_id = ? AND name = ? COLLATE NOCASE AND id != ?').get(k.schuljahr_id, n, k.id);
  const basis = anzeigeName(k.name);
  let neu = basis;
  if (!frei(neu)) neu = `${basis} (wiederhergestellt)`;
  if (!frei(neu)) neu = `${basis} (wiederhergestellt #${k.id})`;
  db.prepare('UPDATE klassen SET name = ? WHERE id = ?').run(neu, k.id);
  return neu;
}
