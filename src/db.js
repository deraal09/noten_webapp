/**
 * Datenbank-Setup mit better-sqlite3-multiple-ciphers (SQLCipher-kompatibler
 * Fork von better-sqlite3, identische API) — die komplette Datenbankdatei
 * liegt verschlüsselt auf der Platte, nicht nur einzelne Felder. Schützt die
 * Datei selbst und Backups davon, falls mehrere Personen Zugriff auf den
 * Server haben; schützt NICHT gegen jemanden mit Zugriff auf den laufenden
 * Prozess/dessen Umgebungsvariablen (der käme über den Schlüssel ohnehin an
 * die Klardaten). Erstellt beim Start das Schema, falls die DB-Datei fehlt,
 * und verschlüsselt eine vorhandene Klartext-Datei einmalig automatisch
 * (siehe migriereZuVerschluesselt()).
 *
 * Tabellen (1:1 vom alten Flask-Modell übernommen):
 *   users, invitations, schuljahre, klassen, schueler, faecher,
 *   fach_zuweisungen, klassen_lehrkraefte,
 *   klausuren, klausur_ergebnisse, unterrichtsleistungen, ul_ergebnisse,
 *   noten, fehlzeiten
 */

import Database from 'better-sqlite3-multiple-ciphers';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'noten.sqlite3');
export const DB_PATH = process.env.DB_PFAD || DEFAULT_DB_PATH;

// Eigene ENV-Variable statt SECRET, damit sich der DB-Schlüssel unabhängig
// vom Session-Secret setzen lässt. Der Schlüssel MUSS aus der Umgebung
// kommen — die einzige Ausnahme ist die Testsuite.
//
// Bewusst NICHT an "ist nicht Produktion" gekoppelt: NODE_ENV wird auf einem
// Plesk-Server leicht vergessen, und ein Ersatzschlüssel aus dem Quelltext
// hätte die Verschlüsselung dann still wertlos gemacht — die Datei wäre zwar
// verschlüsselt gewesen, aber mit einem Schlüssel, der öffentlich im
// Repository steht. Hier muss NODE_ENV=test ausdrücklich gesetzt sein
// (was in app.js ohnehin den Serverstart unterbindet), sonst bricht der
// Start ab. Für die Testsuite reicht ein fester Wert: jeder Lauf legt eine
// eigene, frische Wegwerf-Datenbank in einem temporären Verzeichnis an.
const TEST_SCHLUESSEL = 'nur-fuer-die-testsuite-niemals-fuer-echte-daten';
export const DB_ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY
  || (process.env.NODE_ENV === 'test' ? TEST_SCHLUESSEL : null);
if (!DB_ENCRYPTION_KEY) {
  console.error(
    'FEHLER: ENV-Variable DB_ENCRYPTION_KEY ist nicht gesetzt.\n'
    + 'Die Datenbank wird damit verschlüsselt und ist ohne diesen Schlüssel nicht mehr lesbar.\n'
    + 'Erzeugen mit:  openssl rand -hex 32\n'
    + 'Setzen in Plesk unter Node.js → Umgebungsvariablen (lokal: export DB_ENCRYPTION_KEY=...).\n'
    + 'Den Schlüssel getrennt von der Datenbank sichern — geht er verloren, sind die Daten unwiederbringlich verloren.',
  );
  process.exit(1);
}

// Schema-Version für Migrationen
export const SCHEMA_VERSION = 12;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- COLLATE NOCASE: Der Login sucht den Benutzernamen unabhängig von
    -- Groß-/Kleinschreibung (das AD tut das bei sAMAccountName auch), also
    -- muss er auch case-unabhängig EINDEUTIG sein. Ohne das konnten
    -- "mueller" und "Mueller" nebeneinander existieren, und die Login-Suche
    -- traf eine beliebige der beiden Zeilen -- ein per Einladungslink
    -- angelegtes Konto konnte damit eine LDAP-Lehrkraft dauerhaft aussperren.
    -- (NOCASE faltet nur ASCII A-Z; "Müller"/"müller" bleiben verschieden.)
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
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
    -- Optional: manche Fächer laufen über mehrere Schuljahre und werden nie
    -- "abgeschlossen" — daher bewusst kein Pflichtfeld. Ist es gesetzt, ist
    -- die Fachabschlussnote je Schüler/in in fach_abschlussnoten eingefroren
    -- (siehe src/fach-abschluss.js) und wird nicht mehr live neu berechnet.
    abgeschlossen INTEGER NOT NULL DEFAULT 0,
    abgeschlossen_am TEXT,
    abgeschlossen_von_id INTEGER REFERENCES users(id),
    UNIQUE (klasse_id, name)
);

