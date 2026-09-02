/**
 * Ratelimit für Login-Versuche, keyed auf den eingegebenen Benutzernamen
 * (unabhängig davon, ob er tatsächlich existiert -- verhindert auch das
 * Durchprobieren von Passwörtern für nicht existierende oder erst später
 * angelegte Benutzernamen).
 *
 * Ab dem 3. Fehlversuch in Folge wird eine Sperre mit fester Basisdauer
 * (30 s) verhängt. Jeder weitere Fehlversuch NACH Ablauf der vorherigen
 * Sperre verdoppelt die Sperrdauer (30s, 60s, 120s, 240s, ...) -- klassischer
 * exponentieller Backoff gegen automatisiertes Durchprobieren.
 *
 * Ein Login-Versuch WÄHREND einer aktiven Sperre wird bewusst nicht als
 * weiterer Fehlversuch gezählt und verlängert die Sperre nicht zusätzlich --
 * sonst könnte man ein fremdes Konto durch bloßes Weiter-Versuchen beliebig
 * lange sperren (Denial-of-Service gegen die eigentliche Kontoinhaberin).
 *
 * Persistiert in SQLite (Tabelle `login_ratelimit`, siehe db.js) statt im
 * Arbeitsspeicher, damit die Sperre auch einen App-Neustart übersteht.
 */
import { getDb } from '../db.js';

const SCHWELLE = 3;
const BASIS_SPERRE_MS = 30 * 1000;

function normiere(schluessel) {
  return String(schluessel || '').trim().toLowerCase();
}

/**
 * Prüft, ob für den Schlüssel aktuell eine Sperre läuft. Löst KEINE
 * Anmeldeprüfung aus und verändert den Zustand nicht.
 */
export function pruefeSperre(schluessel) {
  const key = normiere(schluessel);
  if (!key) return { gesperrt: false };
  const row = getDb().prepare('SELECT gesperrt_bis FROM login_ratelimit WHERE schluessel = ?').get(key);
  if (!row || !row.gesperrt_bis || row.gesperrt_bis <= Date.now()) {
    return { gesperrt: false };
  }
  return { gesperrt: true, restSekunden: Math.ceil((row.gesperrt_bis - Date.now()) / 1000) };
}

/** Vermerkt einen Fehlversuch; ab dem 3. in Folge wird (erneut) gesperrt. */
export function vermerkeFehlversuch(schluessel) {
  const key = normiere(schluessel);
  if (!key) return;
  const db = getDb();
  const bestehend = db.prepare('SELECT fehlversuche FROM login_ratelimit WHERE schluessel = ?').get(key);
  const fehlversuche = (bestehend?.fehlversuche || 0) + 1;
  let gesperrtBis = null;
  if (fehlversuche >= SCHWELLE) {
    const dauerMs = BASIS_SPERRE_MS * 2 ** (fehlversuche - SCHWELLE);
    gesperrtBis = Date.now() + dauerMs;
  }
  db.prepare(`
    INSERT INTO login_ratelimit (schluessel, fehlversuche, gesperrt_bis) VALUES (?, ?, ?)
    ON CONFLICT(schluessel) DO UPDATE SET fehlversuche = excluded.fehlversuche, gesperrt_bis = excluded.gesperrt_bis
  `).run(key, fehlversuche, gesperrtBis);
}

/** Setzt den Fehlversuchs-Zähler nach einer erfolgreichen Anmeldung zurück. */
export function setzeZurueck(schluessel) {
  const key = normiere(schluessel);
  if (!key) return;
  getDb().prepare('DELETE FROM login_ratelimit WHERE schluessel = ?').run(key);
}
