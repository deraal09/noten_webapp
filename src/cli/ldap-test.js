/**
 * Diagnose-CLI: testet den LDAP-Login direkt (ohne Webserver/Passenger) und
 * gibt den vollständigen Fehler aus. Liest dieselbe Konfiguration wie der
 * Server (ENV-Variablen bzw. Plesk-Node.js-UI).
 *
 * Aufruf: node src/cli/ldap-test.js <benutzername> <passwort>
 */

import { ldapConfigAusEnv, LdapAuthenticator } from '../auth/ldap.js';

const benutzer = process.argv[2];
const passwort = process.argv[3];
if (!benutzer || !passwort) {
  console.error('Aufruf: node src/cli/ldap-test.js <benutzername> <passwort>');
  process.exit(2);
}

async function main(benutzer, passwort) {
  let cfg;
  try {
    cfg = ldapConfigAusEnv();
  } catch (e) {
    console.error('❌ LDAP-Konfiguration unvollständig:', e.message);
    process.exit(2);
  }
  console.log('LDAP-Konfiguration:');
  console.log('  URL        :', cfg.url);
  console.log('  bindDn     :', cfg.bindDn || '(kein Service-Account – Direkt-Bind)');
  console.log('  baseDn     :', cfg.baseDn);
  console.log('  userFilter :', cfg.userFilter.replace('{{username}}', benutzer));
  console.log('  loginAttr  :', cfg.loginAttr);
  console.log(
    '  TLS        :',
    cfg.tlsOptions
      ? `rejectUnauthorized=${cfg.tlsOptions.rejectUnauthorized ?? true}, CA=${cfg.tlsOptions.ca ? 'gesetzt' : 'keine'}`
      : 'Standard (Prüfung an, System-CAs)',
  );
  console.log();

  const auth = new LdapAuthenticator(cfg);
  try {
    const erg = await auth.authenticate(benutzer, passwort);
    if (erg) {
      console.log('✅ Anmeldung erfolgreich:', erg);
      console.log(
        `\nHinweis: In der Notenverwaltung muss eine Lehrkraft mit login_sub = "${erg.loginSub}" angelegt sein (siehe Admin → LDAP-Import).`,
      );
    } else {
      console.log(
        '⚠️  Anmeldung abgelehnt: Benutzer nicht gefunden, mehrdeutig oder Passwort falsch (kein technischer Fehler).',
      );
    }
  } catch (e) {
    console.error('❌ Technischer Fehler beim LDAP-Zugriff:');
    if (e.code) console.error('  code   :', e.code);
    if (e.message) console.error('  message:', e.message);
    console.error(e);
    process.exit(1);
  }
}

await main(benutzer, passwort);
