/**
 * Fächer-Vorlagen: Die Fächerstruktur einer Klasse (Fächer, Unterfächer,
 * Halbjahre, Unterfach-Gewichte, Verrechnung) lässt sich unter einem Namen
 * speichern und bei jeder neuen Klasse mit demselben Notenschlüssel wieder
 * importieren. Die Lehrkraftzuordnung gehört bewusst NICHT zur Vorlage -- sie
 * wird bei jeder Klasse neu vergeben (der Import legt alle Fächer ohne Lehrkraft
 * an). Vorlagen gehören der Lehrkraft, die
 * sie gespeichert hat.
 */

import { getDb } from './db.js';
import { klassenLaufzeit, fachHalbjahrNummern } from './klassen-jahre.js';
import { legeUnterfachAn, ladeUnterfaecher } from './unterfaecher.js';
import { seedeTeilnehmerAusKlasse } from './fach-teilnehmer.js';
import { sortiereNachName } from './format.js';

/** Vorlagen einer Lehrkraft für einen Notenschlüssel, je mit den Namen ihrer Fächer. */
export function ladeVorlagen(userId, notenschluessel) {
  const db = getDb();
  const vorlagen = db.prepare('SELECT * FROM fach_vorlagen WHERE user_id = ? AND notenschluessel = ?').all(userId, notenschluessel);
  return sortiereNachName(vorlagen).map((v) => {
    const eintraege = db.prepare('SELECT * FROM fach_vorlagen_faecher WHERE vorlage_id = ? ORDER BY id').all(v.id);
    const faecher = eintraege.filter((e) => !e.parent_id);
    return {
      ...v,
      faecher: faecher.map((f) => ({ name: f.name, unterfaecher: eintraege.filter((e) => e.parent_id === f.id).map((e) => e.name) })),
    };
  });
}

/** Fächer einer Klasse, die sich als Vorlage speichern lassen (keine SPA-Fächer, keine Kurse/Komponenten). */
export function speicherbareFaecher(klasseId) {
  return getDb().prepare(`
    SELECT * FROM faecher WHERE klasse_id = ? AND parent_fach_id IS NULL AND spa_fach_key IS NULL AND ist_kurs = 0
  `).all(klasseId);
}

/**
 * Speichert die gewählten Fächer (ids; leer = alle) der Klasse als Vorlage. Eine gleichnamige
 * eigene Vorlage desselben Notenschlüssels wird ersetzt.
 * @returns {{ok: true, id: number, anzahl: number} | {ok: false, fehler: string}}
 */
export function speichereVorlage(userId, klasse, name, fachIds) {
  const db = getDb();
  const titel = String(name || '').trim().slice(0, 100);
  if (!titel) return { ok: false, fehler: 'Bitte einen Namen für die Vorlage angeben.' };
  const moegliche = speicherbareFaecher(klasse.id);
  const gewaehlt = fachIds?.length ? moegliche.filter((f) => fachIds.includes(f.id)) : moegliche;
  if (!gewaehlt.length) return { ok: false, fehler: 'Es gibt keine Fächer, die als Vorlage gespeichert werden können.' };
  let neueId;
  db.transaction(() => {
    db.prepare('DELETE FROM fach_vorlagen WHERE user_id = ? AND notenschluessel = ? AND name = ?').run(userId, klasse.notenschluessel, titel);
    neueId = Number(db.prepare('INSERT INTO fach_vorlagen (user_id, name, notenschluessel) VALUES (?, ?, ?)').run(userId, titel, klasse.notenschluessel).lastInsertRowid);
    const insert = db.prepare('INSERT INTO fach_vorlagen_faecher (vorlage_id, parent_id, name, halbjahre, gewicht, verrechnung) VALUES (?, ?, ?, ?, ?, ?)');
    for (const f of gewaehlt) {
      const id = Number(insert.run(neueId, null, f.name, f.halbjahre, null, f.verrechnung).lastInsertRowid);
      for (const u of ladeUnterfaecher(f.id)) {
        if (u.spa_komponente) continue;
        insert.run(neueId, id, u.kurzname || u.name, u.halbjahre, u.gewicht, null);
      }
    }
  })();
  return { ok: true, id: neueId, anzahl: gewaehlt.length };
}

