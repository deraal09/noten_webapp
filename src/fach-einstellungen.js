/**
 * Fach einstellen (⚙ auf der Klassenseite, IHK/BG): Name, Halbjahre, Unterfächer als Text und Verrechnung der
 * Halbjahre an einer Stelle. Ein Unterfach pro Zeile: "Name; Gewicht; Halbjahre", z. B.
 *     Algebra; 3; 3-4
 *     Geometrie; 1; alle
 * (Gewicht in der Fachnote, leer = 1; Halbjahre als Liste/Bereich, leer oder "alle" = alle Halbjahre des Fachs).
 */

import { getDb } from './db.js';
import { klassenLaufzeit, fachHalbjahrNummern } from './klassen-jahre.js';
import {
  ladeUnterfaecher, legeUnterfachAn, setzeFachHalbjahre, halbjahreMitDaten, UNTERFACH_TRENNER,
} from './unterfaecher.js';

const gewichtText = (g) => String(g).replace('.', ',');

/** "3-4", "1, 3", "alle" aus Halbjahr-Nummern (zusammenhängende Bereiche werden mit Bindestrich geschrieben). */
export function halbjahreAlsText(nummern, alle) {
  if (!nummern.length || nummern.length === alle.length) return 'alle';
  const teile = [];
  for (let i = 0; i < nummern.length; i++) {
    let j = i;
    while (j + 1 < nummern.length && nummern[j + 1] === nummern[j] + 1) j++;
    teile.push(j - i >= 2 ? `${nummern[i]}-${nummern[j]}` : nummern.slice(i, j + 1).join(', '));
    i = j;
  }
  return teile.join(', ');
}

/** Die Unterfächer eines Fachs als Text für das Textfeld. */
export function unterfaecherAlsText(fach) {
  const laufzeit = klassenLaufzeit(fach.klasse_id);
  const alle = fachHalbjahrNummern(fach, laufzeit);
  return ladeUnterfaecher(fach.id)
    .map((u) => `${u.kurzname || u.name}; ${u.gewicht > 0 ? gewichtText(u.gewicht) : '1'}; ${halbjahreAlsText(fachHalbjahrNummern(u, laufzeit), alle)}`)
    .join('\n');
}

/** "3-4", "1,3", "1 2 5-6", "alle" -> Nummern (null = alle); wirft einen Fehlertext bei Unsinn. */
function parseHalbjahre(roh, laufzeit) {
  const t = String(roh ?? '').trim().toLowerCase();
  if (!t || t === 'alle') return null;
  const nummern = new Set();
  for (const teil of t.split(/[,\s]+/).filter(Boolean)) {
    const m = teil.match(/^(\d+)(?:\s*[-–]\s*(\d+))?\.?$/);
    if (!m) throw new Error(`Halbjahre „${roh.trim()}“ nicht verständlich (z. B. 3-4 oder 1, 3 oder alle)`);
    const von = Number(m[1]);
    const bis = m[2] ? Number(m[2]) : von;
    if (von < 1 || bis < von || bis > laufzeit.anzahlHalbjahre) throw new Error(`Halbjahr „${teil}“ gibt es in dieser Klasse nicht (1 bis ${laufzeit.anzahlHalbjahre})`);
    for (let n = von; n <= bis; n++) nummern.add(n);
  }
  return [...nummern].sort((a, b) => a - b);
}

/**
 * Text -> Unterfächer. @returns {{ok: true, eintraege: Array<{name: string, gewicht: number|null, nummern: number[]|null}>} | {ok: false, fehler: string}}
 */
export function parseUnterfaecher(text, laufzeit) {
  const eintraege = [];
  const gesehen = new Set();
  const zeilen = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < zeilen.length; i++) {
    const zeile = zeilen[i].trim();
    if (!zeile) continue;
    const [nameRoh, gewichtRoh = '', halbjahreRoh = ''] = zeile.split(/[;|]/).map((x) => x.trim());
    const name = nameRoh.slice(0, 60);
    const fehler = (grund) => ({ ok: false, fehler: `Unterfächer, Zeile ${i + 1} („${zeile}“): ${grund}.` });
    if (!name) return fehler('Name fehlt');
    if (gesehen.has(name.toLowerCase())) return fehler('dieses Unterfach steht schon in der Liste');
    gesehen.add(name.toLowerCase());
    let gewicht = null;
    if (gewichtRoh !== '') {
      gewicht = Number(gewichtRoh.replace(',', '.'));
      if (!(gewicht > 0 && gewicht <= 100)) return fehler('Gewicht muss eine Zahl über 0 bis 100 sein (leer = 1)');
    }
    let nummern;
    try { nummern = parseHalbjahre(halbjahreRoh, laufzeit); } catch (e) { return fehler(e.message); }
    eintraege.push({ name, gewicht, nummern });
  }
  return { ok: true, eintraege };
}

