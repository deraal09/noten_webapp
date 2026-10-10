/**
 * Stellt die Datenbank aus einer Sicherung wieder her (Anwendung vorher stoppen!):
 *
 *   DB_ENCRYPTION_KEY=… [DB_PFAD=…] node src/cli/backup-wiederherstellen.js <sicherung.sqlite3>
 *
 * Der Schlüssel muss derselbe sein wie bei der Sicherung. Eine vorhandene Datenbank wird nicht überschrieben, sondern
 * als Kopie beiseitegelegt. Danach die Anwendung starten (SECRET wie zuvor setzen).
 */

import path from 'node:path';
import { DB_PATH, DB_ENCRYPTION_KEY, SCHEMA_VERSION } from '../db.js';
import { stelleWiederHer } from '../backup/wiederherstellen.js';

const datei = process.argv[2];
if (!datei || datei.startsWith('-')) {
  console.error('Aufruf: node src/cli/backup-wiederherstellen.js <sicherung.sqlite3>');
  process.exit(2);
}

const ergebnis = stelleWiederHer({ quelle: path.resolve(datei), zielPfad: DB_PATH, schluessel: DB_ENCRYPTION_KEY, maxVersion: SCHEMA_VERSION });
if (!ergebnis.ok) {
  console.error(`FEHLER: ${ergebnis.fehler}`);
  process.exit(1);
}
const z = ergebnis.zahlen;
console.log(`Wiederhergestellt nach ${DB_PATH} (Schema ${ergebnis.version}): ${z.users} Konten, ${z.klassen} Klassen, ${z.schueler} Schüler/innen, ${z.faecher} Fächer.`);
if (ergebnis.beiseite) console.log(`Die bisherige Datenbank liegt als Kopie unter ${ergebnis.beiseite} -- nach erfolgreicher Prüfung löschen.`);
console.log('Jetzt die Anwendung starten.');
