/**
 * Eine Klasse läuft über mehrere Schuljahre (Einschulungs- bis Abschluss-
 * schuljahr, siehe klassen.einschulung_jahr/abschluss_jahr in src/db.js). Die
 * Halbjahre werden über diese Jahre durchgezählt: bei drei Jahren 1. bis 6.
 * Halbjahr, wobei ungerade Halbjahre die erste, gerade die zweite Hälfte
 * eines Schuljahres sind. Die Halbjahres-Schlüssel sind wie bisher Texte
 * ("3. Halbjahr"), damit bestehende Daten (klausuren.halbjahr, noten.halbjahr
 * ...) unverändert gültig bleiben -- bestehende Klassen starten im
 * Einschulungsjahr mit "1./2. Halbjahr".
 *
 * Fehlt der Abschluss, gilt die Standarddauer: SPA zwei, BG/IHK drei Jahre.
 */

import { vergleicheNamen } from './format.js';
import { getDb } from './db.js';
import { parseSchuljahr, baueSchuljahrBezeichnung, aktuellesStartjahr } from './schuljahr-utils.js';

export const STANDARD_JAHRE_SPA = 2;
export const STANDARD_JAHRE_SONST = 3;
/** Obergrenze, damit Fehleingaben keine endlosen Halbjahr-Listen erzeugen. */
export const MAX_SCHULJAHRE = 6;

/**
 * "Heute" für die Berechnung des aktuellen Halbjahres. In Tests (NODE_ENV=test)
 * ist das Datum eingefroren (1.10.2025), damit Standardwerte nicht vom
 * Ausführungstag abhängen; NOTEN_HEUTE (YYYY-MM-DD) überschreibt das.
 */
export function jetzt() {
  if (process.env.NOTEN_HEUTE) return new Date(process.env.NOTEN_HEUTE);
  return process.env.NODE_ENV === 'test' ? new Date('2025-10-01T12:00:00') : new Date();
}

export function standardJahre(notenschluessel) {
  return notenschluessel === 'SPA' ? STANDARD_JAHRE_SPA : STANDARD_JAHRE_SONST;
}

export function halbjahrText(nr) {
  return `${nr}. Halbjahr`;
}

/** "3. Halbjahr" -> 3, sonst null. */
export function halbjahrNr(text) {
  const treffer = /^(\d{1,2})\. Halbjahr$/.exec(String(text || '').trim());
  return treffer ? parseInt(treffer[1], 10) : null;
}

/**
 * Lädt die für die Laufzeit nötigen Spalten einer Klasse (Zeile aus klassen
 * oder ID) samt Startjahr des "Heimat"-Schuljahres.
 */
function ladeKlasse(klasseOderId) {
  const id = typeof klasseOderId === 'object' && klasseOderId !== null ? klasseOderId.id : klasseOderId;
  return getDb().prepare(`
    SELECT k.id, k.notenschluessel, k.schuljahr_id, k.einschulung_jahr, k.abschluss_jahr, s.bezeichnung AS schuljahr_bezeichnung
    FROM klassen k JOIN schuljahre s ON s.id = k.schuljahr_id WHERE k.id = ?
  `).get(id);
}

/**
 * Laufzeit-Infos einer Klasse.
 * @returns {{ einschulungJahr: number, abschlussJahr: number, jahre: number, anzahlHalbjahre: number,
 *   halbjahre: string[], schuljahre: Array<{nr: number, startJahr: number, bezeichnung: string}>,
 *   abschlussIstStandard: boolean } | null}
 */
