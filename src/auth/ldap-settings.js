/**
 * LDAP-Konfiguration über die Admin-Oberfläche (Tabelle `ldap_settings`,
 * eine feste Zeile mit id=1) statt (nur) über Plesk-Umgebungsvariablen.
 *
 * Vorrang: Ist in der DB eine `url` gespeichert, wird AUSSCHLIESSLICH die
 * DB-Konfiguration verwendet (kein Mischen von DB- und ENV-Feldern — das
 * würde zu schwer nachvollziehbaren Halb-Konfigurationen führen). Ist keine
 * DB-Konfiguration vorhanden, greift wie bisher `ldapConfigAusEnv()` aus
 * den ENV-Variablen (LDAP_URL etc.) — bestehende reine Plesk-ENV-Installationen
 * funktionieren dadurch unverändert weiter.
 */

import { getDb } from '../db.js';
import { ldapConfigAusEnv, ldapConfigAusSettings } from './ldap.js';
import { encryptSecret, decryptSecret } from './secret-crypto.js';

export function getLdapSettingsRow() {
  return getDb().prepare('SELECT * FROM ldap_settings WHERE id = 1').get() || null;
}

export function isLdapConfigured() {
  const row = getLdapSettingsRow();
  return Boolean(row?.url) || Boolean(process.env.LDAP_URL);
}

export function isAutoProvisionEnabled() {
  const row = getLdapSettingsRow();
  // Der Haken selbst lebt immer in der DB-Zeile (id=1) — unabhängig davon,
  // ob die eigentliche LDAP-URL/Bind-Konfiguration aus dieser Zeile oder
  // (bei reiner Plesk-ENV-Installation) aus LDAP_URL etc. kommt. Früher war
  // hier zusätzlich `row?.url` gefordert, wodurch Auto-Provisioning bei
  // reiner ENV-Konfiguration nie griff, selbst wenn der Haken gesetzt war.
  return isLdapConfigured() && Boolean(row?.auto_provision);
}

/** Löst die aktive LDAP-Konfiguration auf (DB hat Vorrang vor ENV). Wirft bei unvollständiger Konfiguration. */
export function resolveLdapConfig() {
  const row = getLdapSettingsRow();
  if (row?.url) return ldapConfigAusSettings(row, decryptSecret);
  return ldapConfigAusEnv();
}

/**
 * Speichert die LDAP-Einstellungen. `input.bind_pw` leer/undefined lässt ein
 * bereits gespeichertes Passwort unverändert (Formular zeigt es nie im
 * Klartext an — ein leeres Feld heißt "nicht ändern", nicht "löschen").
 */
export function saveLdapSettings(input) {
  const db = getDb();
  const existing = getLdapSettingsRow();
  const bindPw = input.bind_pw && input.bind_pw.length
    ? encryptSecret(input.bind_pw)
    : (existing?.bind_pw_encrypted ?? null);

  db.prepare(`
    INSERT INTO ldap_settings
      (id, url, base_dn, user_filter, bind_user_template, bind_dn, bind_pw_encrypted,
       login_attr, name_attr, teacher_search_filter, tls_ca_pem, tls_reject_unauthorized,
       auto_provision, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      url = excluded.url,
      base_dn = excluded.base_dn,
      user_filter = excluded.user_filter,
      bind_user_template = excluded.bind_user_template,
      bind_dn = excluded.bind_dn,
      bind_pw_encrypted = excluded.bind_pw_encrypted,
      login_attr = excluded.login_attr,
      name_attr = excluded.name_attr,
      teacher_search_filter = excluded.teacher_search_filter,
      tls_ca_pem = excluded.tls_ca_pem,
      tls_reject_unauthorized = excluded.tls_reject_unauthorized,
      auto_provision = excluded.auto_provision,
      updated_at = datetime('now')
  `).run(
    input.url || null,
    input.base_dn || null,
    input.user_filter || null,
    input.bind_user_template || null,
    input.bind_dn || null,
    bindPw,
    input.login_attr || null,
    input.name_attr || null,
    input.teacher_search_filter || null,
    input.tls_ca_pem || null,
    input.tls_reject_unauthorized ? 1 : 0,
    input.auto_provision ? 1 : 0,
  );
}

export function clearLdapBindPassword() {
  getDb().prepare('UPDATE ldap_settings SET bind_pw_encrypted = NULL, updated_at = datetime(\'now\') WHERE id = 1').run();
}
