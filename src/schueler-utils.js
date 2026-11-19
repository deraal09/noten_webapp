/**
 * Verhindert doppelte Schüler-Einträge in einer Klasse — wird beim
 * Einzeleingabe-Formular, Sammel-Einfügen, CSV-Upload und der
 * Klassen-Übertragung genutzt. Verglichen wird Nachname/Vorname
 * unabhängig von Groß-/Kleinschreibung und Leerzeichen am Rand, damit ein
 * erneut hochgeladenes CSV niemanden doppelt anlegt.
 */

import { getDb } from './db.js';

/** ID der/des bereits vorhandenen Schülers/in mit diesem Namen in der Klasse, sonst null. */
export function holeSchuelerId(klasseId, nachname, vorname) {
  const n = String(nachname || '').trim().toLowerCase();
  const v = String(vorname || '').trim().toLowerCase();
  const zeile = getDb().prepare(`
    SELECT id FROM schueler
    WHERE klasse_id = ? AND LOWER(TRIM(nachname)) = ? AND LOWER(TRIM(vorname)) = ?
  `).get(klasseId, n, v);
  return zeile?.id ?? null;
}

export function schuelerExistiertBereits(klasseId, nachname, vorname) {
  return holeSchuelerId(klasseId, nachname, vorname) !== null;
}

// Ein neu angelegter Schüler/in wird automatisch Teilnehmer/in aller
// bereits bestehenden Fächer der EIGENEN Klasse (nicht fremder Kurse, die
// diese Klasse nur als Teilnehmerquelle nutzen -- siehe fach_teilnehmer in
// src/db.js) -- sonst würde ein nachträglich hinzugefügter Schüler in
// bereits angelegten Fächern schlicht fehlen, obwohl er/sie zur Klasse
// gehört. Bewusst ohne Import aus fach-teilnehmer.js (das umgekehrt diese
// Datei importiert) -- direktes SQL statt eines Ringimports.
function fuegeZuEigenenFaechernHinzu(klasseId, schuelerId) {
  const db = getDb();
  const faecher = db.prepare('SELECT id FROM faecher WHERE klasse_id = ?').all(klasseId);
  const ins = db.prepare('INSERT OR IGNORE INTO fach_teilnehmer (fach_id, schueler_id) VALUES (?, ?)');
  for (const f of faecher) ins.run(f.id, schuelerId);
}

/** Legt Schüler/in an, außer es gibt in der Klasse schon jemanden mit gleichem Namen. Gibt true zurück, wenn tatsächlich angelegt wurde. */
export function fuegeSchuelerHinzuFallsNeu(klasseId, nachname, vorname) {
  if (schuelerExistiertBereits(klasseId, nachname, vorname)) return false;
  const info = getDb().prepare('INSERT INTO schueler (klasse_id, nachname, vorname) VALUES (?, ?, ?)')
    .run(klasseId, nachname, vorname);
  fuegeZuEigenenFaechernHinzu(klasseId, info.lastInsertRowid);
  return true;
}

/** Wie fuegeSchuelerHinzuFallsNeu, gibt aber die (neue oder bestehende) ID zurück. */
export function findeOderLegeSchuelerAn(klasseId, nachname, vorname) {
  const bestehendeId = holeSchuelerId(klasseId, nachname, vorname);
  if (bestehendeId !== null) return bestehendeId;
  const info = getDb().prepare('INSERT INTO schueler (klasse_id, nachname, vorname) VALUES (?, ?, ?)')
    .run(klasseId, String(nachname).trim(), String(vorname).trim());
  fuegeZuEigenenFaechernHinzu(klasseId, info.lastInsertRowid);
  return info.lastInsertRowid;
}

/**
 * Korrigiert Nachname/Vorname einer Person (z. B. bei Schreibfehlern). Es gibt nur EINEN Datensatz je Person -- die Änderung gilt damit
 * sofort überall (Klasse, Fächer, Kurse, Zeugnisse, Sitzplan) und für alle Lehrkräfte, die die Klasse sehen. Noten hängen an der ID und
 * bleiben unberührt. Gibt { ok: true, geaendert } oder { ok: false, fehler: 'leer' | 'zu-lang' | 'nicht-gefunden' | 'doppelt' } zurück.
 */
export function benenneSchuelerUm(schuelerId, nachname, vorname) {
  const nn = String(nachname ?? '').replace(/\s+/g, ' ').trim();
  const vn = String(vorname ?? '').replace(/\s+/g, ' ').trim();
  if (!nn || !vn) return { ok: false, fehler: 'leer' };
  if (nn.length > 100 || vn.length > 100) return { ok: false, fehler: 'zu-lang' };
  const db = getDb();
  const s = db.prepare('SELECT id, klasse_id, nachname, vorname FROM schueler WHERE id = ?').get(schuelerId);
  if (!s) return { ok: false, fehler: 'nicht-gefunden' };
  if (s.nachname === nn && s.vorname === vn) return { ok: true, geaendert: false, klasse_id: s.klasse_id };
  const anderer = holeSchuelerId(s.klasse_id, nn, vn);
  if (anderer !== null && anderer !== s.id) return { ok: false, fehler: 'doppelt', klasse_id: s.klasse_id };
  db.prepare('UPDATE schueler SET nachname = ?, vorname = ? WHERE id = ?').run(nn, vn, s.id);
  return { ok: true, geaendert: true, klasse_id: s.klasse_id, alt: { nachname: s.nachname, vorname: s.vorname } };
}