export function klassenLaufzeit(klasseOderId) {
  const k = ladeKlasse(klasseOderId);
  if (!k) return null;
  const heimat = parseSchuljahr(k.schuljahr_bezeichnung)?.startJahr ?? aktuellesStartjahr();
  const einschulungJahr = k.einschulung_jahr ?? heimat;
  const abschlussIstStandard = k.abschluss_jahr === null || k.abschluss_jahr === undefined || k.abschluss_jahr < einschulungJahr;
  const abschlussJahr = abschlussIstStandard
    ? einschulungJahr + standardJahre(k.notenschluessel) - 1
    : Math.min(k.abschluss_jahr, einschulungJahr + MAX_SCHULJAHRE - 1);
  const jahre = abschlussJahr - einschulungJahr + 1;
  const schuljahre = Array.from({ length: jahre }, (_, i) => ({
    nr: i + 1, startJahr: einschulungJahr + i, bezeichnung: baueSchuljahrBezeichnung(einschulungJahr + i),
  }));
  const anzahlHalbjahre = jahre * 2;
  return {
    einschulungJahr, abschlussJahr, jahre, anzahlHalbjahre, schuljahre, abschlussIstStandard,
    halbjahre: Array.from({ length: anzahlHalbjahre }, (_, i) => halbjahrText(i + 1)),
  };
}

/** Texte "1. Halbjahr" ... "N. Halbjahr" der Klasse. */
export function halbjahreFuerKlasse(klasseOderId) {
  return klassenLaufzeit(klasseOderId)?.halbjahre ?? ['1. Halbjahr', '2. Halbjahr'];
}

/** Gibt `roh` zurück, wenn es ein Halbjahr der Klasse ist, sonst das aktuelle Halbjahr der Klasse. */
export function gueltigesHalbjahrFuerKlasse(klasseOderId, roh) {
  const liste = halbjahreFuerKlasse(klasseOderId);
  return liste.includes(roh) ? roh : standardHalbjahr(klasseOderId, liste);
}

function standardHalbjahr(klasseOderId, liste) {
  const l = klassenLaufzeit(klasseOderId);
  return l ? aktuellesHalbjahrDerKlasse(l, jetzt()) : liste[0];
}

/** Schuljahr-Bezeichnung ("2026/27"), in dem das n-te Halbjahr der Klasse liegt. */
export function schuljahrDesHalbjahrs(laufzeit, nr) {
  if (!laufzeit || !nr) return null;
  return laufzeit.schuljahre[Math.min(laufzeit.schuljahre.length, Math.ceil(nr / 2)) - 1]?.bezeichnung ?? null;
}

/** Hälfte im Schuljahr: 1 oder 2. */
export function haelfteDesHalbjahrs(nr) {
  return nr % 2 === 1 ? 1 : 2;
}

/**
 * Aktuelles Halbjahr einer Klasse nach heutigem Datum: Schuljahr nach
 * Startjahr, ab Februar zweite Hälfte. Vor Beginn das erste, nach Ende das
 * letzte Halbjahr.
 */
export function aktuellesHalbjahrDerKlasse(laufzeit, heute = new Date()) {
  const idx = aktuellesStartjahr(heute) - laufzeit.einschulungJahr;
  if (idx < 0) return halbjahrText(1);
  if (idx >= laufzeit.jahre) return halbjahrText(laufzeit.anzahlHalbjahre);
  const monat = heute.getMonth(); // 0-basiert
  const zweite = monat >= 1 && monat <= 6; // Februar bis Juli
  return halbjahrText(idx * 2 + (zweite ? 2 : 1));
}

/** Liegt das Schuljahr (Startjahr) im Laufzeit-Zeitraum der Klasse? */
export function klasseLaeuftImSchuljahr(laufzeit, startJahr) {
  return Boolean(laufzeit) && startJahr >= laufzeit.einschulungJahr && startJahr <= laufzeit.abschlussJahr;
}

/**
 * Ist das Halbjahr der Klasse vergangen (sein Schuljahr ist abgeschlossen oder
 * das laufende Halbjahr ist schon vorbei)? Grundlage für die Direkteingabe der
 * Klassenleitung.
 */
export function istHalbjahrVergangen(laufzeit, nr, heute = new Date()) {
  const aktuell = halbjahrNr(aktuellesHalbjahrDerKlasse(laufzeit, heute));
  if (aktuellesStartjahr(heute) > laufzeit.abschlussJahr) return true;
  return nr < aktuell;
}

