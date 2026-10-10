/**
 * Datenschutzerklärung und Impressum: öffentlich (ohne Anmeldung) erreichbar, in der Fußzeile jeder Seite verlinkt,
 * die Angaben der Schule kommen aus Admin → Rechtliches (nur Admin), ohne Angaben stehen sichtbare Platzhalter.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-rechtliches-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-rechtliches-bitte-lang-genug-xxxxxx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });

function client() {
  const cookies = new Map();
  return async function req(url, body) {
    const headers = {};
    if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    const opts = { headers, redirect: 'manual' };
    if (body) {
      opts.method = 'POST';
      headers['content-type'] = 'application/x-www-form-urlencoded';
      opts.body = new URLSearchParams(body);
    }
    const r = await fetch(base + url, opts);
    for (const raw of r.headers.getSetCookie?.() ?? []) {
      const [k, ...v] = raw.split(';')[0].split('=');
      cookies.set(k.trim(), v.join('=').trim());
    }
    return r;
  };
}
const anonym = client();
const admin = client();
const lehrer = client();

test('Vorbereitung: Admin und eine Lehrkraft', async () => {
  await admin('/setup', { username: 'admin', display_name: 'Admin', password: 'adminpass123', password2: 'adminpass123' });
  await admin('/admin/einladungen/neu', { display_name: 'lehrer', ttl_days: '14' });
  const inv = getDb().prepare('SELECT token FROM invitations').get();
  await lehrer(`/einladung/${inv.token}`, { username: 'lehrer', display_name: 'lehrer', password: 'passwort123', password2: 'passwort123' });
});

test('Ohne Anmeldung erreichbar; ohne Angaben mit Platzhaltern; Fußzeile verlinkt beide Seiten (auch auf der Anmeldeseite)', async () => {
  for (const url of ['/datenschutz', '/impressum']) {
    const r = await anonym(url);
    assert.equal(r.status, 200, url);
    const html = await r.text();
    assert.match(html, /class="platzhalter"/, `${url}: Platzhalter`);
  }
  const datenschutz = await (await anonym('/datenschutz')).text();
  for (const abschnitt of ['Verantwortliche Stelle', 'Sitzungs-Cookie', 'keine Tracking', 'Ihre Rechte', 'Beschwerderecht']) assert.match(datenschutz, new RegExp(abschnitt));
  const login = await (await anonym('/login')).text();
  assert.match(login, /<a href="\/datenschutz">Datenschutz<\/a> · <a href="\/impressum">Impressum<\/a>/);
});

test('Admin → Rechtliches: nur für die Administration', async () => {
  assert.notEqual((await anonym('/admin/rechtliches')).status, 200, 'ohne Anmeldung kein Zugriff');
  await anonym('/admin/rechtliches', { schulname: 'X' });
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM rechtliche_angaben').get().c, 0, 'ohne Anmeldung nicht speicherbar');
  assert.equal((await lehrer('/admin/rechtliches')).status, 403);
  assert.equal((await lehrer('/admin/rechtliches', { schulname: 'X' })).status, 403);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM rechtliche_angaben').get().c, 0, 'Lehrkraft kann nichts speichern');
  const r = await admin('/admin/rechtliches');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Noch nicht ausgefüllt/);
});

test('Gespeicherte Angaben erscheinen in Impressum und Datenschutzerklärung (HTML-sicher), Standardtexte gelten bei leeren Feldern', async () => {
  const r = await admin('/admin/rechtliches', {
    schulname: 'Berufsschule <b>Test</b>', strasse: 'Schulweg 1', plz_ort: '24768 Rendsburg', vertretung: 'Frau Muster, Schulleiterin',
    email: 'schule@example.org', telefon: '04331 123', dsb_name: 'Herr Datenschutz', dsb_kontakt: 'datenschutz@example.org',
    datenschutzaufsicht: 'Landesbeauftragte für Datenschutz', speicherdauer: 'Bis zum Schulabschluss.\nDanach Löschung.',
  });
  assert.equal(r.status, 302);
  const impressum = await (await anonym('/impressum')).text();
  assert.match(impressum, /Berufsschule &lt;b&gt;Test&lt;\/b&gt;/, 'HTML wird maskiert');
  assert.doesNotMatch(impressum, /<b>Test<\/b>/);
  assert.match(impressum, /Schulweg 1/);
  assert.match(impressum, /href="mailto:schule@example\.org"/);
  assert.match(impressum, /04331 123/);
  assert.doesNotMatch(impressum, /class="platzhalter"/, 'alle Pflichtfelder gefüllt');
  const datenschutz = await (await anonym('/datenschutz')).text();
  assert.match(datenschutz, /Herr Datenschutz/);
  assert.match(datenschutz, /Bis zum Schulabschluss\.\nDanach Löschung\./, 'eigener Text für die Speicherdauer');
  assert.match(datenschutz, /Art\. 6 Abs\. 1 Buchst\. e/, 'Standardtext für die Rechtsgrundlage');
  assert.doesNotMatch(await (await admin('/admin/rechtliches')).text(), /Noch nicht ausgefüllt/);
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