-- Eingefrorene Fachabschlussnote je Schüler/in (Mittelwert aus allen
-- vorhandenen Halbjahren dieses Fachs — aktuelle 1./2. Halbjahr UND
-- historische, siehe historische_halbjahre). Wird beim "Fach abschließen"
-- (neu) berechnet und beim "wieder öffnen" NICHT gelöscht (nur der
-- abgeschlossen-Status auf faecher), damit ein erneutes Abschließen die
-- Werte einfach überschreibt.
CREATE TABLE IF NOT EXISTS fach_abschlussnoten (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fach_id INTEGER NOT NULL REFERENCES faecher(id) ON DELETE CASCADE,
    schueler_id INTEGER NOT NULL REFERENCES schueler(id) ON DELETE CASCADE,
    note REAL,
    UNIQUE (fach_id, schueler_id)
);

-- Historische Halbjahre eines Fachs: für Noten aus der Zeit vor Einführung
-- dieser App (oder von einer anderen Schule) — nur eine freie Bezeichnung
-- und je Schüler/in eine manuell eingetragene Endnote, keine
-- Klausuren/ULs. Von der Klassenleitung angelegt, von den dem Fach
-- zugewiesenen Lehrkräften kontrollierbar/korrigierbar (siehe
-- historische_noten, gleiche Berechtigung wie die Notentafel).
CREATE TABLE IF NOT EXISTS historische_halbjahre (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fach_id INTEGER NOT NULL REFERENCES faecher(id) ON DELETE CASCADE,
    bezeichnung TEXT NOT NULL,
    reihenfolge INTEGER NOT NULL DEFAULT 0,
    erstellt_von_id INTEGER REFERENCES users(id),
    erstellt_am TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS historische_noten (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    historisches_halbjahr_id INTEGER NOT NULL REFERENCES historische_halbjahre(id) ON DELETE CASCADE,
    schueler_id INTEGER NOT NULL REFERENCES schueler(id) ON DELETE CASCADE,
    note REAL,
    UNIQUE (historisches_halbjahr_id, schueler_id)
);

-- Notensperre: nach der Notenkonferenz kann die Klassenleitung die Noten
-- einer/eines Schüler:in klassenweit für ein Halbjahr sperren — betroffene
-- Fachlehrkräfte können dann keine Punkte/Noten mehr für diese Person
-- eintragen (siehe Durchsetzung in routes/teacher.js), können aber eine
-- Aufhebung anfragen statt selbst zu entsperren.
CREATE TABLE IF NOT EXISTS notensperren (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    klasse_id INTEGER NOT NULL REFERENCES klassen(id) ON DELETE CASCADE,
    schueler_id INTEGER NOT NULL REFERENCES schueler(id) ON DELETE CASCADE,
    halbjahr TEXT NOT NULL,
    gesperrt_von_id INTEGER REFERENCES users(id),
    gesperrt_am TEXT NOT NULL DEFAULT (datetime('now')),
    aufhebung_angefragt INTEGER NOT NULL DEFAULT 0,
    aufhebung_angefragt_von_id INTEGER REFERENCES users(id),
    aufhebung_angefragt_am TEXT,
    aufhebung_grund TEXT,
    UNIQUE (klasse_id, schueler_id, halbjahr)
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

-- Datumstabelle für die Unterrichtsleistung: eine Spalte je Unterrichtstermin,
-- eine Note je Schüler/in und Termin, ohne Einzelgewichtung -- der
-- Durchschnitt aller eingetragenen Werte bildet die Basis der
-- Unterrichtsleistungsnote (siehe unterrichtsleistungNote() in
-- grade-calc.js). "unterrichtsleistungen" bleiben davon unberührt und
-- fungieren seither als frei gewichtbare Zusatzleistungen (z. B.
-- Präsentationen), deren Gewichtung den Anteil bestimmt, den die
-- Datumstabelle NICHT ausmacht.
CREATE TABLE IF NOT EXISTS unterricht_termine (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fach_id INTEGER NOT NULL REFERENCES faecher(id) ON DELETE CASCADE,
    halbjahr TEXT NOT NULL,
    datum TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_unterricht_termine_fach ON unterricht_termine(fach_id, halbjahr);

CREATE TABLE IF NOT EXISTS unterricht_noten (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    termin_id INTEGER NOT NULL REFERENCES unterricht_termine(id) ON DELETE CASCADE,
    schueler_id INTEGER NOT NULL REFERENCES schueler(id) ON DELETE CASCADE,
    wert REAL,
    UNIQUE (termin_id, schueler_id)
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

-- Freie Notizen zu einer Person auf der Klassenleitungsseite (Fehlzeiten) —
-- unabhängig von notenbesprechung_notizen (an Noten/Halbjahre gebunden) und
-- vom alten fehlzeiten.notiz-Feld (je Fehlzeitenart, nicht mehr im UI
-- genutzt, aber aus Bestandsschutz nicht gelöscht). Verlauf statt ein
-- überschreibbares Feld — mehrere Klassenlehrkräfte tragen hier
-- gemeinsam ein, keiner soll den Eintrag der/des anderen überschreiben.
CREATE TABLE IF NOT EXISTS schueler_notizen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schueler_id INTEGER NOT NULL REFERENCES schueler(id) ON DELETE CASCADE,
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

-- Server-seitiger Sitzungsspeicher für @fastify/session
-- (src/auth/sqlite-session-store.js) statt des Default-In-Memory-Stores.
-- Damit übersteht eine Anmeldung einen App-Neustart (z. B. nach jedem
-- Deploy auf Plesk) — ohne diese Tabelle wären sonst alle angemeldeten
-- Personen bei jedem Neustart ohne Vorwarnung ausgeloggt.
CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- Ratelimit für Login-Versuche (src/auth/login-ratelimit.js): ab dem 3.
-- Fehlversuch in Folge für einen Benutzernamen wird die Anmeldung für eine
-- Weile gesperrt, jede weitere fehlgeschlagene Anmeldung danach verdoppelt
-- die Sperrdauer (exponentieller Backoff gegen automatisiertes
-- Durchprobieren von Passwörtern).
CREATE TABLE IF NOT EXISTS login_ratelimit (
    schluessel TEXT PRIMARY KEY,
    fehlversuche INTEGER NOT NULL DEFAULT 0,
    gesperrt_bis INTEGER
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

// Erzwingt, dass Benutzernamen auch unabhängig von Groß-/Kleinschreibung
// eindeutig sind. Bei neu angelegten Datenbanken erledigt das schon die
// Spaltendefinition (username ... COLLATE NOCASE); Bestandsdatenbanken haben
// dort noch die case-sensitive Variante, und eine Spalten-Kollation lässt
// sich in SQLite nicht per ALTER TABLE ändern -- ein zusätzlicher
// UNIQUE-Index mit COLLATE NOCASE erreicht dasselbe. Auf neuen Datenbanken
// ist er redundant, aber harmlos (die users-Tabelle ist winzig).
//
// Existieren bereits Namen, die sich nur in der Schreibweise unterscheiden,
// lässt sich der Index nicht anlegen. Die App startet dann trotzdem -- ein
// Schulserver soll wegen Altdaten nicht stehen bleiben -- weist aber bei
// jedem Start darauf hin. Missbrauchen lässt sich der Zustand nicht mehr:
// findeBenutzerFuerLogin() in src/auth.js verweigert eine mehrdeutige
// Anmeldung, statt eine beliebige der Zeilen zu nehmen.
function stelleBenutzernamenEindeutigSicher(db) {
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE)');
  } catch {
    const dubletten = db.prepare(`
      SELECT GROUP_CONCAT(username, ', ') AS namen
      FROM users GROUP BY username COLLATE NOCASE HAVING COUNT(*) > 1
    `).all().map((r) => r.namen);
    console.warn(
      '[db] ACHTUNG: Diese Benutzernamen unterscheiden sich nur in der Groß-/Kleinschreibung: '
      + `${dubletten.join(' | ')}. Anmeldungen mit abweichender Schreibweise werden abgelehnt, `
      + 'bis die Namen eindeutig sind (Admin → Lehrkräfte). Danach greift die Eindeutigkeit automatisch.',
    );
  }
}

function migrate(db) {
  ensureColumn(db, 'users', 'auth_source', "auth_source TEXT NOT NULL DEFAULT 'lokal'");
  ensureColumn(db, 'users', 'login_sub', 'login_sub TEXT');
  // Partial-Index: login_sub muss nur unter LDAP-Konten eindeutig sein.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_login_sub ON users(login_sub) WHERE login_sub IS NOT NULL');
  stelleBenutzernamenEindeutigSicher(db);
  ensureColumn(db, 'klassen', 'created_by_id', 'created_by_id INTEGER REFERENCES users(id)');
  ensureColumn(db, 'fach_zuweisungen', 'auto_sync', 'auto_sync INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'klassen', 'zwei_schulen', 'zwei_schulen INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'fach_sync_stand', 'konferenz_note', 'konferenz_note REAL');
  ensureColumn(db, 'fach_sync_stand', 'konferenz_note_von_id', 'konferenz_note_von_id INTEGER REFERENCES users(id)');
  ensureColumn(db, 'fach_sync_stand', 'konferenz_note_am', 'konferenz_note_am TEXT');
  ensureColumn(db, 'faecher', 'abgeschlossen', 'abgeschlossen INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'faecher', 'abgeschlossen_am', 'abgeschlossen_am TEXT');
  ensureColumn(db, 'faecher', 'abgeschlossen_von_id', 'abgeschlossen_von_id INTEGER REFERENCES users(id)');
}

// SQL-String-Literal escapen (einfache Anführungszeichen verdoppeln) --
// für PRAGMA-Werte und Pfade, die als String-Literal in ein SQL-Statement
// eingebettet werden müssen (kein Platzhalter/Parameter-Binding möglich).
function alsSqlLiteral(text) {
  return text.replace(/'/g, "''");
}

// Prüft, ob unter `pfad` bereits eine (unverschlüsselte) Klartext-SQLite-Datei
// liegt -- true, wenn sie sich ohne Schlüssel lesen lässt. Existiert die
// Datei nicht, ist das kein Klartext-Fall, sondern eine Neuinstallation.
function istUnverschluesseltePlaintextDatei(pfad) {
  if (!fs.existsSync(pfad)) return false;
  try {
    const test = new Database(pfad, { readonly: true, fileMustExist: true });
    test.pragma('quick_check');
    test.close();
    return true;
  } catch {
    return false; // vermutlich schon verschlüsselt -- der reguläre Open-Versuch unten meldet echte Fehler klar
  }
}

// SQL-Bezeichner (Tabellenname) escapen -- Tabellennamen kommen aus
// sqlite_master und lassen sich nicht als Parameter binden.
function alsSqlBezeichner(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

// Zählt die Zeilen jeder Tabelle der frisch verschlüsselten Kopie und
// vergleicht sie mit der Quelle. Schlägt das fehl (oder lässt sich die Kopie
// gar nicht mit dem Schlüssel öffnen), gilt die Migration als gescheitert --
// der Aufrufer lässt die Klartext-Datei dann unangetastet stehen.
function pruefeKopie(tempPfad, schluessel, erwarteteZeilen) {
  const kopie = new Database(tempPfad, { fileMustExist: true });
  try {
    kopie.pragma("cipher='sqlcipher'");
    kopie.pragma(`key='${alsSqlLiteral(schluessel)}'`);
    for (const { name, anzahl } of erwarteteZeilen) {
      const c = kopie.prepare(`SELECT COUNT(*) AS c FROM ${alsSqlBezeichner(name)}`).get().c;
      if (c !== anzahl) {
        throw new Error(`Tabelle ${name}: ${c} statt ${anzahl} Zeilen in der verschlüsselten Kopie`);
      }
    }
  } finally {
    kopie.close();
  }
}

// Verschlüsselt eine bestehende Klartext-Datenbankdatei einmalig, ohne
// vorhandene Daten unbrauchbar zu machen: Tabellen + Inhalte werden in eine
// neue, mit `schluessel` verschlüsselte Datei kopiert (Indizes fehlen dort
// zunächst -- SCHEMA/migrate() erzeugen sie direkt danach über
// "CREATE INDEX IF NOT EXISTS" neu, siehe getDb()).
//
// Die Klartext-Datei wird dabei NICHT als Sicherungskopie behalten: eine
// vollständige, unverschlüsselte Kopie aller Noten und Fehlzeiten, die
// dauerhaft neben der verschlüsselten Datei im selben Verzeichnis liegt,
// würde die Verschlüsselung praktisch aufheben (jedes Backup des
// Datenverzeichnisses hätte sie mitgenommen). Stattdessen wird die Kopie
// VOR dem Ersetzen gegengeprüft (pruefeKopie) und danach per rename über die
// Klartext-Datei geschoben -- unter POSIX ein atomarer Schritt, es gibt also
// keinen Moment, in dem die Datenbank fehlt oder halb geschrieben ist.
// Scheitert irgendetwas davor, bleibt die Klartext-Datei unverändert liegen
// und der Start bricht mit dem echten Fehler ab.
function migriereZuVerschluesselt(pfad, schluessel) {
  const tempPfad = pfad + '.migration-tmp';
  const tempAufraeumen = () => {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(tempPfad + suffix, { force: true });
  };
  try {
    tempAufraeumen();
    const quelle = new Database(pfad);
    let zeilenzahlen;
    try {
      // Cipher VOR dem ATTACH festlegen -- sonst würde die angehängte Zieldatei
      // mit dem Standard-Cipher der Bibliothek (sqleet) statt sqlcipher
      // verschlüsselt, und getDb() könnte sie unten mit cipher='sqlcipher' nicht
      // mehr öffnen.
      quelle.pragma("cipher='sqlcipher'");
      quelle.exec(`ATTACH DATABASE '${alsSqlLiteral(tempPfad)}' AS verschluesselt KEY '${alsSqlLiteral(schluessel)}'`);
      const tabellen = quelle.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL"
      ).all();
      for (const t of tabellen) {
        quelle.exec(t.sql.replace(/^CREATE TABLE/i, 'CREATE TABLE verschluesselt.'));
        quelle.exec(`INSERT INTO verschluesselt.${alsSqlBezeichner(t.name)} SELECT * FROM main.${alsSqlBezeichner(t.name)}`);
      }
      zeilenzahlen = tabellen.map((t) => ({
        name: t.name,
        anzahl: quelle.prepare(`SELECT COUNT(*) AS c FROM main.${alsSqlBezeichner(t.name)}`).get().c,
      }));
      quelle.exec('DETACH DATABASE verschluesselt');
      quelle.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      quelle.close();
    }

    pruefeKopie(tempPfad, schluessel, zeilenzahlen);

    // Erst jetzt, nach bestandener Gegenprüfung: die Klartext-Datei atomar
    // durch die verschlüsselte ersetzen. Ihr -wal/-shm gehört zur alten,
    // unverschlüsselten Datei und muss mit weg.
    fs.renameSync(tempPfad, pfad);
    for (const suffix of ['-wal', '-shm']) fs.rmSync(pfad + suffix, { force: true });
    const gesamt = zeilenzahlen.reduce((summe, t) => summe + t.anzahl, 0);
    console.log(
      `[db] Bestehende Datenbank wurde verschlüsselt (${zeilenzahlen.length} Tabellen, ${gesamt} Zeilen geprüft). `
      + 'Die bisherige Klartext-Datei wurde dabei ersetzt und existiert nicht mehr.',
    );
  } catch (e) {
    // Aufräumen darf den eigentlichen Fehler nicht überdecken -- scheitert
    // es (z. B. weil genau dieser Pfad das Problem war), bleibt die
    // Ursachenmeldung erhalten und die Reste werden beim nächsten Versuch
    // entfernt.
    try { tempAufraeumen(); } catch { /* Ursache unten ist die wichtigere Meldung */ }
    throw new Error(
      `Verschlüsselung der bestehenden Datenbank fehlgeschlagen: ${e.message}. `
      + `Die bisherige Datenbank unter ${pfad} wurde nicht verändert.`,
      { cause: e },
    );
  }
}

// Frühere Versionen dieser Migration haben die Klartext-Datei als
// ".vor-verschluesselung.bak" liegen lassen. Wer damals schon migriert hat,
// hat also weiterhin eine vollständige, unverschlüsselte Kopie aller Daten
// im Datenverzeichnis -- bei jedem Start deutlich darauf hinweisen, bis sie
// weg ist. Bewusst kein automatisches Löschen: es ist die einzige Datei, die
// diese Installation vor der Verschlüsselung hatte.
function warneVorAlterKlartextSicherung(pfad) {
  const sicherungPfad = pfad + '.vor-verschluesselung.bak';
  if (!fs.existsSync(sicherungPfad)) return;
  console.warn(
    `[db] ACHTUNG: ${sicherungPfad} ist eine UNVERSCHLÜSSELTE Kopie der kompletten Datenbank `
    + '(aus einer früheren Version dieser Migration). Solange sie existiert, schützt die '
    + 'Verschlüsselung weder die Platte noch Backups des Datenverzeichnisses. '
    + 'Bitte prüfen, dass die App läuft, und die Datei anschließend löschen.',
  );
}

let _db = null;

export function getDb() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  if (istUnverschluesseltePlaintextDatei(DB_PATH)) {
    migriereZuVerschluesselt(DB_PATH, DB_ENCRYPTION_KEY);
  }
  warneVorAlterKlartextSicherung(DB_PATH);

  _db = new Database(DB_PATH);
  _db.pragma("cipher='sqlcipher'");
  _db.pragma(`key='${alsSqlLiteral(DB_ENCRYPTION_KEY)}'`);
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
