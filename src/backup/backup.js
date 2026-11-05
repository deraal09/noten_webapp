/**
 * Datensicherung: ein konsistenter Schnappschuss der (verschlüsselten) Datenbank wird am eingestellten Ziel abgelegt.
 *
 * Der Schnappschuss entsteht mit VACUUM INTO und bleibt dabei mit demselben DB_ENCRYPTION_KEY verschlüsselt -- am Ziel
 * liegen also keine lesbaren Notendaten. Zur Wiederherstellung (siehe wiederherstellen.js) werden die Sicherungsdatei UND
 * der DB_ENCRYPTION_KEY gebraucht, außerdem SECRET (verschlüsselte Werte wie das LDAP-Passwort). Beide Schlüssel gehören
 * getrennt und sicher aufbewahrt, nicht in dieselbe Sicherung.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3-multiple-ciphers';
import { getDb, DB_PATH, DB_ENCRYPTION_KEY } from '../db.js';
import {
  ladeEinstellungenMitPasswort, letzteLaeufe, protokolliereStart, protokolliereEnde, istFaellig, letzterLauf,
} from './einstellungen.js';
import { ziel, DATEI_MUSTER, bereinige } from './ziele.js';

const pad = (n) => String(n).padStart(2, '0');
/** noten-backup-YYYYMMDD-HHMMSS.sqlite3 (Ortszeit des Servers). */
export function dateiname(datum = new Date()) {
  return `noten-backup-${datum.getFullYear()}${pad(datum.getMonth() + 1)}${pad(datum.getDate())}-${pad(datum.getHours())}${pad(datum.getMinutes())}${pad(datum.getSeconds())}.sqlite3`;
}

const alsSqlLiteral = (text) => String(text).replace(/'/g, "''");

/**
 * Erzeugt einen verschlüsselten Schnappschuss in einem eigenen Temp-Verzeichnis und prüft ihn (Öffnen mit dem Schlüssel,
 * quick_check). Der Aufrufer löscht das Verzeichnis `verzeichnis` anschließend.
 * @returns {{pfad: string, verzeichnis: string, groesse: number, sha256: string}}
 */
export async function erzeugeSchnappschuss(datum = new Date()) {
  const verzeichnis = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'noten-backup-'));
  const pfad = path.join(verzeichnis, dateiname(datum));
  try {
    getDb().exec(`VACUUM INTO '${alsSqlLiteral(pfad)}'`);
    const pruef = new Database(pfad, { readonly: true, fileMustExist: true });
    try {
      pruef.pragma("cipher='sqlcipher'");
      pruef.pragma(`key='${alsSqlLiteral(DB_ENCRYPTION_KEY)}'`);
      const ergebnis = pruef.pragma('quick_check', { simple: true });
      if (ergebnis !== 'ok') throw new Error(`Die Sicherung ist beschädigt (quick_check: ${ergebnis}).`);
      pruef.prepare('SELECT COUNT(*) FROM users').get();
    } finally {
      pruef.close();
    }
    const inhalt = await fs.promises.readFile(pfad);
    return { pfad, verzeichnis, groesse: inhalt.length, sha256: crypto.createHash('sha256').update(inhalt).digest('hex') };
  } catch (e) {
    await fs.promises.rm(verzeichnis, { recursive: true, force: true });
    throw e;
  }
}

// Länger dauert kein Lauf (WebDAV bricht nach 15 Minuten ab). Ein älterer, nie beendeter Lauf stammt von einem
// beendeten oder abgestürzten Prozess und blockiert nicht mehr.
export const LAUF_FRIST_MS = 2 * 3600_000;

/**
 * Beansprucht den nächsten Lauf -- über die Datenbank, damit auch mehrere Prozesse der Anwendung (z. B. Passenger mit
 * mehreren Instanzen) nie gleichzeitig sichern. In einer IMMEDIATE-Transaktion: verwaiste Läufe werden als abgebrochen
 * beendet, ein noch laufender verhindert den neuen; `nurWennFaellig` prüft die Fälligkeit erneut (ein anderer Prozess
 * kann gerade gesichert haben).
 * @returns {number|null} id des Protokolleintrags oder null, wenn nicht gesichert werden soll
 */
