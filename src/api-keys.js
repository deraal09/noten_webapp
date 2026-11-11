/**
 * API-Schlüssel (persönliche Zugriffstokens) für KI-Agenten und andere Programme.
 *
 * Jede Lehrkraft erzeugt ihre Schlüssel selbst (Menü „API-Zugang“). Ein Schlüssel handelt immer als seine Besitzerin/sein Besitzer --
 * mit genau deren Rechten (dieselben Prüfungen wie in der Oberfläche). Berechtigung: „lesen“ (nur GET und Berechnungen) oder
 * „schreiben“ (zusätzlich Noten eintragen). Gespeichert wird nur der SHA-256-Hash; den Klartext sieht man einmal bei der Anlage.
 */

import crypto from 'node:crypto';
import { getDb } from './db.js';

export const SCOPES = ['lesen', 'schreiben'];
export const PREFIX = 'nk_';
export const MAX_KEYS_PRO_USER = 20;
export const RATE_PRO_MINUTE = 120;

const hash = (key) => crypto.createHash('sha256').update(key).digest('hex');

/** Zufälliger Schlüssel, z. B. nk_2f9k… (32 Byte Zufall, base64url). */
function neuerSchluessel() {
  return PREFIX + crypto.randomBytes(32).toString('base64url');
}

/** Gültigkeit in Tagen (null = unbegrenzt) -> ISO-Zeit oder null. */
function ablaufNachTagen(tage, heute = new Date()) {
  const n = Number(tage);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(heute.getTime() + n * 86400000).toISOString();
}

/**
 * Legt einen Schlüssel an. @returns {{ok: true, id: number, key: string} | {ok: false, fehler: string}} -- `key` nur hier im Klartext.
 */
export function erzeugeSchluessel(userId, { name, scope, gueltigTage = null }, heute = new Date()) {
  const db = getDb();
  const bezeichnung = String(name || '').trim().slice(0, 80);
  if (!bezeichnung) return { ok: false, fehler: 'Bitte einen Namen angeben (z. B. „Claude Notenassistent“).' };
  if (!SCOPES.includes(scope)) return { ok: false, fehler: 'Unbekannte Berechtigung.' };
  const anzahl = db.prepare('SELECT COUNT(*) AS c FROM api_keys WHERE user_id = ? AND revoked_at IS NULL').get(userId).c;
  if (anzahl >= MAX_KEYS_PRO_USER) return { ok: false, fehler: `Höchstens ${MAX_KEYS_PRO_USER} aktive Schlüssel -- bitte nicht mehr benötigte widerrufen.` };
  const key = neuerSchluessel();
  const info = db.prepare('INSERT INTO api_keys (user_id, name, key_hash, key_prefix, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, bezeichnung, hash(key), key.slice(0, 11), scope, ablaufNachTagen(gueltigTage, heute));
  return { ok: true, id: Number(info.lastInsertRowid), key };
}

/** Schlüssel einer Lehrkraft (ohne Klartext), neueste zuerst. */
export function ladeSchluessel(userId) {
  return getDb().prepare(`
    SELECT id, name, key_prefix, scope, created_at, expires_at, last_used_at, revoked_at FROM api_keys WHERE user_id = ? ORDER BY id DESC
  `).all(userId);
}

/** Widerruft einen eigenen Schlüssel (der Admin darf jeden). */
export function widerrufeSchluessel(id, userId, istAdmin = false) {
  const r = istAdmin
    ? getDb().prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL").run(id)
    : getDb().prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND user_id = ? AND revoked_at IS NULL").run(id, userId);
  return r.changes > 0;
}

/**
 * Prüft einen Bearer-Schlüssel. @returns {{ok: true, user: object, key: {id, scope}} | {ok: false, status: number, fehler: string}}
 * Setzt last_used_at (höchstens einmal pro Minute und Schlüssel).
 */
export function pruefeSchluessel(authHeader, heute = new Date()) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(authHeader || ''));
  if (!m || !m[1].startsWith(PREFIX)) return { ok: false, status: 401, fehler: 'API-Schlüssel fehlt: Header „Authorization: Bearer nk_…“ senden.' };
  const db = getDb();
  const row = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(hash(m[1]));
  if (!row || row.revoked_at) return { ok: false, status: 401, fehler: 'API-Schlüssel ungültig oder widerrufen.' };
  if (row.expires_at && new Date(row.expires_at).getTime() <= heute.getTime()) return { ok: false, status: 401, fehler: 'API-Schlüssel abgelaufen.' };
  const u = db.prepare('SELECT id, username, email, role, display_name, active, auth_source FROM users WHERE id = ?').get(row.user_id);
  if (!u || !u.active) return { ok: false, status: 401, fehler: 'Das Konto zu diesem Schlüssel ist nicht aktiv.' };
  const letzte = row.last_used_at ? new Date(row.last_used_at).getTime() : 0;
  if (heute.getTime() - letzte > 60000) db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(heute.toISOString(), row.id);
  return {
    ok: true,
    key: { id: row.id, name: row.name, scope: row.scope, prefix: row.key_prefix, expires_at: row.expires_at },
    user: {
      id: u.id, username: u.username, email: u.email, role: u.role, displayName: u.display_name, isAdmin: u.role === 'admin', authSource: u.auth_source,
    },
  };
}

// Einfache Begrenzung je Schlüssel: höchstens RATE_PRO_MINUTE Anfragen pro Minute (im Speicher).
const fenster = new Map();
export function rateLimitErreicht(keyId, jetztMs = Date.now()) {
  const minute = Math.floor(jetztMs / 60000);
  const e = fenster.get(keyId);
  if (!e || e.minute !== minute) { fenster.set(keyId, { minute, n: 1 }); return false; }
  e.n += 1;
  return e.n > RATE_PRO_MINUTE;
}
