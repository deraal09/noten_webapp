/**
 * API-Schlüssel (persönliche Zugriffstokens) für KI-Agenten und andere Programme.
 *
 * Jede Lehrkraft erzeugt ihre Schlüssel selbst (Menü „API-Zugang“). Ein Schlüssel handelt immer als seine Besitzerin/sein Besitzer --
 * mit genau deren Rechten (dieselben Prüfungen wie in der Oberfläche). Berechtigung: „lesen“ (nur GET und Berechnungen) oder
 * „schreiben“ (zusätzlich Noten eintragen). Gespeichert wird nur der SHA-256-Hash; den Klartext sieht man einmal bei der Anlage.
 *
 * Nur Schulkonten (LDAP) dürfen Schlüssel anlegen und benutzen -- lokale Konten (auch der Admin) nicht. Gültig höchstens ein Jahr.
 * Der Admin kann die API insgesamt abschalten (Vorgabe: an), einzelne Schlüssel deaktivieren (wieder aktivierbar) und löschen.
 */

import crypto from 'node:crypto';
import { getDb } from './db.js';

export const SCOPES = ['lesen', 'schreiben'];
export const PREFIX = 'nk_';
export const MAX_KEYS_PRO_USER = 20;
export const RATE_PRO_MINUTE = 120;
export const MAX_GUELTIG_TAGE = 365;

/** Schlüssel und API nur für Schulkonten (LDAP). `user` mit authSource (Sitzung) oder auth_source (Datenbank). */
export const darfApiNutzen = (user) => (user?.authSource ?? user?.auth_source) === 'ldap';

/** Ist die API eingeschaltet? Vorgabe: ja (kein Eintrag in app_einstellungen). */
export function apiAktiv() {
  return getDb().prepare("SELECT value FROM app_einstellungen WHERE key = 'api_aktiv'").get()?.value !== '0';
}
export function setzeApiAktiv(aktiv) {
  getDb().prepare("INSERT INTO app_einstellungen (key, value) VALUES ('api_aktiv', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(aktiv ? '1' : '0');
}

const hash = (key) => crypto.createHash('sha256').update(key).digest('hex');

/** Zufälliger Schlüssel, z. B. nk_2f9k… (32 Byte Zufall, base64url). */
function neuerSchluessel() {
  return PREFIX + crypto.randomBytes(32).toString('base64url');
}

/** Gültigkeit in Tagen (1 bis MAX_GUELTIG_TAGE) -> ISO-Zeit; sonst null (ungültig). */
function ablaufNachTagen(tage, heute = new Date()) {
  const n = Number(tage);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_GUELTIG_TAGE) return null;
  return new Date(heute.getTime() + n * 86400000).toISOString();
}

/**
 * Legt einen Schlüssel an. @returns {{ok: true, id: number, key: string} | {ok: false, fehler: string}} -- `key` nur hier im Klartext.
 */
