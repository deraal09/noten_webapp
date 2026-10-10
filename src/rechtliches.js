/**
 * Angaben für Datenschutzerklärung und Impressum. Die Schule trägt sie unter Admin → Rechtliches ein
 * (Tabelle rechtliche_angaben); die öffentlichen Seiten /datenschutz und /impressum setzen sie in die Texte ein.
 */

import { getDb } from './db.js';

/** Felder in der Reihenfolge des Formulars: `gruppe` gliedert es, `pflicht` = ohne Angabe fehlt die Seite etwas. */
export const FELDER = [
  { key: 'schulname', gruppe: 'schule', label: 'Name der Schule', hint: 'z. B. Berufsbildende Schulen Rendsburg-Eckernförde', pflicht: true },
  { key: 'traeger', gruppe: 'schule', label: 'Schulträger (optional)', hint: 'z. B. Kreis Rendsburg-Eckernförde' },
  { key: 'strasse', gruppe: 'schule', label: 'Straße und Hausnummer', pflicht: true },
  { key: 'plz_ort', gruppe: 'schule', label: 'PLZ und Ort', pflicht: true },
  { key: 'vertretung', gruppe: 'schule', label: 'Vertretungsberechtigt (Schulleitung)', hint: 'Name und Funktion', pflicht: true },
  { key: 'telefon', gruppe: 'schule', label: 'Telefon' },
  { key: 'email', gruppe: 'schule', label: 'E-Mail der Schule', pflicht: true },
  { key: 'aufsicht', gruppe: 'schule', label: 'Zuständige Schulaufsicht (optional)', hint: 'Bezeichnung und Anschrift' },
  { key: 'betreuung', gruppe: 'schule', label: 'Technische Ansprechperson für diese Anwendung (optional)', hint: 'z. B. Name/Funktion und E-Mail der Administration' },
  { key: 'dsb_name', gruppe: 'datenschutz', label: 'Datenschutzbeauftragte/r der Schule', hint: 'Name oder Funktion', pflicht: true },
  { key: 'dsb_kontakt', gruppe: 'datenschutz', label: 'Kontakt der/des Datenschutzbeauftragten', hint: 'E-Mail, Telefon, Anschrift', pflicht: true },
  { key: 'datenschutzaufsicht', gruppe: 'datenschutz', label: 'Zuständige Datenschutz-Aufsichtsbehörde', hint: 'Name und Anschrift der Landesbehörde', pflicht: true },
  { key: 'rechtsgrundlage', gruppe: 'datenschutz', label: 'Rechtsgrundlage (Schulrecht des Landes)', multiline: true, hint: 'Eintragen oder anpassen; leer = allgemeiner Standardtext' },
  { key: 'speicherdauer', gruppe: 'datenschutz', label: 'Speicherdauer und Löschung', multiline: true, hint: 'Eintragen oder anpassen; leer = allgemeiner Standardtext' },
  { key: 'protokolle', gruppe: 'datenschutz', label: 'Server-Protokolle (Aufbewahrung)', multiline: true, hint: 'Welche Verbindungsdaten der Server protokolliert und wie lange; leer = allgemeiner Standardtext' },
];

export const STANDARD_RECHTSGRUNDLAGE = 'Die Verarbeitung erfolgt zur Erfüllung der Aufgaben der Schule (Leistungsbewertung, Zeugniserstellung, Dokumentation des Unterrichts) auf Grundlage von Art. 6 Abs. 1 Buchst. e der Datenschutz-Grundverordnung (DSGVO) in Verbindung mit den schul- und datenschutzrechtlichen Vorschriften des Landes. Die Daten der Lehrkräfte werden zur Durchführung des Dienstverhältnisses verarbeitet (Art. 6 Abs. 1 Buchst. e und b DSGVO in Verbindung mit den beamten- bzw. arbeitsrechtlichen Vorschriften).';
export const STANDARD_SPEICHERDAUER = 'Die Daten werden nur so lange gespeichert, wie sie für die genannten Zwecke erforderlich sind bzw. gesetzliche Aufbewahrungsfristen es verlangen. Klassen, Fächer und Schüler/innen können von der Klassenleitung bzw. der Administration gelöscht werden; Personen, die die Schule verlassen, werden aus den Klassen entfernt. Konten von Lehrkräften werden bei Ausscheiden deaktiviert bzw. gelöscht.';
export const STANDARD_PROTOKOLLE = 'Beim Aufruf der Anwendung kann der Server technisch bedingt Verbindungsdaten (IP-Adresse, Zeitpunkt, aufgerufene Adresse, Statuscode) in Protokolldateien erfassen. Sie dienen ausschließlich dem sicheren und störungsfreien Betrieb, werden nicht mit anderen Daten zusammengeführt und nach kurzer Zeit gelöscht. Wiederholt fehlgeschlagene Anmeldungen werden zum Schutz vor Missbrauch gezählt und führen vorübergehend zu einer Sperre.';

/** Alle Angaben als Objekt (fehlende Felder = leerer Text). */
export function ladeAngaben() {
  const angaben = Object.fromEntries(FELDER.map((f) => [f.key, '']));
  for (const r of getDb().prepare('SELECT schluessel, wert FROM rechtliche_angaben').all()) {
    if (r.schluessel in angaben) angaben[r.schluessel] = r.wert;
  }
  return angaben;
}

/** Speichert die Angaben aus einem Formular (nur bekannte Felder, getrimmt, begrenzt). */
export function speichereAngaben(body) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO rechtliche_angaben (schluessel, wert) VALUES (?, ?)
    ON CONFLICT(schluessel) DO UPDATE SET wert = excluded.wert
  `);
  db.transaction(() => {
    for (const f of FELDER) {
      const roh = String(body?.[f.key] ?? '').replace(/\r\n/g, '\n').trim();
      stmt.run(f.key, roh.slice(0, f.multiline ? 4000 : 300));
    }
  })();
}

/** Pflichtfelder, die noch fehlen (für den Hinweis an die Administration). */
export function fehlendePflichtfelder(angaben = ladeAngaben()) {
  return FELDER.filter((f) => f.pflicht && !angaben[f.key]).map((f) => f.label);
}
