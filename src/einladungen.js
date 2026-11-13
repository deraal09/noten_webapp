/**
 * Einladungen anlegen (gemeinsam für Admin und Klassenleitung): Ohne eingegebenen Anzeigenamen bekommt die Einladung einen zufälligen
 * Namen aus dem Star-Trek-Universum als Etikett (invitations.name_generiert = 1), damit man beim Verschicken weiß, welcher Link für wen
 * gedacht ist. Ein solches Etikett erscheint weder in der Anrede der Mail noch als Name des neuen Kontos.
 */

import { getDb } from './db.js';
import { makeToken } from './auth.js';
import { zufaelligerStartrekName } from './startrek-namen.js';

export const MAX_ANZEIGENAME = 100;

/**
 * @returns {{id: number, token: string, displayName: string, generiert: boolean}}
 */
export function legeEinladungAn({ userId, email, displayName, ttlDays, zufall = Math.random }) {
  const db = getDb();
  const eingabe = String(displayName ?? '').trim().slice(0, MAX_ANZEIGENAME);
  const ttl = parseInt(ttlDays, 10) || 14;
  const expires = new Date(Date.now() + ttl * 86400 * 1000).toISOString();
  const token = makeToken();
  const generiert = !eingabe;
  // Etiketten der noch offenen Einladungen sind vergeben, damit sich zwei Links nie gleich nennen.
  const name = eingabe || zufaelligerStartrekName(
    db.prepare('SELECT display_name FROM invitations WHERE used_at IS NULL AND display_name IS NOT NULL').all().map((r) => r.display_name),
    zufall,
  );
  const info = db.prepare(`INSERT INTO invitations (token, email, display_name, name_generiert, role, created_by_id, expires_at)
                           VALUES (?, ?, ?, ?, 'teacher', ?, ?)`)
    .run(token, String(email ?? '').trim() || null, name, generiert ? 1 : 0, userId, expires);
  return { id: Number(info.lastInsertRowid), token, displayName: name, generiert };
}
