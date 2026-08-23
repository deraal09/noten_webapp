/**
 * Authenticator-Abstraktion, damit die App ohne echten LDAP-Server testbar
 * bleibt. Die echte Implementierung (LDAP-Bind gegen das AD) liegt in
 * `ldap.js`; Tests nutzen `FakeAuthenticator`.
 *
 * Ein Authenticator liefert bei Erfolg { loginSub, name? } zurück, sonst null.
 * Rollen kommen NICHT aus dem Verzeichnis, sondern aus der lokalen DB.
 */

/** Einfacher In-Memory-Authenticator für Tests und lokale Entwicklung. */
export class FakeAuthenticator {
  constructor(nutzer) {
    this.nutzer = nutzer;
  }

  async authenticate(benutzername, passwort) {
    const eintrag = this.nutzer[benutzername];
    if (!eintrag || eintrag.passwort !== passwort) return null;
    return eintrag.name !== undefined
      ? { loginSub: benutzername, name: eintrag.name }
      : { loginSub: benutzername };
  }
}
