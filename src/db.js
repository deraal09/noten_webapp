/**
 * Datenbank-Setup mit better-sqlite3.
 * Erstellt beim Start das Schema, falls die DB-Datei fehlt.
 *
 * Tabellen (1:1 vom alten Flask-Modell übernommen):
 *   users, invitations, schuljahre, klassen, schueler, faecher,
 *   fach_zuweisungen, klassen_lehrkraefte,
 *   klausuren, klausur_ergebnisse, unterrichtsleistungen, ul_ergebnisse,
 *   noten, fehlzeiten
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'noten.sqlite3');
export const DB_PATH = process.env.DB_PFAD || DEFAULT_DB_PATH;

// Schema-Version für Migrationen
export const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'teacher',
    display_name TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    invited_by_id INTEGER REFERENCES users(id),
    -- 'lokal': Login per Passwort (Einladungslink). 'ldap': Login per LDAP-Bind,
    -- password_hash ist dann nur ein nie verwendeter Platzhalter.
    auth_source TEXT NOT NULL DEFAULT 'lokal',
    -- Stabile Kennung aus dem Verzeichnis (z. B. sAMAccountName), nur bei auth_source='ldap'.
    login_sub TEXT
);

CREATE TABLE IF NOT EXISTS invitations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    email TEXT,
    display_name TEXT,
    role TEXT NOT NULL DEFAULT 'teacher',
    created_by_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT,
    used_at TEXT,
    used_by_id INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS schuljahre (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bezeichnung TEXT NOT NULL UNIQUE,
    gewichtung_muendlich INTEGER NOT NULL DEFAULT 60
);

CREATE TABLE IF NOT EXISTS klassen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schuljahr_id INTEGER NOT NULL REFERENCES schuljahre(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    notenschluessel TEXT NOT NULL DEFAULT 'IHK',
    notenschluessel_csv TEXT NOT NULL DEFAULT '',
    UNIQUE (schuljahr_id, name)
);

CREATE TABLE IF NOT EXISTS schueler (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    klasse_id INTEGER NOT NULL REFERENCES klassen(id) ON DELETE CASCADE,
    nachname TEXT NOT NULL,
    vorname TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS faecher (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    klasse_id INTEGER NOT NULL REFERENCES klassen(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    UNIQUE (klasse_id, name)
);

CREATE TABLE IF NOT EXISTS fach_zuweisungen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fach_id INTEGER NOT NULL REFERENCES faecher(id) ON DELETE CASCADE,
    UNIQUE (user_id, fach_id)
);

CREATE TABLE IF NOT EXISTS klassen_lehrkraefte (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    klasse_id INTEGER NOT NULL REFERENCES klassen(id) ON DELETE CASCADE,
    fach_id INTEGER NOT NULL REFERENCES faecher(id) ON DELETE CASCADE,
    UNIQUE (user_id, klasse_id, fach_id)
);

CREATE TABLE IF NOT EXISTS klausuren (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fach_id INTEGER NOT NULL REFERENCES faecher(id) ON DELETE CASCADE,
    halbjahr TEXT NOT NULL,
    name TEXT NOT NULL,
    max_punkte_pro_aufgabe TEXT NOT NULL DEFAULT '[]',
    gewichtung REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS klausur_ergebnisse (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    klausur_id INTEGER NOT NULL REFERENCES klausuren(id) ON DELETE CASCADE,
    schueler_id INTEGER NOT NULL REFERENCES schueler(id) ON DELETE CASCADE,
    punkte TEXT NOT NULL DEFAULT '[]',
    UNIQUE (klausur_id, schueler_id)
);

CREATE TABLE IF NOT EXISTS unterrichtsleistungen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fach_id INTEGER NOT NULL REFERENCES faecher(id) ON DELETE CASCADE,
    halbjahr TEXT NOT NULL,
    name TEXT NOT NULL,
    max_punkte_pro_aufgabe TEXT NOT NULL DEFAULT '[]',
    gewichtung REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ul_ergebnisse (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ul_id INTEGER NOT NULL REFERENCES unterrichtsleistungen(id) ON DELETE CASCADE,
    schueler_id INTEGER NOT NULL REFERENCES schueler(id) ON DELETE CASCADE,
    punkte TEXT NOT NULL DEFAULT '[]',
    UNIQUE (ul_id, schueler_id)
);

CREATE TABLE IF NOT EXISTS noten (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schueler_id INTEGER NOT NULL REFERENCES schueler(id) ON DELETE CASCADE,
    fach_id INTEGER NOT NULL REFERENCES faecher(id) ON DELETE CASCADE,
    halbjahr TEXT NOT NULL,
    typ TEXT NOT NULL,
    wert REAL NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS fehlzeiten (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schueler_id INTEGER NOT NULL REFERENCES schueler(id) ON DELETE CASCADE,
    halbjahr TEXT NOT NULL,
    typ TEXT NOT NULL,
    stunden REAL NOT NULL DEFAULT 0,
    notiz TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (schueler_id, halbjahr, typ)
);

CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

// Fügt einer bereits existierenden Tabelle (aus einer älteren SCHEMA_VERSION)
// eine Spalte hinzu, falls sie fehlt. CREATE TABLE IF NOT EXISTS deckt nur
// neue DBs ab — Bestandsinstallationen brauchen ALTER TABLE.
function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

function migrate(db) {
  ensureColumn(db, 'users', 'auth_source', "auth_source TEXT NOT NULL DEFAULT 'lokal'");
  ensureColumn(db, 'users', 'login_sub', 'login_sub TEXT');
  // Partial-Index: login_sub muss nur unter LDAP-Konten eindeutig sein.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_login_sub ON users(login_sub) WHERE login_sub IS NOT NULL');
}

let _db = null;

export function getDb() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.exec(SCHEMA);
  migrate(_db);
  const v = _db.prepare("SELECT value FROM schema_meta WHERE key='version'").get();
  if (!v) {
    _db.prepare("INSERT INTO schema_meta (key, value) VALUES ('version', ?)").run(String(SCHEMA_VERSION));
  } else if (Number(v.value) < SCHEMA_VERSION) {
    _db.prepare("UPDATE schema_meta SET value = ? WHERE key='version'").run(String(SCHEMA_VERSION));
  }
  return _db;
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
