/**
 * LDAP/Active-Directory-Anbindung. Portiert aus `notentabellen-spa`
 * (packages/server/src/auth/ldap.ts), angepasst an dieses (nicht-TypeScript)
 * Projekt.
 *
 * Zwei Modi (siehe `ldapConfigAusEnv`):
 * - Service-Modus (Default): Mit Service-Account binden, Benutzer per Filter
 *   suchen, dann mit gefundener DN + eingegebenem Passwort erneut binden.
 * - Direkt-Modus (LDAP_BIND_USER_TEMPLATE gesetzt): Der Nutzer bindet sofort
 *   mit eigener Kennung + Passwort — kein Service-Account nötig.
 *
 * Für die Verzeichnis-Suche (Admin-Feature „Lehrkräfte aus LDAP importieren")
 * wird IMMER ein Service-Account (LDAP_BIND_DN/LDAP_BIND_PW) benötigt, auch
 * wenn der Login selbst im Direkt-Modus läuft — siehe `searchLehrkraefte`.
 */

import { readFileSync } from 'node:fs';
import { Client, InvalidCredentialsError } from 'ldapts';

/** Liest die LDAP-Konfiguration aus Umgebungsvariablen (niemals aus dem Repo!). */
export function ldapConfigAusEnv(env = process.env) {
  const pflicht = (k) => {
    const v = env[k];
    if (!v) throw new Error(`Umgebungsvariable ${k} fehlt (LDAP-Konfiguration)`);
    return v;
  };
  // TLS-Optionen für ldaps:// aus der Umgebung ableiten:
  // - LDAP_TLS_CA_PFAD: Pfad zur PEM-Datei der internen CA (empfohlen).
  // - LDAP_TLS_REJECT_UNAUTHORIZED=false: Zertifikatsprüfung abschalten
  //   (nur als Notlösung in vertrauenswürdigen Netzen — siehe README).
  const tlsOptions = {};
  const caPfad = env['LDAP_TLS_CA_PFAD'];
  if (caPfad) tlsOptions.ca = readFileSync(caPfad);
  if (env['LDAP_TLS_REJECT_UNAUTHORIZED'] === 'false') tlsOptions.rejectUnauthorized = false;

  // Im Direkt-Bind-Modus (LDAP_BIND_USER_TEMPLATE gesetzt) ist der
  // Service-Account optional.
  const userBindTemplate = env['LDAP_BIND_USER_TEMPLATE'];
  const direkt = Boolean(userBindTemplate);

  return {
    url: pflicht('LDAP_URL'),
    bindDn: direkt ? (env['LDAP_BIND_DN'] ?? '') : pflicht('LDAP_BIND_DN'),
    bindPasswort: direkt ? (env['LDAP_BIND_PW'] ?? '') : pflicht('LDAP_BIND_PW'),
    baseDn: pflicht('LDAP_BASE_DN'),
    userFilter: env['LDAP_USER_FILTER'] ?? '(sAMAccountName={{username}})',
    loginAttr: env['LDAP_LOGIN_ATTR'] ?? 'sAMAccountName',
    nameAttr: env['LDAP_NAME_ATTR'] ?? 'displayName',
    // Filter für die Lehrkräfte-Suche im Admin-Bereich (Substring wird via {{query}} eingesetzt).
    teacherSearchFilter:
      env['LDAP_TEACHER_SEARCH_FILTER'] ??
      '(&(objectClass=person)(|(cn=*{{query}}*)(sAMAccountName=*{{query}}*)(displayName=*{{query}}*)))',
    ...(Object.keys(tlsOptions).length ? { tlsOptions } : {}),
    ...(userBindTemplate ? { userBindTemplate } : {}),
  };
}

