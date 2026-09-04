/**
 * Bestandsdatenbanken, in denen bereits zwei Konten liegen, die sich nur in
 * der Groß-/Kleinschreibung unterscheiden.
 *
 * Die Spalten-Kollation lässt sich in SQLite nicht per ALTER TABLE ändern,
 * und der nachgerüstete UNIQUE-Index (COLLATE NOCASE) lässt sich bei
 * vorhandenen Dubletten nicht anlegen. Erwartetes Verhalten:
 *
 * - Die App startet trotzdem (ein Schulserver soll wegen Altdaten nicht
 *   stehen bleiben) und weist beim Start auf die betroffenen Namen hin.
 * - Eine Anmeldung, die nicht eindeutig zuzuordnen ist, wird abgelehnt statt
 *   geraten — genau das war die Lücke (eine beliebige der beiden Zeilen
 *   gewann, womit ein Konto das andere aussperren konnte).
 * - Mit exakter Schreibweise bleiben beide Konten benutzbar.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import Database from 'better-sqlite3-multiple-ciphers';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noten-test-benutzer-alt-'));
const dbPfad = path.join(tempDir, 'test.sqlite3');
const DB_KEY = 'altbestand-testschluessel-lang-genug-abc123';

process.env.DB_PFAD = dbPfad;
process.env.DB_ENCRYPTION_KEY = DB_KEY;
process.env.SECRET = 'test-secret-fuer-benutzer-altbestand-lang-genug';
process.env.NODE_ENV = 'test';
delete process.env.LDAP_URL;

// Diese Importe berühren die Datenbankdatei noch nicht (getDb() wird erst
// beim ersten Aufruf geöffnet) — die Helfer stehen also schon bereit,
// während wir die Altdatenbank von Hand aufbauen.
const { hashPassword, makeToken, findeBenutzerFuerLogin } = await import('../src/auth.js');

// Eine "alte" Installation nachstellen: users mit case-sensitiver
// UNIQUE-Spalte (so lautete die Definition vor dieser Regel) und zwei
// Konten, die sich nur in der Schreibweise unterscheiden. Beides muss vor
// dem ersten getDb() stehen — danach legt migrate() den NOCASE-Index an,
// und die Dublette ließe sich gar nicht mehr einfügen.
const bestand = new Database(dbPfad);
bestand.pragma("cipher='sqlcipher'");
bestand.pragma(`key='${DB_KEY}'`);
bestand.exec(`CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  email TEXT, password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'teacher', display_name TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  invited_by_id INTEGER, auth_source TEXT NOT NULL DEFAULT 'lokal', login_sub TEXT
)`);
bestand.prepare(`INSERT INTO users (username, display_name, password_hash, role, active, auth_source, login_sub)
                 VALUES ('mueller', 'Echte Lehrkraft', ?, 'teacher', 1, 'ldap', 'mueller')`)
  .run(hashPassword(makeToken()));
bestand.prepare(`INSERT INTO users (username, display_name, password_hash, role, active, auth_source)
                 VALUES ('Mueller', 'Squatter', ?, 'teacher', 1, 'lokal')`)
  .run(hashPassword('squatter1'));
bestand.close();

const { buildApp } = await import('../app.js');
const { getDb } = await import('../src/db.js');

const fastify = await buildApp({ logger: false });
const base = await fastify.listen({ port: 0, host: '127.0.0.1' });

const form = (url, body) => fetch(base + url, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body),
  redirect: 'manual',
});

test('Testannahme: die Dublette liegt tatsächlich in der Datenbank', () => {
  const namen = getDb().prepare('SELECT username FROM users ORDER BY id').all().map((u) => u.username);
  assert.deepEqual(namen, ['mueller', 'Mueller']);
});

test('Eine nicht eindeutig zuzuordnende Anmeldung wird abgelehnt statt geraten', async () => {
  const treffer = findeBenutzerFuerLogin('MUELLER');
  assert.equal(treffer.mehrdeutig, true);
  assert.equal(treffer.row, null);

  // Auch über die Route: mit dem Passwort des Squatters darf keine Sitzung
  // entstehen, und die Meldung nennt den Grund statt "Passwort falsch".
  const r = await form('/login', { username: 'MUELLER', password: 'squatter1' });
  assert.equal(r.status, 200, 'kein Redirect — es darf keine Anmeldung zustande kommen');
  assert.match(await r.text(), /mehrfach in unterschiedlicher Schreibweise/);
});

test('Mit exakter Schreibweise bleiben beide Konten benutzbar', async () => {
  const echte = findeBenutzerFuerLogin('mueller');
  assert.equal(echte.mehrdeutig, false);
  assert.equal(echte.row.username, 'mueller');
  assert.equal(echte.row.auth_source, 'ldap', 'die exakte Schreibweise muss das LDAP-Konto treffen');

  const squatter = findeBenutzerFuerLogin('Mueller');
  assert.equal(squatter.mehrdeutig, false);
  assert.equal(squatter.row.username, 'Mueller');
  assert.equal(squatter.row.auth_source, 'lokal');

  const r = await form('/login', { username: 'Mueller', password: 'squatter1' });
  assert.equal(r.headers.get('location'), '/', 'das lokale Konto meldet sich mit seiner Schreibweise normal an');
});

test('Sind die Namen wieder eindeutig, greift die Eindeutigkeit automatisch', () => {
  const db = getDb();
  db.prepare("UPDATE users SET username = 'mueller-extern' WHERE username = 'Mueller'").run();
  // Was migrate() beim nächsten Start täte:
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE)');
  assert.throws(
    () => db.prepare("INSERT INTO users (username, password_hash, role, active) VALUES ('MUELLER', 'x', 'teacher', 1)").run(),
    /UNIQUE constraint failed/,
  );
  const treffer = findeBenutzerFuerLogin('MUELLER');
  assert.equal(treffer.mehrdeutig, false, 'ohne Dublette ist die Zuordnung wieder eindeutig');
  assert.equal(treffer.row.username, 'mueller');
});

test.after(async () => {
  await fastify.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