/**
 * Halbjahr aus Query/Body: akzeptiert "3. Halbjahr" und nur die Ziffer ("3",
 * wie in den SPA-Links); sonst das erste Halbjahr der Klasse.
 */
export function halbjahrAusEingabe(klasseOderId, roh) {
  const liste = halbjahreFuerKlasse(klasseOderId);
  const text = /^\d{1,2}$/.test(String(roh)) ? halbjahrText(parseInt(roh, 10)) : roh;
  return liste.includes(text) ? text : standardHalbjahr(klasseOderId, liste);
}

/**
 * Mündlich-Anteil (%) für ein Halbjahr einer Klasse: die Einstellung des
 * Schuljahres, in dem dieses Halbjahr liegt (siehe schuljahre.gewichtung_
 * muendlich); gibt es dieses Schuljahr nicht als Eintrag, gilt das Schuljahr
 * der Klasse, sonst `standard`.
 */
export function muendlichProzentFuerHalbjahr(klasseId, halbjahr, standard = 60) {
  const db = getDb();
  const laufzeit = klassenLaufzeit(klasseId);
  const bez = laufzeit ? schuljahrDesHalbjahrs(laufzeit, halbjahrNr(halbjahr)) : null;
  const eigenes = bez ? db.prepare('SELECT gewichtung_muendlich AS g FROM schuljahre WHERE bezeichnung = ?').get(bez) : null;
  if (eigenes) return eigenes.g;
  const heimat = db.prepare('SELECT s.gewichtung_muendlich AS g FROM schuljahre s JOIN klassen k ON k.schuljahr_id = s.id WHERE k.id = ?').get(klasseId);
  return heimat?.g ?? standard;
}

/** Startjahr aus einem Formularfeld ("2025"), sonst null. */
export function parseJahrEingabe(roh) {
  const n = parseInt(roh, 10);
  return Number.isFinite(n) && n >= 2000 && n <= 2100 ? n : null;
}

/** Auswahl für Einschulungs-/Abschlussschuljahr: Startjahre mit Bezeichnung ("2025/26"). */
export function jahresOptionen(heute = jetzt()) {
  const jetzt = aktuellesStartjahr(heute);
  return Array.from({ length: 12 }, (_, i) => jetzt - 5 + i).map((jahr) => ({ jahr, bezeichnung: baueSchuljahrBezeichnung(jahr) }));
}

/** { "1. Halbjahr": "2025/26", ... } für die Beschriftung der Halbjahres-Reiter. */
export function halbjahrSchuljahrMap(klasseOderId) {
  const l = klassenLaufzeit(klasseOderId);
  if (!l) return {};
  return Object.fromEntries(l.halbjahre.map((h, i) => [h, schuljahrDesHalbjahrs(l, i + 1)]));
}

// ---------- Fächer je Halbjahr ----------

/** Halbjahr-Nummern, in denen das Fach gilt (faecher.halbjahre; NULL = alle der Klasse). */
export function fachHalbjahrNummern(fach, laufzeit) {
  const alle = laufzeit.halbjahre.map((_, i) => i + 1);
  if (!fach?.halbjahre) return alle;
  try {
    const nummern = JSON.parse(fach.halbjahre).filter((n) => Number.isInteger(n) && n >= 1 && n <= laufzeit.anzahlHalbjahre);
    return nummern.length ? [...new Set(nummern)].sort((a, b) => a - b) : alle;
  } catch {
    return alle;
  }
}

export function fachGiltInHalbjahr(fach, halbjahrText_, laufzeit = klassenLaufzeit(fach.klasse_id)) {
  const nr = halbjahrNr(halbjahrText_);
  return nr !== null && fachHalbjahrNummern(fach, laufzeit).includes(nr);
}

/** Halbjahr-Texte, in denen das Fach gilt. */
export function halbjahreFuerFach(fach) {
  const l = klassenLaufzeit(fach.klasse_id);
  if (!l) return ['1. Halbjahr', '2. Halbjahr'];
  return fachHalbjahrNummern(fach, l).map(halbjahrText);
}