export function erzeugeSchluessel(userId, { name, scope, gueltigTage = 90 }, heute = new Date()) {
  const db = getDb();
  if (!apiAktiv()) return { ok: false, fehler: 'Die API ist vom Admin abgeschaltet -- es lassen sich keine Schlüssel anlegen.' };
  if (!darfApiNutzen(db.prepare('SELECT auth_source FROM users WHERE id = ?').get(userId))) {
    return { ok: false, fehler: 'API-Schlüssel gibt es nur für Schulkonten (LDAP).' };
  }
  const ablauf = ablaufNachTagen(gueltigTage, heute);
  if (!ablauf) return { ok: false, fehler: `Gültigkeit: 1 bis ${MAX_GUELTIG_TAGE} Tage.` };
  const bezeichnung = String(name || '').trim().slice(0, 80);
  if (!bezeichnung) return { ok: false, fehler: 'Bitte einen Namen angeben (z. B. „Claude Notenassistent“).' };
  if (!SCOPES.includes(scope)) return { ok: false, fehler: 'Unbekannte Berechtigung.' };
  const anzahl = db.prepare('SELECT COUNT(*) AS c FROM api_keys WHERE user_id = ? AND revoked_at IS NULL').get(userId).c;
  if (anzahl >= MAX_KEYS_PRO_USER) return { ok: false, fehler: `Höchstens ${MAX_KEYS_PRO_USER} aktive Schlüssel -- bitte nicht mehr benötigte widerrufen.` };
  const key = neuerSchluessel();
  const info = db.prepare('INSERT INTO api_keys (user_id, name, key_hash, key_prefix, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, bezeichnung, hash(key), key.slice(0, 11), scope, ablauf);
  return { ok: true, id: Number(info.lastInsertRowid), key };
}

/** Schlüssel einer Lehrkraft (ohne Klartext), neueste zuerst. */
export function ladeSchluessel(userId) {
  return getDb().prepare(`
    SELECT id, name, key_prefix, scope, created_at, expires_at, last_used_at, revoked_at, gesperrt_at FROM api_keys WHERE user_id = ? ORDER BY id DESC
  `).all(userId);
}

/** Widerruft einen eigenen Schlüssel (der Admin darf jeden). */
export function widerrufeSchluessel(id, userId, istAdmin = false) {
  const r = istAdmin
    ? getDb().prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL").run(id)
    : getDb().prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND user_id = ? AND revoked_at IS NULL").run(id, userId);
  return r.changes > 0;
}

// ---------- Verwaltung durch den Admin ----------

/** Alle Schlüssel mit Besitzer/in (ohne Klartext und Hash), neueste zuerst. */
export function ladeAlleSchluessel() {
  return getDb().prepare(`
    SELECT k.id, k.name, k.key_prefix, k.scope, k.created_at, k.expires_at, k.last_used_at, k.revoked_at, k.gesperrt_at,
           u.id AS user_id, u.username, u.display_name, u.auth_source, u.active
    FROM api_keys k JOIN users u ON u.id = k.user_id ORDER BY k.id DESC
  `).all();
}

/** Deaktiviert einen Schlüssel (gesperrt = true) oder gibt ihn wieder frei. Widerrufene Schlüssel bleiben widerrufen. */
export function sperreSchluessel(id, gesperrt) {
  const r = gesperrt
    ? getDb().prepare("UPDATE api_keys SET gesperrt_at = datetime('now') WHERE id = ? AND gesperrt_at IS NULL AND revoked_at IS NULL").run(id)
    : getDb().prepare('UPDATE api_keys SET gesperrt_at = NULL WHERE id = ? AND gesperrt_at IS NOT NULL AND revoked_at IS NULL').run(id);
  return r.changes > 0;
}

/** Löscht einen Schlüssel endgültig (auch aus der Liste der Besitzerin/des Besitzers). */
export function loescheSchluessel(id) {
  return getDb().prepare('DELETE FROM api_keys WHERE id = ?').run(id).changes > 0;
}

/** Widerruft alle noch gültigen Schlüssel von LDAP-Konten (z. B. mit „LDAP-Anmeldungen beenden“). @returns Anzahl */
export function widerrufeLdapSchluessel() {
  return getDb().prepare(`
    UPDATE api_keys SET revoked_at = datetime('now')
    WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE auth_source = 'ldap')
  `).run().changes;
}

/**
 * Prüft einen Bearer-Schlüssel.
 * @returns {{ok: true, user: object, key: {id, scope}} | {ok: false, status: number, code: string, fehler: string}}
 * Setzt last_used_at (höchstens einmal pro Minute und Schlüssel).
 */
export function pruefeSchluessel(authHeader, heute = new Date()) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(authHeader || ''));
  const nein = (status, code, fehler) => ({ ok: false, status, code, fehler });
  if (!apiAktiv()) return nein(503, 'api_deaktiviert', 'Die API ist vom Admin abgeschaltet.');
  if (!m || !m[1].startsWith(PREFIX)) return nein(401, 'unauthorized', 'API-Schlüssel fehlt: Header „Authorization: Bearer nk_…“ senden.');
  const db = getDb();
  const row = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(hash(m[1]));
  if (!row || row.revoked_at) return nein(401, 'unauthorized', 'API-Schlüssel ungültig oder widerrufen.');
  if (row.gesperrt_at) return nein(401, 'unauthorized', 'API-Schlüssel vom Admin deaktiviert.');
  if (!row.expires_at || new Date(row.expires_at).getTime() <= heute.getTime()) return nein(401, 'unauthorized', 'API-Schlüssel abgelaufen.');
  const u = db.prepare('SELECT id, username, email, role, display_name, active, auth_source FROM users WHERE id = ?').get(row.user_id);
  if (!u || !u.active) return nein(401, 'unauthorized', 'Das Konto zu diesem Schlüssel ist nicht aktiv.');
  if (!darfApiNutzen(u)) return nein(403, 'nur_ldap', 'Die API steht nur Schulkonten (LDAP) zur Verfügung.');
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
