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
export const SCHEMA_VERSION = 8;

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
    -- Lehrkraft, die die Klasse selbst angelegt hat (Selbstbedienung ohne
    -- vorherige Admin-Zuweisung). NULL bei admin-angelegten Klassen.
    created_by_id INTEGER REFERENCES users(id),
    -- Optional: Schüler/innen dieser Klasse werden an zwei Schulen
    -- unterrichtet (z. B. duales Modell) — Fehlzeiten-Erfassung bekommt
    -- dann zwei Spalten je Typ + Summe, siehe fehlzeiten_schule2.
    zwei_schulen INTEGER NOT NULL DEFAULT 0,
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
    -- "automatisch mit Klassenleitung synchronisieren": bei 1 löst jede
    -- Notenänderung dieser Lehrkraft in diesem Fach sofort einen Sync aus
    -- (siehe src/noten-sync.js), statt nur auf Knopfdruck.
    auto_sync INTEGER NOT NULL DEFAULT 0,
    UNIQUE (user_id, fach_id)
);

CREATE TABLE IF NOT EXISTS klassen_lehrkraefte (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    klasse_id INTEGER NOT NULL REFERENCES klassen(id) ON DELETE CASCADE,
    fach_id INTEGER NOT NULL REFERENCES faecher(id) ON DELETE CASCADE,
    UNIQUE (user_id, klasse_id, fach_id)
);

-- Klassen-weite Klassenleitung (im Unterschied zu klassen_lehrkraefte oben,
-- das historisch je Fach eine Zeile braucht). Wer hier steht, sieht alle
-- Noten der Klasse und kann Fächer anlegen/Lehrkräfte zuordnen.
CREATE TABLE IF NOT EXISTS klassenleitung (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    klasse_id INTEGER NOT NULL REFERENCES klassen(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (klasse_id, user_id)
);

-- Verknüpfungsanfrage: Jemand möchte einer bereits bestehenden Klasse
-- beitreten (Namenskollision beim Selbst-Anlegen), statt eine zweite,
-- doppelte Klasse zu erzeugen. Alle bereits mit der Klasse verbundenen
-- Personen (Ersteller/in, Klassenleitung, zugewiesene Lehrkräfte) müssen
-- zustimmen, siehe klassen_verknuepfungsantworten.
CREATE TABLE IF NOT EXISTS klassen_verknuepfungsanfragen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ziel_klasse_id INTEGER NOT NULL REFERENCES klassen(id) ON DELETE CASCADE,
    angefragt_von_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vorgeschlagenes_fach TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'offen', -- 'offen' | 'angenommen' | 'abgelehnt'
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    entschieden_at TEXT
);

