/**
 * Einstellungen der Datensicherung (Tabelle backup_einstellungen, eine feste Zeile) und das Protokoll der Läufe
 * (backup_laeufe). Das Passwort des Sicherungsziels liegt nur verschlüsselt in der DB und wird nie angezeigt.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, DB_PATH } from '../db.js';
import { encryptSecret, decryptSecret } from '../auth/secret-crypto.js';

const PROJEKT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const TYPEN = {
  verzeichnis: 'Verzeichnis (lokal oder eingebundenes Netzlaufwerk)',
  webdav: 'WebDAV (z. B. Nextcloud, Netzwerkspeicher)',
};
export const MIN_INTERVALL = 1;
export const MAX_INTERVALL = 24 * 31;
export const MAX_AUFBEWAHREN = 365;

const STANDARD = { aktiv: 0, typ: 'verzeichnis', ziel: '', benutzer: '', passwort_verschluesselt: '', intervall_stunden: 24, aufbewahren: 14 };

/** Gespeicherte Einstellungen (ohne Passwort im Klartext: `hatPasswort` zeigt nur, ob eines hinterlegt ist). */
export function ladeEinstellungen() {
  const row = getDb().prepare('SELECT * FROM backup_einstellungen WHERE id = 1').get() || STANDARD;
  return {
    aktiv: Boolean(row.aktiv), typ: row.typ, ziel: row.ziel, benutzer: row.benutzer,
    hatPasswort: Boolean(row.passwort_verschluesselt),
    intervall_stunden: row.intervall_stunden, aufbewahren: row.aufbewahren,
  };
}

/** Einstellungen samt entschlüsseltem Passwort -- nur für den Sicherungslauf selbst. */
export function ladeEinstellungenMitPasswort() {
  const row = getDb().prepare('SELECT * FROM backup_einstellungen WHERE id = 1').get() || STANDARD;
  let passwort = '';
  try { passwort = decryptSecret(row.passwort_verschluesselt); } catch { passwort = ''; }
  return { ...ladeEinstellungen(), passwort };
}

/**
 * Prüft die Eingaben des Formulars.
 * @returns {{ok: true, werte: object} | {ok: false, fehler: string}}
 */
export function pruefeEingabe(body) {
  const typ = Object.hasOwn(TYPEN, body?.typ) ? body.typ : null;
  if (!typ) return { ok: false, fehler: 'Bitte einen Speichertyp wählen.' };
  const ziel = String(body?.ziel ?? '').trim();
  const intervall = Number.parseInt(body?.intervall_stunden, 10);
  const aufbewahren = Number.parseInt(body?.aufbewahren, 10);
  if (!Number.isInteger(intervall) || intervall < MIN_INTERVALL || intervall > MAX_INTERVALL) {
    return { ok: false, fehler: `Das Intervall muss zwischen ${MIN_INTERVALL} und ${MAX_INTERVALL} Stunden liegen.` };
  }
  if (!Number.isInteger(aufbewahren) || aufbewahren < 1 || aufbewahren > MAX_AUFBEWAHREN) {
    return { ok: false, fehler: `Aufbewahrung: 1 bis ${MAX_AUFBEWAHREN} Sicherungen.` };
  }
  let zielNormal = ziel;
  if (ziel) {
    if (typ === 'verzeichnis') {
      if (!path.isAbsolute(ziel)) return { ok: false, fehler: 'Das Verzeichnis muss ein absoluter Pfad sein (z. B. /mnt/backup/noten).' };
      zielNormal = path.resolve(ziel);
      if (zielNormal === path.resolve(path.dirname(DB_PATH))) {
        return { ok: false, fehler: 'Das Ziel darf nicht das Verzeichnis der Datenbank selbst sein -- eine Sicherung gehört auf einen anderen Speicher.' };
      }
      for (const verboten of ['static', 'views', 'src', 'node_modules']) {
        const v = path.join(PROJEKT, verboten);
        if (zielNormal === v || zielNormal.startsWith(v + path.sep)) {
          return { ok: false, fehler: `Das Ziel darf nicht im Anwendungsverzeichnis „${verboten}“ liegen.` };
        }
      }
    } else {
      let url;
      try { url = new URL(ziel); } catch { return { ok: false, fehler: 'Bitte eine gültige WebDAV-Adresse eintragen (https://…).' }; }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, fehler: 'Die WebDAV-Adresse muss mit https:// (oder http://) beginnen.' };
      if (url.username || url.password) return { ok: false, fehler: 'Benutzer und Passwort bitte in die eigenen Felder eintragen, nicht in die Adresse.' };
      zielNormal = ziel.replace(/\/+$/, '');
    }
  }
  const aktiv = Boolean(body?.aktiv);
  if (aktiv && !zielNormal) return { ok: false, fehler: 'Für die automatische Sicherung bitte ein Ziel eintragen.' };
  return {
    ok: true,
    werte: { aktiv, typ, ziel: zielNormal, benutzer: String(body?.benutzer ?? '').trim().slice(0, 200), intervall_stunden: intervall, aufbewahren },
  };
}