function beanspruche(ausloeser, cfg, { nurWennFaellig = false, jetzt = new Date() } = {}) {
  const db = getDb();
  return db.transaction(() => {
    for (const offen of db.prepare('SELECT id, gestartet_at FROM backup_laeufe WHERE beendet_at IS NULL').all()) {
      if (jetzt.getTime() - new Date(offen.gestartet_at).getTime() < LAUF_FRIST_MS) return null;
      protokolliereEnde(offen.id, { ok: false, meldung: 'Abgebrochen: der Lauf wurde nicht beendet (Anwendung neu gestartet oder abgestürzt).' }, jetzt);
    }
    if (nurWennFaellig && !istFaellig(cfg, letzterLauf(), jetzt)) return null;
    return protokolliereStart(ausloeser, jetzt);
  }).immediate();
}

/**
 * Ein Sicherungslauf: Schnappschuss erzeugen, ans Ziel schreiben, alte Sicherungen über die Aufbewahrung hinaus löschen,
 * alles im Protokoll festhalten. Es läuft höchstens ein Lauf gleichzeitig, auch über mehrere Prozesse hinweg.
 * @returns {Promise<{ok: boolean, meldung: string, dateiname?: string, groesse?: number, uebersprungen?: boolean}>}
 */
export async function fuehreBackupAus(ausloeser = 'manuell', { nurWennFaellig = false } = {}) {
  const cfg = ladeEinstellungenMitPasswort();
  if (!cfg.ziel) return { ok: false, meldung: 'Es ist noch kein Sicherungsziel eingetragen.' };
  const id = beanspruche(ausloeser, cfg, { nurWennFaellig });
  if (id === null) return { ok: false, uebersprungen: true, meldung: 'Es läuft bereits eine Sicherung.' };
  let schnappschuss = null;
  try {
    const ziel_ = ziel(cfg.typ);
    schnappschuss = await erzeugeSchnappschuss();
    const name = path.basename(schnappschuss.pfad);
    const groesse = await ziel_.schreibe(cfg, schnappschuss.pfad, name);
    let hinweis = '';
    try {
      const vorhanden = await ziel_.liste(cfg);
      const zuLoeschen = vorhanden.filter((n) => DATEI_MUSTER.test(n)).slice(0, Math.max(0, vorhanden.length - cfg.aufbewahren));
      for (const alt of zuLoeschen) await ziel_.loesche(cfg, alt);
      if (zuLoeschen.length) hinweis = ` ${zuLoeschen.length} ältere Sicherung(en) gelöscht.`;
    } catch (e) {
      hinweis = ` Hinweis: Aufräumen alter Sicherungen fehlgeschlagen (${bereinige(e.message)}).`;
    }
    const meldung = `Gesichert (${Math.round(groesse / 1024)} KB, SHA-256 ${schnappschuss.sha256.slice(0, 12)}…).${hinweis}`;
    protokolliereEnde(id, { ok: true, dateiname: name, groesse, meldung });
    return { ok: true, meldung, dateiname: name, groesse };
  } catch (e) {
    const meldung = bereinige(e.message || String(e));
    protokolliereEnde(id, { ok: false, meldung });
    return { ok: false, meldung };
  } finally {
    if (schnappschuss) await fs.promises.rm(schnappschuss.verzeichnis, { recursive: true, force: true }).catch(() => {});
  }
}

/** Testet das eingestellte Ziel (Verbindung, Schreibrecht), ohne zu sichern. */
export async function testeZiel(cfg = ladeEinstellungenMitPasswort()) {
  if (!cfg.ziel) return { ok: false, meldung: 'Bitte zuerst ein Ziel eintragen und speichern.' };
  try {
    return { ok: true, meldung: await ziel(cfg.typ).teste(cfg) };
  } catch (e) {
    return { ok: false, meldung: bereinige(e.message || String(e)) };
  }
}

/** Alle Sicherungen, die am Ziel liegen (neueste zuerst). */
export async function listeSicherungen(cfg = ladeEinstellungenMitPasswort()) {
  if (!cfg.ziel) return [];
  return (await ziel(cfg.typ).liste(cfg)).reverse();
}

/**
 * Der Planer: prüft jede Minute, ob ein geplanter Lauf fällig ist. Beim ersten Start nach dem Aktivieren sichert er
 * sofort, danach alle `intervall_stunden`; nach einem Fehler versucht er es nach einer Stunde erneut.
 */
export function starteBackupPlaner({ intervallMs = 60_000 } = {}) {
  const tick = async () => {
    try {
      if (istFaellig(ladeEinstellungenMitPasswort(), letzterLauf())) await fuehreBackupAus('geplant', { nurWennFaellig: true });
    } catch (e) {
      console.error('[backup] Planer:', bereinige(e.message));
    }
  };
  const timer = setInterval(tick, intervallMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export { letzteLaeufe, DB_PATH };
