/**
 * Raster "Direkte Endnoteneingabe" für die Klassenleitung: Schüler/innen ×
 * Fächer eines Halbjahres mit der direkt eingetragenen Endnote und der aus
 * Klausuren/Unterrichtsleistung berechneten Note (siehe
 * src/halbjahr-endnoten.js). Die Klassenleitung darf sie für vergangene
 * Halbjahre eintragen, sofern die Person nicht durch die Notenkonferenz
 * gesperrt ist.
 */

import { getDb } from './db.js';
import { ladeFaecherFuerKlassenleitung, berechneGesamtnotenOhneEndnoten } from './noten-service.js';
import { ladeEndnoten } from './halbjahr-endnoten.js';
import { ladeSperrenFuerKlasse } from './noten-sperre.js';
import { fachGiltInHalbjahr, klassenLaufzeit, halbjahrNr, istHalbjahrVergangen, jetzt } from './klassen-jahre.js';

export function ladeEndnotenRaster(klasse, halbjahr) {
  const db = getDb();
  const laufzeit = klassenLaufzeit(klasse.id);
  const schueler = db.prepare('SELECT * FROM schueler WHERE klasse_id = ? ORDER BY nachname, vorname').all(klasse.id);
  // SPA-Fächer bewerten in Punkten mit eigener Eingabemaske (Komponenten) -- dort gibt es die direkte Eingabe separat.
  const faecher = ladeFaecherFuerKlassenleitung(klasse.id).filter((f) => !f.spa_fach_key && fachGiltInHalbjahr(f, halbjahr, laufzeit));
  const sperren = ladeSperrenFuerKlasse(klasse.id, halbjahr);
  const teilnehmer = new Map(); // fach_id -> Set<schueler_id>
  for (const f of faecher) {
    teilnehmer.set(f.id, new Set(db.prepare('SELECT schueler_id FROM fach_teilnehmer WHERE fach_id = ?').all(f.id).map((r) => r.schueler_id)));
  }
  const berechnet = new Map(faecher.map((f) => [f.id, berechneGesamtnotenOhneEndnoten(f.id, halbjahr)]));
  const direkt = new Map(faecher.map((f) => [f.id, ladeEndnoten(f.id, halbjahr)]));
  const zeilen = schueler.map((s) => ({
    schueler: s,
    gesperrt: Boolean(sperren.get(s.id)),
    zellen: faecher.map((f) => ({
      fach: f,
      teilnimmt: teilnehmer.get(f.id).has(s.id),
      berechnet: berechnet.get(f.id).get(s.id) ?? null,
      direkt: direkt.get(f.id).get(s.id) ?? null,
    })),
  }));
  return {
    faecher, zeilen, sperren,
    bearbeitbar: istHalbjahrVergangen(laufzeit, halbjahrNr(halbjahr), jetzt()),
  };
}