/**
 * Halbjahr aus Query/Body für ein Fach: gültig nur innerhalb der Halbjahre des
 * Fachs; sonst das aktuelle Halbjahr der Klasse, falls das Fach dort gilt, sonst
 * das zeitlich nächste Halbjahr des Fachs.
 */
export function halbjahrAusEingabeFuerFach(fach, roh) {
  const liste = halbjahreFuerFach(fach);
  const text = /^\d{1,2}$/.test(String(roh)) ? halbjahrText(parseInt(roh, 10)) : roh;
  if (liste.includes(text)) return text;
  const l = klassenLaufzeit(fach.klasse_id);
  const aktuell = l ? aktuellesHalbjahrDerKlasse(l, jetzt()) : liste[0];
  if (liste.includes(aktuell)) return aktuell;
  const ziel = halbjahrNr(aktuell) ?? 1;
  return liste.reduce((beste, h) => (Math.abs(halbjahrNr(h) - ziel) < Math.abs(halbjahrNr(beste) - ziel) ? h : beste), liste[0]);
}

/**
 * Halbjahr-Auswahl aus einem Formular (wiederholte Checkboxen) als Nummern der
 * Laufzeit; null, wenn nichts oder alles gewählt wurde (= gilt in allen).
 */
export function parseHalbjahreEingabe(roh, laufzeit) {
  const liste = (Array.isArray(roh) ? roh : [roh]).map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n) && n >= 1 && n <= laufzeit.anzahlHalbjahre);
  const eindeutig = [...new Set(liste)].sort((a, b) => a - b);
  if (!eindeutig.length || eindeutig.length === laufzeit.anzahlHalbjahre) return null;
  return eindeutig;
}

/** Die beiden Halbjahre des aktuellen Schuljahres der Klasse (Vorbelegung beim Anlegen eines Fachs). */
export function aktuelleHalbjahrNummern(laufzeit, heute = jetzt()) {
  const nr = halbjahrNr(aktuellesHalbjahrDerKlasse(laufzeit, heute)) ?? 1;
  const erste = nr % 2 === 1 ? nr : nr - 1;
  return [erste, erste + 1].filter((n) => n <= laufzeit.anzahlHalbjahre);
}

// ---------- Verrechnung der Halbjahresnoten ----------

/** Verrechnung aus der Speicherform (JSON) als { [vonHalbjahrNr]: prozent }. */
export function parseVerrechnung(roh) {
  if (!roh) return {};
  try {
    const obj = JSON.parse(roh);
    const ergebnis = {};
    for (const [k, v] of Object.entries(obj)) {
      const p = Number(v);
      if (Number.isInteger(Number(k)) && Number.isFinite(p) && p > 0) ergebnis[k] = Math.min(100, p);
    }
    return ergebnis;
  } catch {
    return {};
  }
}

/** Verrechnung der Klasse (Vorgabe für Fächer ohne eigene Einstellung) als { [vonHalbjahrNr]: prozent }. */
export function ladeVerrechnung(klasseId) {
  return parseVerrechnung(getDb().prepare('SELECT verrechnung FROM klassen WHERE id = ?').get(klasseId)?.verrechnung);
}

/**
 * Verrechnung eines Fachs: die eigene Einstellung (faecher.verrechnung), sonst
 * die Vorgabe der Klasse. Unterfächer (ihre Noten fließen gewichtet ins Fach,
 * das selbst verrechnet) haben keine. SPA-Fächer kennen nur die eigene
 * Einstellung (je Fach auf der Fachseite), nie die Klassen-Vorgabe.
 */
export function ladeVerrechnungFuerFach(fach) {
  if (fach.parent_fach_id) return {};
  if (fach.verrechnung !== null && fach.verrechnung !== undefined) return parseVerrechnung(fach.verrechnung);
  return fach.spa_fach_key ? {} : ladeVerrechnung(fach.klasse_id);
}

