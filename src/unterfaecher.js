/**
 * Unterfächer und Lehrkraftzuordnung je Halbjahr.
 *
 * Ein Fach kann sich je Halbjahr aus Unterfächern zusammensetzen (z. B. ein
 * Lernfeld aus Kunst/Musik/...). Ein Unterfach ist technisch ein normales Fach
 * der Klasse (faecher.parent_fach_id): eigene Klausuren, Unterrichtsleistung,
 * Noten, Teilnehmerliste und Lehrkräfte; die Fachnote des Halbjahres ergibt
 * sich gewichtet aus den Unterfächern (siehe berechneGesamtnoten in
 * src/noten-service.js). Lehrkräfte werden je Fach bzw. Unterfach für
 * bestimmte Halbjahre zugeordnet (fach_zuweisungen.halbjahre); das Fach selbst
 * kann nur in Halbjahren ohne Unterfächer direkt Lehrkräfte haben.
 */

import { getDb } from './db.js';
import { klassenLaufzeit, fachHalbjahrNummern, halbjahrNr, halbjahrText, istHalbjahrVergangen, jetzt } from './klassen-jahre.js';

export const UNTERFACH_TRENNER = ' › ';

const DATEN_TABELLEN = ['klausuren', 'unterrichtsleistungen', 'unterricht_termine', 'halbjahr_endnoten'];

/** Unterfächer eines Fachs (alle Halbjahre), in Anlagereihenfolge. */
export function ladeUnterfaecher(parentId) {
  return getDb().prepare('SELECT * FROM faecher WHERE parent_fach_id = ? ORDER BY id').all(parentId);
}

/** Unterfächer, die im Halbjahr (Nummer) gelten. */
export function unterfaecherImHalbjahr(parent, nr, laufzeit = klassenLaufzeit(parent.klasse_id)) {
  return ladeUnterfaecher(parent.id).filter((u) => fachHalbjahrNummern(u, laufzeit).includes(nr));
}

/** Hat das Fach in diesem Halbjahr Unterfächer (setzt es sich also aus ihnen zusammen)? */
export function hatUnterfaecherImHalbjahr(parent, halbjahrText_) {
  const nr = halbjahrNr(halbjahrText_);
  if (nr === null) return false;
  return unterfaecherImHalbjahr(parent, nr).length > 0;
}

/** Halbjahr-Nummern des Fachs, in denen es KEINE Unterfächer hat (dort darf es direkt Lehrkräfte haben). */
export function halbjahreOhneUnterfaecher(fach, laufzeit = klassenLaufzeit(fach.klasse_id)) {
  const eigene = fachHalbjahrNummern(fach, laufzeit);
  // SPA-Fächer: die Komponenten-Unterfächer ersetzen die Lehrkraft des Fachs nicht (sie füttern nur Komponenten).
  if (fach.parent_fach_id || fach.spa_fach_key) return eigene;
  const belegt = new Set();
  for (const u of ladeUnterfaecher(fach.id)) for (const n of fachHalbjahrNummern(u, laufzeit)) belegt.add(n);
  return eigene.filter((n) => !belegt.has(n));
}

/** Halbjahr-Nummern, in denen für das Fach schon Leistungen oder Endnoten eingetragen sind. */
export function halbjahreMitDaten(fachId) {
  const db = getDb();
  const belegt = new Set();
  for (const tabelle of DATEN_TABELLEN) {
    for (const r of db.prepare(`SELECT DISTINCT halbjahr FROM ${tabelle} WHERE fach_id = ?`).all(fachId)) {
      const nr = halbjahrNr(r.halbjahr);
      if (nr) belegt.add(nr);
    }
  }
  return belegt;
}

/** Speicherform: alle Halbjahre der Klasse = NULL, sonst JSON-Array. */
function alsHalbjahreJson(nummern, laufzeit) {
  const sortiert = [...new Set(nummern)].sort((a, b) => a - b);
  return sortiert.length === laufzeit.anzahlHalbjahre ? null : JSON.stringify(sortiert);
}

function halbjahrNummernAusJson(roh) {
  if (!roh) return null;
  try {
    const arr = JSON.parse(roh);
    return Array.isArray(arr) ? arr.filter((n) => Number.isInteger(n)) : null;
  } catch {
    return null;
  }
}

/**
 * Legt ein Unterfach an. `nummern` = Halbjahre, in denen es gilt (null = alle
 * Halbjahre des Elternfachs).
 * @returns {{ok: true, id: number} | {ok: false, fehler: string}}
 */
