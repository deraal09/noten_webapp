/**
 * Wiederherstellung einer Sicherung (siehe src/cli/backup-wiederherstellen.js). Läuft bei gestoppter Anwendung:
 * Die Sicherungsdatei wird mit dem DB_ENCRYPTION_KEY geöffnet und geprüft, die bisherige Datenbank (falls vorhanden)
 * bleibt als Kopie liegen, danach wird die Sicherung an ihre Stelle gelegt.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';

const alsSqlLiteral = (text) => String(text).replace(/'/g, "''");

/**
 * Prüft eine Sicherungsdatei: Öffnen mit dem Schlüssel, Integrität, Schema-Version.
 * @returns {{ok: true, version: number, zahlen: object} | {ok: false, fehler: string}}
 */
export function pruefeSicherung(datei, schluessel, maxVersion = Infinity) {
  if (!fs.existsSync(datei)) return { ok: false, fehler: `Datei nicht gefunden: ${datei}` };
  let db;
  try {
    db = new Database(datei, { readonly: true, fileMustExist: true });
    db.pragma("cipher='sqlcipher'");
    db.pragma(`key='${alsSqlLiteral(schluessel)}'`);
    const ergebnis = db.pragma('quick_check', { simple: true });
    if (ergebnis !== 'ok') return { ok: false, fehler: `Die Sicherung ist beschädigt (quick_check: ${ergebnis}).` };
    const version = Number(db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get()?.value ?? 0);
    if (version > maxVersion) {
      return { ok: false, fehler: `Die Sicherung stammt aus einer neueren Programmversion (Schema ${version}, diese Version kennt ${maxVersion}). Bitte zuerst die Anwendung aktualisieren.` };
    }
    const zahl = (tabelle) => db.prepare(`SELECT COUNT(*) AS c FROM ${tabelle}`).get().c;
    return { ok: true, version, zahlen: { users: zahl('users'), klassen: zahl('klassen'), schueler: zahl('schueler'), faecher: zahl('faecher') } };
  } catch (e) {
    const falscherSchluessel = /not a database|file is encrypted|no such table/i.test(e.message);
    return { ok: false, fehler: falscherSchluessel
      ? 'Die Sicherung lässt sich nicht öffnen -- ist DB_ENCRYPTION_KEY der Schlüssel, mit dem sie erstellt wurde?'
      : `Die Sicherung lässt sich nicht lesen: ${e.message}` };
  } finally {
    db?.close();
  }
}

/**
 * Legt `quelle` als Datenbank unter `zielPfad` ab. Eine vorhandene Datenbank wird nicht gelöscht, sondern als
 * `<ziel>.vor-wiederherstellung-<Zeit>` beiseitegelegt (verschlüsselt wie das Original; nach erfolgreicher Prüfung löschen).
 */
export function stelleWiederHer({ quelle, zielPfad, schluessel, maxVersion = Infinity, jetzt = new Date() }) {
  const pruefung = pruefeSicherung(quelle, schluessel, maxVersion);
  if (!pruefung.ok) return pruefung;
  fs.mkdirSync(path.dirname(zielPfad), { recursive: true });
  let beiseite = null;
  if (fs.existsSync(zielPfad)) {
    beiseite = `${zielPfad}.vor-wiederherstellung-${jetzt.toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(zielPfad, beiseite);
  }
  for (const suffix of ['-wal', '-shm']) fs.rmSync(zielPfad + suffix, { force: true });
  const tmp = `${zielPfad}.wiederherstellung-tmp`;
  fs.copyFileSync(quelle, tmp);
  fs.renameSync(tmp, zielPfad);
  return { ...pruefung, beiseite };
}