/**
 * Prozent der Note aus dem VORHERIGEN Halbjahr, die in dieses Halbjahr
 * einfließen (0 beim 1. Halbjahr oder wenn nicht eingestellt). Mit `fach` gilt
 * dessen Einstellung (siehe ladeVerrechnungFuerFach), sonst die der Klasse.
 */
export function verrechnungsProzent(klasseId, halbjahr, fach = null) {
  const nr = halbjahrNr(halbjahr);
  if (!nr || nr < 2) return 0;
  const einstellung = fach ? ladeVerrechnungFuerFach(fach) : ladeVerrechnung(klasseId);
  return einstellung[String(nr - 1)] ?? 0;
}

/** Mischt die Note des Halbjahres mit der des Vorhalbjahres: (1-p)*aktuell + p*vorher, auf 2 Stellen gerundet. */
export function wendeVerrechnungAn(aktuell, vorher, prozent) {
  if (!prozent || aktuell === null || aktuell === undefined || vorher === null || vorher === undefined) return aktuell ?? null;
  const p = prozent / 100;
  return Math.round(((1 - p) * aktuell + p * vorher) * 100) / 100;
}

/**
 * Sortiergruppe eines Fachs nach seinen Halbjahren: [von, bis] bei einem
 * zusammenhängenden Teilbereich, sonst null -- null gilt für Fächer in allen
 * Halbjahren UND für inkonsistente (lückenhafte) Angaben.
 */
export function halbjahrGruppe(fach, laufzeit) {
  const n = fachHalbjahrNummern(fach, laufzeit);
  if (!n.length || n.length === laufzeit.anzahlHalbjahre) return null;
  return n[n.length - 1] - n[0] + 1 === n.length ? [n[0], n[n.length - 1]] : null;
}

/**
 * Sortiert Fächer: zuerst nach den Halbjahren aufsteigend (früheste zuerst),
 * Fächer in allen Halbjahren (auch lückenhafte Angaben) ganz unten; innerhalb
 * einer Gruppe alphabetisch (deutsch). `laufzeit` optional (sonst je Klasse des Fachs).
 */
export function sortiereFaecher(liste, laufzeit = null) {
  const cache = new Map();
  const laufzeitVon = (f) => {
    if (laufzeit) return laufzeit;
    if (!cache.has(f.klasse_id)) cache.set(f.klasse_id, klassenLaufzeit(f.klasse_id));
    return cache.get(f.klasse_id);
  };
  const mitGruppe = liste.map((f) => ({ f, g: halbjahrGruppe(f, laufzeitVon(f)) }));
  mitGruppe.sort((a, b) => {
    if (!a.g !== !b.g) return a.g ? -1 : 1; // Fächer mit Teilbereich vor "alle Halbjahre"
    if (a.g && (a.g[0] - b.g[0] || a.g[1] - b.g[1])) return (a.g[0] - b.g[0]) || (a.g[1] - b.g[1]);
    return vergleicheNamen(a.f.name, b.f.name);
  });
  return mitGruppe.map((x) => x.f);
}

/**
 * Ist das Fach abgeschlossen? Ergibt sich aus den Halbjahren des Fachs: sobald
 * sein letztes Halbjahr vergangen ist (siehe istHalbjahrVergangen), gilt es als
 * abgeschlossen und zeigt seine Fachabschlussnote.
 */
export function istFachAbgeschlossen(fach, heute = jetzt()) {
  const laufzeit = klassenLaufzeit(fach.klasse_id);
  const nummern = fachHalbjahrNummern(fach, laufzeit);
  return Boolean(nummern.length) && istHalbjahrVergangen(laufzeit, nummern[nummern.length - 1], heute);
}

/** Fach-Zeile mit abgeleitetem `abgeschlossen`-Status (0/1) statt des früher von Hand gesetzten. */
export function mitAbschlussStatus(fach) {
  return fach ? { ...fach, abgeschlossen: istFachAbgeschlossen(fach) ? 1 : 0, abgeschlossen_am: null } : fach;
}
