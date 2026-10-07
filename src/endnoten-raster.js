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
import { spaSchemaFuerFach, berechneFachFuerSchueler as berechneSpaFachFuerSchueler } from './spa-noten-service.js';
import { fachHatLehrkraftImHalbjahr } from './unterfaecher.js';
import { fachGiltInHalbjahr, klassenLaufzeit, halbjahrNr, istHalbjahrVergangen, jetzt } from './klassen-jahre.js';

export function ladeEndnotenRaster(klasse, halbjahr) {
  const db = getDb();
  const laufzeit = klassenLaufzeit(klasse.id);
  const schueler = db.prepare('SELECT * FROM schueler WHERE klasse_id = ? ORDER BY nachname, vorname').all(klasse.id);
  // SPA-Fächer sind dabei: die direkt eingetragenen Gesamtpunkte gelten als Endpunkte des Halbjahres
  // (nur in den Halbjahren, die das SPA-Schema des Fachs kennt).
  const hjNr = halbjahrNr(halbjahr);
  const faecher = ladeFaecherFuerKlassenleitung(klasse.id).filter((f) => fachGiltInHalbjahr(f, halbjahr, laufzeit)
    && (!f.spa_fach_key || spaSchemaFuerFach(db, f.id).schema.some((s) => s.halbjahr === hjNr)));
  const sperren = ladeSperrenFuerKlasse(klasse.id, halbjahr);
  const teilnehmer = new Map(); // fach_id -> Set<schueler_id>
  for (const f of faecher) {
    teilnehmer.set(f.id, new Set(db.prepare('SELECT schueler_id FROM fach_teilnehmer WHERE fach_id = ?').all(f.id).map((r) => r.schueler_id)));
  }
  // SPA: berechnete Endpunkte (ohne Direkteingabe) je Person; sonst die Halbjahresnote aus Klausuren/Unterrichtsleistung.
  const berechnet = new Map(faecher.map((f) => {
    if (!f.spa_fach_key) return [f.id, berechneGesamtnotenOhneEndnoten(f.id, halbjahr)];
    const proPerson = new Map();
    for (const sid of teilnehmer.get(f.id)) {
      const e = berechneSpaFachFuerSchueler(db, f.id, sid, { ohneDirekteingabe: true }).find((x) => x.halbjahr === hjNr);
      proPerson.set(sid, e?.endpunkte ?? null);
    }
    return [f.id, proPerson];
  }));
  const direkt = new Map(faecher.map((f) => [f.id, ladeEndnoten(f.id, halbjahr)]));
  // Vergangene Halbjahre kann die Klassenleitung immer direkt eintragen; Fächer OHNE Lehrkraft auch in jedem anderen Halbjahr.
  const vergangen = istHalbjahrVergangen(laufzeit, hjNr, jetzt());
  const bearbeitbarJeFach = new Map(faecher.map((f) => [f.id, vergangen || !fachHatLehrkraftImHalbjahr(f, hjNr, laufzeit)]));
  const zeilen = schueler.map((s) => ({
    schueler: s,
    gesperrt: Boolean(sperren.get(s.id)),
    zellen: faecher.map((f) => ({
      fach: f,
      teilnimmt: teilnehmer.get(f.id).has(s.id),
      bearbeitbar: bearbeitbarJeFach.get(f.id),
      berechnet: berechnet.get(f.id).get(s.id) ?? null,
      direkt: direkt.get(f.id).get(s.id) ?? null,
    })),
  }));
  return {
    faecher, zeilen, sperren,
    bearbeitbar: vergangen,
    mitFaechernOhneLehrkraft: faecher.some((f) => !vergangen && bearbeitbarJeFach.get(f.id)),
  };
}