function escapeFilter(wert) {
  // RFC 4515: Sonderzeichen im Suchfilter maskieren (Injection vermeiden).
  return wert.replace(/[\\*() ]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

function alsString(v) {
  if (Array.isArray(v)) return v.length ? String(v[0]) : undefined;
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  return v === undefined ? undefined : String(v);
}

/**
 * Authentifizierung per LDAP-Bind gegen ein Active Directory.
 * Rollen kommen NICHT aus dem AD, sondern aus der DB (Tabelle `users`).
 */
export class LdapAuthenticator {
  constructor(cfg) {
    this.cfg = cfg;
  }

  clientOptions() {
    return {
      url: this.cfg.url,
      ...(this.cfg.tlsOptions ? { tlsOptions: this.cfg.tlsOptions } : {}),
    };
  }

  async authenticate(benutzername, passwort) {
    if (!benutzername || !passwort) return null;
    if (this.cfg.userBindTemplate) {
      return this.authenticateDirekt(benutzername, passwort);
    }

    const clientOpts = this.clientOptions();
    const suchClient = new Client(clientOpts);
    let benutzerDn;
    let loginSub;
    let name;
    try {
      try {
        await suchClient.bind(this.cfg.bindDn, this.cfg.bindPasswort);
      } catch (e) {
        // Fehler beim Service-Account-Bind ist ein Konfigurationsproblem
        // (falsche LDAP_BIND_DN/LDAP_BIND_PW), nicht ein Anmeldefehler des
        // Nutzers — klar kennzeichnen, damit es im Log eindeutig ist.
        throw new Error(
          `Service-Account-Bind fehlgeschlagen — bitte LDAP_BIND_DN und LDAP_BIND_PW prüfen (Lese-Nutzer): ${e.message}`,
          { cause: e },
        );
      }
      const filter = this.cfg.userFilter.replace('{{username}}', escapeFilter(benutzername));
      const { searchEntries } = await suchClient.search(this.cfg.baseDn, {
        scope: 'sub',
        filter,
        attributes: ['dn', this.cfg.loginAttr, this.cfg.nameAttr],
      });
      if (searchEntries.length !== 1) return null; // nicht gefunden oder mehrdeutig
      const eintrag = searchEntries[0];
      benutzerDn = String(eintrag.dn);
      loginSub = alsString(eintrag[this.cfg.loginAttr]) ?? benutzername;
      name = alsString(eintrag[this.cfg.nameAttr]);
    } finally {
      await suchClient.unbind().catch(() => undefined);
    }

    // Schritt 2: Passwort gegen die Benutzer-DN prüfen.
    const verifyClient = new Client(clientOpts);
    try {
      await verifyClient.bind(benutzerDn, passwort);
    } catch (e) {
      if (e instanceof InvalidCredentialsError) return null;
      throw e;
    } finally {
      await verifyClient.unbind().catch(() => undefined);
    }

    return name !== undefined ? { loginSub, name } : { loginSub };
  }

  /**
   * Direkt-Bind: Der Nutzer meldet sich mit `userBindTemplate` (z. B.
   * `SNRD\{{username}}`) und eigenem Passwort an. Schlägt der Bind mit
   * ungültigen Anmeldedaten fehl, gilt die Anmeldung als abgelehnt (null).
   */
  async authenticateDirekt(benutzername, passwort) {
    const bindName = this.cfg.userBindTemplate.replace('{{username}}', benutzername);
    const client = new Client(this.clientOptions());
    try {
      try {
        await client.bind(bindName, passwort);
      } catch (e) {
        if (e instanceof InvalidCredentialsError) return null; // Passwort falsch
        throw e; // technischer Fehler (TLS, Netzwerk, …)
      }

      // Anmeldung ist bereits bestätigt. Attribute sind optional: Wir lesen sie
      // best effort über die authentifizierte Verbindung; klappt das nicht
      // (z. B. fehlende Leserechte), fällt loginSub auf den Eingabenamen zurück.
      let loginSub = benutzername;
      let name;
      try {
        const filter = this.cfg.userFilter.replace('{{username}}', escapeFilter(benutzername));
        const { searchEntries } = await client.search(this.cfg.baseDn, {
          scope: 'sub',
          filter,
          attributes: ['dn', this.cfg.loginAttr, this.cfg.nameAttr],
        });
        if (searchEntries.length === 1) {
          const eintrag = searchEntries[0];
          loginSub = alsString(eintrag[this.cfg.loginAttr]) ?? benutzername;
          name = alsString(eintrag[this.cfg.nameAttr]);
        }
      } catch {
        /* Attributsuche optional — Anmeldung gilt bereits als erfolgreich */
      }
      return name !== undefined ? { loginSub, name } : { loginSub };
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }
}

/**
 * Durchsucht das Verzeichnis nach Lehrkräften (für den Admin-Import).
 * Benötigt IMMER einen Service-Account (LDAP_BIND_DN/LDAP_BIND_PW), auch
 * wenn der Login selbst im Direkt-Modus läuft — ohne eigenes Nutzerpasswort
 * gibt es sonst keine Verbindung, mit der sich das Verzeichnis auflisten ließe.
 *
 * @returns {Promise<Array<{loginSub: string, name: string|undefined, dn: string}>>}
 */
export async function searchLehrkraefte(cfg, { query = '', limit = 50 } = {}) {
  if (!cfg.bindDn || !cfg.bindPasswort) {
    throw new Error(
      'Für die LDAP-Verzeichnis-Suche wird ein Service-Account benötigt (LDAP_BIND_DN/LDAP_BIND_PW setzen), ' +
      'auch wenn der Login selbst per Direkt-Bind läuft.',
    );
  }
  const client = new Client({
    url: cfg.url,
    ...(cfg.tlsOptions ? { tlsOptions: cfg.tlsOptions } : {}),
  });
  try {
    await client.bind(cfg.bindDn, cfg.bindPasswort);
    const filter = cfg.teacherSearchFilter.replace(/\{\{query\}\}/g, escapeFilter(query));
    const { searchEntries } = await client.search(cfg.baseDn, {
      scope: 'sub',
      filter,
      attributes: ['dn', cfg.loginAttr, cfg.nameAttr],
      sizeLimit: limit,
    });
    return searchEntries.map((eintrag) => ({
      dn: String(eintrag.dn),
      loginSub: alsString(eintrag[cfg.loginAttr]) ?? '',
      name: alsString(eintrag[cfg.nameAttr]),
    })).filter((e) => e.loginSub);
  } finally {
    await client.unbind().catch(() => undefined);
  }
}
