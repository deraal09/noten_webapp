/**
 * Einladungslinks gelten nur für EIN Konto: nach dem Einlösen ist der Link verbraucht (auch bei gleichzeitigen
 * Aufrufen), ein abgelaufener Link funktioniert nicht, und ein gescheiterter Versuch verbraucht ihn nicht.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-einladung-einmalig-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-einladung-einmalig-bitte-lang-genug-xx';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');
const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });

function client() {
  const cookies = new Map();
  return async function req(url, opts = {}) {
    const headers = { ...opts.headers };
    if (cookies.size) headers.cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(base + url, { ...opts, headers, redirect: 'manual' });
    for (const raw of r.headers.getSetCookie?.() ?? []) {
      const [k, ...v] = raw.split(';')[0].split('=');
      cookies.set(k.trim(), v.join('=').trim());
    }
    return r;
  };
}
const form = (req, url, body) => req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
const konto = (name, extra = {}) => ({ username: name, display_name: name, password: 'passwort123', password2: 'passwort123', ...extra });
const anzahlKonten = () => getDb().prepare('SELECT COUNT(*) AS c FROM users').get().c;
const neuerLink = async (admin, felder = {}) => {
  await form(admin, '/admin/einladungen/neu', { ttl_days: '14', ...felder });
  return getDb().prepare('SELECT * FROM invitations ORDER BY id DESC').get();
};

const admin = client();

test('Vorbereitung: Admin', async () => {
  await form(admin, '/setup', konto('admin', { password: 'adminpass123', password2: 'adminpass123' }));
  assert.equal(anzahlKonten(), 1);
});

test('Ein Link erzeugt genau ein Konto; danach ist er verbraucht (Anzeige und Absenden)', async () => {
  const inv = await neuerLink(admin);
  const erste = client();
  assert.equal((await form(erste, `/einladung/${inv.token}`, konto('erste'))).status, 302);
  assert.equal(anzahlKonten(), 2);
  const row = getDb().prepare('SELECT * FROM invitations WHERE id = ?').get(inv.id);
  assert.ok(row.used_at);
  assert.equal(row.used_by_id, getDb().prepare("SELECT id FROM users WHERE username = 'erste'").get().id);

  // Zweiter Versuch mit demselben Link: Seite meldet "bereits eingelöst", Absenden legt nichts an
  const zweite = client();
  assert.match(await (await zweite(`/einladung/${inv.token}`)).text(), /abgelaufen oder bereits eingel/);
  const r = await form(zweite, `/einladung/${inv.token}`, konto('zweite'));
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /\/login/);
  assert.equal(anzahlKonten(), 2);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS c FROM users WHERE username = 'zweite'").get().c, 0);
  // und es gibt keine Anmeldung der zweiten Person
  assert.notEqual((await zweite('/start')).status, 200);
});

test('Gleichzeitige Aufrufe mit demselben Link: nur einer bekommt ein Konto', async () => {
  const inv = await neuerLink(admin);
  const vorher = anzahlKonten();
  const antworten = await Promise.all(['anna1', 'anna2', 'anna3', 'anna4', 'anna5'].map((n) => form(client(), `/einladung/${inv.token}`, konto(n))));
  assert.equal(anzahlKonten(), vorher + 1);
  assert.equal(antworten.filter((r) => r.headers.get('location') === '/').length, 1);
});

test('Abgelaufener Link legt kein Konto an', async () => {
  const inv = await neuerLink(admin);
  getDb().prepare("UPDATE invitations SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(inv.id);
  const vorher = anzahlKonten();
  const r = await form(client(), `/einladung/${inv.token}`, konto('zuspaet'));
  assert.match(r.headers.get('location'), /\/login/);
  assert.equal(anzahlKonten(), vorher);
});

test('Gescheiterter Versuch (Benutzername vergeben, Passwort zu kurz) verbraucht den Link nicht', async () => {
  const inv = await neuerLink(admin);
  const vorher = anzahlKonten();
  assert.equal((await form(client(), `/einladung/${inv.token}`, konto('admin'))).status, 200, 'Name vergeben');
  assert.equal((await form(client(), `/einladung/${inv.token}`, konto('kurz', { password: 'x', password2: 'x' }))).status, 200);
  assert.equal(anzahlKonten(), vorher);
  assert.equal(getDb().prepare('SELECT used_at FROM invitations WHERE id = ?').get(inv.id).used_at, null);
  assert.equal((await form(client(), `/einladung/${inv.token}`, konto('klappt'))).status, 302);
  assert.equal(anzahlKonten(), vorher + 1);
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