/** Nummern aus der Speicherform; null = alle. Nummern jenseits der Laufzeit der Zielklasse entfallen. */
function nummernFuerKlasse(roh, laufzeit) {
  if (!roh) return null;
  let arr;
  try { arr = JSON.parse(roh); } catch { return null; }
  const passend = (Array.isArray(arr) ? arr : []).filter((n) => Number.isInteger(n) && n >= 1 && n <= laufzeit.anzahlHalbjahre);
  return passend.length && passend.length < laufzeit.anzahlHalbjahre ? passend : null;
}

/**
 * Legt die Fächer einer Vorlage in der Klasse an (bestehende Fächer gleichen Namens bleiben
 * unberührt). Es wird niemand zugeordnet -- alle Fächer starten ohne Lehrkraft.
 * @param {{mitVerrechnung: boolean}} optionen Verrechnung nur übernehmen, wenn die Person sie setzen darf
 * @returns {{ok: true, angelegt: string[], uebersprungen: string[]} | {ok: false, fehler: string}}
 */
export function importiereVorlage(vorlageId, userId, klasse, { mitVerrechnung = false } = {}) {
  const db = getDb();
  const vorlage = db.prepare('SELECT * FROM fach_vorlagen WHERE id = ? AND user_id = ?').get(vorlageId, userId);
  if (!vorlage) return { ok: false, fehler: 'Vorlage nicht gefunden.' };
  if (vorlage.notenschluessel !== klasse.notenschluessel) return { ok: false, fehler: 'Die Vorlage gehört zu einem anderen Notenschlüssel.' };
  const laufzeit = klassenLaufzeit(klasse.id);
  const eintraege = db.prepare('SELECT * FROM fach_vorlagen_faecher WHERE vorlage_id = ? ORDER BY id').all(vorlage.id);
  const angelegt = [];
  const uebersprungen = [];
  db.transaction(() => {
    for (const e of eintraege.filter((x) => !x.parent_id)) {
      if (db.prepare('SELECT 1 FROM faecher WHERE klasse_id = ? AND name = ?').get(klasse.id, e.name)) {
        uebersprungen.push(e.name);
        continue;
      }
      const nummern = nummernFuerKlasse(e.halbjahre, laufzeit);
      const info = db.prepare('INSERT INTO faecher (klasse_id, name, halbjahre, verrechnung) VALUES (?, ?, ?, ?)')
        .run(klasse.id, e.name, nummern ? JSON.stringify(nummern) : null, mitVerrechnung ? e.verrechnung : null);
      const fachId = Number(info.lastInsertRowid);
      seedeTeilnehmerAusKlasse(fachId, klasse.id);
      angelegt.push(e.name);
      const fach = db.prepare('SELECT * FROM faecher WHERE id = ?').get(fachId);
      for (const u of eintraege.filter((x) => x.parent_id === e.id)) {
        const elternHj = fachHalbjahrNummern(fach, laufzeit);
        const uHj = nummernFuerKlasse(u.halbjahre, laufzeit);
        const erlaubt = (uHj ?? elternHj).filter((n) => elternHj.includes(n));
        const res = legeUnterfachAn(fach, u.name, erlaubt.length ? erlaubt : null);
        if (res.ok && u.gewicht) db.prepare('UPDATE faecher SET gewicht = ? WHERE id = ?').run(u.gewicht, res.id);
      }
    }
  })();
  return { ok: true, angelegt, uebersprungen };
}

/** Löscht eine eigene Vorlage. */
export function loescheVorlage(vorlageId, userId) {
  return getDb().prepare('DELETE FROM fach_vorlagen WHERE id = ? AND user_id = ?').run(vorlageId, userId).changes > 0;
}
