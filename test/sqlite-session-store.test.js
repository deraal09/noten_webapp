/**
 * Sitzungsspeicher in SQLite (src/auth/sqlite-session-store.js) statt des
 * Default-In-Memory-Stores von @fastify/session — Ziel: eine Anmeldung
 * übersteht einen App-Neustart (Plesk-Deploy), siehe test/session-persistenz.test.js
 * für den End-to-End-Nachweis über echte Logins/Requests hinweg.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-sessionstore-'));
process.env.DB_PFAD = path.join(tempDir, 'test.sqlite3');
process.env.SECRET = 'test-secret-fuer-sessionstore-bitte-lang-genug';

const { getDb } = await import('../src/db.js');
const { SqliteSessionStore } = await import('../src/auth/sqlite-session-store.js');

const store = new SqliteSessionStore(getDb());

function alsPromise(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

test('set + get: eine gespeicherte Session kommt unverändert zurück', async () => {
  const session = { userId: 42, cookie: { expires: new Date(Date.now() + 10000).toISOString() } };
  await alsPromise(store.set.bind(store), 'sid-1', session);
  const zurueck = await alsPromise(store.get.bind(store), 'sid-1');
  assert.deepEqual(zurueck, session);
});

test('get: unbekannte Session-ID liefert null', async () => {
  const zurueck = await alsPromise(store.get.bind(store), 'nie-gespeichert');
  assert.equal(zurueck, null);
});

test('get: eine bereits abgelaufene Session liefert null und wird gelöscht', async () => {
  const session = { userId: 1, cookie: { expires: new Date(Date.now() - 1000).toISOString() } };
  await alsPromise(store.set.bind(store), 'sid-abgelaufen', session);
  const zurueck = await alsPromise(store.get.bind(store), 'sid-abgelaufen');
  assert.equal(zurueck, null);
  const row = getDb().prepare('SELECT * FROM sessions WHERE sid = ?').get('sid-abgelaufen');
  assert.equal(row, undefined, 'abgelaufene Session muss beim Lesen aufgeräumt werden');
});

test('destroy: entfernt die Session, ein nachfolgendes get liefert null', async () => {
  const session = { userId: 7, cookie: { expires: new Date(Date.now() + 10000).toISOString() } };
  await alsPromise(store.set.bind(store), 'sid-2', session);
  await alsPromise(store.destroy.bind(store), 'sid-2');
  const zurueck = await alsPromise(store.get.bind(store), 'sid-2');
  assert.equal(zurueck, null);
});

test('set: räumt beiläufig andere, bereits abgelaufene Sessions auf (keine unbegrenzt wachsende Tabelle)', async () => {
  const abgelaufen = { userId: 5, cookie: { expires: new Date(Date.now() - 5000).toISOString() } };
  getDb().prepare('INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)')
    .run('sid-alt-abgelaufen', JSON.stringify(abgelaufen), Date.now() - 5000);

  const neu = { userId: 8, cookie: { expires: new Date(Date.now() + 10000).toISOString() } };
  await alsPromise(store.set.bind(store), 'sid-neu', neu);

  const row = getDb().prepare('SELECT * FROM sessions WHERE sid = ?').get('sid-alt-abgelaufen');
  assert.equal(row, undefined, 'beim nächsten set() müssen abgelaufene Zeilen mit aufgeräumt werden');
});

test('set: eine Session ohne cookie.expires bekommt einen Fallback-Ablauf statt dauerhaft zu bleiben', async () => {
  const session = { userId: 9 };
  await alsPromise(store.set.bind(store), 'sid-ohne-expires', session);
  const row = getDb().prepare('SELECT expires_at FROM sessions WHERE sid = ?').get('sid-ohne-expires');
  assert.ok(row);
  assert.ok(row.expires_at > Date.now(), 'Fallback-Ablauf muss in der Zukunft liegen');
});
