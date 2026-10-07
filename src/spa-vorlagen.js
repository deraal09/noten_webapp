/**
 * SPA-Vorlagen: Die komplette Fächervorgabe einer SPA-Klasse (Fächer, Bewertungsart, Verrechnung,
 * Komponenten und Gewichte je Halbjahr) ist frei editierbar und lässt sich unter einem Namen
 * speichern. Beim Anlegen einer SPA-Klasse kann eine Vorlage geladen werden (oder der Standard,
 * oder keine) -- später lassen sich Vorlagen auch in eine bestehende Klasse laden. Die Klasse
 * bekommt eine KOPIE des Schemas (faecher.spa_schema): spätere Änderungen an der Vorlage
 * ändern bestehende Klassen nicht. Vorlagen gehören der Lehrkraft, die sie angelegt hat.
 */

import { getDb } from './db.js';
import { sortiereNachName } from './format.js';
import {
  BILDUNGSGAENGE, KOMPONENTEN_NAMEN, standardKonfig, pruefeKonfig, istFachSchluessel,
} from './spa-schema.js';
import { seedeSpaFaecher } from './spa-noten-service.js';

const bildungsgangOk = (b) => BILDUNGSGAENGE.some((x) => x.schluessel === b);

/** Eigene Vorlagen (nach Name sortiert), mit Fachnamen für die Anzeige. */
export function ladeSpaVorlagen(userId) {
  const zeilen = getDb().prepare('SELECT * FROM spa_vorlagen WHERE user_id = ?').all(userId);
  return sortiereNachName(zeilen).map((v) => {
    let faecher = [];
    try { faecher = JSON.parse(v.konfig).faecher ?? []; } catch { /* leer */ }
    return { ...v, faecher };
  });
}

/** Eine eigene Vorlage samt Fächern, oder null. */
export function ladeSpaVorlage(id, userId) {
  const v = getDb().prepare('SELECT * FROM spa_vorlagen WHERE id = ? AND user_id = ?').get(id, userId);
  if (!v) return null;
  let faecher = [];
  try { faecher = JSON.parse(v.konfig).faecher ?? []; } catch { /* leer */ }
  return { ...v, faecher };
}

/** @returns {{ok: true, id: number} | {ok: false, fehler: string}} */
export function speichereSpaVorlage(userId, { id = null, name, bildungsgang, faecher }) {
  const titel = String(name ?? '').trim().slice(0, 100);
  if (!titel) return { ok: false, fehler: 'Bitte einen Namen für die Vorlage angeben.' };
  if (!bildungsgangOk(bildungsgang)) return { ok: false, fehler: 'Bitte einen Bildungsgang wählen.' };
  const geprueft = pruefeKonfig(faecher);
  if (!geprueft.ok) return geprueft;
  const db = getDb();
  const doppelt = db.prepare('SELECT id FROM spa_vorlagen WHERE user_id = ? AND name = ? AND id IS NOT ?').get(userId, titel, id);
  if (doppelt) return { ok: false, fehler: `Es gibt schon eine Vorlage „${titel}“.` };
  const konfig = JSON.stringify({ faecher: geprueft.faecher });
  if (id) {
    const res = db.prepare('UPDATE spa_vorlagen SET name = ?, bildungsgang = ?, konfig = ? WHERE id = ? AND user_id = ?').run(titel, bildungsgang, konfig, id, userId);
    return res.changes ? { ok: true, id } : { ok: false, fehler: 'Vorlage nicht gefunden.' };
  }
  const info = db.prepare('INSERT INTO spa_vorlagen (user_id, name, bildungsgang, konfig) VALUES (?, ?, ?, ?)').run(userId, titel, bildungsgang, konfig);
  return { ok: true, id: Number(info.lastInsertRowid) };
}

