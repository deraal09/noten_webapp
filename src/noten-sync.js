/**
 * Sync-Mechanismus: gibt der Klassenleitung Einblick in die Noten anderer
 * Lehrkräfte, ohne dass diese permanent live mitschauen kann. Eine Lehrkraft
 * synchronisiert ihr Fach entweder per Knopfdruck (jederzeit) oder — wenn
 * sie den Haken "automatisch synchronisieren" gesetzt hat — bei jeder
 * Notenänderung automatisch. Der zuletzt synchronisierte Stand landet in
 * fach_sync_stand/fach_sync_meta; die Klassenleitung sieht NUR diesen Stand
 * (siehe /teacher/klassen/:id/uebersicht), nie die Live-Notentafel fremder
 * Fächer.
 */

import { getDb } from './db.js';
import { berechneGesamtnoten, ladeFaecherFuerKlassenleitung } from './noten-service.js';
import { ladeSperrenFuerKlasse } from './noten-sperre.js';

/** Schreibt den aktuellen Notenstand eines Fachs/Halbjahrs in den Sync-Stand. */
export function syncFach(fachId, halbjahr, userId) {
  const db = getDb();
  const noten = berechneGesamtnoten(fachId, halbjahr);
  const tx = db.transaction(() => {
    const upsert = db.prepare(`
      INSERT INTO fach_sync_stand (fach_id, halbjahr, schueler_id, note, synced_at, synced_by_id)
      VALUES (?, ?, ?, ?, datetime('now'), ?)
      ON CONFLICT(fach_id, halbjahr, schueler_id) DO UPDATE SET
        note = excluded.note, synced_at = excluded.synced_at, synced_by_id = excluded.synced_by_id
    `);
    for (const [schuelerId, note] of noten) {
      upsert.run(fachId, halbjahr, schuelerId, note, userId);
    }
    db.prepare(`
      INSERT INTO fach_sync_meta (fach_id, halbjahr, synced_at, synced_by_id)
      VALUES (?, ?, datetime('now'), ?)
      ON CONFLICT(fach_id, halbjahr) DO UPDATE SET
        synced_at = excluded.synced_at, synced_by_id = excluded.synced_by_id
    `).run(fachId, halbjahr, userId);
  });
  tx();
}

/** Nach einer Notenänderung aufrufen: synchronisiert nur, wenn der Haken für diese Lehrkraft/dieses Fach gesetzt ist. */
export function syncFallsAutoAktiv(fachId, halbjahr, userId) {
  const row = getDb().prepare('SELECT auto_sync FROM fach_zuweisungen WHERE fach_id = ? AND user_id = ?')
    .get(fachId, userId);
  if (row?.auto_sync) syncFach(fachId, halbjahr, userId);
}

/** Sync-Metadaten (zuletzt synchronisiert am/von) für ein Fach+Halbjahr, oder null. */
export function holeSyncMeta(fachId, halbjahr) {
  return getDb().prepare(`
    SELECT m.synced_at, u.display_name, u.username
    FROM fach_sync_meta m LEFT JOIN users u ON u.id = m.synced_by_id
    WHERE m.fach_id = ? AND m.halbjahr = ?
  `).get(fachId, halbjahr) || null;
}

/**
 * Daten für die Halbjahresübersicht einer Klasse (Klassenleitung/Admin) --
 * zeigt NUR den zuletzt synchronisierten Stand je Fach (siehe Modul-Kommentar
 * oben), nie Live-Werte. Ausgelagert aus routes/teacher.js, damit sowohl die
 * eigenständige Seite (/teacher/klassen/:id/uebersicht) als auch der
 * gleichnamige Reiter auf der Klassenleitungsübersicht (routes/klassenlehrer.js)
 * dieselbe Logik verwenden.
 */
export function ladeHalbjahresuebersicht(klasse, halbjahr) {
  const db = getDb();
  const schueler = db.prepare('SELECT * FROM schueler WHERE klasse_id = ? ORDER BY nachname, vorname').all(klasse.id);
  const faecher = ladeFaecherFuerKlassenleitung(klasse.id);
  const syncMeta = new Map(faecher.map((f) => [f.id, holeSyncMeta(f.id, halbjahr)]));
  const standRows = faecher.length ? db.prepare(`
    SELECT fach_id, schueler_id, note, konferenz_note FROM fach_sync_stand
    WHERE halbjahr = ? AND fach_id IN (${faecher.map(() => '?').join(',')})
  `).all(halbjahr, ...faecher.map((f) => f.id)) : [];
  // Von der Klassenleitung im Konferenzmodus überschriebene Note hat Vorrang
  // vor dem reinen Sync-Stand der Fachlehrkraft.
  const stand = new Map(); // schueler_id -> Map(fach_id -> {note, ueberschrieben})
  for (const s of schueler) stand.set(s.id, new Map());
  for (const r of standRows) {
    const ueberschrieben = r.konferenz_note !== null && r.konferenz_note !== undefined;
    stand.get(r.schueler_id)?.set(r.fach_id, { note: ueberschrieben ? r.konferenz_note : r.note, ueberschrieben });
  }

  const notizRows = schueler.length ? db.prepare(`
    SELECT n.*, u.display_name, u.username, f.name AS fach_name FROM notenbesprechung_notizen n
    LEFT JOIN users u ON u.id = n.created_by_id
    LEFT JOIN faecher f ON f.id = n.fach_id
    WHERE n.halbjahr = ? AND n.schueler_id IN (${schueler.map(() => '?').join(',')})
    ORDER BY n.created_at DESC
  `).all(halbjahr, ...schueler.map((s) => s.id)) : [];
  const notizenNachSchueler = new Map();
  for (const n of notizRows) {
    if (!notizenNachSchueler.has(n.schueler_id)) notizenNachSchueler.set(n.schueler_id, []);
    notizenNachSchueler.get(n.schueler_id).push(n);
  }

  const zeilen = schueler.map((s) => {
    const noten = faecher.map((f) => stand.get(s.id)?.get(f.id) ?? { note: null, ueberschrieben: false });
    const vorhanden = noten.map((n) => n.note).filter((n) => n !== null && n !== undefined);
    const schnitt = vorhanden.length ? vorhanden.reduce((a, b) => a + b, 0) / vorhanden.length : null;
    return { schueler: s, noten, schnitt, notizen: notizenNachSchueler.get(s.id) || [] };
  });

  return { faecher, zeilen, syncMeta, sperren: ladeSperrenFuerKlasse(klasse.id, halbjahr) };
}