export function legeUnterfachAn(parent, name, nummern) {
  const db = getDb();
  if (parent.parent_fach_id) return { ok: false, fehler: 'Ein Unterfach kann keine eigenen Unterfächer haben.' };
  if (parent.spa_fach_key) return { ok: false, fehler: 'SPA-Fächer haben vorgegebene Komponenten als Unterfächer -- sie lassen sich nicht ergänzen.' };
  const kurz = String(name || '').trim().slice(0, 60);
  if (!kurz) return { ok: false, fehler: 'Bitte einen Namen für das Unterfach angeben.' };
  const laufzeit = klassenLaufzeit(parent.klasse_id);
  const elternHj = fachHalbjahrNummern(parent, laufzeit);
  const gewaehlt = (nummern ?? elternHj).filter((n) => elternHj.includes(n));
  if (!gewaehlt.length) return { ok: false, fehler: 'Bitte mindestens ein Halbjahr des Fachs auswählen.' };
  const mitDaten = halbjahreMitDaten(parent.id);
  const konflikt = gewaehlt.filter((n) => mitDaten.has(n));
  if (konflikt.length) {
    return { ok: false, fehler: `Im ${konflikt.map((n) => `${n}. Halbjahr`).join(', ')} sind für das Fach schon Leistungen oder Endnoten eingetragen -- dort kann es nicht auf Unterfächer umgestellt werden.` };
  }
  let neueId;
  try {
    const tx = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO faecher (klasse_id, name, parent_fach_id, kurzname, halbjahre)
        VALUES (?, ?, ?, ?, ?)
      `).run(parent.klasse_id, `${parent.name}${UNTERFACH_TRENNER}${kurz}`, parent.id, kurz, alsHalbjahreJson(gewaehlt, laufzeit));
      neueId = info.lastInsertRowid;
      // Teilnehmerliste vom Elternfach übernehmen.
      db.prepare('INSERT OR IGNORE INTO fach_teilnehmer (fach_id, schueler_id) SELECT ?, schueler_id FROM fach_teilnehmer WHERE fach_id = ?').run(neueId, parent.id);
      // In diesen Halbjahren setzt sich das Elternfach jetzt aus Unterfächern zusammen: direkte Zuordnungen dort entfallen.
      for (const z of db.prepare('SELECT id, halbjahre FROM fach_zuweisungen WHERE fach_id = ?').all(parent.id)) {
        const aktuell = halbjahrNummernAusJson(z.halbjahre) ?? elternHj;
        const rest = aktuell.filter((n) => !gewaehlt.includes(n));
        if (rest.length === aktuell.length) continue;
        if (!rest.length) db.prepare('DELETE FROM fach_zuweisungen WHERE id = ?').run(z.id);
        else db.prepare('UPDATE fach_zuweisungen SET halbjahre = ? WHERE id = ?').run(JSON.stringify(rest), z.id);
      }
    });
    tx();
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return { ok: false, fehler: 'Dieses Unterfach gibt es schon.' };
    throw e;
  }
  return { ok: true, id: Number(neueId) };
}

/**
 * Halbjahre eines Fachs/Unterfachs ändern. Ein Unterfach darf nur Halbjahre
 * seines Elternfachs haben; beim Elternfach fallen Halbjahre auch bei den
 * Unterfächern weg. Halbjahre mit eingetragenen Leistungen/Endnoten dürfen
 * nicht entfernt werden.
 * @returns {{ok: true} | {ok: false, fehler: string}}
 */
export function setzeFachHalbjahre(fach, nummern) {
  const db = getDb();
  if (fach.spa_komponente) return { ok: false, fehler: 'Die Halbjahre einer SPA-Komponente werden über die Komponenten-Schalter des Fachs gesetzt.' };
  const laufzeit = klassenLaufzeit(fach.klasse_id);
  const alle = laufzeit.halbjahre.map((_, i) => i + 1);
  let gewaehlt = (nummern ?? alle).filter((n) => alle.includes(n));
  if (fach.parent_fach_id) {
    const eltern = db.prepare('SELECT * FROM faecher WHERE id = ?').get(fach.parent_fach_id);
    const erlaubt = fachHalbjahrNummern(eltern, laufzeit);
    gewaehlt = gewaehlt.filter((n) => erlaubt.includes(n));
  }
  if (!gewaehlt.length) return { ok: false, fehler: 'Mindestens ein Halbjahr muss ausgewählt sein.' };
  const aktuell = fachHalbjahrNummern(fach, laufzeit);
  const entfernt = aktuell.filter((n) => !gewaehlt.includes(n));
  const betroffene = [fach, ...(fach.parent_fach_id ? [] : ladeUnterfaecher(fach.id))];
  const blockiert = new Set();
  for (const f of betroffene) {
    const fHj = fachHalbjahrNummern(f, laufzeit);
    const faelltWeg = f.id === fach.id ? entfernt : fHj.filter((n) => !gewaehlt.includes(n));
    const mitDaten = halbjahreMitDaten(f.id);
    for (const n of faelltWeg) if (mitDaten.has(n)) blockiert.add(n);
  }
  if (blockiert.size) {
    return { ok: false, fehler: `In ${[...blockiert].sort((a, b) => a - b).map((n) => `${n}. Halbjahr`).join(', ')} sind schon Leistungen oder Endnoten eingetragen -- das Fach muss dort gelten.` };
  }
  const tx = db.transaction(() => {
    db.prepare('UPDATE faecher SET halbjahre = ? WHERE id = ?').run(alsHalbjahreJson(gewaehlt, laufzeit), fach.id);
    if (!fach.parent_fach_id) {
      for (const u of ladeUnterfaecher(fach.id)) {
        const rest = fachHalbjahrNummern(u, laufzeit).filter((n) => gewaehlt.includes(n));
        if (!rest.length) db.prepare('DELETE FROM faecher WHERE id = ?').run(u.id);
        else db.prepare('UPDATE faecher SET halbjahre = ? WHERE id = ?').run(alsHalbjahreJson(rest, laufzeit), u.id);
      }
    }
    // Zuordnungen auf die verbleibenden Halbjahre begrenzen.
    for (const f of [fach, ...(fach.parent_fach_id ? [] : ladeUnterfaecher(fach.id))]) {
      const fHj = db.prepare('SELECT * FROM faecher WHERE id = ?').get(f.id);
      if (!fHj) continue;
      const hj = fachHalbjahrNummern(fHj, laufzeit);
      for (const z of db.prepare('SELECT id, halbjahre FROM fach_zuweisungen WHERE fach_id = ?').all(f.id)) {
        const roh = halbjahrNummernAusJson(z.halbjahre);
        if (!roh) continue;
        const rest = roh.filter((n) => hj.includes(n));
        if (rest.length === roh.length) continue;
        if (!rest.length) db.prepare('DELETE FROM fach_zuweisungen WHERE id = ?').run(z.id);
        else db.prepare('UPDATE fach_zuweisungen SET halbjahre = ? WHERE id = ?').run(JSON.stringify(rest), z.id);
      }
    }
  });
  tx();
  return { ok: true };
}

/**
 * Ist dem Fach im Halbjahr (Nummer) mindestens eine Lehrkraft zugeordnet -- direkt oder über eines
 * seiner Unterfächer? Ohne Lehrkraft trägt die Klassenleitung die Noten selbst ein.
 */
export function fachHatLehrkraftImHalbjahr(fach, nr, laufzeit = klassenLaufzeit(fach.klasse_id)) {
  const db = getDb();
  const faecher = [fach, ...(fach.parent_fach_id ? [] : ladeUnterfaecher(fach.id))];
  return faecher.some((f) => db.prepare('SELECT * FROM fach_zuweisungen WHERE fach_id = ?').all(f.id)
    .some((z) => zuweisungsHalbjahre(z, f, laufzeit).includes(nr)));
}

/**
 * Namen der Lehrkräfte eines Fachs (alphabetisch): direkt zugeordnete und die der Unterfächer (dann mit
 * "(Unterfach)"). Mit `nr` nur die Zuordnungen, die in diesem Halbjahr gelten, sonst alle.
 */
export function lehrkraefteDesFachs(fach, nr = null, laufzeit = klassenLaufzeit(fach.klasse_id)) {
  const db = getDb();
  const namen = new Set();
  const sammle = (f, zusatz) => {
    for (const z of db.prepare(`
      SELECT fz.*, u.display_name, u.username FROM fach_zuweisungen fz JOIN users u ON u.id = fz.user_id WHERE fz.fach_id = ?
    `).all(f.id)) {
      if (nr !== null && !zuweisungsHalbjahre(z, f, laufzeit).includes(nr)) continue;
      namen.add(`${z.display_name || z.username}${zusatz}`);
    }
  };
  sammle(fach, '');
  if (!fach.parent_fach_id) for (const u of ladeUnterfaecher(fach.id)) sammle(u, ` (${u.kurzname || u.name})`);
  return [...namen].sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }));
}

/** Halbjahre, in denen eine Zuordnung (Zeile aus fach_zuweisungen) gilt, als Nummern. */
export function zuweisungsHalbjahre(zuweisung, fach, laufzeit = klassenLaufzeit(fach.klasse_id)) {
  const fachHj = fachHalbjahrNummern(fach, laufzeit);
  const roh = halbjahrNummernAusJson(zuweisung.halbjahre);
  return roh ? fachHj.filter((n) => roh.includes(n)) : fachHj;
}

/**
 * Ordnet eine Lehrkraft einem Fach bzw. Unterfach für Halbjahre zu (null =
 * alle erlaubten). Ein Fach mit Unterfächern kann nur in Halbjahren OHNE
 * Unterfächer direkt Lehrkräfte haben. Eine bestehende Zuordnung wird um die
 * gewählten Halbjahre erweitert.
 * @returns {{ok: true, id: number} | {ok: false, fehler: string}}
 */
export function weiseLehrkraftZu(fach, userId, nummern) {
  const db = getDb();
  const laufzeit = klassenLaufzeit(fach.klasse_id);
  const erlaubt = halbjahreOhneUnterfaecher(fach, laufzeit);
  if (!erlaubt.length) return { ok: false, fehler: 'Dieses Fach setzt sich in allen seinen Halbjahren aus Unterfächern zusammen -- bitte den Unterfächern Lehrkräfte zuordnen.' };
  const gewaehlt = (nummern ?? erlaubt).filter((n) => erlaubt.includes(n));
  if (!gewaehlt.length) return { ok: false, fehler: 'Bitte mindestens ein passendes Halbjahr auswählen.' };
  const bestehend = db.prepare('SELECT id, halbjahre FROM fach_zuweisungen WHERE user_id = ? AND fach_id = ?').get(userId, fach.id);
  const fachAlle = fachHalbjahrNummern(fach, laufzeit);
  const speichern = (liste) => {
    const sortiert = [...new Set(liste)].sort((a, b) => a - b);
    return sortiert.length === fachAlle.length && !ladeUnterfaecher(fach.id).length ? null : JSON.stringify(sortiert);
  };
  if (bestehend) {
    const vorher = zuweisungsHalbjahre(bestehend, fach, laufzeit);
    const neu = [...new Set([...vorher, ...gewaehlt])];
    if (neu.length === vorher.length) return { ok: false, fehler: 'Diese Zuordnung besteht bereits.' };
    db.prepare('UPDATE fach_zuweisungen SET halbjahre = ? WHERE id = ?').run(speichern(neu), bestehend.id);
    return { ok: true, id: bestehend.id };
  }
  const info = db.prepare('INSERT INTO fach_zuweisungen (user_id, fach_id, halbjahre) VALUES (?, ?, ?)').run(userId, fach.id, speichern(gewaehlt));
  return { ok: true, id: Number(info.lastInsertRowid) };
}

/** Ersetzt die Halbjahre einer bestehenden Zuordnung. */
export function setzeZuweisungHalbjahre(zuweisungId, nummern) {
  const db = getDb();
  const z = db.prepare('SELECT * FROM fach_zuweisungen WHERE id = ?').get(zuweisungId);
  if (!z) return { ok: false, fehler: 'Zuordnung nicht gefunden.' };
  const fach = db.prepare('SELECT * FROM faecher WHERE id = ?').get(z.fach_id);
  const laufzeit = klassenLaufzeit(fach.klasse_id);
  const erlaubt = halbjahreOhneUnterfaecher(fach, laufzeit);
  const gewaehlt = [...new Set(nummern)].filter((n) => erlaubt.includes(n)).sort((a, b) => a - b);
  if (!gewaehlt.length) return { ok: false, fehler: 'Bitte mindestens ein passendes Halbjahr auswählen.' };
  const fachAlle = fachHalbjahrNummern(fach, laufzeit);
  const wert = gewaehlt.length === fachAlle.length && !ladeUnterfaecher(fach.id).length ? null : JSON.stringify(gewaehlt);
  db.prepare('UPDATE fach_zuweisungen SET halbjahre = ? WHERE id = ?').run(wert, zuweisungId);
  return { ok: true };
}

/**
 * Alle Zuordnungen einer Klasse für die Anzeige: je Fach/Unterfach die
 * Lehrkräfte samt ihren Halbjahren (Nummern).
 * @returns {Map<number, Array<{id: number, user_id: number, name: string, halbjahre: number[], alle: boolean}>>} fach_id -> Lehrkräfte
 */
export function ladeZuweisungenDerKlasse(klasseId, faecher, laufzeit = klassenLaufzeit(klasseId)) {
  const db = getDb();
  const proFach = new Map(faecher.map((f) => [f.id, []]));
  const rows = db.prepare(`
    SELECT fz.id, fz.user_id, fz.fach_id, fz.halbjahre, fz.selbst_eingetragen, u.display_name, u.username
    FROM fach_zuweisungen fz JOIN faecher f ON f.id = fz.fach_id JOIN users u ON u.id = fz.user_id
    WHERE f.klasse_id = ? ORDER BY u.display_name, u.username
  `).all(klasseId);
  const fachById = new Map(faecher.map((f) => [f.id, f]));
  for (const r of rows) {
    const fach = fachById.get(r.fach_id);
    if (!fach) continue;
    proFach.get(fach.id).push({
      id: r.id, user_id: r.user_id, name: r.display_name || r.username,
      halbjahre: zuweisungsHalbjahre(r, fach, laufzeit), alle: !r.halbjahre, selbst: Boolean(r.selbst_eingetragen),
    });
  }
  return proFach;
}

/**
 * Halbjahre (Nummern), in denen sich eine Lehrkraft selbst für das Fach eintragen kann: Halbjahre des Fachs, in denen
 * (noch) niemand eingetragen ist und die nicht schon vorbei sind. Ein Fach, das sich aus Unterfächern zusammensetzt,
 * (auch nur in einem Teil der Halbjahre, ebenso SPA-Fächer mit Komponenten) hat selbst keine freien Halbjahre -- die
 * Unterfächer sind selbst Fächer. Kurse sind ausgenommen.
 */
export function freieHalbjahre(fach, laufzeit = klassenLaufzeit(fach.klasse_id), heute = jetzt()) {
  if (fach.ist_kurs) return [];
  // Hat das Fach Unterfächer (auch SPA-Komponenten), tragen sich Lehrkräfte dort ein -- nicht beim Fach selbst.
  if (!fach.parent_fach_id && ladeUnterfaecher(fach.id).length) return [];
  const belegt = new Set();
  for (const z of getDb().prepare('SELECT * FROM fach_zuweisungen WHERE fach_id = ?').all(fach.id)) {
    for (const n of zuweisungsHalbjahre(z, fach, laufzeit)) belegt.add(n);
  }
  return halbjahreOhneUnterfaecher(fach, laufzeit).filter((n) => !belegt.has(n) && !istHalbjahrVergangen(laufzeit, n, heute));
}

/**
 * Die Lehrkraft trägt sich für alle freien Halbjahre des Fachs ein (auch wenn sie das Fach nicht angelegt hat).
 * Eine dabei NEU entstehende Zuordnung gilt als selbst eingetragen und darf von ihr wieder aufgehoben werden;
 * eine schon bestehende (z. B. von der Klassenleitung vergebene) wird nur erweitert und bleibt Sache der Klassenleitung.
 * @returns {{ok: true, halbjahre: number[]} | {ok: false, fehler: string}}
 */
export function traegeMichEin(fach, userId) {
  const db = getDb();
  const frei = freieHalbjahre(fach);
  if (!frei.length) return { ok: false, fehler: 'Für dieses Fach ist keine Lehrkraft-Stelle frei -- bitte die Klassenleitung fragen.' };
  const vorher = db.prepare('SELECT id FROM fach_zuweisungen WHERE user_id = ? AND fach_id = ?').get(userId, fach.id);
  const res = weiseLehrkraftZu(fach, userId, frei);
  if (!res.ok) return res;
  if (!vorher) db.prepare('UPDATE fach_zuweisungen SET selbst_eingetragen = 1 WHERE id = ?').run(res.id);
  return { ok: true, halbjahre: frei };
}

/** Hebt eine selbst vorgenommene Eintragung wieder auf -- das Fach ist danach wieder frei. Nur für die eigene Zuordnung. */
export function traegeMichAus(zuweisungId, userId) {
  return getDb().prepare('DELETE FROM fach_zuweisungen WHERE id = ? AND user_id = ? AND selbst_eingetragen = 1').run(zuweisungId, userId).changes > 0;
}