CREATE TABLE IF NOT EXISTS klassen_verknuepfungsantworten (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    anfrage_id INTEGER NOT NULL REFERENCES klassen_verknuepfungsanfragen(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    zustimmung INTEGER, -- NULL = noch offen, 1 = zugestimmt, 0 = abgelehnt
    entschieden_at TEXT,
    UNIQUE (anfrage_id, user_id)
);

-- Zuletzt synchronisierte Gesamtnote je Fach/Halbjahr/Schüler ("Sync-Stand").
-- Wird NICHT live berechnet, sondern nur beim Sync (Knopfdruck oder
-- Auto-Sync) aktualisiert — genau das gibt der Klassenleitung Einblick,
-- ohne live in fremde Notentafeln schauen zu können (src/noten-sync.js).
CREATE TABLE IF NOT EXISTS fach_sync_stand (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fach_id INTEGER NOT NULL REFERENCES faecher(id) ON DELETE CASCADE,
    halbjahr TEXT NOT NULL,
    schueler_id INTEGER NOT NULL REFERENCES schueler(id) ON DELETE CASCADE,
    note REAL,
    synced_at TEXT NOT NULL DEFAULT (datetime('now')),
    synced_by_id INTEGER REFERENCES users(id),
    -- Von der Klassenleitung im Konferenzmodus überschriebene Note (z. B.
    -- Entscheidung der Notenkonferenz) — bleibt bei einem erneuten Sync durch
    -- die Fachlehrkraft erhalten (das UPSERT in noten-sync.js aktualisiert nur
    -- note/synced_at/synced_by_id) und wird angezeigt, falls gesetzt.
    konferenz_note REAL,
    konferenz_note_von_id INTEGER REFERENCES users(id),
    konferenz_note_am TEXT,
    UNIQUE (fach_id, halbjahr, schueler_id)
);

-- Zeitpunkt des letzten Syncs je Fach/Halbjahr (für die Anzeige "zuletzt
-- synchronisiert am ..." unabhängig von einzelnen Schüler-Zeilen).
CREATE TABLE IF NOT EXISTS fach_sync_meta (
    fach_id INTEGER NOT NULL REFERENCES faecher(id) ON DELETE CASCADE,
    halbjahr TEXT NOT NULL,
    synced_at TEXT NOT NULL DEFAULT (datetime('now')),
    synced_by_id INTEGER REFERENCES users(id),
    PRIMARY KEY (fach_id, halbjahr)
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

-- Fehlzeiten an der zweiten Schule, für Klassen mit klassen.zwei_schulen=1
-- (z. B. Schüler/innen im dualen Modell, die an zwei Schulen unterrichtet
-- werden). Bewusst eine separate Tabelle statt einer weiteren Spalte in
-- fehlzeiten, damit die bestehende UNIQUE-Zeile pro Schüler/Halbjahr/Typ
-- unangetastet bleibt — die Summe beider Tabellen ergibt den Gesamtwert.
CREATE TABLE IF NOT EXISTS fehlzeiten_schule2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schueler_id INTEGER NOT NULL REFERENCES schueler(id) ON DELETE CASCADE,
    halbjahr TEXT NOT NULL,
    typ TEXT NOT NULL,
    stunden REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (schueler_id, halbjahr, typ)
);

-- Notizen aus Notenbesprechungen (typ='besprechung', an ein Fach gebunden)
-- oder Notenkonferenz-Entscheidungen (typ='konferenz', fach_id NULL,
-- klassenweit). Mehrere Einträge pro Schüler/Halbjahr möglich (Verlauf statt
-- ein überschreibbares Feld).
CREATE TABLE IF NOT EXISTS notenbesprechung_notizen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schueler_id INTEGER NOT NULL REFERENCES schueler(id) ON DELETE CASCADE,
    fach_id INTEGER REFERENCES faecher(id) ON DELETE CASCADE,
    halbjahr TEXT NOT NULL,
    typ TEXT NOT NULL DEFAULT 'besprechung', -- 'besprechung' | 'konferenz'
    text TEXT NOT NULL,
    created_by_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sitzplan: freie Anordnung auf einem "Blatt" (x/y in Prozent, damit
-- beliebige Raumformen abgebildet werden können, statt eines starren
-- Raster-Layouts). Jede Lehrkraft mit Klassenzugriff hat einen eigenen,
-- privaten Entwurf je Klasse — erst per Knopfdruck (Übertragen) wird er in
-- sitzplan_geteilt kopiert und damit für andere Lehrkräfte der Klasse
-- sichtbar (gleiches Prinzip wie der Noten-Sync: kein automatisches Teilen).
CREATE TABLE IF NOT EXISTS sitzplaene (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    klasse_id INTEGER NOT NULL REFERENCES klassen(id) ON DELETE CASCADE,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plaetze TEXT NOT NULL DEFAULT '[]', -- JSON-Array: [{id, x, y, text}]
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (klasse_id, owner_id)
);

-- Der zuletzt an alle Lehrkräfte der Klasse übertragene Sitzplan-Stand.
CREATE TABLE IF NOT EXISTS sitzplan_geteilt (
    klasse_id INTEGER PRIMARY KEY REFERENCES klassen(id) ON DELETE CASCADE,
    plaetze TEXT NOT NULL DEFAULT '[]',
    geteilt_von_id INTEGER REFERENCES users(id),
    geteilt_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Eine feste Zeile (id=1) mit der LDAP-Konfiguration aus der Admin-Oberfläche.
-- bind_pw_encrypted ist AES-256-GCM-verschlüsselt (Schlüssel aus ENV SECRET
-- abgeleitet, siehe src/auth/secret-crypto.js) — niemals im Klartext abgelegt
-- und über die Oberfläche auch nicht wieder auslesbar.
CREATE TABLE IF NOT EXISTS ldap_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    url TEXT,
    base_dn TEXT,
    user_filter TEXT,
    bind_user_template TEXT,
    bind_dn TEXT,
    bind_pw_encrypted TEXT,
    login_attr TEXT,
    name_attr TEXT,
    teacher_search_filter TEXT,
    tls_ca_pem TEXT,
    tls_reject_unauthorized INTEGER NOT NULL DEFAULT 1,
    -- Legt bei jeder erfolgreichen LDAP-Anmeldung automatisch ein Konto an,
    -- falls noch keins existiert (statt Pflicht-Import durch den Admin).
    auto_provision INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  ensureColumn(db, 'klassen', 'created_by_id', 'created_by_id INTEGER REFERENCES users(id)');
  ensureColumn(db, 'fach_zuweisungen', 'auto_sync', 'auto_sync INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'klassen', 'zwei_schulen', 'zwei_schulen INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'fach_sync_stand', 'konferenz_note', 'konferenz_note REAL');
  ensureColumn(db, 'fach_sync_stand', 'konferenz_note_von_id', 'konferenz_note_von_id INTEGER REFERENCES users(id)');
  ensureColumn(db, 'fach_sync_stand', 'konferenz_note_am', 'konferenz_note_am TEXT');
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
