/**
 * SPA-Abschlusszeugnis: pro Person wählbare Quellfächer je Zeugnisposition.
 *
 * Standardmäßig speist das SPA-Fach der AKTUELLEN Klasse eine Position
 * (siehe abschlusszeugnis in spa-noten-service.js). Hat eine Person zusätzlich
 * Fächer aus früheren Klassen oder Fächer vergangener
 * Schuljahre (siehe ladeFaecherEinerPerson), lässt sich jede Position pro
 * Person aus beliebigen dieser Fächer zusammenstellen: mehrere gewählte
 * Fächer werden gemittelt. Ohne gespeicherte Auswahl bleibt alles beim
 * Standard.
 */

import { ladeFaecherEinerPerson, ladeFachNotenEintraege } from './fach-abschluss.js';
import {
  berechneFachFuerSchueler, zeugnisFuerKlasse, ausweisTendenz,
} from './spa-noten-service.js';
import { tendenzAusEndpunkten, STANDARD_NOTENSKALA } from './spa-grade-calc.js';
import { spaSchemaFuer } from './spa-schema.js';

const begrenze = (x) => Math.max(0, Math.min(15, x));

/**
 * Schulnote (1-6) -> Punkte 0-15 der SPA-Notenskala (1 = 14, 2 = 11, ... 6 = 0).
 * Noten der BG-Skala (0-15) sind bereits Punkte.
 */
function notePunkte(note, notenschluessel) {
  return notenschluessel === 'BG' ? begrenze(note) : begrenze(17 - 3 * note);
}

/**
 * Punktwert, den `fach` zur Position (Fach-Schlüssel, Halbjahr) einer Person
 * beisteuert -- oder null, wenn dort noch nichts eingetragen ist.
 * SPA-Fach: Endpunkte des Halbjahres, sonst der zuletzt vorhandene frühere
 * Wert (wie beim Standard). Anderes Fach: Abschlussnote bzw. aktueller Stand,
 * in Punkte umgerechnet.
 */
function punkteFuerQuelle(db, fach, schuelerId, halbjahr, cache) {
  if (fach.spa_fach_key) {
    if (!cache.has(fach.id)) cache.set(fach.id, berechneFachFuerSchueler(db, fach.id, schuelerId));
    const ergebnisse = cache.get(fach.id);
    for (let h = halbjahr; h >= 1; h -= 1) {
      const e = ergebnisse.find((x) => x.halbjahr === h);
      if (e && e.endpunkte != null) return e.endpunkte;
    }
    return null;
  }
  if (!cache.has(`n${fach.id}`)) cache.set(`n${fach.id}`, ladeFachNotenEintraege(fach, schuelerId));
  const info = cache.get(`n${fach.id}`);
  const note = fach.abgeschlossen ? info.abschlussnote : info.stand;
  return note === null ? null : notePunkte(note, fach.notenschluessel);
}

/** Map Position -> [fach_id] der gespeicherten Auswahl einer Person. */
export function ladeQuellenAuswahl(db, schuelerId) {
  const auswahl = new Map();
  for (const r of db.prepare('SELECT position, fach_id FROM spa_zeugnis_quellen WHERE schueler_id = ?').all(schuelerId)) {
    if (!auswahl.has(r.position)) auswahl.set(r.position, []);
    auswahl.get(r.position).push(r.fach_id);
  }
  return auswahl;
}

/** Setzt pro Person alle gespeicherten Auswahlen zurück (zurück zum Standard). */
export function loescheQuellenAuswahl(db, schuelerId) {
  db.prepare('DELETE FROM spa_zeugnis_quellen WHERE schueler_id = ?').run(schuelerId);
}

/**
 * Rechnet die gespeicherten Quellen-Auswahlen in die Zeilen des SPA-
 * Abschlusszeugnisses (siehe zeugnisFuerKlasse, 4. Halbjahr) ein. Eine
 * angepasste Position bekommt `angepasst: true` und die Namen der Quellen.
 */
