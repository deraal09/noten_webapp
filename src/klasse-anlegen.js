/**
 * Klasse anlegen (gemeinsam für die Oberfläche und die API): Einschulung/Abschluss (Laufzeit), SPA-Bildungsgang samt Fächervorgabe.
 * Prüfungen, die zur Oberfläche bzw. API gehören (Berechtigung, Meldungen), machen die Aufrufer.
 */

import { getDb } from './db.js';
import { DEFAULT_NS_CSV } from './grade-calc.js';
import { parseSchuljahr } from './schuljahr-utils.js';
import { parseJahrEingabe, MAX_SCHULJAHRE } from './klassen-jahre.js';
import { ladeSpaVorlageInKlasse } from './spa-vorlagen.js';

export const KLASSEN_NOTENSCHLUESSEL = ['IHK', 'BG', 'SPA'];

/**
 * Laufzeit: Einschulung (Standard: gewähltes Schuljahr) und Abschluss (Standard: leer = SPA 2, sonst 3 Jahre; `anzahlJahre` hat Vorrang).
 * Ein unsinniger Abschluss wird verworfen (= Standard).
 */
export function berechneLaufzeit({ schuljahrBezeichnung, einschulungJahr, anzahlJahre, abschlussJahr }) {
  const heimat = parseSchuljahr(schuljahrBezeichnung)?.startJahr ?? null;
  const einschulung = parseJahrEingabe(einschulungJahr) ?? heimat;
  const dauer = parseInt(anzahlJahre, 10);
  let abschluss = Number.isFinite(dauer) && dauer >= 1 && einschulung !== null ? einschulung + dauer - 1 : parseJahrEingabe(abschlussJahr);
  if (abschluss !== null && einschulung !== null && (abschluss < einschulung || abschluss >= einschulung + MAX_SCHULJAHRE)) abschluss = null;
  return { einschulung, abschluss };
}

/**
 * Legt die Klasse an. `spaVorlage`: 'standard', 'keine' oder die ID einer eigenen Vorlage (nur bei SPA).
 * @returns {{ok: true, klasseId: number, einschulung: number|null, abschluss: number|null} | {ok: false, doppelt: number|null}}
 */
export function legeKlasseAn({ userId, schuljahrId, name, notenschluessel, spaBildungsgang = null, spaVorlage = 'standard', offenFuerBeitritt = false, einschulungJahr, anzahlJahre, abschlussJahr }) {
  const db = getDb();
  const sj = db.prepare('SELECT bezeichnung FROM schuljahre WHERE id = ?').get(schuljahrId);
  const { einschulung, abschluss } = berechneLaufzeit({ schuljahrBezeichnung: sj?.bezeichnung, einschulungJahr, anzahlJahre, abschlussJahr });
  try {
    const info = db.prepare(`
      INSERT INTO klassen (schuljahr_id, name, notenschluessel, notenschluessel_csv, created_by_id, offen_fuer_beitritt, spa_bildungsgang, einschulung_jahr, abschluss_jahr)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(schuljahrId, name, notenschluessel, DEFAULT_NS_CSV[notenschluessel] || '', userId, offenFuerBeitritt ? 1 : 0, spaBildungsgang, einschulung, abschluss);
    const klasseId = Number(info.lastInsertRowid);
    if (notenschluessel === 'SPA') ladeSpaVorlageInKlasse({ id: klasseId, notenschluessel: 'SPA', spa_bildungsgang: spaBildungsgang }, spaVorlage, userId);
    return { ok: true, klasseId, einschulung, abschluss };
  } catch {
    // Name in diesem Schuljahr bereits vergeben
    const bestehend = db.prepare('SELECT id FROM klassen WHERE schuljahr_id = ? AND name = ?').get(schuljahrId, name);
    return { ok: false, doppelt: bestehend?.id ?? null };
  }
}
