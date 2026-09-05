/**
 * Single Sign-on und Schnittstelle für Schwester-Apps (derzeit: Lehrerkalender).
 *
 * Diese App ist der Anmeldedienst: Wer hier angemeldet ist, kommt ohne zweite
 * Anmeldung in den Lehrerkalender. Der Ablauf ist ein bewusst schlanker
 * Authorization-Code-Flow mit gemeinsamem Geheimnis (beide Apps gehören
 * derselben Schule und sprechen über HTTPS):
 *
 *   1. Kalender -> GET  /sso/authorize?client_id&redirect_uri&state
 *                  (ist hier niemand angemeldet, erscheint erst /login)
 *   2. wir      -> Weiterleitung an redirect_uri?code=<Einmal-Code>&state=…
 *   3. Kalender -> POST /sso/token  (server-zu-server, mit dem Geheimnis)
 *                  Antwort: { sub, username, name, rolle }
 *
 * Der Code ist einmalig, 60 s gültig und wird nur als SHA-256-Hash gespeichert
 * — ein Blick in die Datenbank erlaubt also kein Nachspielen.
 *
 * `sub` ist die stabile Kennung der Lehrkraft:
 *   - AD-Konten:    kleingeschriebener login_sub (sAMAccountName)
 *   - lokale Konten: "nv:" + kleingeschriebener Benutzername
 * Bei AD-Konten ist das exakt die Kennung, die der Lehrerkalender bisher aus
 * dem LDAP-Login gewonnen hat — bestehende Kalenderdaten bleiben dadurch
 * nach der SSO-Umstellung erreichbar.
 *
 * Konfiguration (ENV):
 *   SSO_CLIENT_ID       Kennung der Partner-App          (Default 'lehrerkalender')
 *   SSO_CLIENT_SECRET   gemeinsames Geheimnis            (Pflicht, sonst ist SSO aus)
 *   SSO_REDIRECT_URIS   erlaubte Rücksprungadressen, kommagetrennt (Pflicht)
 *   LEHRERKALENDER_URL  Basis-URL für den Link "Lehrerkalender" in der Navigation
 */

import crypto from 'node:crypto';
import { getDb } from './db.js';

const CODE_TTL_MS = 60 * 1000; // Einmal-Code: 60 Sekunden

export function ssoConfig() {
  return {
    clientId: process.env.SSO_CLIENT_ID || 'lehrerkalender',
    clientSecret: process.env.SSO_CLIENT_SECRET || '',
    redirectUris: (process.env.SSO_REDIRECT_URIS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    kalenderUrl: (process.env.LEHRERKALENDER_URL || '').replace(/\/+$/, ''),
  };
}

/** Ist SSO/die Kalender-Schnittstelle eingerichtet? */
export function istSsoAktiv() {
  const c = ssoConfig();
  return Boolean(c.clientSecret && c.redirectUris.length);
}

/** Zeitkonstanter Vergleich (verhindert Timing-Rückschlüsse aufs Geheimnis). */
export function geheimnisPasst(uebergeben) {
  const soll = ssoConfig().clientSecret;
  if (!soll || !uebergeben) return false;
  const a = Buffer.from(String(uebergeben));
  const b = Buffer.from(soll);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Prüft den Bearer-Token aus dem Authorization-Header. */
export function bearerPasst(authorizationHeader) {
  const m = /^Bearer\s+(.+)$/i.exec(String(authorizationHeader || ''));
  return m ? geheimnisPasst(m[1]) : false;
}

/** Ist die Rücksprungadresse für diesen Client freigegeben? (exakter Vergleich) */
export function redirectUriErlaubt(uri) {
  return ssoConfig().redirectUris.includes(String(uri || ''));
}

/** Stabile Kennung einer Lehrkraft für die Partner-App. */
export function subFuerUser(user) {
  const quelle = user.auth_source || user.authSource || 'lokal';
  if (quelle === 'ldap') {
    return String(user.login_sub || user.username).trim().toLowerCase();
  }
  return 'nv:' + String(user.username).trim().toLowerCase();
}

/**
 * Löst eine Kennung (`sub`) wieder in das Konto auf — Gegenstück zu
 * subFuerUser(). Nur aktive Konten. Rückgabe: users-Zeile oder null.
 */
export function userAusSub(sub) {
  const s = String(sub || '').trim().toLowerCase();
  if (!s) return null;
  const db = getDb();
  if (s.startsWith('nv:')) {
    const name = s.slice(3);
    return (
      db
        .prepare(
          `SELECT * FROM users
           WHERE username = ? COLLATE NOCASE AND auth_source <> 'ldap' AND active = 1`,
        )
        .get(name) || null
    );
  }
  return (
    db
      .prepare(
        `SELECT * FROM users
         WHERE active = 1 AND auth_source = 'ldap'
           AND (login_sub = ? COLLATE NOCASE OR username = ? COLLATE NOCASE)
         ORDER BY (login_sub = ? COLLATE NOCASE) DESC
         LIMIT 1`,
      )
      .get(s, s, s) || null
  );
}

function hash(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

/**
 * Erzeugt einen Einmal-Code für die angemeldete Person. Nur der Hash landet in
 * der Datenbank; zurückgegeben wird der Code selbst (für die Weiterleitung).
 */
export function erzeugeCode({ userId, clientId, redirectUri }) {
  const db = getDb();
  const code = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM sso_codes WHERE expires_at < ?').run(Date.now()); // Altlasten wegräumen
  db.prepare(
    `INSERT INTO sso_codes (code_hash, client_id, user_id, redirect_uri, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(hash(code), clientId, userId, redirectUri, Date.now() + CODE_TTL_MS);
  return code;
}

/**
 * Löst einen Einmal-Code ein. Der Code wird dabei gelöscht (single use).
 * Wirft mit `.status`/`.code`, wenn er unbekannt, abgelaufen oder für eine
 * andere Rücksprungadresse ausgestellt wurde.
 */
export function loeseCodeEin({ code, clientId, redirectUri }) {
  const db = getDb();
  const zeile = db.prepare('SELECT * FROM sso_codes WHERE code_hash = ?').get(hash(String(code || '')));
  // Immer löschen: auch ein fehlgeschlagener Versuch verbraucht den Code.
  if (zeile) db.prepare('DELETE FROM sso_codes WHERE code_hash = ?').run(zeile.code_hash);

  const fehler = (nachricht) => {
    const e = new Error(nachricht);
    e.status = 400;
    return e;
  };
  if (!zeile) throw fehler('Code unbekannt oder bereits eingelöst');
  if (zeile.expires_at < Date.now()) throw fehler('Code abgelaufen');
  if (zeile.client_id !== clientId) throw fehler('Code gehört zu einer anderen App');
  if (zeile.redirect_uri !== redirectUri) throw fehler('redirect_uri passt nicht zum Code');

  const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(zeile.user_id);
  if (!user) throw fehler('Konto existiert nicht mehr oder ist deaktiviert');
  return user;
}