/** Speichert die geprüften Werte. `passwort` leer = bestehendes behalten; `passwortLoeschen` entfernt es. */
export function speichereEinstellungen(werte, { passwort = '', passwortLoeschen = false } = {}) {
  const db = getDb();
  const bisher = db.prepare('SELECT passwort_verschluesselt FROM backup_einstellungen WHERE id = 1').get();
  let pw = bisher?.passwort_verschluesselt ?? '';
  if (passwortLoeschen) pw = '';
  else if (passwort) pw = encryptSecret(passwort);
  db.prepare(`
    INSERT INTO backup_einstellungen (id, aktiv, typ, ziel, benutzer, passwort_verschluesselt, intervall_stunden, aufbewahren)
    VALUES (1, @aktiv, @typ, @ziel, @benutzer, @pw, @intervall_stunden, @aufbewahren)
    ON CONFLICT(id) DO UPDATE SET aktiv = @aktiv, typ = @typ, ziel = @ziel, benutzer = @benutzer, passwort_verschluesselt = @pw,
      intervall_stunden = @intervall_stunden, aufbewahren = @aufbewahren
  `).run({ ...werte, aktiv: werte.aktiv ? 1 : 0, pw });
}

/** Protokoll der letzten Läufe (neueste zuerst). */
export function letzteLaeufe(limit = 20) {
  return getDb().prepare('SELECT * FROM backup_laeufe ORDER BY id DESC LIMIT ?').all(limit);
}

export function protokolliereStart(ausloeser, jetzt = new Date()) {
  return getDb().prepare('INSERT INTO backup_laeufe (gestartet_at, ausloeser) VALUES (?, ?)').run(jetzt.toISOString(), ausloeser).lastInsertRowid;
}

export function protokolliereEnde(id, { ok, dateiname = '', groesse = 0, meldung = '' }, jetzt = new Date()) {
  getDb().prepare('UPDATE backup_laeufe SET beendet_at = ?, ok = ?, dateiname = ?, groesse = ?, meldung = ? WHERE id = ?')
    .run(jetzt.toISOString(), ok ? 1 : 0, dateiname, groesse, String(meldung).slice(0, 1000), id);
  // Das Protokoll klein halten: nur die letzten 200 Läufe bleiben.
  getDb().prepare('DELETE FROM backup_laeufe WHERE id <= (SELECT MAX(id) FROM backup_laeufe) - 200').run();
}

/** Ist nach `intervall_stunden` ein neuer geplanter Lauf fällig? Nach einem Fehler erst nach einer Stunde erneut. */
export function istFaellig(einstellungen, letzterLauf, jetzt = new Date()) {
  if (!einstellungen.aktiv || !einstellungen.ziel) return false;
  if (!letzterLauf) return true;
  const seit = jetzt.getTime() - new Date(letzterLauf.gestartet_at).getTime();
  const wartezeit = letzterLauf.ok ? einstellungen.intervall_stunden * 3600_000 : Math.min(einstellungen.intervall_stunden, 1) * 3600_000;
  return seit >= wartezeit;
}

/** Letzter geplanter oder manueller Lauf (Grundlage für die Fälligkeit). */
export function letzterLauf() {
  return getDb().prepare('SELECT * FROM backup_laeufe WHERE beendet_at IS NOT NULL ORDER BY id DESC LIMIT 1').get() || null;
}