export function wendeQuellenAn(db, klasse, zeilen) {
  for (const zeile of zeilen) {
    const auswahl = ladeQuellenAuswahl(db, zeile.schuelerId);
    if (auswahl.size === 0) continue;
    const kandidaten = new Map(ladeFaecherEinerPerson(zeile.schuelerId).map((f) => [f.id, f]));
    const cache = new Map();
    for (const zelle of zeile.faecher) {
      const fachIds = auswahl.get(zelle.fach);
      if (!fachIds) continue;
      const [fachKey, hj] = zelle.fach.split(':');
      const quellen = fachIds.map((id) => kandidaten.get(id)).filter(Boolean);
      if (quellen.length === 0) continue;
      const werte = quellen
        .map((q) => punkteFuerQuelle(db, q, zeile.schuelerId, Number(hj), cache))
        .filter((w) => w !== null);
      const istKomma = spaSchemaFuer(fachKey, klasse.spa_bildungsgang).some((s) => s.kommaNote);
      const mittel = werte.length ? werte.reduce((a, b) => a + b, 0) / werte.length : null;
      zelle.endpunkte = mittel;
      zelle.tendenz = mittel === null ? null : ausweisTendenz(istKomma, tendenzAusEndpunkten(mittel, STANDARD_NOTENSKALA));
      zelle.angepasst = true;
      zelle.quellen = quellen.map((q) => `${q.name} (${q.klasse_name}, ${q.schuljahr_bezeichnung})`);
    }
  }
  return zeilen;
}

/** Zeugnisübersicht einer SPA-Klasse inkl. gewählter Quellen (nur das Abschlusszeugnis, 4. Halbjahr, ist betroffen). */
export function zeugnisMitQuellen(db, klasse, halbjahr) {
  const zeilen = zeugnisFuerKlasse(db, klasse.id, halbjahr);
  return halbjahr === 4 ? wendeQuellenAn(db, klasse, zeilen) : zeilen;
}

/**
 * Daten für die Auswahl-Seite einer Person: je Zeugnisposition alle
 * Kandidaten-Fächer mit dem Punktwert, den sie beisteuern würden, und ob sie
 * gewählt sind. `standardFachId` ist das Fach der aktuellen Klasse, das ohne
 * Auswahl verwendet wird.
 */
export function ladeQuellenSeite(db, klasse, schuelerId) {
  const zeile = zeugnisFuerKlasse(db, klasse.id, 4).find((z) => z.schuelerId === schuelerId);
  if (!zeile) return null;
  const kandidaten = ladeFaecherEinerPerson(schuelerId);
  const auswahl = ladeQuellenAuswahl(db, schuelerId);
  const cache = new Map();
  const standardFaecher = new Map(
    db.prepare('SELECT id, spa_fach_key FROM faecher WHERE klasse_id = ? AND spa_fach_key IS NOT NULL').all(klasse.id)
      .map((f) => [f.spa_fach_key, f.id]),
  );
  const positionen = zeile.faecher.map((zelle) => {
    const [fachKey, hj] = zelle.fach.split(':');
    const gewaehlt = new Set(auswahl.get(zelle.fach) ?? []);
    return {
      key: zelle.fach, label: zelle.label,
      standardFachId: standardFaecher.get(fachKey) ?? null,
      angepasst: gewaehlt.size > 0,
      kandidaten: kandidaten.map((f) => ({
        fach: f, gewaehlt: gewaehlt.has(f.id),
        punkte: punkteFuerQuelle(db, f, schuelerId, Number(hj), cache),
      })),
    };
  });
  return { schueler: { id: zeile.schuelerId, nachname: zeile.nachname, vorname: zeile.vorname }, positionen };
}

/**
 * Speichert die Auswahl einer Person. `gewaehlt`: Liste von "<Position>|<fach_id>".
 * Nur bekannte Positionen und tatsächlich zur Person gehörende Fächer werden
 * übernommen. Der Standard (keine Zeile) bleibt bestehen, wenn für eine
 * Position nichts gewählt ist.
 */
export function speichereQuellenAuswahl(db, klasse, schuelerId, gewaehlt) {
  const zeile = zeugnisFuerKlasse(db, klasse.id, 4).find((z) => z.schuelerId === schuelerId);
  if (!zeile) return 0;
  const positionen = new Set(zeile.faecher.map((z) => z.fach));
  const erlaubteFaecher = new Set(ladeFaecherEinerPerson(schuelerId).map((f) => f.id));
  const insert = db.prepare('INSERT OR IGNORE INTO spa_zeugnis_quellen (schueler_id, position, fach_id) VALUES (?, ?, ?)');
  let gespeichert = 0;
  db.transaction(() => {
    loescheQuellenAuswahl(db, schuelerId);
    for (const eintrag of gewaehlt) {
      const [position, rohId] = String(eintrag).split('|');
      const fachId = parseInt(rohId, 10);
      if (!positionen.has(position) || !erlaubteFaecher.has(fachId)) continue;
      insert.run(schuelerId, position, fachId);
      gespeichert += 1;
    }
  })();
  return gespeichert;
}
