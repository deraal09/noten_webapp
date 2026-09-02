import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-ldapsettings-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-ldap-settings-bitte-lang-genug';
delete process.env.LDAP_URL;

const {
  getLdapSettingsRow, saveLdapSettings, clearLdapBindPassword, resolveLdapConfig, isLdapConfigured, isAutoProvisionEnabled,
} = await import('../src/auth/ldap-settings.js');

test('Ohne gespeicherte Einstellungen und ohne ENV: nicht konfiguriert', () => {
  assert.equal(isLdapConfigured(), false);
  assert.equal(getLdapSettingsRow(), null);
});

test('saveLdapSettings + resolveLdapConfig: Direkt-Bind-Konfiguration aus der DB', () => {
  saveLdapSettings({
    url: 'ldaps://dc01.schule.local:636',
    base_dn: 'DC=schule,DC=local',
    bind_user_template: 'SCHULE\\{{username}}',
    tls_reject_unauthorized: true,
    auto_provision: true,
  });
  assert.equal(isLdapConfigured(), true);
  assert.equal(isAutoProvisionEnabled(), true);
  const cfg = resolveLdapConfig();
  assert.equal(cfg.url, 'ldaps://dc01.schule.local:636');
  assert.equal(cfg.userBindTemplate, 'SCHULE\\{{username}}');
  assert.equal(cfg.bindDn, '');
});

test('Passwort wird verschlüsselt gespeichert, nie im Klartext in der DB-Zeile', () => {
  saveLdapSettings({
    url: 'ldaps://dc01.schule.local:636',
    base_dn: 'DC=schule,DC=local',
    bind_dn: 'CN=svc,DC=schule,DC=local',
    bind_pw: 'geheimes-service-passwort',
  });
  const row = getLdapSettingsRow();
  assert.notEqual(row.bind_pw_encrypted, 'geheimes-service-passwort');
  assert.ok(row.bind_pw_encrypted);
  // resolveLdapConfig kann es intern entschlüsseln, um zu binden:
  const cfg = resolveLdapConfig();
  assert.equal(cfg.bindPasswort, 'geheimes-service-passwort');
});

test('Leeres bind_pw beim erneuten Speichern lässt das bestehende Passwort unverändert', () => {
  saveLdapSettings({
    url: 'ldaps://dc01.schule.local:636',
    base_dn: 'DC=schule,DC=local',
    bind_dn: 'CN=svc,DC=schule,DC=local',
    bind_pw: '', // unverändert lassen
  });
  const cfg = resolveLdapConfig();
  assert.equal(cfg.bindPasswort, 'geheimes-service-passwort');
});

test('clearLdapBindPassword entfernt das Passwort', () => {
  clearLdapBindPassword();
  const row = getLdapSettingsRow();
  assert.equal(row.bind_pw_encrypted, null);
});

test('Unvollständige DB-Konfiguration (kein Direkt-Bind, kein Service-Account) wirft klaren Fehler', () => {
  assert.throws(() => resolveLdapConfig(), /Service-Account-Passwort fehlt/);
});

test('Auto-Provisioning wirkt auch bei reiner ENV-Konfiguration (keine LDAP-URL in der DB gespeichert)', () => {
  // Regression: isAutoProvisionEnabled() verlangte früher zusätzlich eine in
  // der DB-Zeile gespeicherte URL, wodurch der Haken bei einer reinen
  // Plesk-ENV-Installation (nur LDAP_URL etc.) wirkungslos blieb, selbst wenn
  // er gesetzt war — LDAP-Logins funktionierten dann weiterhin nur für vom
  // Admin vorab importierte Konten.
  process.env.LDAP_URL = 'ldaps://dc01.schule.local:636';
  try {
    saveLdapSettings({ auto_provision: true }); // bewusst keine url -> bleibt in der DB-Zeile leer
    assert.equal(getLdapSettingsRow().url, null, 'Testannahme: keine URL in der DB gespeichert');
    assert.equal(isLdapConfigured(), true, 'LDAP gilt dank ENV-Variable als konfiguriert');
    assert.equal(isAutoProvisionEnabled(), true,
      'der Haken muss auch ohne DB-URL wirken, solange LDAP per ENV konfiguriert ist');
  } finally {
    delete process.env.LDAP_URL;
  }
});
