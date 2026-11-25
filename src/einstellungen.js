/**
 * Kleine persönliche Einstellungen je Konto (Tabelle user_einstellungen). Nur bekannte Schlüssel mit den Werten '1' / '0'.
 * Sie liegen auf dem Server, damit sie auf jedem Gerät und Browser gelten und nicht verloren gehen, wenn ein Browser seine
 * Website-Daten löscht (Schul-Rechner, privater Modus, Safari nach längerer Pause).
 */

import { getDb } from './db.js';

/** Erlaubte Schlüssel. */
export const EINSTELLUNGEN = ['statistik_an'];

/** @returns {'1'|'0'|null} null = noch nie gesetzt */
export function ladeEinstellung(userId, schluessel) {
  if (!EINSTELLUNGEN.includes(schluessel)) return null;
  const z = getDb().prepare('SELECT wert FROM user_einstellungen WHERE user_id = ? AND schluessel = ?').get(userId, schluessel);
  return z ? z.wert : null;
}

/** @returns {boolean} false bei unbekanntem Schlüssel oder Wert */
export function setzeEinstellung(userId, schluessel, wert) {
  if (!EINSTELLUNGEN.includes(schluessel) || (wert !== '1' && wert !== '0')) return false;
  getDb().prepare(`
    INSERT INTO user_einstellungen (user_id, schluessel, wert) VALUES (?, ?, ?)
    ON CONFLICT(user_id, schluessel) DO UPDATE SET wert = excluded.wert
  `).run(userId, schluessel, wert);
  return true;
}