export function loescheSpaVorlage(id, userId) {
  return getDb().prepare('DELETE FROM spa_vorlagen WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

/** Vorschlag für den Namen einer neuen Vorlage, der noch nicht vergeben ist. */
export function freierVorlagenName(userId, basis) {
  const db = getDb();
  let name = basis;
  for (let i = 2; db.prepare('SELECT 1 FROM spa_vorlagen WHERE user_id = ? AND name = ?').get(userId, name); i++) name = `${basis} (${i})`;
  return name;
}

/**
 * Lädt eine Vorlage in eine SPA-Klasse: legt die Fächer an, die es dort noch nicht gibt (Schlüssel oder Name).
 * `quelle`: 'standard' (Vorgabe des Bildungsgangs), eine Vorlagen-ID oder 'keine' (nichts tun).
 * @returns {{ok: true, angelegt: string[]} | {ok: false, fehler: string}}
 */
export function ladeSpaVorlageInKlasse(klasse, quelle, userId) {
  const db = getDb();
  if (klasse.notenschluessel !== 'SPA' || !klasse.spa_bildungsgang) return { ok: false, fehler: 'Das ist keine SPA-Klasse.' };
  if (quelle === 'keine') return { ok: true, angelegt: [] };
  if (quelle === 'standard' || quelle === undefined || quelle === null || quelle === '') {
    return { ok: true, angelegt: seedeSpaFaecher(db, klasse.id, klasse.spa_bildungsgang, userId) };
  }
  const vorlage = ladeSpaVorlage(parseInt(quelle, 10), userId);
  if (!vorlage) return { ok: false, fehler: 'Vorlage nicht gefunden.' };
  return { ok: true, angelegt: seedeSpaFaecher(db, klasse.id, klasse.spa_bildungsgang, userId, vorlage.faecher) };
}

// ---------------------------------------------------------------------------
// Editor-Formular: Anzeige-Modell und Auswertung (flache Feldnamen, kein JavaScript nötig)
//   fach_idx (mehrfach)        Indizes der Fach-Karten
//   f{i}_key / _name / _typ / _entfernen
//   f{i}_h{h}_status           fehlt | inaktiv | aktiv
//   f{i}_h{h}_modus            direkt | komponenten_gewichtet     f{i}_h{h}_komp  Zeilen "Name; 40" oder "Name; Rest"
//   f{i}_h{h}_kum              keine | fortlaufend_50_50 | gewichtet_vorgaenger | mittelwert_halbjahre
//   f{i}_h{h}_mw (mehrfach)    Halbjahre für den Mittelwert
//   f{i}_h{h}_quelle           vorgaenger | fach | pruefung       _extfach / _exthj / _extpct
//   f{i}_h{h}_deakt / _abschluss / _pruefung / _komma  (Kontrollkästchen)
// ---------------------------------------------------------------------------

const prozentText = (x) => String(Math.round(x * 1000) / 10).replace('.', ',');
const alsListe = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Ein Halbjahr des Schemas als Formularwerte (Texte/Kontrollkästchen). */
function halbjahrModell(hj, s) {
  if (!s) return { hj, status: 'fehlt', modus: 'direkt', kum: 'keine', komp: '', mw: [], quelle: 'vorgaenger', extFach: '', extHj: 3, extPct: '30', deakt: false, abschluss: false, pruefung: false, komma: false };
  const quelle = s.externFach ? 'fach' : (s.pruefungVerrechnen ? 'pruefung' : 'vorgaenger');
  return {
    hj, status: s.aktiv ? 'aktiv' : 'inaktiv', modus: s.halbjahrModus, kum: s.kumulationModus,
    komp: (s.komponenten ?? []).map((k) => `${KOMPONENTEN_NAMEN[k.schluessel] || k.schluessel}; ${k.restAnteil ? 'Rest' : prozentText(k.gewichtFix)}`).join('\n'),
    mw: s.mittelwertHalbjahre ?? [], quelle, extFach: s.externFach ?? '', extHj: s.externHalbjahr ?? 3,
    extPct: s.gewichtExtern !== undefined ? prozentText(s.gewichtExtern) : '30',
    deakt: Boolean(s.deaktivierbar), abschluss: Boolean(s.abschlussZeigen), pruefung: Boolean(s.pruefung), komma: Boolean(s.kommaNote),
  };
}

/** Fach-Definitionen -> Formularmodell der Fach-Karten. */
export function editorModell(faecher) {
  return faecher.map((f) => ({
    schluessel: f.schluessel ?? '', name: f.name ?? '', typ: f.typ === 'LF' ? 'LF' : 'FACH',
    halbjahre: [1, 2, 3, 4].map((hj) => halbjahrModell(hj, (f.schema ?? []).find((s) => s.halbjahr === hj))),
  }));
}

/** Neues, leeres Fach: in allen vier Halbjahren aktiv, Direkteingabe, keine Verrechnung. */
export function neuesFach() {
  return {
    schluessel: '', name: '', typ: 'FACH',
    schema: [1, 2, 3, 4].map((hj) => ({ halbjahr: hj, aktiv: true, halbjahrModus: 'direkt', kumulationModus: 'keine', deaktivierbar: false, komponenten: [], abschlussZeigen: hj === 4 })),
  };
}

const KEY_NAMEN = new Map(Object.entries(KOMPONENTEN_NAMEN).map(([k, n]) => [n.toLowerCase(), k]));

function parseKomponenten(text) {
  const ergebnis = [];
  for (const zeile of String(text ?? '').split(/\r?\n/)) {
    const t = zeile.trim();
    if (!t) continue;
    const [namenRoh, restRoh = ''] = t.split(/[;|]/).map((x) => x.trim());
    const schluessel = KEY_NAMEN.get(namenRoh.toLowerCase()) ?? namenRoh;
    if (!restRoh || /^rest/i.test(restRoh)) ergebnis.push({ schluessel, restAnteil: true });
    else ergebnis.push({ schluessel, gewichtFix: Number(restRoh.replace('%', '').replace(',', '.')) / 100 });
  }
  return ergebnis;
}

function parseProzent(roh, standard) {
  const n = Number(String(roh ?? '').replace('%', '').replace(',', '.'));
  return (Number.isFinite(n) ? n : standard) / 100;
}

/** Schlüssel für ein neues Fach aus dem Namen (A-Z, 0-9, _), eindeutig unter `belegt`. */
function neuerSchluessel(name, belegt) {
  const basis = (name.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'SS').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'FACH');
  let k = basis;
  for (let i = 2; belegt.has(k); i++) k = `${basis.slice(0, 26)}_${i}`;
  return k;
}

/**
 * Liest die Fach-Karten aus dem Formular. Nicht gültige Eingaben bleiben erhalten (z. B. NaN-Gewicht) und
 * werden erst von pruefeKonfig() beanstandet, damit das Formular mit Fehlermeldung wieder angezeigt werden kann.
 * @returns {Array<{schluessel: string, name: string, typ: string, schema: object[]}>}
 */
export function leseFaecherAusFormular(body) {
  const faecher = [];
  const belegt = new Set(alsListe(body.fach_idx).map((i) => String(body[`f${i}_key`] ?? '')).filter(istFachSchluessel));
  for (const i of alsListe(body.fach_idx)) {
    if (body[`f${i}_entfernen`]) continue;
    const name = String(body[`f${i}_name`] ?? '').trim();
    let schluessel = String(body[`f${i}_key`] ?? '');
    if (!istFachSchluessel(schluessel)) { schluessel = neuerSchluessel(name, belegt); belegt.add(schluessel); }
    const schema = [];
    for (let hj = 1; hj <= 4; hj++) {
      const p = `f${i}_h${hj}_`;
      const status = body[`${p}status`];
      if (status !== 'aktiv' && status !== 'inaktiv') continue;
      const s = {
        halbjahr: hj, aktiv: status === 'aktiv', halbjahrModus: body[`${p}modus`], kumulationModus: body[`${p}kum`],
        deaktivierbar: Boolean(body[`${p}deakt`]), abschlussZeigen: Boolean(body[`${p}abschluss`]),
        pruefung: Boolean(body[`${p}pruefung`]), kommaNote: Boolean(body[`${p}komma`]), komponenten: [],
      };
      if (s.halbjahrModus === 'komponenten_gewichtet') s.komponenten = parseKomponenten(body[`${p}komp`]);
      if (s.kumulationModus === 'mittelwert_halbjahre') s.mittelwertHalbjahre = alsListe(body[`${p}mw`]).map(Number);
      if (s.kumulationModus === 'gewichtet_vorgaenger') {
        const quelle = body[`${p}quelle`];
        if (quelle === 'fach' || quelle === 'pruefung') {
          s.gewichtExtern = parseProzent(body[`${p}extpct`], 30);
          if (quelle === 'fach') {
            s.externFach = String(body[`${p}extfach`] ?? '');
            s.externHalbjahr = Number(body[`${p}exthj`]);
          } else s.pruefungVerrechnen = true;
        }
      }
      schema.push(s);
    }
    faecher.push({ schluessel, name, typ: body[`f${i}_typ`] === 'LF' ? 'LF' : 'FACH', schema });
  }
  return faecher;
}
