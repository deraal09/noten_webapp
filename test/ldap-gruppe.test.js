/**
 * LDAP-Anmeldung mit geforderter AD-Gruppe (AAD-LUL): Nur Mitglieder dürfen sich anmelden, wer nicht Mitglied ist (oder
 * wessen Mitgliedschaft sich nicht prüfen lässt) wird abgewiesen. Geprüft gegen ein nachgebautes Verzeichnis (kein echter
 * LDAP-Server im Testlauf) und über den Login-Ablauf der App.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { InvalidCredentialsError } from 'ldapts';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-ldap-gruppe-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-ldap-gruppe-bitte-lang-genug-xx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const { setLdapAuthenticatorForTests } = await import('../src/auth.js');
const L = await import('../src/auth/ldap.js');

const GRUPPE = 'AAD-LUL';
const GRUPPEN_DN = 'CN=AAD-LUL,OU=Gruppen,DC=schule,DC=local';
const nutzer = {
  anna: { dn: 'CN=Anna Lehrerin,OU=Lehrer,DC=schule,DC=local', pw: 'pw-anna', name: 'Anna Lehrerin', mitglied: true },
  bernd: { dn: 'CN=Bernd Schueler,OU=Schueler,DC=schule,DC=local', pw: 'pw-bernd', name: 'Bernd Schüler', mitglied: false },
};

/** Minimal-Verzeichnis: versteht genau die Suchen, die ldap.js stellt. */
function fakeVerzeichnis({ suchfehler = false, gruppenName = GRUPPE } = {}) {
  const aufrufe = [];
  const factory = () => {
    let angemeldet = null;
    return {
      async bind(dn, pw) {
        if (dn === 'CN=svc' && pw === 'svcpw') { angemeldet = 'svc'; return; }
        const n = Object.values(nutzer).find((x) => x.dn === dn || `SCHULE\\${Object.keys(nutzer).find((k) => nutzer[k] === x)}` === dn);
        if (n && n.pw === pw) { angemeldet = n.dn; return; }
        throw new InvalidCredentialsError('falsch');
      },
      async search(base, { scope, filter }) {
        aufrufe.push({ base, scope, filter });
        if (suchfehler) throw new Error('Insufficient access');
        const gruppeGesucht = /^\(&\(objectClass=group\)\(\|\(cn=(.+?)\)\(sAMAccountName=/.exec(filter);
        if (gruppeGesucht) return { searchEntries: gruppeGesucht[1] === gruppenName ? [{ dn: GRUPPEN_DN }] : [] };
        const mitglied = /^\(memberOf:1\.2\.840\.113556\.1\.4\.1941:=(.+)\)$/.exec(filter);
        if (mitglied) {
          const n = Object.values(nutzer).find((x) => x.dn === base);
          return { searchEntries: n && n.mitglied && mitglied[1] === GRUPPEN_DN ? [{ dn: base }] : [] };
        }
        if (filter.includes('objectClass=person')) {
          const nurMitglieder = filter.includes('memberOf:1.2.840.113556.1.4.1941:=');
          return { searchEntries: Object.entries(nutzer).filter(([, n]) => !nurMitglieder || n.mitglied).map(([k, n]) => ({ dn: n.dn, sAMAccountName: k, displayName: n.name })) };
        }
        const name = /\(sAMAccountName=([^)]+)\)/.exec(filter)?.[1];
        const n = nutzer[name];
        return { searchEntries: n ? [{ dn: n.dn, sAMAccountName: name, displayName: n.name }] : [] };
      },
      async unbind() { angemeldet = null; },
    };
  };
  return { factory, aufrufe };
}

const cfgService = (extra = {}) => ({
  url: 'ldaps://x', bindDn: 'CN=svc', bindPasswort: 'svcpw', baseDn: 'DC=schule,DC=local',
  userFilter: '(sAMAccountName={{username}})', loginAttr: 'sAMAccountName', nameAttr: 'displayName',
  teacherSearchFilter: '(&(objectClass=person)(cn=*{{query}}*))', requiredGroup: GRUPPE, ...extra,
});
const cfgDirekt = (extra = {}) => cfgService({ bindDn: '', bindPasswort: '', userBindTemplate: 'SCHULE\\{{username}}', ...extra });

for (const [modus, cfg] of [['Service-Account-Modus', cfgService], ['Direkt-Bind-Modus', cfgDirekt]]) {
  test(`${modus}: Mitglied wird angemeldet, Nicht-Mitglied mit richtigem Kennwort abgewiesen, falsches Kennwort bleibt „falsch“`, async () => {
    const v = fakeVerzeichnis();
    const auth = new L.LdapAuthenticator(cfg(), v.factory);
    assert.deepEqual(await auth.authenticate('anna', 'pw-anna'), { loginSub: 'anna', name: 'Anna Lehrerin' });
    await assert.rejects(() => auth.authenticate('bernd', 'pw-bernd'), (e) => e instanceof L.NichtInGruppeError && e.gruppe === GRUPPE);
    assert.equal(await auth.authenticate('bernd', 'falsch'), null, 'ohne gültiges Kennwort erfährt niemand etwas über die Gruppe');
    assert.equal(await auth.authenticate('unbekannt', 'x'), null);
    // die Prüfung läuft über die verschachtelte Mitgliedschaft (AD-Suchregel) und die aufgelöste Gruppen-DN
    assert.ok(v.aufrufe.some((a) => a.scope === 'base' && a.filter.includes(`memberOf:1.2.840.113556.1.4.1941:=${GRUPPEN_DN}`)));
  });

  test(`${modus}: ohne geforderte Gruppe meldet sich jedes Konto an (bisheriges Verhalten)`, async () => {
    const auth = new L.LdapAuthenticator(cfg({ requiredGroup: '' }), fakeVerzeichnis().factory);
    assert.ok(await auth.authenticate('bernd', 'pw-bernd'));
  });

  test(`${modus}: Gruppe als DN angegeben -- ohne Gruppensuche`, async () => {
    const v = fakeVerzeichnis();
    const auth = new L.LdapAuthenticator(cfg({ requiredGroup: GRUPPEN_DN }), v.factory);
    assert.ok(await auth.authenticate('anna', 'pw-anna'));
    assert.ok(!v.aufrufe.some((a) => a.filter.includes('objectClass=group')), 'DN wird direkt verwendet');
  });

  test(`${modus}: unbekannte Gruppe oder fehlende Leserechte -> technischer Fehler, keine Anmeldung`, async () => {
    const falscheGruppe = new L.LdapAuthenticator(cfg({ requiredGroup: 'GIBT-ES-NICHT' }), fakeVerzeichnis().factory);
    await assert.rejects(() => falscheGruppe.authenticate('anna', 'pw-anna'), (e) => !(e instanceof L.NichtInGruppeError) && /nicht zu finden/.test(e.message));
    const ohneRechte = new L.LdapAuthenticator(cfg(), fakeVerzeichnis({ suchfehler: true }).factory);
    await assert.rejects(() => ohneRechte.authenticate('anna', 'pw-anna'), (e) => !(e instanceof L.NichtInGruppeError));
  });
}

test('Direkt-Bind ohne Gruppenprüfung bleibt tolerant: scheitert nur die Attributsuche, gilt die Anmeldung weiter', async () => {
  const auth = new L.LdapAuthenticator(cfgDirekt({ requiredGroup: '' }), fakeVerzeichnis({ suchfehler: true }).factory);
  assert.deepEqual(await auth.authenticate('anna', 'pw-anna'), { loginSub: 'anna' });
});

test('Lehrkräfte-Suche (Admin-Import) zeigt mit geforderter Gruppe nur deren Mitglieder', async () => {
  const mit = await L.searchLehrkraefte(cfgService(), { query: 'a' }, fakeVerzeichnis().factory);
  assert.deepEqual(mit.map((e) => e.loginSub), ['anna']);
  const ohne = await L.searchLehrkraefte(cfgService({ requiredGroup: '' }), { query: 'a' }, fakeVerzeichnis().factory);
  assert.deepEqual(ohne.map((e) => e.loginSub).sort(), ['anna', 'bernd']);
});

test('Konfiguration: ENV LDAP_REQUIRED_GROUP und Einstellungsseite (Spalte required_group)', () => {
  const basis = { LDAP_URL: 'ldaps://x', LDAP_BASE_DN: 'DC=a', LDAP_BIND_USER_TEMPLATE: '{{username}}@a' };
  assert.equal(L.ldapConfigAusEnv({ ...basis, LDAP_REQUIRED_GROUP: ' AAD-LUL ' }).requiredGroup, 'AAD-LUL');
  assert.equal(L.ldapConfigAusEnv(basis).requiredGroup, '');
  const row = { url: 'ldaps://x', base_dn: 'DC=a', bind_user_template: '{{username}}@a', required_group: 'AAD-LUL', tls_reject_unauthorized: 1 };
  assert.equal(L.ldapConfigAusSettings(row, (x) => x).requiredGroup, 'AAD-LUL');
  assert.equal(L.ldapConfigAusSettings({ ...row, required_group: null }, (x) => x).requiredGroup, '');
});

// ---------- Login-Ablauf der App ----------
const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
function client() {
  const cookies = new Map();
  return async function req(url, body) {
    const headers = {};
    if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    const opts = { headers, redirect: 'manual' };
    if (body) { opts.method = 'POST'; headers['content-type'] = 'application/x-www-form-urlencoded'; opts.body = new URLSearchParams(body); }
    const r = await fetch(base + url, opts);
    for (const raw of r.headers.getSetCookie?.() ?? []) { const [k, ...v] = raw.split(';')[0].split('='); cookies.set(k.trim(), v.join('=').trim()); }
    return r;
  };
}

test('Login-Ablauf: Nicht-Mitglied bekommt eine klare Meldung, kein Konto, keine Sitzung; Mitglied wird (auto-)angelegt', async () => {
  const admin = client();
  await admin('/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  // Haken "Anmeldung ohne Vorab-Import" und geforderte Gruppe speichern (wie im Formular)
  await admin('/admin/ldap/einstellungen', { url: 'ldaps://x', base_dn: 'DC=schule,DC=local', bind_user_template: 'SCHULE\\{{username}}', auto_provision: '1', required_group: ' AAD-LUL ' });
  assert.equal(getDb().prepare('SELECT required_group FROM ldap_settings').get().required_group, 'AAD-LUL');
  assert.match(await (await admin('/admin/ldap/einstellungen')).text(), /name="required_group" value="AAD-LUL"/);

  // Authenticator mit dem nachgebauten Verzeichnis (Direkt-Bind, geforderte Gruppe)
  setLdapAuthenticatorForTests(new L.LdapAuthenticator(cfgDirekt(), fakeVerzeichnis().factory));
  try {
    const bernd = client();
    let r = await bernd('/login', { username: 'bernd', password: 'pw-bernd' });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Anmeldung nicht möglich: Dein Konto gehört nicht zur Gruppe „AAD-LUL“/);
    assert.equal(getDb().prepare("SELECT COUNT(*) AS c FROM users WHERE username = 'bernd'").get().c, 0, 'kein Konto automatisch angelegt');
    assert.notEqual((await bernd('/start')).status, 200, 'keine Sitzung');

    const anna = client();
    r = await anna('/login', { username: 'anna', password: 'pw-anna' });
    assert.equal(r.status, 302);
    assert.equal(getDb().prepare("SELECT auth_source FROM users WHERE username = 'anna'").get().auth_source, 'ldap');
    assert.equal((await anna('/start')).status, 200);

    // Bestehendes LDAP-Konto, das (inzwischen) nicht mehr in der Gruppe ist: keine Anmeldung
    getDb().prepare("INSERT INTO users (username, display_name, password_hash, role, active, auth_source, login_sub) VALUES ('bernd', 'Bernd', 'x', 'teacher', 1, 'ldap', 'bernd')").run();
    const bernd2 = client();
    r = await bernd2('/login', { username: 'bernd', password: 'pw-bernd' });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /gehört nicht zur Gruppe „AAD-LUL“/);
    assert.notEqual((await bernd2('/start')).status, 200);
    // falsches Kennwort bleibt die allgemeine Meldung
    const bernd3 = client();
    assert.match(await (await bernd3('/login', { username: 'bernd', password: 'falsch' })).text(), /Benutzername oder Passwort ist falsch/);
  } finally {
    setLdapAuthenticatorForTests(undefined);
  }
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
