import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ldapConfigAusEnv } from '../src/auth/ldap.js';

const basis = {
  LDAP_URL: 'ldaps://ldap.example.de:636',
  LDAP_BASE_DN: 'DC=SNRD,DC=local',
};

test('Service-Modus: verlangt LDAP_BIND_DN und LDAP_BIND_PW', () => {
  assert.throws(() => ldapConfigAusEnv({ ...basis }), /LDAP_BIND_DN/);
  const cfg = ldapConfigAusEnv({
    ...basis,
    LDAP_BIND_DN: 'CN=svc,DC=SNRD,DC=local',
    LDAP_BIND_PW: 'geheim',
  });
  assert.equal(cfg.userBindTemplate, undefined);
  assert.equal(cfg.bindDn, 'CN=svc,DC=SNRD,DC=local');
});

test('Direkt-Modus: Service-Account ist optional, Template wird übernommen', () => {
  const cfg = ldapConfigAusEnv({
    ...basis,
    LDAP_BIND_USER_TEMPLATE: 'SNRD\\{{username}}',
  });
  assert.equal(cfg.userBindTemplate, 'SNRD\\{{username}}');
  assert.equal(cfg.bindDn, '');
  assert.equal(cfg.bindPasswort, '');
});

test('TLS-Optionen: rejectUnauthorized=false wird gesetzt', () => {
  const cfg = ldapConfigAusEnv({
    ...basis,
    LDAP_BIND_USER_TEMPLATE: 'SNRD\\{{username}}',
    LDAP_TLS_REJECT_UNAUTHORIZED: 'false',
  });
  assert.equal(cfg.tlsOptions?.rejectUnauthorized, false);
});

test('Defaults für Filter/Attribute', () => {
  const cfg = ldapConfigAusEnv({
    ...basis,
    LDAP_BIND_USER_TEMPLATE: '{{username}}@snrd.local',
  });
  assert.equal(cfg.userFilter, '(sAMAccountName={{username}})');
  assert.equal(cfg.loginAttr, 'sAMAccountName');
  assert.equal(cfg.nameAttr, 'displayName');
  assert.match(cfg.teacherSearchFilter, /\{\{query\}\}/);
});
