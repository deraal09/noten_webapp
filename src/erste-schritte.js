/**
 * „Erste Schritte“-Checkliste auf der Startseite: Klasse anlegen → Fach anlegen → Schüler/innen eintragen → erste Klausur anlegen.
 * Sie erscheint nur für Lehrkräfte, die noch nicht alles erledigt haben, und verschwindet von selbst, sobald alle Schritte erledigt
 * sind (oder wenn man sie ausblendet). Erledigt wird aus den vorhandenen Daten abgeleitet, es wird nichts zusätzlich gespeichert.
 */

import { getDb } from './db.js';
import { ladeMeineKlassen, userDarfSelbstKlasseAnlegen } from './auth.js';

/** @returns {null | { schritte: {id: string, titel: string, text: string, erledigt: boolean, href: string|null}[], erledigt: number }} null = nichts anzeigen */
export function ersteSchritte(user) {
  if (!user || user.isAdmin) return null;
  const db = getDb();
  const klassen = ladeMeineKlassen(user.id).filter((k) => !k.ist_ablage);
  if (!klassen.length && !userDarfSelbstKlasseAnlegen(user)) return null; // ohne eigene Klasse und ohne Recht, eine anzulegen: nichts zu tun
  const ids = klassen.map((k) => k.id);
  const platz = ids.map(() => '?').join(',');
  const anzahlSchueler = ids.length ? db.prepare(`SELECT COUNT(*) AS c FROM schueler WHERE klasse_id IN (${platz})`).get(...ids).c : 0;
  const faecher = db.prepare(`
    SELECT DISTINCT f.id, f.klasse_id FROM fach_zuweisungen fz JOIN faecher f ON f.id = fz.fach_id WHERE fz.user_id = ? ORDER BY f.id
  `).all(user.id);
  const anzahlFaecherInKlassen = ids.length ? db.prepare(`SELECT COUNT(*) AS c FROM faecher WHERE klasse_id IN (${platz}) AND ist_kurs = 0`).get(...ids).c : 0;
  const anzahlKlausuren = faecher.length
    ? db.prepare(`SELECT COUNT(*) AS c FROM klausuren WHERE fach_id IN (${faecher.map(() => '?').join(',')})`).get(...faecher.map((f) => f.id)).c : 0;
  const ersteKlasse = klassen[0];
  const schritte = [
    { id: 'klasse', titel: 'Klasse anlegen', text: 'Name, Schuljahr und Notenschlüssel wählen.', erledigt: klassen.length > 0, href: '/teacher/klassen#panel-klasse-anlegen' },
    { id: 'fach', titel: 'Fach anlegen', text: 'In der Klasse ein Fach hinzufügen, in dem du Noten einträgst.', erledigt: anzahlFaecherInKlassen > 0 || faecher.length > 0, href: ersteKlasse ? `/teacher/klassen/${ersteKlasse.id}` : null },
    { id: 'schueler', titel: 'Schüler/innen eintragen', text: 'Einzeln, als Liste oder per CSV-Datei.', erledigt: anzahlSchueler > 0, href: ersteKlasse ? `/teacher/klassen/${ersteKlasse.id}#schueler-hinzufuegen` : null },
    { id: 'klausur', titel: 'Erste Klausur anlegen', text: 'Im Fach den Reiter „Klausuren“ öffnen und „Neu hinzufügen“ wählen.', erledigt: anzahlKlausuren > 0, href: faecher[0] ? `/teacher/fach/${faecher[0].id}` : null },
  ];
  const erledigt = schritte.filter((s) => s.erledigt).length;
  if (erledigt === schritte.length) return null;
  return { schritte, erledigt };
}
