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
import { berechneGesamtnoten } from './noten-service.js';

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