/**
 * Speichert Name, Halbjahre und Unterfächer eines Fachs (IHK/BG, oberste Ebene). Die Verrechnung speichert die Route.
 * Nicht Gespeichertes (z. B. Halbjahre mit schon eingetragenen Leistungen) wird in `hinweise` gemeldet; der Rest gilt.
 * @returns {{ok: true, hinweise: string[]} | {ok: false, fehler: string}}
 */
export function speichereFachEinstellungen(fach, { name, nummern, unterfaecherText }) {
  const db = getDb();
  const laufzeit = klassenLaufzeit(fach.klasse_id);
  const titel = String(name ?? '').trim().slice(0, 100);
  if (!titel) return { ok: false, fehler: 'Bitte einen Namen angeben.' };
  const geparst = parseUnterfaecher(unterfaecherText, laufzeit);
  if (!geparst.ok) return geparst;
  if (db.prepare('SELECT 1 FROM faecher WHERE klasse_id = ? AND name = ? AND id != ?').get(fach.klasse_id, titel, fach.id)) {
    return { ok: false, fehler: `Ein Fach „${titel}“ gibt es in dieser Klasse schon.` };
  }
  const hinweise = [];
  // Halbjahre zuerst: scheitert es (Leistungen in wegfallenden Halbjahren), bleibt alles unverändert.
  const hj = setzeFachHalbjahre(fach, nummern);
  if (!hj.ok) return hj;
  db.transaction(() => {
    db.prepare('UPDATE faecher SET name = ? WHERE id = ?').run(titel, fach.id);
    for (const u of ladeUnterfaecher(fach.id)) {
      db.prepare('UPDATE faecher SET name = ? WHERE id = ?').run(`${titel}${UNTERFACH_TRENNER}${u.kurzname || u.name}`, u.id);
    }
  })();
  const aktuellesFach = db.prepare('SELECT * FROM faecher WHERE id = ?').get(fach.id);
  const vorhanden = new Map(ladeUnterfaecher(fach.id).map((u) => [(u.kurzname || u.name).toLowerCase(), u]));
  const gewuenscht = new Set(geparst.eintraege.map((e) => e.name.toLowerCase()));

  // Entfernte Zeilen: Unterfach löschen -- nur, solange nichts darin eingetragen ist.
  for (const [schluessel, u] of vorhanden) {
    if (gewuenscht.has(schluessel)) continue;
    if (halbjahreMitDaten(u.id).size) {
      hinweise.push(`„${u.kurzname || u.name}“ enthält schon Leistungen oder Endnoten und wurde nicht gelöscht.`);
      continue;
    }
    db.prepare('DELETE FROM faecher WHERE id = ?').run(u.id);
  }
  for (const e of geparst.eintraege) {
    const bestehend = vorhanden.get(e.name.toLowerCase());
    if (bestehend) {
      db.prepare('UPDATE faecher SET gewicht = ? WHERE id = ?').run(e.gewicht, bestehend.id);
      const ziel = e.nummern ?? fachHalbjahrNummern(aktuellesFach, laufzeit);
      const jetzt = fachHalbjahrNummern(db.prepare('SELECT * FROM faecher WHERE id = ?').get(bestehend.id), laufzeit);
      if (ziel.join() !== jetzt.join()) {
        const r = setzeFachHalbjahre(db.prepare('SELECT * FROM faecher WHERE id = ?').get(bestehend.id), ziel);
        if (!r.ok) hinweise.push(`„${e.name}“: ${r.fehler}`);
      }
      continue;
    }
    const neu = legeUnterfachAn(aktuellesFach, e.name, e.nummern);
    if (!neu.ok) { hinweise.push(`„${e.name}“: ${neu.fehler}`); continue; }
    if (e.gewicht) db.prepare('UPDATE faecher SET gewicht = ? WHERE id = ?').run(e.gewicht, neu.id);
  }
  return { ok: true, hinweise };
}
