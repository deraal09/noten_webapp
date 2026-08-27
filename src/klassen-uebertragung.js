/**
 * Klasse in ein anderes (i. d. R. das nächste) Schuljahr übertragen.
 * Kopiert bewusst NUR Struktur (Schüler/innen, optional Fächer samt
 * Lehrkraft-Zuweisungen, Klassenleitung), keine Noten/Klausuren/ULs — die
 * neue Klasse startet mit leeren Halbjahren. Die alte Klasse bleibt
 * unverändert für die Historie erhalten: eigene, neue Schüler-Datensätze
 * statt Umhängen der bestehenden (sonst wären die alten Halbjahresnoten
 * verwaist).
 */

import { getDb } from './db.js';

export function uebertrageKlasseInSchuljahr(klasseId, zielSchuljahrId, neuerName, mitFaechern, userId) {
  const db = getDb();
  const alteKlasse = db.prepare('SELECT * FROM klassen WHERE id = ?').get(klasseId);
  if (!alteKlasse) throw new Error('Klasse nicht gefunden');
  const zielSchuljahr = db.prepare('SELECT id FROM schuljahre WHERE id = ?').get(zielSchuljahrId);
  if (!zielSchuljahr) throw new Error('Ziel-Schuljahr nicht gefunden');
  const name = String(neuerName || '').trim() || alteKlasse.name;

  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO klassen (schuljahr_id, name, notenschluessel, notenschluessel_csv, created_by_id, zwei_schulen)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(zielSchuljahrId, name, alteKlasse.notenschluessel, alteKlasse.notenschluessel_csv, userId, alteKlasse.zwei_schulen);
    const neueKlasseId = info.lastInsertRowid;

    const schuelerListe = db.prepare('SELECT * FROM schueler WHERE klasse_id = ? ORDER BY nachname, vorname').all(klasseId);
    const insertSchueler = db.prepare('INSERT INTO schueler (klasse_id, nachname, vorname) VALUES (?, ?, ?)');
    for (const s of schuelerListe) insertSchueler.run(neueKlasseId, s.nachname, s.vorname);

    // Klassenleitung wird immer mit übernommen (unabhängig von "mit Fächern") —
    // sie betreut i. d. R. dieselbe Klasse auch im neuen Schuljahr weiter.
    const klassenleitungListe = db.prepare('SELECT user_id FROM klassenleitung WHERE klasse_id = ?').all(klasseId);
    const insertKlassenleitung = db.prepare('INSERT INTO klassenleitung (klasse_id, user_id) VALUES (?, ?)');
    for (const kl of klassenleitungListe) {
      try { insertKlassenleitung.run(neueKlasseId, kl.user_id); } catch { /* bereits vorhanden */ }
    }

    if (mitFaechern) {
      const faecherListe = db.prepare('SELECT * FROM faecher WHERE klasse_id = ?').all(klasseId);
      const insertFach = db.prepare('INSERT INTO faecher (klasse_id, name) VALUES (?, ?)');
      const insertZuweisung = db.prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)');
      const zuweisungenStmt = db.prepare('SELECT user_id FROM fach_zuweisungen WHERE fach_id = ?');
      for (const f of faecherListe) {
        const neuesFach = insertFach.run(neueKlasseId, f.name);
        for (const z of zuweisungenStmt.all(f.id)) {
          try { insertZuweisung.run(z.user_id, neuesFach.lastInsertRowid); } catch { /* bereits vorhanden */ }
        }
      }
    }
    return neueKlasseId;
  });
  return tx();
}
