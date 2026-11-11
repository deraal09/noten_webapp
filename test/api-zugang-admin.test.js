/**
 * API-Zugang: nur für Schulkonten (LDAP), Gültigkeit höchstens ein Jahr; der Admin sieht alle Schlüssel, deaktiviert sie
 * (wieder aktivierbar) oder löscht sie und schaltet die API insgesamt ab (Vorgabe: an). „LDAP-Anmeldungen beenden“
 * widerruft auch die Schlüssel der LDAP-Konten. Bisher unbegrenzte Schlüssel laufen nach der Umstellung in einem Jahr ab.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-api-zugang-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-api-zugang-admin-lang-genug-xxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb, closeDb } = await import('../src/db.js');
const { apiAktiv } = await import('../src/api-keys.js');
const { hashPassword, makeToken, setLdapAuthenticatorForTests } = await import('../src/auth.js');
const { FakeAuthenticator } = await import('../src/auth/authenticator.js');
const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });
test.after(async () => { await fastify.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });

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
async function me(key) {
  const r = await fetch(`${base}/api/v1/me`, { headers: { authorization: `Bearer ${key}` } });
  return { status: r.status, json: await r.json() };
}
const admin = client();
const anna = client(); // Schulkonto (LDAP)
const ben = client(); // lokales Konto
const db = () => getDb();
const keyId = (name) => db().prepare('SELECT id FROM api_keys WHERE name = ?').get(name).id;
async function neuerSchluessel(name, tage = '90') {
  const html = await (await anna('/konto/api', { name, scope: 'lesen', gueltig_tage: tage })).text();
  return /value="(nk_[A-Za-z0-9_-]+)"/.exec(html)?.[1];
}
let key;

test('Vorbereitung: Admin, Anna (LDAP) und Ben (lokal)', async () => {
  await admin('/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await admin('/admin/einladungen/neu', { display_name: 'ben', ttl_days: '14' });
  const inv = db().prepare('SELECT token FROM invitations ORDER BY id DESC').get();
  await ben(`/einladung/${inv.token}`, { username: 'ben', display_name: 'ben', password: 'passwort123', password2: 'passwort123' });
  db().prepare(`INSERT INTO users (username, display_name, password_hash, role, active, auth_source, login_sub)
    VALUES ('anna', 'Anna', ?, 'teacher', 1, 'ldap', 'anna')`).run(hashPassword(makeToken()));
  setLdapAuthenticatorForTests(new FakeAuthenticator({ anna: { passwort: 'pw-anna' } }));
  assert.equal((await anna('/login', { username: 'anna', password: 'pw-anna' })).status, 302);
  assert.equal(apiAktiv(), true, 'Vorgabe: die API ist eingeschaltet');
});

test('Nur Schulkonten: Anna hat Menüeintrag und Formular, Ben (lokal) nicht und bekommt 403', async () => {
  const s = await (await anna('/start')).text();
  assert.match(s, /href="\/konto\/api"/);
  assert.doesNotMatch(await (await ben('/start')).text(), /href="\/konto\/api"/);
  const seiteBen = await (await ben('/konto/api')).text();
  assert.match(seiteBen, /nur <strong>Schulkonten \(LDAP\)<\/strong>/);
  assert.doesNotMatch(seiteBen, /name="gueltig_tage"/);
  assert.equal((await ben('/konto/api', { name: 'Ben', scope: 'lesen', gueltig_tage: '30' })).status, 403);
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM api_keys').get().c, 0);

  key = await neuerSchluessel('Agent');
  assert.ok(key);
  assert.equal((await me(key)).status, 200);
});

test('Gültigkeit höchstens ein Jahr: keine Auswahl „unbegrenzt“, längere oder ungültige Angaben werden abgelehnt', async () => {
  const seite = await (await anna('/konto/api')).text();
  assert.doesNotMatch(seite, /unbegrenzt/);
  for (const tage of ['400', '0', '-5', 'abc']) {
    const r = await anna('/konto/api', { name: `x${tage}`, scope: 'lesen', gueltig_tage: tage });
    assert.equal(r.status, 400, tage);
    assert.match(await r.text(), /1 bis 365 Tage/);
  }
  assert.ok(await neuerSchluessel('Jahr', '365'));
  assert.ok(await neuerSchluessel('Ohne Angabe', ''), 'ohne Angabe: Vorgabe 90 Tage');
  const max = Date.now() + 366 * 86400000;
  for (const r of db().prepare('SELECT expires_at FROM api_keys').all()) assert.ok(r.expires_at && new Date(r.expires_at).getTime() < max);
});

test('Wird ein Konto lokal (kein Schulkonto mehr), wird sein Schlüssel abgelehnt (403 nur_ldap)', async () => {
  db().prepare("UPDATE users SET auth_source = 'lokal' WHERE username = 'anna'").run();
  const r = await me(key);
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'nur_ldap');
  db().prepare("UPDATE users SET auth_source = 'ldap' WHERE username = 'anna'").run();
  assert.equal((await me(key)).status, 200);
});

test('Admin-Seite: nur für den Admin, zeigt alle Schlüssel mit Lehrkraft und Status', async () => {
  assert.equal((await anna('/admin/api')).status, 403);
  const html = await (await admin('/admin/api')).text();
  assert.match(html, /API-Zugänge/);
  assert.match(html, /anna/);
  assert.match(html, /Agent/);
  assert.match(html, /eingeschaltet/);
  assert.match(await (await admin('/admin')).text(), /href="\/admin\/api"/);
  assert.equal((await anna(`/admin/api/${keyId('Agent')}/deaktivieren`, {})).status, 403, 'Lehrkräfte dürfen nicht');
});

test('Deaktivieren sperrt den Schlüssel (401), Anna sieht den Status; Aktivieren gibt ihn wieder frei', async () => {
  assert.equal((await admin(`/admin/api/${keyId('Agent')}/deaktivieren`, {})).status, 302);
  const r = await me(key);
  assert.equal(r.status, 401);
  assert.match(r.json.message, /deaktiviert/);
  assert.match(await (await anna('/konto/api')).text(), /vom Admin deaktiviert/);
  assert.match(await (await admin('/admin/api')).text(), /Aktivieren/);
  await admin(`/admin/api/${keyId('Agent')}/aktivieren`, {});
  assert.equal((await me(key)).status, 200);
});

test('Löschen entfernt den Schlüssel ganz', async () => {
  const id = keyId('Jahr');
  assert.equal((await admin(`/admin/api/${id}/loeschen`, {})).status, 302);
  assert.equal(db().prepare('SELECT 1 FROM api_keys WHERE id = ?').get(id), undefined);
  assert.doesNotMatch(await (await anna('/konto/api')).text(), />Jahr</);
});

test('API abschalten: /api/v1 antwortet 503, keine neuen Schlüssel, Doku bleibt erreichbar; wieder einschalten', async () => {
  await admin('/admin/api/schalter', { aktiv: '0' });
  assert.equal(apiAktiv(), false);
  const r = await me(key);
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'api_deaktiviert');
  assert.equal((await fetch(`${base}/api/v1/me`)).status, 503, 'auch ohne Schlüssel');
  const seite = await (await anna('/konto/api')).text();
  assert.match(seite, /abgeschaltet/);
  assert.doesNotMatch(seite, /name="gueltig_tage"/);
  assert.equal((await anna('/konto/api', { name: 'Neu', scope: 'lesen', gueltig_tage: '30' })).status, 400);
  assert.equal((await fetch(`${base}/api/v1/docs`)).status, 200);
  assert.equal((await fetch(`${base}/api/v1/openapi.json`)).status, 200);
  assert.match(await (await admin('/admin/api')).text(), /abgeschaltet/);

  await admin('/admin/api/schalter', { aktiv: '1' });
  assert.equal((await me(key)).status, 200);
});

test('„Alle LDAP-Anmeldungen beenden“ widerruft auch die Schlüssel der LDAP-Konten', async () => {
  const r = await admin('/admin/ldap/einstellungen', { url: 'ldap://example.invalid', base_dn: 'dc=x', ldap_sitzungen_beenden: '1' });
  assert.equal(r.status, 302);
  assert.match(await (await admin(r.headers.get('location'))).text(), /2 API-Schlüssel widerrufen/);
  assert.equal((await me(key)).status, 401);
  assert.equal(db().prepare('SELECT COUNT(*) AS c FROM api_keys WHERE revoked_at IS NULL').get().c, 0);
});

test('Umstellung: bisher unbegrenzte Schlüssel laufen ein Jahr nach der Umstellung ab', () => {
  const k = 'nk_unbegrenzt-aus-frueherer-version';
  const annaId = db().prepare("SELECT id FROM users WHERE username = 'anna'").get().id;
  db().prepare("INSERT INTO api_keys (user_id, name, key_hash, key_prefix, scope) VALUES (?, 'Alt', ?, 'nk_unbegre', 'lesen')")
    .run(annaId, crypto.createHash('sha256').update(k).digest('hex'));
  closeDb();
  const ablauf = new Date(db().prepare("SELECT expires_at FROM api_keys WHERE name = 'Alt'").get().expires_at).getTime();
  assert.ok(Math.abs(ablauf - (Date.now() + 365 * 86400000)) < 120000, 'in einem Jahr');
});
