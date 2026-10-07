/**
 * Lehrkraft-Routen: Notentafel (AJAX), Klausuren, ULs, mündlich/schriftlich.
 * Zugriffsschutz: User muss dem Fach zugewiesen sein (oder Admin).
 */

import { getDb } from '../db.js';
import { formatZeitLokal, sortiereNachName } from '../format.js';
import { setzeEndnote, notenBereich } from '../halbjahr-endnoten.js';
import { erkenneSchuelerZeile } from '../schueler-eingabe.js';
import { ladeVorlagen, speicherbareFaecher, speichereVorlage, importiereVorlage, loescheVorlage } from '../fach-vorlagen.js';
import {
  ladeUnterfaecher, UNTERFACH_TRENNER, legeUnterfachAn, setzeFachHalbjahre, weiseLehrkraftZu, setzeZuweisungHalbjahre,
  halbjahreOhneUnterfaecher, ladeZuweisungenDerKlasse, zuweisungsHalbjahre,
} from '../unterfaecher.js';
import { halbjahrAusEingabeFuerFach, halbjahreFuerFach, fachGiltInHalbjahr, fachHalbjahrNummern, parseHalbjahreEingabe, aktuelleHalbjahrNummern, halbjahrAusEingabe, halbjahreFuerKlasse, halbjahrSchuljahrMap, halbjahrNr, muendlichProzentFuerHalbjahr, klassenLaufzeit, findeLaufendeKlasse, sortiereFaecher, ladeVerrechnung, ladeVerrechnungFuerFach, klasseLaeuftImSchuljahr, istHalbjahrVergangen, jetzt, jahresOptionen, parseJahrEingabe, MAX_SCHULJAHRE } from '../klassen-jahre.js';
import {
  requireAuth, userHatFachZgriff, erlaubteHalbjahreImFach, userDarfTeilnehmerVerwalten, userHatKlassenZugriff, userIstKlassenlehrer, userDarfKlasseExportieren,
  userDarfFachLoeschen, userDarfKlasseVerwalten,
  ladeMeineKlassen, ladeMeineKurse, userDarfSelbstKlasseAnlegen, istIrgendeineKlassenleitung, makeToken,
} from '../auth.js';
import {
  HALBJAHRE, autoDistribute, DEFAULT_GEWICHTUNG, DEFAULT_NS_CSV, parseTendenzNote, NTG, parseKlausurTeile, passeTeileAnAufgabenzahl, passeTeileAnTeilzahl, MAX_KLAUSUR_TEILE,
} from '../grade-calc.js';
import { starteVerknuepfung, ermittleVerbundenePersonen } from '../klassen-verknuepfung.js';
import {
  ladeFachMitUmfeld, ladeNotenuebersicht, ladeFaecherFuerSchueler, ladeFaecherFuerKlassenleitung, unterfaecherDesHalbjahrs,
} from '../noten-service.js';
import { syncFach, syncFallsAutoAktiv, holeSyncMeta, ladeHalbjahresuebersicht } from '../noten-sync.js';
import {
  ladeAbschlussnoten,
  ladeAbgangszeugnisDaten, ladeAbschlussuebersicht,
} from '../fach-abschluss.js';
import {
  istSchuelerGesperrtInFach, sperren, entsperren, aufhebungAnfragen,
  ladeSperrenFuerSchueler, holeSperre,
} from '../noten-sperre.js';
import {
  ladeVersetzZiele, versetzeSchueler, loescheKlasseMitSchuelerUebernahme, ladeAblagePersonen, uebernehmeAusAblage,
} from '../klassenwechsel.js';
import { parseSchuelerCsv } from '../csv-import.js';
import { fuegeSchuelerHinzuFallsNeu } from '../schueler-utils.js';
import {
  seedeTeilnehmerAusKlasse, ladeTeilnehmerMitHerkunft, fuegeTeilnehmerHinzu, entferneTeilnehmer,
  sucheSchuelerFuerFach, legeManuellenTeilnehmerAn,
} from '../fach-teilnehmer.js';
import { sortiereSchuljahreAbsteigend, sortiereSchuljahreFuerReiter, parseSchuljahr } from '../schuljahr-utils.js';
import { BILDUNGSGAENGE, KOMPONENTEN_NAMEN, WPK_KURSE } from '../spa-schema.js';
import {
  berechneFachFuerSchueler as berechneSpaFachFuerSchueler, vorwerteFuer as spaVorwerteFuer,
  ladeEingabeAnzeige as ladeSpaEingabeAnzeige,
  seedeSpaFaecher, spaSchemaFuerFach, spaKomponentenKonfig, spaSetzeKomponenteAktiv, spaKomponentenHalbjahre, seedeKomponentenUnterfaecher,
} from '../spa-noten-service.js';
import {
  zeugnisMitQuellen, ladeQuellenSeite, speichereQuellenAuswahl, loescheQuellenAuswahl,
} from '../spa-zeugnis-quellen.js';
import { leistungsZiel, setzeLeistungsZiel, spaTendenz } from '../spa-leistung.js';
import Busboy from '@fastify/busboy';
import { Readable } from 'node:stream';

/**
 * Liest genau ein Datei-Feld aus einem multipart/form-data-Buffer. Absichtlich
 * ohne @fastify/multipart (das registriert seinen Content-Type-Parser global
 * für die ganze App via fastify-plugin und würde damit dafür sorgen, dass
 * ANDERE Routen multipart/form-data plötzlich mit leerem statt mit 415
 * abgelehntem Body erhalten — siehe die Regression in
 * fach_detail.ejs/Punkte-Eingabe, die genau auf dem alten 415-Verhalten
 * beruht). Der Content-Type-Parser für multipart wird stattdessen weiter
 * unten NUR innerhalb eines eigenen, gekapselten fastify.register()-Blocks
 * registriert, gilt also wirklich nur für den CSV-Upload.
 */
function leseMultipartDatei(buffer, contentType, feldname) {
  return new Promise((resolve, reject) => {
    let busboy;
    try {
      busboy = new Busboy({ headers: { 'content-type': contentType } });
    } catch (e) {
      return reject(e);
    }
    let ergebnis = null;
    busboy.on('file', (name, stream) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        if (name === feldname) ergebnis = Buffer.concat(chunks);
      });
    });
    busboy.on('error', reject);
    busboy.on('finish', () => resolve(ergebnis));
    Readable.from(buffer).pipe(busboy);
  });
}

/** Fach-assignierte Lehrkraft ODER Klassenleitung darf die Notentafel eines Fachs bearbeiten. */
function userDarfFachBearbeiten(user, fach) {
  return userHatFachZgriff(user, fach.id) || userIstKlassenlehrer(user, fach.klasse_id);
}

/** Lehrkraft eines Unterfachs, Lehrkraft des Fachs selbst oder Klassenleitung (Zusammensetzungs-Seite). */
function userDarfZusammensetzungSehen(user, fach) {
  if (userHatFachZgriff(user, fach.id) || userIstKlassenlehrer(user, fach.klasse_id)) return true;
  return ladeUnterfaecher(fach.id).some((u) => userHatFachZgriff(user, u.id));
}

function renderZusammensetzung(request, reply, fach, halbjahr) {
  const uebersicht = ladeNotenuebersicht(fach, halbjahr);
  const komposition = {
    unterfaecher: uebersicht.komposition.unterfaecher.map((u) => ({ ...u, darfOeffnen: userHatFachZgriff(request.user, u.id) })),
  };
  return reply.viewEjs('teacher/fach_zusammensetzung.ejs', {
    HALBJAHRE: halbjahreFuerFach(fach), HALBJAHR_SCHULJAHR: halbjahrSchuljahrMap(fach.klasse_id),
    user: request.user, fach, halbjahr, komposition, rows: uebersicht.rows, verrechnung: uebersicht.verrechnung,
    darfGewichteAendern: userDarfZusammensetzungSehen(request.user, fach),
    darfEndnoteEintragen: userHatFachZgriff(request.user, fach.id, halbjahr) || userIstKlassenlehrer(request.user, fach.klasse_id),
  });
}

/**
 * Halbjahres-Text aus Query/Body für ein Fach bzw. eine Klasse: gültig sind
 * die Halbjahre der Klasse (je nach Laufzeit "1. Halbjahr" ... "N. Halbjahr",
 * siehe src/klassen-jahre.js); akzeptiert auch nur die Ziffer, sonst das erste.
 */
function halbjahrFuerFach(fach, roh) {
  return halbjahrAusEingabeFuerFach(fach, roh);
}

function halbjahrFuerFachId(fachId, roh) {
  const fach = getDb().prepare('SELECT * FROM faecher WHERE id = ?').get(fachId);
  return fach ? halbjahrAusEingabeFuerFach(fach, roh) : HALBJAHRE[0];
}

function halbjahrFuerKlasseId(klasseId, roh) {
  return halbjahrAusEingabe(klasseId, roh);
}

/** Aktives Halbjahr (laut Query oder erstes im Schema aktives) für eine SPA-Fachseite. */
function spaAktivesHalbjahr(schema, query) {
  const aktive = schema.filter((s) => s.aktiv).map((s) => s.halbjahr);
  const hj = parseInt(query?.hj, 10);
  return aktive.includes(hj) ? hj : (aktive[0] ?? 1);
}

/** Berechnete Ergebnisse + Vorwerte aller Fach-Teilnehmer/innen für ein Halbjahr, für Seite und JSON-Refresh gleich aufbereitet. */
function spaZeilenFuerHalbjahr(fach, teilnehmer, halbjahr) {
  const vorwert = spaVorwerteFuer(getDb(), fach.klasse_id, fach.spa_fach_key, halbjahr);
  const vorwertBySchueler = new Map(vorwert.werte.map((w) => [w.schuelerId, w]));
  const zeilen = teilnehmer.map((t) => {
    const ergebnisse = berechneSpaFachFuerSchueler(getDb(), fach.id, t.id);
    const ergebnis = ergebnisse.find((e) => e.halbjahr === halbjahr) ?? null;
    return { schueler: t, ergebnis, vorwert: vorwertBySchueler.get(t.id) ?? null };
  });
  return { zeilen, vorwertLabel: vorwert.label };
}

/** Rendert die Eingabemaske eines SPA-Fachs (eigenes Bewertungsmodell, siehe spa-schema.js/spa-noten-service.js). */
function renderSpaFachDetail(request, reply, fach) {
  const db = getDb();
  const { schema } = spaSchemaFuerFach(db, fach.id);
  const halbjahr = spaAktivesHalbjahr(schema, request.query);
  const schemaHj = schema.find((s) => s.halbjahr === halbjahr);
  const teilnehmer = ladeTeilnehmerMitHerkunft(fach);
  const { zeilen, vorwertLabel } = spaZeilenFuerHalbjahr(fach, teilnehmer, halbjahr);
  const eingaben = new Map(zeilen.map((z) => [
    z.schueler.id, ladeSpaEingabeAnzeige(db, fach.id, z.schueler.id, halbjahr, schemaHj),
  ]));
  const sperren = ladeSperrenFuerSchueler(teilnehmer.map((t) => t.id), String(halbjahr));
  return reply.viewEjs('teacher/fach_detail_spa.ejs', {
    user: request.user, fach, schema, schemaHj, halbjahr,
    aktiveHalbjahre: schema.filter((s) => s.aktiv).map((s) => s.halbjahr),
    zeilen, vorwertLabel, eingaben, sperren,
    komponentenNamen: KOMPONENTEN_NAMEN, wpkKurse: WPK_KURSE,
    darfBearbeiten: userDarfFachBearbeiten(request.user, fach),
    // Welche Rest-Komponenten aktiv sind (z. B. bei LF3), stellt die Klassenleitung auf der
    // Klassenseite ein (Fächer und Lehrkräftezuordnung) -- hier nur die Anzeige der abgeschalteten.
    inaktiveKomponenten: spaKomponentenKonfig(db, fach.id, halbjahr).filter((k) => !k.aktiv),
  });
}

/** Datum einer Klausur/Zusatzleistung: optional, aber wenn angegeben nur im validen YYYY-MM-DD-Format -- sonst null. */
function alsGueltigesDatumOderNull(wert) {
  const s = String(wert || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// Meldung für alles, was userDarfKlasseVerwalten() verlangt (siehe src/auth.js).
const KLASSE_VERWALTEN_NUR = 'Das darf nur die Klassenleitung, die Lehrkraft, die die Klasse angelegt hat, oder der Admin — '
  + 'es betrifft auch Fächer und Noten anderer Lehrkräfte.';

/** Namen aller eingetragenen Klassenlehrkräfte einer Klasse (beide Quellen, siehe userIstKlassenlehrer), alphabetisch. */
function ladeKlassenleitungNamen(klasseId) {
  const rows = getDb().prepare(`
    SELECT u.display_name, u.username FROM users u WHERE u.id IN (
      SELECT user_id FROM klassenleitung WHERE klasse_id = ?
      UNION SELECT user_id FROM klassen_lehrkraefte WHERE klasse_id = ?
    )
  `).all(klasseId, klasseId);
  return sortiereNachName(rows.map((r) => ({ name: r.display_name || r.username }))).map((r) => r.name);
}

/**
 * Verrechnung aus einem Formular (p_<n> = Prozent der Note aus Halbjahr n, die in n+1 einfließen).
 * @returns {{werte: Object<string, number>} | {fehler: string}} leere Felder und 0 zählen nicht
 */
function parseVerrechnungEingabe(body, laufzeit) {
  const werte = {};
  for (let n = 1; n < laufzeit.anzahlHalbjahre; n++) {
    const roh = String(body?.[`p_${n}`] ?? '').trim().replace(',', '.');
    if (roh === '') continue;
    const p = Number(roh);
    if (!Number.isFinite(p) || p < 0 || p > 100) return { fehler: `Ungültiger Prozentwert für Halbjahr ${n} → ${n + 1} (erlaubt: 0 bis 100).` };
    if (p > 0) werte[n] = Math.round(p * 10) / 10;
  }
  return { werte };
}

export default async function teacherRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  // Zugriff strikt je Halbjahr: Routen unter /fach/:id, die ein Halbjahr mitschicken
  // (Formularfeld "halbjahr" bzw. Query "hj"), verlangen eine Zuordnung, die dieses
  // Halbjahr abdeckt. Die Fachseite selbst (GET /fach/:id) leitet stattdessen auf ein
  // erlaubtes Halbjahr um, die Endnoten-Route erlaubt zusätzlich der Klassenleitung.
  fastify.addHook('preHandler', async (request, reply) => {
    const url = request.routeOptions?.url || '';
    if (!/\/fach\/:id\//.test(url) || url.endsWith('/endnote')) return;
    const roh = request.body?.halbjahr ?? request.query?.hj;
    if (roh === undefined || roh === null || roh === '' || halbjahrNr(String(roh)) === null && !/^\d{1,2}$/.test(String(roh))) return;
    if (!userHatFachZgriff(request.user, request.params.id)) return; // die Route meldet das selbst
    if (userHatFachZgriff(request.user, request.params.id, roh)) return;
    const meldung = 'Keine Berechtigung für dieses Halbjahr.';
    if (request.method === 'GET' && !request.headers.accept?.includes('application/json') && !url.endsWith('/noten')) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: meldung });
    }
    return reply.code(403).send({ ok: false, error: 'forbidden', message: meldung });
  });

  // ---------- Dashboard (Lehrkraft) ----------
  fastify.get('/', async (request, reply) => {
    if (request.user.isAdmin) {
      const schuljahre = sortiereSchuljahreAbsteigend(getDb().prepare('SELECT * FROM schuljahre').all());
      return reply.viewEjs('teacher/dashboard_admin.ejs', { user: request.user, schuljahre });
    }
    // Faecher des Users, nach Klasse gruppiert. Kurse (ist_kurs=1) bekommen
    // eine eigene, klassenlose Rubrik statt unter ihrer unsichtbaren
    // Kurs-Hülle zu erscheinen (siehe /kurse/neu, klassen.ist_kurs_huelle) --
    // deren technischer Name (__kurshuelle_…) wäre als "Klassen"-Überschrift
    // nur verwirrend.
    const rows = getDb().prepare(`
      SELECT f.id, f.name, f.ist_kurs, f.halbjahre AS fach_halbjahre, fz.halbjahre AS zuw_halbjahre, k.id AS klasse_id, k.name AS klasse_name, k.notenschluessel,
             s.id AS schuljahr_id, s.bezeichnung AS schuljahr_bezeichnung,
             (SELECT COUNT(*) FROM klausuren kk WHERE kk.fach_id = f.id) AS anzahl_klausuren,
             (SELECT COUNT(*) FROM unterrichtsleistungen uu WHERE uu.fach_id = f.id) AS anzahl_uls
      FROM fach_zuweisungen fz
      JOIN faecher f ON f.id = fz.fach_id
      JOIN klassen k ON k.id = f.klasse_id
      JOIN schuljahre s ON s.id = k.schuljahr_id
      WHERE fz.user_id = ?
      ORDER BY s.bezeichnung DESC, k.name, f.name
    `).all(request.user.id);
    const byKlasse = new Map();
    const kurse = [];
    for (const r of rows) {
      // Nur bei einer auf einzelne Halbjahre begrenzten Zuordnung anzeigen, in welchen Halbjahren die Lehrkraft das Fach hat.
      let halbjahreText = null;
      if (r.zuw_halbjahre) {
        const laufzeit = klassenLaufzeit(r.klasse_id);
        const nummern = zuweisungsHalbjahre({ halbjahre: r.zuw_halbjahre }, { halbjahre: r.fach_halbjahre, klasse_id: r.klasse_id }, laufzeit);
        if (nummern.length < laufzeit.anzahlHalbjahre) halbjahreText = `${nummern.map((n) => `${n}.`).join(', ')} Halbjahr`;
      }
      const eintrag = { id: r.id, name: r.name, klasse_id: r.klasse_id, halbjahre: r.fach_halbjahre, anzahl_klausuren: r.anzahl_klausuren, anzahl_uls: r.anzahl_uls, halbjahreText };
      if (r.ist_kurs) {
        kurse.push({ ...eintrag, notenschluessel: r.notenschluessel, schuljahr_bezeichnung: r.schuljahr_bezeichnung });
        continue;
      }
      if (!byKlasse.has(r.klasse_id)) byKlasse.set(r.klasse_id, {
        id: r.klasse_id, name: r.klasse_name, notenschluessel: r.notenschluessel,
        schuljahr_bezeichnung: r.schuljahr_bezeichnung, faecher: [],
      });
      byKlasse.get(r.klasse_id).faecher.push(eintrag);
    }

    // Klassen alphabetisch nach Klassenname (bei gleichem Namen bleibt das neuere Schuljahr vorn).
    const klassenListe = sortiereNachName(Array.from(byKlasse.values()));
    for (const k of klassenListe) k.faecher = sortiereFaecher(k.faecher);
    return reply.viewEjs('teacher/dashboard.ejs', {
      user: request.user, byKlasse: klassenListe, kurse: sortiereNachName(kurse),
    });
  });

  // ---------- Fach-Detail (Noteneingabe) ----------
  fastify.get('/fach/:id', async (request, reply) => {
    const fach = ladeFachMitUmfeld(request.params.id);
    if (!fach) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Fach nicht gefunden.' });
    // Bewusst NUR die dem Fach zugewiesene Lehrkraft (nicht jede
    // Klassenleitung) -- die Live-Notentafel bleibt bis zum Sync unter
    // Kontrolle der Fachlehrkraft (siehe src/noten-sync.js). Eine
    // Klassenleitung ohne eigene Zuweisung trägt Endnoten vergangener
    // Halbjahre im Klassenleitungsbereich ein (Reiter "Endnoten").
    // Ausnahme: In einem Halbjahr, in dem sich das Fach aus Unterfächern
    // zusammensetzt, ist die (rein lesende) Zusammensetzungs-Seite auch für die
    // Lehrkräfte der Unterfächer und die Klassenleitung offen.
    const zusammensetzungHj = halbjahrFuerFach(fach, request.query?.hj);
    if (unterfaecherDesHalbjahrs(fach, zusammensetzungHj).length) {
      if (!userDarfZusammensetzungSehen(request.user, fach)) {
        return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
      }
      return renderZusammensetzung(request, reply, fach, zusammensetzungHj);
    }
    if (!userHatFachZgriff(request.user, fach.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    // Strikt je Halbjahr: nur die Halbjahre der Zuordnung (siehe src/unterfaecher.js).
    // Ein nicht erlaubtes (oder fehlendes) Halbjahr führt auf das nächstliegende erlaubte.
    const erlaubteHj = erlaubteHalbjahreImFach(request.user, fach.id);
    if (erlaubteHj && !userHatFachZgriff(request.user, fach.id, zusammensetzungHj)) {
      const gueltige = halbjahreFuerFach(fach).filter((h) => erlaubteHj.includes(halbjahrNr(h)));
      if (!gueltige.length) return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
      const ziel = halbjahrNr(zusammensetzungHj) ?? 1;
      const naechstes = gueltige.reduce((b, h) => (Math.abs(halbjahrNr(h) - ziel) < Math.abs(halbjahrNr(b) - ziel) ? h : b), gueltige[0]);
      const q = new URLSearchParams({ ...request.query, hj: naechstes });
      return reply.redirect(`/teacher/fach/${fach.id}?${q}`);
    }
    // SPA-Fächer werden wie IHK/BG über Klausuren und Unterrichtsleistung
    // (mündlich/schriftlich) bewertet, in Punkten 0-15 -- diese Seite ist die
    // normale Noteneingabe. Die Punkte speisen die Endnotentabelle des Fachs
    // (siehe src/spa-leistung.js); deren eigene Ansicht mit Komponenten,
    // Vorwerten und Tendenz (src/spa-noten-service.js, spa-schema.js) ist die
    // "Direkte Endnoteneingabe" (?ansicht=endnoten).
    if (fach.spa_fach_key && request.query?.ansicht === 'endnoten') {
      return renderSpaFachDetail(request, reply, fach);
    }
    const halbjahr = halbjahrFuerFach(fach, request.query?.hj);
    const uebersicht = ladeNotenuebersicht(fach, halbjahr);
    const zuweisung = getDb().prepare('SELECT auto_sync FROM fach_zuweisungen WHERE fach_id = ? AND user_id = ?')
      .get(fach.id, request.user.id);
    const syncMeta = holeSyncMeta(fach.id, halbjahr);
    const abschlussnoten = fach.abgeschlossen ? ladeAbschlussnoten(fach) : new Map();
    // Sperren über die Schüler-IDs statt "die eine Klasse" -- bei einem
    // klassenübergreifenden Kurs liegt die Sperre bei der jeweils EIGENEN
    // Klasse einer teilnehmenden Person (siehe fach_teilnehmer).
    const sperren = ladeSperrenFuerSchueler(uebersicht.schueler.map((s) => s.id), halbjahr);
    const teilnehmer = ladeTeilnehmerMitHerkunft(fach);
    // Anzahl der Unterrichtsnotizen je Person (Notizzettel-Symbol in der Datumstabelle).
    const unterrichtNotizAnzahl = {};
    for (const n of getDb().prepare(`
      SELECT schueler_id, COUNT(*) AS anzahl FROM notenbesprechung_notizen
      WHERE fach_id = ? AND halbjahr = ? AND typ = 'unterricht' GROUP BY schueler_id
    `).all(fach.id, halbjahr)) unterrichtNotizAnzahl[n.schueler_id] = n.anzahl;
    let spaLeistung = null;
    if (fach.spa_fach_key) {
      const hjNr = halbjahrNr(halbjahr);
      const schemaHj = spaSchemaFuerFach(getDb(), fach.id).schema.find((x) => x.halbjahr === hjNr);
      // Endpunkte/Tendenz laut Endnotentabelle (inkl. Vorwerten, Komponenten und Handeingaben) je Person.
      const endpunkte = new Map();
      for (const t of ladeTeilnehmerMitHerkunft(fach)) {
        const e = berechneSpaFachFuerSchueler(getDb(), fach.id, t.id).find((x) => x.halbjahr === hjNr) ?? null;
        endpunkte.set(t.id, e);
      }
      spaLeistung = {
        hjNr, schemaHj, ziel: leistungsZiel(getDb(), fach.id, hjNr), endpunkte,
        komponentenNamen: KOMPONENTEN_NAMEN, darfBearbeiten: userDarfFachBearbeiten(request.user, fach),
        verrechnungEinstellung: {
          werte: ladeVerrechnungFuerFach(fach), anzahlHalbjahre: klassenLaufzeit(fach.klasse_id).anzahlHalbjahre,
          darfAendern: userIstKlassenlehrer(request.user, fach.klasse_id),
        },
      };
    } else if (fach.spa_komponente) {
      // Vorgegebene SPA-Komponente (Unterfach): bewertet in Punkten; die Punkte füttern die Komponente des Elternfachs.
      const eltern = getDb().prepare('SELECT id, name FROM faecher WHERE id = ?').get(fach.parent_fach_id);
      spaLeistung = {
        hjNr: halbjahrNr(halbjahr), schemaHj: null, ziel: null, endpunkte: new Map(),
        komponentenNamen: KOMPONENTEN_NAMEN, darfBearbeiten: userDarfFachBearbeiten(request.user, fach),
        komponente: { name: fach.kurzname || fach.name, elternId: eltern.id, elternName: eltern.name },
      };
    }
    return reply.viewEjs('teacher/fach_detail.ejs', {
      HALBJAHRE: halbjahreFuerFach(fach).filter((h) => !erlaubteHj || erlaubteHj.includes(halbjahrNr(h))),
      HALBJAHR_SCHULJAHR: halbjahrSchuljahrMap(fach.klasse_id), spaLeistung, spaTendenz,
      user: request.user, fach, halbjahr,
      schueler: uebersicht.schueler, klausuren: uebersicht.klausuren, uls: uebersicht.uls,
      termine: uebersicht.termine, unterrichtNotizAnzahl,
      rows: uebersicht.rows, schriftlichPct: uebersicht.schriftlichPct, ulPct: uebersicht.ulPct, verrechnung: uebersicht.verrechnung,
      autoSync: Boolean(zuweisung?.auto_sync), syncMeta,
      abschlussnoten, sperren, teilnehmer,
    });
  });

  // Komponente wählen, in die die Leistungsnote aus Klausuren/Unterrichtsleistung
  // bei einem SPA-Fach mit Komponenten (z. B. LF2/LF3) einfließt -- leer = keine.
  fastify.post('/fach/:id/spa/leistung-ziel', async (request, reply) => {
    const fach = ladeFachMitUmfeld(request.params.id);
    if (!fach || !fach.spa_fach_key) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'SPA-Fach nicht gefunden.' });
    if (!userHatFachZgriff(request.user, fach.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    const hjNr = parseInt(request.body?.halbjahr, 10);
    const schemaHj = spaSchemaFuerFach(getDb(), fach.id).schema.find((x) => x.halbjahr === hjNr);
    const komponente = String(request.body?.komponente || '');
    if (schemaHj?.halbjahrModus === 'komponenten_gewichtet'
        && (komponente === '' || schemaHj.komponenten.some((k) => k.schluessel === komponente))) {
      setzeLeistungsZiel(getDb(), fach.id, hjNr, komponente);
      request.flash?.('success', komponente ? 'Die Leistungsnote fließt jetzt in diese Komponente ein.' : 'Die Leistungsnote fließt in keine Komponente ein.');
    } else {
      request.flash?.('error', 'Ungültige Komponente für dieses Halbjahr.');
    }
    return reply.redirect(`/teacher/fach/${fach.id}?hj=${hjNr}`);
  });

  // ---------- SPA-Eingabemaske (eigenes Bewertungsmodell, siehe oben) ----------
  fastify.get('/fach/:id/spa/daten', async (request, reply) => {
    const fach = ladeFachMitUmfeld(request.params.id);
    if (!fach || !fach.spa_fach_key) return reply.code(404).send({ error: 'not found' });
    if (!userHatFachZgriff(request.user, fach.id)) return reply.code(403).send({ error: 'forbidden' });
    const { schema } = spaSchemaFuerFach(getDb(), fach.id);
    const halbjahr = spaAktivesHalbjahr(schema, request.query);
    const teilnehmer = ladeTeilnehmerMitHerkunft(fach);
    const { zeilen, vorwertLabel } = spaZeilenFuerHalbjahr(fach, teilnehmer, halbjahr);
    return reply.send({
      halbjahr,
      vorwertLabel,
      schueler: zeilen.map((z) => ({
        schueler_id: z.schueler.id,
        zwischennote: z.ergebnis?.zwischennote ?? null,
        endpunkte: z.ergebnis?.endpunkte ?? null,
        tendenz: z.ergebnis?.tendenz ?? null,
        vorwert: z.vorwert ? { endpunkte: z.vorwert.endpunkte, tendenz: z.vorwert.tendenz } : null,
      })),
    });
  });

  fastify.post('/fach/:id/spa/eingabe', async (request, reply) => {
    const fach = ladeFachMitUmfeld(request.params.id);
    if (!fach || !fach.spa_fach_key) return reply.code(404).send({ ok: false, error: 'not found' });
    if (!userDarfFachBearbeiten(request.user, fach)) return reply.code(403).send({ ok: false, error: 'forbidden' });

    const schuelerId = parseInt(request.body?.schueler_id, 10);
    const halbjahr = parseInt(request.body?.halbjahr, 10);
    const { schema } = spaSchemaFuerFach(getDb(), fach.id);
    if (!Number.isFinite(schuelerId) || !schema.some((s) => s.halbjahr === halbjahr)) {
      return reply.code(400).send({ ok: false, error: 'bad params' });
    }
    if (istSchuelerGesperrtInFach(fach.id, schuelerId, String(halbjahr))) {
      return reply.code(403).send({ ok: false, error: 'gesperrt' });
    }

    const feld = String(request.body?.feld || '');
    const roh = request.body?.wert;
    const parsePunktwert = () => {
      if (roh === '' || roh === null || roh === undefined) return null;
      const n = Number(roh);
      return Number.isFinite(n) && n >= 0 && n <= 15 ? n : undefined; // undefined = ungültig
    };
    const db = getDb();
    const sicherstellenZeile = () => db.prepare(`
      INSERT INTO spa_eingaben (fach_id, schueler_id, halbjahr) VALUES (?, ?, ?)
      ON CONFLICT(fach_id, schueler_id, halbjahr) DO NOTHING
    `).run(fach.id, schuelerId, halbjahr);

    if (feld === 'direktwert' || feld === 'pruefungswert') {
      const wert = parsePunktwert();
      if (wert === undefined) return reply.code(400).send({ ok: false, error: 'Punktwert außerhalb 0–15.' });
      sicherstellenZeile();
      db.prepare(`UPDATE spa_eingaben SET ${feld} = ? WHERE fach_id = ? AND schueler_id = ? AND halbjahr = ?`)
        .run(wert, fach.id, schuelerId, halbjahr);
    } else if (feld === 'ist_na') {
      sicherstellenZeile();
      db.prepare('UPDATE spa_eingaben SET ist_na = ? WHERE fach_id = ? AND schueler_id = ? AND halbjahr = ?')
        .run(roh === '1' ? 1 : 0, fach.id, schuelerId, halbjahr);
    } else if (feld.startsWith('komponente:')) {
      const schluessel = feld.slice('komponente:'.length);
      const schemaHj = schema.find((s) => s.halbjahr === halbjahr);
      if (!schemaHj?.komponenten.some((k) => k.schluessel === schluessel)) {
        return reply.code(400).send({ ok: false, error: 'unbekannte Komponente' });
      }
      const wert = parsePunktwert();
      if (wert === undefined) return reply.code(400).send({ ok: false, error: 'Punktwert außerhalb 0–15.' });
      if (wert === null) {
        db.prepare(`
          DELETE FROM spa_komponenten_noten
          WHERE fach_id = ? AND schueler_id = ? AND halbjahr = ? AND komponente_schluessel = ?
        `).run(fach.id, schuelerId, halbjahr, schluessel);
      } else {
        db.prepare(`
          INSERT INTO spa_komponenten_noten (fach_id, schueler_id, halbjahr, komponente_schluessel, punkte)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(fach_id, schueler_id, halbjahr, komponente_schluessel) DO UPDATE SET punkte = excluded.punkte
        `).run(fach.id, schuelerId, halbjahr, schluessel, wert);
      }
    } else {
      return reply.code(400).send({ ok: false, error: 'unbekanntes Feld' });
    }
    return reply.send({ ok: true });
  });

  // WPK-Kursname (z. B. "Krippe (U3)") ist eine Eigenschaft des ganzen Fachs,
  // nicht je Schüler/in -- eigener, kleiner Endpunkt statt Überladung von
  // /spa/eingabe.
  fastify.post('/fach/:id/spa/wpk-kurs', async (request, reply) => {
    const fach = ladeFachMitUmfeld(request.params.id);
    if (!fach || fach.spa_fach_key !== 'WPK') return reply.code(404).send({ ok: false, error: 'not found' });
    if (!userDarfFachBearbeiten(request.user, fach)) return reply.code(403).send({ ok: false, error: 'forbidden' });
    const kurs = String(request.body?.kurs || '').trim().slice(0, 100);
    getDb().prepare('UPDATE faecher SET spa_wpk_kurs = ? WHERE id = ?').run(kurs || null, fach.id);
    return reply.send({ ok: true });
  });

  // ---------- Sync mit Klassenleitung ----------
  fastify.post('/fach/:id/sync', async (request, reply) => {
    if (!userHatFachZgriff(request.user, request.params.id)) return reply.code(403).send({ error: 'forbidden' });
    const halbjahr = halbjahrFuerFachId(request.params.id, request.body?.halbjahr);
    syncFach(request.params.id, halbjahr, request.user.id);
    request.flash?.('success', 'Noten mit der Klassenleitung synchronisiert.');
    return reply.redirect(`/teacher/fach/${request.params.id}?hj=${halbjahr}`);
  });

  fastify.post('/fach/:id/auto-sync', async (request, reply) => {
    if (!userHatFachZgriff(request.user, request.params.id)) return reply.code(403).send({ error: 'forbidden' });
    const halbjahr = halbjahrFuerFachId(request.params.id, request.body?.halbjahr);
    const aktiv = request.body?.aktiv === '1';
    getDb().prepare('UPDATE fach_zuweisungen SET auto_sync = ? WHERE fach_id = ? AND user_id = ?')
      .run(aktiv ? 1 : 0, request.params.id, request.user.id);
    if (aktiv) syncFach(request.params.id, halbjahr, request.user.id); // sofort auf aktuellen Stand bringen
    return reply.redirect(`/teacher/fach/${request.params.id}?hj=${halbjahr}`);
  });

  // ---------- Noten-API (JSON für Live-Aktualisierung) ----------
  fastify.get('/fach/:id/noten', async (request, reply) => {
    const fach = ladeFachMitUmfeld(request.params.id);
    if (!fach) return reply.code(404).send({ error: 'not found' });
    if (!userHatFachZgriff(request.user, fach.id)) return reply.code(403).send({ error: 'forbidden' });
    const halbjahr = halbjahrFuerFachId(request.params.id, request.query?.hj);
    const uebersicht = ladeNotenuebersicht(fach, halbjahr);
    return reply.send({
      schueler: uebersicht.rows, halbjahr, csv_typ: fach.notenschluessel,
      schriftlich_pct: uebersicht.schriftlichPct, ul_pct: uebersicht.ulPct,
    });
  });

  // ---------- Notenbesprechungsmodus (eine Schüler:in nach der anderen) ----------
  fastify.get('/fach/:id/besprechung/:schuelerId', async (request, reply) => {
    const fach = ladeFachMitUmfeld(request.params.id);
    if (!fach) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Fach nicht gefunden.' });
    if (!userHatFachZgriff(request.user, fach.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    const halbjahr = halbjahrFuerFachId(fach.id, request.query?.hj);
    const uebersicht = ladeNotenuebersicht(fach, halbjahr);
    const idx = uebersicht.rows.findIndex((r) => r.schueler_id === Number(request.params.schuelerId));
    if (idx === -1) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Schüler/in nicht in diesem Fach.' });
    const zeile = uebersicht.rows[idx];
    const notizen = getDb().prepare(`
      SELECT n.*, u.display_name, u.username FROM notenbesprechung_notizen n
      LEFT JOIN users u ON u.id = n.created_by_id
      WHERE n.schueler_id = ? AND n.halbjahr = ? AND (n.fach_id = ? OR n.fach_id IS NULL)
      ORDER BY n.created_at DESC
    `).all(zeile.schueler_id, halbjahr, fach.id);
    return reply.viewEjs('teacher/notenbesprechung.ejs', {
      user: request.user, fach, halbjahr, HALBJAHRE: halbjahreFuerFach(fach), HALBJAHR_SCHULJAHR: halbjahrSchuljahrMap(fach.klasse_id), zeile, notizen,
      vorherige: idx > 0 ? uebersicht.rows[idx - 1] : null,
      naechste: idx < uebersicht.rows.length - 1 ? uebersicht.rows[idx + 1] : null,
      position: idx + 1, anzahl: uebersicht.rows.length,
    });
  });

  fastify.post('/fach/:id/besprechung/:schuelerId/notiz', async (request, reply) => {
    if (!userHatFachZgriff(request.user, request.params.id)) return reply.code(403).send({ error: 'forbidden' });
    const halbjahr = halbjahrFuerFachId(request.params.id, request.body?.halbjahr);
    const typ = ['konferenz', 'unterricht'].includes(request.body?.typ) ? request.body.typ : 'besprechung';
    const text = String(request.body?.text || '').trim();
    if (text) {
      getDb().prepare(`
        INSERT INTO notenbesprechung_notizen (schueler_id, fach_id, halbjahr, typ, text, created_by_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(request.params.schuelerId, typ === 'konferenz' ? null : request.params.id, halbjahr, typ, text, request.user.id);
    }
    return reply.redirect(`/teacher/fach/${request.params.id}/besprechung/${request.params.schuelerId}?hj=${encodeURIComponent(halbjahr)}`);
  });

  // ---------- Direkte Endnoteneingabe (je Fach, Person und Halbjahr) ----------
  // Ersetzt die berechnete Halbjahresnote (siehe src/halbjahr-endnoten.js).
  // Fachlehrkräfte tragen sie auf der Fachseite ein, die Klassenleitung im
  // Klassenleitungsbereich (siehe /klassen/:id/endnote). Eine Notenkonferenz-
  // Sperre der Person für dieses Halbjahr verhindert die Eingabe -- sie muss
  // erst entsperrt werden.
  function speichereEndnote(request, reply, fach, { schuelerId, halbjahr, wert }) {
    if (!ladeTeilnehmerMitHerkunft(fach).some((t) => t.id === schuelerId)) {
      return reply.code(404).send({ ok: false, error: 'Person nimmt nicht an diesem Fach teil.' });
    }
    if (istSchuelerGesperrtInFach(fach.id, schuelerId, halbjahr)) {
      return reply.code(403).send({ ok: false, error: 'Die Noten dieser Person sind für dieses Halbjahr gesperrt (Notenkonferenz) -- die Klassenleitung muss erst entsperren.' });
    }
    const ergebnis = setzeEndnote(fach.id, schuelerId, halbjahr, wert, notenBereich(fach.notenschluessel), request.user.id);
    if (!ergebnis.ok) return reply.code(400).send({ ok: false, error: ergebnis.fehler });
    syncFallsAutoAktiv(fach.id, halbjahr, request.user.id);
    return reply.send({ ok: true, note: ergebnis.note, ntg: ergebnis.ntg });
  }

  fastify.post('/fach/:id/endnote', async (request, reply) => {
    const fach = ladeFachMitUmfeld(request.params.id);
    if (!fach) return reply.code(404).send({ ok: false, error: 'not found' });
    const halbjahr = halbjahrFuerFach(fach, request.body?.halbjahr);
    if (!userHatFachZgriff(request.user, fach.id, halbjahr) && !userIstKlassenlehrer(request.user, fach.klasse_id)) {
      return reply.code(403).send({ ok: false, error: 'forbidden' });
    }
    const schuelerId = parseInt(request.body?.schueler_id, 10);
    if (!Number.isFinite(schuelerId)) return reply.code(400).send({ ok: false, error: 'bad params' });
    return speichereEndnote(request, reply, fach, { schuelerId, halbjahr, wert: request.body?.wert });
  });

  // Klassenleitung: Endnoten vergangener Halbjahre direkt eintragen (Raster im
  // Klassenleitungsbereich). Nur für Halbjahre, die schon vorbei sind, und nur,
  // solange die Person nicht durch die Notenkonferenz gesperrt ist.
  fastify.post('/klassen/:id/endnote', async (request, reply) => {
    const klasse = getDb().prepare('SELECT id FROM klassen WHERE id = ?').get(request.params.id);
    if (!klasse) return reply.code(404).send({ ok: false, error: 'not found' });
    if (!userIstKlassenlehrer(request.user, klasse.id)) return reply.code(403).send({ ok: false, error: 'forbidden' });
    const halbjahr = halbjahrFuerKlasseId(klasse.id, request.body?.halbjahr);
    if (!istHalbjahrVergangen(klassenLaufzeit(klasse.id), halbjahrNr(halbjahr), jetzt())) {
      return reply.code(400).send({ ok: false, error: 'Die Klassenleitung kann Endnoten nur für vergangene Halbjahre direkt eintragen.' });
    }
    const fachId = parseInt(request.body?.fach_id, 10);
    const schuelerId = parseInt(request.body?.schueler_id, 10);
    const fach = ladeFachMitUmfeld(fachId);
    if (!fach || !Number.isFinite(schuelerId) || !ladeFaecherFuerKlassenleitung(klasse.id).some((f) => f.id === fach.id)) {
      return reply.code(404).send({ ok: false, error: 'Fach nicht in dieser Klasse.' });
    }
    if (!fachGiltInHalbjahr(fach, halbjahr)) {
      return reply.code(400).send({ ok: false, error: 'Das Fach gilt in diesem Halbjahr nicht.' });
    }
    return speichereEndnote(request, reply, fach, { schuelerId, halbjahr, wert: request.body?.wert });
  });

  // ---------- Notizen zur Unterrichtsleistung (Notizzettel in der Datumstabelle) ----------
  // Je Person, Fach und Halbjahr, als Verlauf (nichts wird überschrieben). Sie
  // erscheinen auch in der Notenbesprechung (typ 'unterricht').
  const unterrichtNotizen = (schuelerId, fachId, halbjahr, userId, isAdmin) =>
    getDb().prepare(`
      SELECT n.id, n.text, n.created_at, n.created_by_id, u.display_name, u.username
      FROM notenbesprechung_notizen n LEFT JOIN users u ON u.id = n.created_by_id
      WHERE n.schueler_id = ? AND n.fach_id = ? AND n.halbjahr = ? AND n.typ = 'unterricht'
      ORDER BY n.created_at DESC, n.id DESC
    `).all(schuelerId, fachId, halbjahr).map((n) => ({
      id: n.id, text: n.text, von: n.display_name || n.username || 'unbekannt',
      am: formatZeitLokal(n.created_at), loeschbar: isAdmin || n.created_by_id === userId,
    }));
  const unterrichtNotizKontext = (request, reply) => {
    const fach = ladeFachMitUmfeld(request.params.id);
    if (!fach) { reply.code(404).send({ ok: false, error: 'not found' }); return null; }
    if (!userHatFachZgriff(request.user, fach.id)) { reply.code(403).send({ ok: false, error: 'forbidden' }); return null; }
    const schuelerId = parseInt(request.params.schuelerId, 10);
    if (!ladeTeilnehmerMitHerkunft(fach).some((t) => t.id === schuelerId)) {
      reply.code(404).send({ ok: false, error: 'not found' });
      return null;
    }
    return { fach, schuelerId, halbjahr: halbjahrFuerFachId(fach.id, request.query?.hj ?? request.body?.halbjahr) };
  };

  fastify.get('/fach/:id/unterricht/notizen/:schuelerId', async (request, reply) => {
    const ctx = unterrichtNotizKontext(request, reply);
    if (!ctx) return;
    return reply.send({ ok: true, notizen: unterrichtNotizen(ctx.schuelerId, ctx.fach.id, ctx.halbjahr, request.user.id, request.user.isAdmin) });
  });

  fastify.post('/fach/:id/unterricht/notizen/:schuelerId', async (request, reply) => {
    const ctx = unterrichtNotizKontext(request, reply);
    if (!ctx) return;
    const text = String(request.body?.text || '').trim().slice(0, 4000);
    if (!text) return reply.code(400).send({ ok: false, error: 'leer' });
    getDb().prepare(`
      INSERT INTO notenbesprechung_notizen (schueler_id, fach_id, halbjahr, typ, text, created_by_id)
      VALUES (?, ?, ?, 'unterricht', ?, ?)
    `).run(ctx.schuelerId, ctx.fach.id, ctx.halbjahr, text, request.user.id);
    return reply.send({ ok: true, notizen: unterrichtNotizen(ctx.schuelerId, ctx.fach.id, ctx.halbjahr, request.user.id, request.user.isAdmin) });
  });

  fastify.post('/unterricht/notizen/:noteId/loeschen', async (request, reply) => {
    const n = getDb().prepare("SELECT * FROM notenbesprechung_notizen WHERE id = ? AND typ = 'unterricht'").get(request.params.noteId);
    if (!n) return reply.code(404).send({ ok: false, error: 'not found' });
    if (!userHatFachZgriff(request.user, n.fach_id, n.halbjahr)) return reply.code(403).send({ ok: false, error: 'forbidden' });
    if (!request.user.isAdmin && n.created_by_id !== request.user.id) return reply.code(403).send({ ok: false, error: 'forbidden' });
    getDb().prepare('DELETE FROM notenbesprechung_notizen WHERE id = ?').run(n.id);
    return reply.send({ ok: true, notizen: unterrichtNotizen(n.schueler_id, n.fach_id, n.halbjahr, request.user.id, request.user.isAdmin) });
  });

  // ---------- Klausuren ----------
  fastify.post('/fach/:id/klausuren/neu', async (request, reply) => {
    if (!userHatFachZgriff(request.user, request.params.id)) return reply.code(403).send({ error: 'forbidden' });
    const halbjahr = halbjahrFuerFachId(request.params.id, request.body?.halbjahr);
    const name = String(request.body?.name || '').trim();
    const aufgaben = Math.max(1, parseInt(request.body?.aufgaben, 10) || 1);
    const datum = alsGueltigesDatumOderNull(request.body?.datum);
    if (!name) return reply.redirect(`/teacher/fach/${request.params.id}?hj=${halbjahr}`);
    const info = getDb().prepare(`INSERT INTO klausuren (fach_id, halbjahr, name, datum, max_punkte_pro_aufgabe, gewichtung)
                     VALUES (?, ?, ?, ?, ?, 0)`)
      .run(request.params.id, halbjahr, name, datum, JSON.stringify(Array(aufgaben).fill(1)));
    autoVerteileKlausuren(request.params.id, halbjahr, { erzwingen: true });
    syncFallsAutoAktiv(request.params.id, halbjahr, request.user.id);
    // Direkt auf die neu angelegte Klausur springen (siehe ?tab=/?open=
    // Handling in fach_detail.ejs) -- Punkte können dann sofort eingetragen
    // werden, statt erst wieder zum passenden Reiter klicken zu müssen.
    return reply.redirect(`/teacher/fach/${request.params.id}?hj=${halbjahr}&tab=klausuren&open=klausur-panel-${info.lastInsertRowid}`);
  });

  fastify.post('/klausuren/:id/loeschen', async (request, reply) => {
    const k = getDb().prepare('SELECT fach_id, halbjahr FROM klausuren WHERE id = ?').get(request.params.id);
    if (!k) return reply.redirect('/teacher');
    if (!userHatFachZgriff(request.user, k.fach_id, k.halbjahr)) return reply.code(403).send({ error: 'forbidden' });
    getDb().prepare('DELETE FROM klausuren WHERE id = ?').run(request.params.id);
    autoVerteileKlausuren(k.fach_id, k.halbjahr);
    syncFallsAutoAktiv(k.fach_id, k.halbjahr, request.user.id);
    return reply.redirect(`/teacher/fach/${k.fach_id}?hj=${encodeURIComponent(k.halbjahr)}`);
  });

  fastify.post('/klausuren/:id/gewichtung', async (request, reply) => {
    const k = getDb().prepare('SELECT fach_id, halbjahr FROM klausuren WHERE id = ?').get(request.params.id);
    if (!k) return reply.redirect('/teacher');
    if (!userHatFachZgriff(request.user, k.fach_id, k.halbjahr)) return reply.code(403).send({ error: 'forbidden' });
    const gw = Number(request.body?.gewichtung) || 0;
    getDb().prepare('UPDATE klausuren SET gewichtung = ? WHERE id = ?').run(gw, request.params.id);
    syncFallsAutoAktiv(k.fach_id, k.halbjahr, request.user.id);
    return reply.redirect(`/teacher/fach/${k.fach_id}?hj=${encodeURIComponent(k.halbjahr)}`);
  });

  fastify.post('/klausuren/:id/datum', async (request, reply) => {
    const k = getDb().prepare('SELECT fach_id, halbjahr FROM klausuren WHERE id = ?').get(request.params.id);
    if (!k) return reply.redirect('/teacher');
    if (!userHatFachZgriff(request.user, k.fach_id, k.halbjahr)) return reply.code(403).send({ error: 'forbidden' });
    const datum = alsGueltigesDatumOderNull(request.body?.datum);
    getDb().prepare('UPDATE klausuren SET datum = ? WHERE id = ?').run(datum, request.params.id);
    return reply.redirect(`/teacher/fach/${k.fach_id}?hj=${encodeURIComponent(k.halbjahr)}`);
  });

  fastify.post('/klausuren/:id/maxpunkte', async (request, reply) => {
    const k = getDb().prepare('SELECT fach_id, halbjahr, max_punkte_pro_aufgabe, teile FROM klausuren WHERE id = ?').get(request.params.id);
    if (!k) return reply.redirect('/teacher');
    if (!userHatFachZgriff(request.user, k.fach_id, k.halbjahr)) return reply.code(403).send({ error: 'forbidden' });
    // Bei einer mehrteiligen Klausur passen sich die Teile an die neue
    // Aufgabenzahl an (siehe passeTeileAnAufgabenzahl) -- Aufgaben kommen zum
    // letzten Teil dazu bzw. werden von hinten abgezogen.
    const teileInfo = parseKlausurTeile(k.teile);
    const anzahl = Math.max(1, Math.min(40, parseInt(request.body?.anzahl_aufgaben, 10) || JSON.parse(k.max_punkte_pro_aufgabe).length));
    if (teileInfo) {
      const angepasst = passeTeileAnAufgabenzahl(teileInfo, anzahl);
      getDb().prepare('UPDATE klausuren SET teile = ? WHERE id = ?')
        .run(angepasst ? JSON.stringify(angepasst) : null, request.params.id);
    }
    const neueWerte = [];
    for (let i = 0; i < anzahl; i++) {
      neueWerte.push(Number(request.body?.['mp_' + i]) || 1);
    }
    getDb().prepare('UPDATE klausuren SET max_punkte_pro_aufgabe = ? WHERE id = ?')
      .run(JSON.stringify(neueWerte), request.params.id);
    // bestehende Ergebnisse anpassen
    const ergebnisse = getDb().prepare('SELECT id, punkte FROM klausur_ergebnisse WHERE klausur_id = ?').all(request.params.id);
    for (const e of ergebnisse) {
      const arr = JSON.parse(e.punkte);
      if (arr.length !== anzahl) {
        const extended = arr.slice(0, anzahl);
        while (extended.length < anzahl) extended.push(null);
        getDb().prepare('UPDATE klausur_ergebnisse SET punkte = ? WHERE id = ?')
          .run(JSON.stringify(extended), e.id);
      }
    }
    syncFallsAutoAktiv(k.fach_id, k.halbjahr, request.user.id);
    return reply.redirect(`/teacher/fach/${k.fach_id}?hj=${encodeURIComponent(k.halbjahr)}`);
  });

  // Mehrteilige Klausur einrichten/ändern: Teile mit Namen, Aufgabenzahl und
  // prozentualer Gewichtung; optional bestimmt EIN Teil die beste erreichbare
  // Gesamtnote (siehe klausurNote in src/grade-calc.js). Die Aufgaben bleiben
  // eine gemeinsame Liste -- die Teile gruppieren sie nur der Reihe nach.
  // Schreibt die Teile (null = einteilig) und bringt Max-Punkte-Liste sowie die
  // eingetragenen Punkte auf die Gesamt-Aufgabenzahl (vorhandene Werte bleiben).
  function schreibeTeile(request, k, teileObj, gesamtAufgaben) {
    const id = request.params.id;
    const alteMax = JSON.parse(k.max_punkte_pro_aufgabe);
    const neueMax = Array.from({ length: gesamtAufgaben }, (_, i) => alteMax[i] ?? 1);
    getDb().prepare('UPDATE klausuren SET teile = ?, max_punkte_pro_aufgabe = ? WHERE id = ?')
      .run(teileObj ? JSON.stringify(teileObj) : null, JSON.stringify(neueMax), id);
    for (const e of getDb().prepare('SELECT id, punkte FROM klausur_ergebnisse WHERE klausur_id = ?').all(id)) {
      const arr = JSON.parse(e.punkte).slice(0, gesamtAufgaben);
      while (arr.length < gesamtAufgaben) arr.push(null);
      getDb().prepare('UPDATE klausur_ergebnisse SET punkte = ? WHERE id = ?').run(JSON.stringify(arr), e.id);
    }
    syncFallsAutoAktiv(k.fach_id, k.halbjahr, request.user.id);
  }

  fastify.post('/klausuren/:id/teile', async (request, reply) => {
    const k = getDb().prepare('SELECT fach_id, halbjahr, max_punkte_pro_aufgabe FROM klausuren WHERE id = ?').get(request.params.id);
    if (!k) return reply.redirect('/teacher');
    if (!userHatFachZgriff(request.user, k.fach_id, k.halbjahr)) return reply.code(403).send({ error: 'forbidden' });
    const zurueck = `/teacher/fach/${k.fach_id}?hj=${encodeURIComponent(k.halbjahr)}&tab=klausuren&open=klausur-panel-${request.params.id}`;
    const liste = (roh) => (Array.isArray(roh) ? roh : [roh]);

    // "Einteilig machen": Teile entfernen, die Aufgaben bleiben unverändert.
    if (request.body?.einteilig === '1') {
      getDb().prepare('UPDATE klausuren SET teile = NULL WHERE id = ?').run(request.params.id);
      syncFallsAutoAktiv(k.fach_id, k.halbjahr, request.user.id);
      request.flash?.('success', 'Klausur ist wieder einteilig.');
      return reply.redirect(zurueck);
    }

    const namen = liste(request.body?.teil_name);
    const aufgabenRoh = liste(request.body?.teil_aufgaben);
    const gewichtungen = liste(request.body?.teil_gewichtung);
    const bestimmendRoh = request.body?.bestimmend;
    const bestimmendZeile = bestimmendRoh === undefined || bestimmendRoh === '' ? null : parseInt(bestimmendRoh, 10);
    const teile = [];
    let bestimmend = null;
    const zeilen = Math.min(Math.max(namen.length, aufgabenRoh.length, gewichtungen.length), MAX_KLAUSUR_TEILE);
    for (let i = 0; i < zeilen; i++) {
      const leer = (v) => v === undefined || String(v).trim() === '';
      if (leer(namen[i]) && leer(aufgabenRoh[i]) && leer(gewichtungen[i])) continue; // komplett leere Zeile = kein Teil
      // Eine nicht (mehr) lesbare Aufgabenzahl zählt als 1, damit das Löschen einer Ziffer keinen Teil verschwinden lässt.
      const aufgaben = Math.max(1, parseInt(aufgabenRoh[i], 10) || 1);
      const gewichtung = Number(String(gewichtungen[i] ?? '').replace(',', '.'));
      if (bestimmendZeile === i) bestimmend = teile.length;
      teile.push({
        name: String(namen[i] ?? '').trim() || `Teil ${teile.length + 1}`,
        aufgaben: Math.min(aufgaben, 20),
        gewichtung: Number.isFinite(gewichtung) && gewichtung >= 0 ? gewichtung : 0,
      });
    }
    const gesamtAufgaben = teile.reduce((a, t) => a + t.aufgaben, 0);
    if (teile.length < 2 || gesamtAufgaben > 40 || teile.reduce((a, t) => a + t.gewichtung, 0) <= 0) {
      request.flash?.('error', 'Eine mehrteilige Klausur braucht mindestens zwei Teile mit je mindestens einer Aufgabe und einer Gewichtung über 0 %.');
      return reply.redirect(zurueck);
    }

    schreibeTeile(request, k, { teile, bestimmend }, gesamtAufgaben);
    request.flash?.('success', 'Teile der Klausur gespeichert.');
    return reply.redirect(zurueck);
  });

  // Anzahl der Teile ändern (1 = einteilig). Verteilt die Aufgaben bzw. ergänzt/
  // entfernt Teile, siehe passeTeileAnTeilzahl.
  fastify.post('/klausuren/:id/teile-anzahl', async (request, reply) => {
    const k = getDb().prepare('SELECT fach_id, halbjahr, max_punkte_pro_aufgabe, teile FROM klausuren WHERE id = ?').get(request.params.id);
    if (!k) return reply.redirect('/teacher');
    if (!userHatFachZgriff(request.user, k.fach_id, k.halbjahr)) return reply.code(403).send({ error: 'forbidden' });
    const zurueck = `/teacher/fach/${k.fach_id}?hj=${encodeURIComponent(k.halbjahr)}&tab=klausuren&open=klausur-panel-${request.params.id}`;
    const anzahl = Math.max(1, Math.min(MAX_KLAUSUR_TEILE, parseInt(request.body?.anzahl_teile, 10) || 1));
    const aktuell = JSON.parse(k.max_punkte_pro_aufgabe).length;
    const neu = passeTeileAnTeilzahl(parseKlausurTeile(k.teile), aktuell, anzahl);
    const gesamt = neu ? neu.teile.reduce((a, t) => a + t.aufgaben, 0) : aktuell;
    if (gesamt > 40) {
      request.flash?.('error', 'Eine Klausur kann höchstens 40 Aufgaben haben.');
      return reply.redirect(zurueck);
    }
    schreibeTeile(request, k, neu, gesamt);
    return reply.redirect(zurueck);
  });

  fastify.post('/klausuren/:id/punkte', async (request, reply) => {
    const k = getDb().prepare('SELECT fach_id, halbjahr, max_punkte_pro_aufgabe FROM klausuren WHERE id = ?').get(request.params.id);
    if (!k) return reply.code(404).send({ ok: false, error: 'not found' });
    if (!userHatFachZgriff(request.user, k.fach_id, k.halbjahr)) return reply.code(403).send({ ok: false, error: 'forbidden' });
    const maxArr = JSON.parse(k.max_punkte_pro_aufgabe);
    const schuelerId = parseInt(request.body?.schueler_id, 10);
    const idx = parseInt(request.body?.aufgabe_idx, 10);
    if (!Number.isFinite(schuelerId) || !Number.isFinite(idx) || idx < 0 || idx >= maxArr.length) {
      return reply.code(400).send({ ok: false, error: 'bad params' });
    }
    if (istSchuelerGesperrtInFach(k.fach_id, schuelerId, k.halbjahr)) {
      return reply.code(403).send({ ok: false, error: 'gesperrt' });
    }
    let wert = null;
    if (request.body?.wert !== '' && request.body?.wert !== null && request.body?.wert !== undefined) {
      wert = Number(request.body.wert);
      if (!Number.isFinite(wert) || wert < 0 || wert > maxArr[idx]) {
        return reply.code(400).send({ ok: false, error: 'Punktwert außerhalb des Bereichs' });
      }
    }
    const existing = getDb().prepare(
      'SELECT id, punkte FROM klausur_ergebnisse WHERE klausur_id = ? AND schueler_id = ?'
    ).get(request.params.id, schuelerId);
    let arr;
    if (existing) {
      arr = JSON.parse(existing.punkte);
      if (arr.length !== maxArr.length) {
        while (arr.length < maxArr.length) arr.push(null);
        arr = arr.slice(0, maxArr.length);
      }
      arr[idx] = wert;
      getDb().prepare('UPDATE klausur_ergebnisse SET punkte = ? WHERE id = ?')
        .run(JSON.stringify(arr), existing.id);
    } else {
      arr = new Array(maxArr.length).fill(null);
      arr[idx] = wert;
      getDb().prepare('INSERT INTO klausur_ergebnisse (klausur_id, schueler_id, punkte) VALUES (?, ?, ?)')
        .run(request.params.id, schuelerId, JSON.stringify(arr));
    }
    syncFallsAutoAktiv(k.fach_id, k.halbjahr, request.user.id);
    return reply.send({ ok: true });
  });

  // ---------- Unterrichtsleistungen ----------
  fastify.post('/fach/:id/uls/neu', async (request, reply) => {
    if (!userHatFachZgriff(request.user, request.params.id)) return reply.code(403).send({ error: 'forbidden' });
    const halbjahr = halbjahrFuerFachId(request.params.id, request.body?.halbjahr);
    const name = String(request.body?.name || '').trim();
    const aufgaben = Math.max(1, parseInt(request.body?.aufgaben, 10) || 1);
    const datum = alsGueltigesDatumOderNull(request.body?.datum);
    if (!name) return reply.redirect(`/teacher/fach/${request.params.id}?hj=${halbjahr}`);
    // Gewichtung ist beim Anlegen optional angebbar (Standard weiterhin 0,
    // also uncounted, wenn nichts eingetragen wird) -- keine automatische
    // Verteilung: eine Zusatzleistung zählt erst, wenn die Lehrkraft ihr
    // ausdrücklich einen Anteil am Unterrichtsleistungs-Topf gibt — der Rest
    // entfällt sonst automatisch auf die Datumstabelle (siehe
    // unterrichtsleistungNote() in grade-calc.js).
    const gewichtung = Math.min(100, Math.max(0, Number(request.body?.gewichtung) || 0));
    const info = getDb().prepare(`INSERT INTO unterrichtsleistungen (fach_id, halbjahr, name, datum, max_punkte_pro_aufgabe, gewichtung)
                     VALUES (?, ?, ?, ?, ?, ?)`)
      .run(request.params.id, halbjahr, name, datum, JSON.stringify(Array(aufgaben).fill(1)), gewichtung);
    syncFallsAutoAktiv(request.params.id, halbjahr, request.user.id);
    // Direkt auf die neu angelegte Zusatzleistung springen (siehe ?tab=/?open=
    // Handling in fach_detail.ejs) -- Punkte können dann sofort eingetragen
    // werden, statt erst wieder zum passenden Reiter klicken zu müssen.
    return reply.redirect(`/teacher/fach/${request.params.id}?hj=${halbjahr}&tab=uls&open=ul-panel-${info.lastInsertRowid}`);
  });

  fastify.post('/uls/:id/loeschen', async (request, reply) => {
    const u = getDb().prepare('SELECT fach_id, halbjahr FROM unterrichtsleistungen WHERE id = ?').get(request.params.id);
    if (!u) return reply.redirect('/teacher');
    if (!userHatFachZgriff(request.user, u.fach_id, u.halbjahr)) return reply.code(403).send({ error: 'forbidden' });
    getDb().prepare('DELETE FROM unterrichtsleistungen WHERE id = ?').run(request.params.id);
    syncFallsAutoAktiv(u.fach_id, u.halbjahr, request.user.id);
    return reply.redirect(`/teacher/fach/${u.fach_id}?hj=${encodeURIComponent(u.halbjahr)}`);
  });

  fastify.post('/uls/:id/gewichtung', async (request, reply) => {
    const u = getDb().prepare('SELECT fach_id, halbjahr FROM unterrichtsleistungen WHERE id = ?').get(request.params.id);
    if (!u) return reply.redirect('/teacher');
    if (!userHatFachZgriff(request.user, u.fach_id, u.halbjahr)) return reply.code(403).send({ error: 'forbidden' });
    const gw = Number(request.body?.gewichtung) || 0;
    getDb().prepare('UPDATE unterrichtsleistungen SET gewichtung = ? WHERE id = ?').run(gw, request.params.id);
    syncFallsAutoAktiv(u.fach_id, u.halbjahr, request.user.id);
    return reply.redirect(`/teacher/fach/${u.fach_id}?hj=${encodeURIComponent(u.halbjahr)}`);
  });

  fastify.post('/uls/:id/datum', async (request, reply) => {
    const u = getDb().prepare('SELECT fach_id, halbjahr FROM unterrichtsleistungen WHERE id = ?').get(request.params.id);
    if (!u) return reply.redirect('/teacher');
    if (!userHatFachZgriff(request.user, u.fach_id, u.halbjahr)) return reply.code(403).send({ error: 'forbidden' });
    const datum = alsGueltigesDatumOderNull(request.body?.datum);
    getDb().prepare('UPDATE unterrichtsleistungen SET datum = ? WHERE id = ?').run(datum, request.params.id);
    return reply.redirect(`/teacher/fach/${u.fach_id}?hj=${encodeURIComponent(u.halbjahr)}`);
  });

  fastify.post('/uls/:id/maxpunkte', async (request, reply) => {
    const u = getDb().prepare('SELECT fach_id, halbjahr, max_punkte_pro_aufgabe FROM unterrichtsleistungen WHERE id = ?').get(request.params.id);
    if (!u) return reply.redirect('/teacher');
    if (!userHatFachZgriff(request.user, u.fach_id, u.halbjahr)) return reply.code(403).send({ error: 'forbidden' });
    const anzahl = Math.max(1, parseInt(request.body?.anzahl_aufgaben, 10) || JSON.parse(u.max_punkte_pro_aufgabe).length);
    const neueWerte = [];
    for (let i = 0; i < anzahl; i++) neueWerte.push(Number(request.body?.['mp_' + i]) || 1);
    getDb().prepare('UPDATE unterrichtsleistungen SET max_punkte_pro_aufgabe = ? WHERE id = ?')
      .run(JSON.stringify(neueWerte), request.params.id);
    const ergebnisse = getDb().prepare('SELECT id, punkte FROM ul_ergebnisse WHERE ul_id = ?').all(request.params.id);
    for (const e of ergebnisse) {
      const arr = JSON.parse(e.punkte);
      if (arr.length !== anzahl) {
        const extended = arr.slice(0, anzahl);
        while (extended.length < anzahl) extended.push(null);
        getDb().prepare('UPDATE ul_ergebnisse SET punkte = ? WHERE id = ?')
          .run(JSON.stringify(extended), e.id);
      }
    }
    syncFallsAutoAktiv(u.fach_id, u.halbjahr, request.user.id);
    return reply.redirect(`/teacher/fach/${u.fach_id}?hj=${encodeURIComponent(u.halbjahr)}`);
  });

  fastify.post('/uls/:id/punkte', async (request, reply) => {
    const u = getDb().prepare('SELECT fach_id, halbjahr, max_punkte_pro_aufgabe FROM unterrichtsleistungen WHERE id = ?').get(request.params.id);
    if (!u) return reply.code(404).send({ ok: false, error: 'not found' });
    if (!userHatFachZgriff(request.user, u.fach_id, u.halbjahr)) return reply.code(403).send({ ok: false, error: 'forbidden' });
    const maxArr = JSON.parse(u.max_punkte_pro_aufgabe);
    const schuelerId = parseInt(request.body?.schueler_id, 10);
    const idx = parseInt(request.body?.aufgabe_idx, 10);
    if (!Number.isFinite(schuelerId) || !Number.isFinite(idx) || idx < 0 || idx >= maxArr.length) {
      return reply.code(400).send({ ok: false, error: 'bad params' });
    }
    if (istSchuelerGesperrtInFach(u.fach_id, schuelerId, u.halbjahr)) {
      return reply.code(403).send({ ok: false, error: 'gesperrt' });
    }
    let wert = null;
    if (request.body?.wert !== '' && request.body?.wert !== null && request.body?.wert !== undefined) {
      wert = Number(request.body.wert);
      if (!Number.isFinite(wert) || wert < 0 || wert > maxArr[idx]) {
        return reply.code(400).send({ ok: false, error: 'Punktwert außerhalb des Bereichs' });
      }
    }
    const existing = getDb().prepare(
      'SELECT id, punkte FROM ul_ergebnisse WHERE ul_id = ? AND schueler_id = ?'
    ).get(request.params.id, schuelerId);
    let arr;
    if (existing) {
      arr = JSON.parse(existing.punkte);
      if (arr.length !== maxArr.length) {
        while (arr.length < maxArr.length) arr.push(null);
        arr = arr.slice(0, maxArr.length);
      }
      arr[idx] = wert;
      getDb().prepare('UPDATE ul_ergebnisse SET punkte = ? WHERE id = ?')
        .run(JSON.stringify(arr), existing.id);
    } else {
      arr = new Array(maxArr.length).fill(null);
      arr[idx] = wert;
      getDb().prepare('INSERT INTO ul_ergebnisse (ul_id, schueler_id, punkte) VALUES (?, ?, ?)')
        .run(request.params.id, schuelerId, JSON.stringify(arr));
    }
    syncFallsAutoAktiv(u.fach_id, u.halbjahr, request.user.id);
    return reply.send({ ok: true });
  });

  // ---------- Datumstabelle (Unterrichtsleistung ohne Einzelgewichtung) ----------
  fastify.post('/fach/:id/unterricht/termine/neu', async (request, reply) => {
    if (!userHatFachZgriff(request.user, request.params.id)) return reply.code(403).send({ error: 'forbidden' });
    const halbjahr = halbjahrFuerFachId(request.params.id, request.body?.halbjahr);
    const datum = String(request.body?.datum || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) {
      request.flash?.('error', 'Ungültiges Datum.');
      return reply.redirect(`/teacher/fach/${request.params.id}?hj=${halbjahr}`);
    }
    getDb().prepare('INSERT INTO unterricht_termine (fach_id, halbjahr, datum) VALUES (?, ?, ?)')
      .run(request.params.id, halbjahr, datum);
    return reply.redirect(`/teacher/fach/${request.params.id}?hj=${halbjahr}`);
  });

  fastify.post('/unterricht/termine/:id/loeschen', async (request, reply) => {
    const t = getDb().prepare('SELECT fach_id, halbjahr FROM unterricht_termine WHERE id = ?').get(request.params.id);
    if (!t) return reply.redirect('/teacher');
    if (!userHatFachZgriff(request.user, t.fach_id, t.halbjahr)) return reply.code(403).send({ error: 'forbidden' });
    getDb().prepare('DELETE FROM unterricht_termine WHERE id = ?').run(request.params.id);
    syncFallsAutoAktiv(t.fach_id, t.halbjahr, request.user.id);
    return reply.redirect(`/teacher/fach/${t.fach_id}?hj=${encodeURIComponent(t.halbjahr)}`);
  });

  fastify.post('/unterricht/termine/:id/note', async (request, reply) => {
    const t = getDb().prepare('SELECT fach_id, halbjahr FROM unterricht_termine WHERE id = ?').get(request.params.id);
    if (!t) return reply.code(404).send({ ok: false, error: 'not found' });
    if (!userHatFachZgriff(request.user, t.fach_id, t.halbjahr)) return reply.code(403).send({ ok: false, error: 'forbidden' });
    const schuelerId = parseInt(request.body?.schueler_id, 10);
    if (!Number.isFinite(schuelerId)) return reply.code(400).send({ ok: false, error: 'bad params' });
    if (istSchuelerGesperrtInFach(t.fach_id, schuelerId, t.halbjahr)) {
      return reply.code(403).send({ ok: false, error: 'gesperrt' });
    }
    const fach = ladeFachMitUmfeld(t.fach_id);
    const [min, max] = fach.notenschluessel === 'BG' ? [0, 15] : [1, 6];
    // Eingabe: leer = nichts eingetragen, Zahl im Notenbereich = Note, alles
    // andere ("n.a.", Text, Zahl außerhalb des Bereichs) = n.a. (nicht anwesend).
    const roh = String(request.body?.wert ?? '').trim();
    let wert = null;
    let na = 0;
    if (roh !== '') {
      const zahl = /^[+-]?\d+([.,]\d+)?$/.test(roh) ? Number(roh.replace(',', '.')) : NaN;
      if (Number.isFinite(zahl) && zahl >= min && zahl <= max) wert = zahl;
      else na = 1;
    }
    getDb().prepare(`
      INSERT INTO unterricht_noten (termin_id, schueler_id, wert, nicht_anwesend) VALUES (?, ?, ?, ?)
      ON CONFLICT(termin_id, schueler_id) DO UPDATE SET wert = excluded.wert, nicht_anwesend = excluded.nicht_anwesend
    `).run(request.params.id, schuelerId, wert, na);
    syncFallsAutoAktiv(t.fach_id, t.halbjahr, request.user.id);
    return reply.send({ ok: true, wert, na: Boolean(na) });
  });

  // ---------- Notensperre: Entsperrung anfragen (Fachlehrkraft) ----------
  fastify.post('/fach/:id/sperre/:schuelerId/anfragen', async (request, reply) => {
    const fach = ladeFachMitUmfeld(request.params.id);
    if (!fach) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Fach nicht gefunden.' });
    if (!userHatFachZgriff(request.user, fach.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    const halbjahr = halbjahrFuerFach(fach, request.body?.halbjahr);
    const grund = String(request.body?.grund || '').trim();
    const gefunden = aufhebungAnfragen(fach.klasse_id, request.params.schuelerId, halbjahr, request.user.id, grund);
    request.flash?.(gefunden ? 'success' : 'error',
      gefunden ? 'Entsperrung angefragt — die Klassenleitung wurde informiert.' : 'Keine Sperre gefunden.');
    return reply.redirect(`/teacher/fach/${fach.id}?hj=${encodeURIComponent(halbjahr)}`);
  });

  // ---------- Selbstbedienung: Klassen anlegen/verwalten ohne Admin-Zuweisung ----------
  // Jede angemeldete Lehrkraft kann eigene Klassen anlegen (Ersteller/in
  // behält automatisch Zugriff, siehe userHatKlassenZugriff). Eine spätere
  // Zuweisung weiterer Lehrkräfte über Admin → Zuweisungen bleibt optional.

  fastify.get('/klassen', async (request, reply) => {
    const db = getDb();
    const schuljahre = sortiereSchuljahreAbsteigend(db.prepare('SELECT * FROM schuljahre').all());
    const schuljahreReiter = sortiereSchuljahreFuerReiter(schuljahre);
    const klassen = ladeMeineKlassen(request.user.id);
    const klassenNachSchuljahr = new Map();
    for (const sj of schuljahreReiter) klassenNachSchuljahr.set(sj.id, []);
    // Sammelklassen "Ohne Klasse" mit Personen sind für alle Lehrkräfte sichtbar.
    const sichtbareKlassen = [...klassen];
    const ablagen = db.prepare(`
      SELECT k.*, s.bezeichnung AS schuljahr_bezeichnung FROM klassen k
      JOIN schuljahre s ON s.id = k.schuljahr_id
      WHERE k.ist_ablage = 1 AND EXISTS (SELECT 1 FROM schueler sc WHERE sc.klasse_id = k.id)
    `).all();
    for (const a of ablagen) if (!sichtbareKlassen.some((k) => k.id === a.id)) sichtbareKlassen.push(a);
    // Eine Klasse läuft über mehrere Schuljahre (siehe src/klassen-jahre.js) und
    // erscheint im Reiter jedes Schuljahres ihrer Laufzeit.
    const schuljahrStart = new Map(schuljahreReiter.map((sj) => [sj.id, parseSchuljahr(sj.bezeichnung)?.startJahr]));
    for (const k of sichtbareKlassen) {
      const laufzeit = klassenLaufzeit(k.id);
      for (const sj of schuljahreReiter) {
        const start = schuljahrStart.get(sj.id);
        if (sj.id === k.schuljahr_id || (start !== undefined && klasseLaeuftImSchuljahr(laufzeit, start))) {
          klassenNachSchuljahr.get(sj.id)?.push(k);
        }
      }
    }

    // Kurse (siehe ladeMeineKurse) bekommen in "Meine Klassen" eine eigene
    // Rubrik neben den echten Klassen -- gleiches Gruppieren nach Schuljahr,
    // aber getrennte Map, damit die View beides unterscheidbar rendern kann.
    const kurse = ladeMeineKurse(request.user.id)
      .map((k) => ({ ...k, darfLoeschen: userDarfFachLoeschen(request.user, k) }));
    const kurseNachSchuljahr = new Map();
    for (const sj of schuljahreReiter) kurseNachSchuljahr.set(sj.id, []);
    for (const k of kurse) kurseNachSchuljahr.get(k.schuljahr_id)?.push(k);

    // Bereits vorhandene Klassen (aller Lehrkräfte), denen man noch nicht angehört -- "Vorhandene Klasse wählen"
    // übernimmt Schuljahr, Notenschlüssel, Einschulungsjahr und Laufzeit dieser Klasse unverändert und führt
    // in den Beitritt (siehe klassen-verknuepfung.js). Kurs-Hüllen sind keine echten Klassen.
    const vorhandeneKlassen = db.prepare(`
      SELECT k.id, k.name, k.notenschluessel, s.bezeichnung AS schuljahr_bezeichnung
      FROM klassen k JOIN schuljahre s ON s.id = k.schuljahr_id
      WHERE k.ist_kurs_huelle = 0 AND k.ist_ablage = 0 ORDER BY s.bezeichnung DESC, k.name
    `).all().filter((k) => !userHatKlassenZugriff(request.user, k.id));

    return reply.viewEjs('teacher/klassen_liste.ejs', {
      user: request.user, schuljahre, schuljahreReiter, klassenNachSchuljahr, klassen: sichtbareKlassen,
      kurseNachSchuljahr, bildungsgaenge: BILDUNGSGAENGE, jahresOptionen: jahresOptionen(),
      kannSelbstKlasseAnlegen: userDarfSelbstKlasseAnlegen(request.user), vorhandeneKlassen,
    });
  });

  fastify.post('/klassen/neu', async (request, reply) => {
    if (!userDarfSelbstKlasseAnlegen(request.user)) {
      request.flash?.('error', 'Nur Lehrkräfte mit LDAP-Zugang können eigene Klassen anlegen. Bitte eine Klassenleitung oder den Admin bitten, dich einem Fach zuzuweisen.');
      return reply.redirect('/teacher/klassen');
    }
    // "Vorhandene Klasse wählen": nichts wird neu angelegt oder eingestellt -- Schuljahr, Notenschlüssel,
    // Einschulungsjahr und Laufzeit gehören der bestehenden Klasse, man tritt ihr bei.
    if (request.body?.vorhandene_klasse_id !== undefined) {
      const vorhanden = getDb().prepare('SELECT id FROM klassen WHERE id = ? AND ist_kurs_huelle = 0 AND ist_ablage = 0')
        .get(parseInt(request.body.vorhandene_klasse_id, 10));
      if (!vorhanden) {
        request.flash?.('error', 'Bitte eine vorhandene Klasse auswählen.');
        return reply.redirect('/teacher/klassen');
      }
      return reply.redirect(userHatKlassenZugriff(request.user, vorhanden.id)
        ? `/teacher/klassen/${vorhanden.id}`
        : `/teacher/klassen/${vorhanden.id}/verknuepfen`);
    }
    const schuljahrId = parseInt(request.body?.schuljahr_id, 10);
    const name = String(request.body?.name || '').trim();
    let ns = String(request.body?.notenschluessel || 'IHK');
    if (!['IHK', 'BG', 'SPA'].includes(ns)) ns = 'IHK';
    // SPA-Klassen (Sozialpädagogische Assistenz) brauchen zusätzlich den
    // Bildungsgang -- der bestimmt, welche festen Fächer/Komponenten/
    // Gewichte gelten (siehe src/spa-schema.js) und wird beim Anlegen
    // einmalig festgelegt (nicht nachträglich änderbar, da er die gesamte
    // Fächerstruktur bestimmt).
    let spaBildungsgang = null;
    if (ns === 'SPA') {
      spaBildungsgang = String(request.body?.spa_bildungsgang || '');
      if (!BILDUNGSGAENGE.some((b) => b.schluessel === spaBildungsgang)) {
        request.flash?.('error', 'Bitte einen Bildungsgang für die SPA-Klasse auswählen.');
        return reply.redirect('/teacher/klassen');
      }
    }
    // Erlaubt anderen Lehrkräften später einen sofortigen Beitritt bei
    // Namenskollision, ohne Zustimmung einzuholen (siehe klassen-verknuepfung.js).
    const offenFuerBeitritt = request.body?.offen_fuer_beitritt === '1' ? 1 : 0;
    if (!schuljahrId || !name) {
      request.flash?.('error', 'Schuljahr und Name sind erforderlich.');
      return reply.redirect('/teacher/klassen');
    }
    // Gibt es diese Klasse schon (läuft sie im gewählten Schuljahr)? Dann nicht doppelt anlegen, sondern beitreten.
    const laufende = findeLaufendeKlasse(name, schuljahrId);
    if (laufende) {
      request.flash?.('error', `Die Klasse „${name}" gibt es schon (${laufende.notenschluessel}) -- sie wurde nicht doppelt angelegt.`);
      return reply.redirect(userHatKlassenZugriff(request.user, laufende.id)
        ? `/teacher/klassen/${laufende.id}`
        : `/teacher/klassen/${laufende.id}/verknuepfen`);
    }
    try {
      // Laufzeit: Einschulung (Standard: gewähltes Schuljahr) und Abschluss (Standard: SPA 2, sonst 3 Jahre).
      const heimatJahr = parseSchuljahr(getDb().prepare('SELECT bezeichnung FROM schuljahre WHERE id = ?').get(schuljahrId)?.bezeichnung)?.startJahr ?? null;
      const einschulungJahr = parseJahrEingabe(request.body?.einschulung_jahr) ?? heimatJahr;
      const dauer = parseInt(request.body?.anzahl_jahre, 10);
      let abschlussJahr = Number.isFinite(dauer) && dauer >= 1 && einschulungJahr !== null
        ? einschulungJahr + dauer - 1
        : parseJahrEingabe(request.body?.abschluss_jahr);
      if (abschlussJahr !== null && einschulungJahr !== null && (abschlussJahr < einschulungJahr || abschlussJahr >= einschulungJahr + MAX_SCHULJAHRE)) abschlussJahr = null;
      const info = getDb().prepare(`
        INSERT INTO klassen (schuljahr_id, name, notenschluessel, notenschluessel_csv, created_by_id, offen_fuer_beitritt, spa_bildungsgang, einschulung_jahr, abschluss_jahr)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(schuljahrId, name, ns, DEFAULT_NS_CSV[ns] || '', request.user.id, offenFuerBeitritt, spaBildungsgang, einschulungJahr, abschlussJahr);
      const klasseId = info.lastInsertRowid;
      if (ns === 'SPA') seedeSpaFaecher(getDb(), klasseId, spaBildungsgang, request.user.id);
      return reply.redirect(`/teacher/klassen/${klasseId}`);
    } catch (e) {
      // Name in diesem Schuljahr bereits vergeben → statt Fehlermeldung zum
      // Beitritt weiterleiten, damit die Klasse nicht doppelt entsteht.
      const bestehend = getDb().prepare('SELECT id FROM klassen WHERE schuljahr_id = ? AND name = ?')
        .get(schuljahrId, name);
      if (bestehend) return reply.redirect(`/teacher/klassen/${bestehend.id}/verknuepfen`);
      request.flash?.('error', 'Klasse existiert in diesem Schuljahr bereits.');
      return reply.redirect('/teacher/klassen');
    }
  });

  // ---------- Laufzeit der Klasse (Einschulungs-/Abschlussschuljahr) ----------
  // Bestimmt, über wie viele Schuljahre/Halbjahre die Klasse läuft (siehe
  // src/klassen-jahre.js). Leer = Standard (Einschulung: Schuljahr der Klasse,
  // Abschluss: SPA zwei, sonst drei Jahre). Nur Klassenleitung/Admin.
  fastify.post('/klassen/:id/laufzeit', async (request, reply) => {
    const klasse = getDb().prepare('SELECT * FROM klassen WHERE id = ?').get(request.params.id);
    if (!klasse) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Klasse nicht gefunden.' });
    if (!userIstKlassenlehrer(request.user, klasse.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die Klassenleitung oder der Admin dürfen die Laufzeit ändern.' });
    }
    const zurueck = `/teacher/klassen/${klasse.id}`;
    const heimat = parseSchuljahr(getDb().prepare('SELECT bezeichnung FROM schuljahre WHERE id = ?').get(klasse.schuljahr_id)?.bezeichnung)?.startJahr ?? null;
    const einschulung = parseJahrEingabe(request.body?.einschulung_jahr) ?? heimat;
    // Dauer in Jahren (z. B. 2 oder 3) hat Vorrang vor einem direkt gewählten Abschlussschuljahr; leer = Standard.
    const anzahlJahre = parseInt(request.body?.anzahl_jahre, 10);
    const abschluss = Number.isFinite(anzahlJahre) && anzahlJahre >= 1 && einschulung !== null
      ? einschulung + anzahlJahre - 1
      : parseJahrEingabe(request.body?.abschluss_jahr);
    if (einschulung === null) {
      request.flash?.('error', 'Einschulungsschuljahr ungültig.');
      return reply.redirect(zurueck);
    }
    if (abschluss !== null && (abschluss < einschulung || abschluss >= einschulung + MAX_SCHULJAHRE)) {
      request.flash?.('error', `Das Abschlussschuljahr muss zwischen dem Einschulungsschuljahr und ${MAX_SCHULJAHRE - 1} Jahren danach liegen.`);
      return reply.redirect(zurueck);
    }
    // Nicht kürzen, wenn in den wegfallenden Halbjahren schon Daten stehen.
    const standardJahre = klasse.notenschluessel === 'SPA' ? 2 : 3;
    const neueHalbjahre = ((abschluss ?? (einschulung + standardJahre - 1)) - einschulung + 1) * 2;
    const hatDaten = (tabelle) => getDb().prepare(`
      SELECT halbjahr FROM ${tabelle} t JOIN faecher f ON f.id = t.fach_id WHERE f.klasse_id = ?
    `).all(klasse.id).some((r) => (halbjahrNr(r.halbjahr) ?? 0) > neueHalbjahre);
    if (['klausuren', 'unterrichtsleistungen', 'unterricht_termine'].some(hatDaten)) {
      request.flash?.('error', 'In Halbjahren, die dabei wegfallen würden, sind bereits Noten oder Leistungen eingetragen. Das Abschlussschuljahr kann nicht davor liegen.');
      return reply.redirect(zurueck);
    }
    getDb().prepare('UPDATE klassen SET einschulung_jahr = ?, abschluss_jahr = ? WHERE id = ?').run(einschulung, abschluss, klasse.id);
    request.flash?.('success', 'Laufzeit der Klasse gespeichert.');
    return reply.redirect(zurueck);
  });

  // ---------- Verrechnung der Halbjahresnoten je Fach (Prozent je Übergang) ----------
  // p_<n> = Prozent der Note aus Halbjahr n, die in Halbjahr n+1 einfließen
  // (0 = gar nicht). Gilt für das Fach (nicht für Unterfächer -- sie fließen
  // gewichtet ins Fach, das selbst verrechnet). SPA-Fächer: die Leistungspunkte
  // des Vorhalbjahres fließen ein (siehe src/spa-leistung.js), nur je Fach.
  // Mit "fuer_alle" für alle Nicht-SPA-Fächer der Klasse. Nur Klassenleitung/Admin.
  fastify.post('/faecher/:id/verrechnung', async (request, reply) => {
    const fach = getDb().prepare('SELECT * FROM faecher WHERE id = ?').get(request.params.id);
    if (!fach) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Fach nicht gefunden.' });
    if (!userIstKlassenlehrer(request.user, fach.klasse_id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die Klassenleitung oder der Admin dürfen die Verrechnung ändern.' });
    }
    // SPA-Fächer stellen die Verrechnung auf ihrer Fachseite (Noteneingabe) ein, alle anderen auf der Klassenseite.
    const zurueck = fach.spa_fach_key
      ? `/teacher/fach/${fach.id}?hj=${encodeURIComponent(halbjahrFuerFach(fach, request.body?.halbjahr))}`
      : `/teacher/klassen/${fach.klasse_id}#verrechnung`;
    if (fach.parent_fach_id) {
      request.flash?.('error', 'Für Unterfächer gibt es keine eigene Verrechnung -- sie gilt für das Fach.');
      return reply.redirect(zurueck);
    }
    const eingabe = parseVerrechnungEingabe(request.body, klassenLaufzeit(fach.klasse_id));
    if (eingabe.fehler) {
      request.flash?.('error', eingabe.fehler);
      return reply.redirect(zurueck);
    }
    const werte = eingabe.werte;
    // Immer als eigene Einstellung speichern ("{}" = bewusst keine Verrechnung), damit die Klassen-Vorgabe nicht durchschlägt.
    const json = JSON.stringify(werte);
    if (request.body?.fuer_alle === '1') {
      getDb().prepare('UPDATE faecher SET verrechnung = ? WHERE klasse_id = ? AND parent_fach_id IS NULL AND spa_fach_key IS NULL').run(json, fach.klasse_id);
    } else {
      getDb().prepare('UPDATE faecher SET verrechnung = ? WHERE id = ?').run(json, fach.id);
    }
    // Die Sync-Stände sind damit veraltet -- Fachlehrkräfte mit Auto-Sync aktualisieren sich bei der nächsten Eingabe.
    request.flash?.('success', request.body?.fuer_alle === '1' ? 'Verrechnung für alle Fächer gespeichert.' : `Verrechnung für „${fach.name}" gespeichert.`);
    return reply.redirect(zurueck);
  });

  // ---------- Beitritt zu einer bereits bestehenden Klasse (Namenskollision) ----------
  fastify.get('/klassen/:id/verknuepfen', async (request, reply) => {
    const klasse = getDb().prepare(`
      SELECT k.*, s.bezeichnung AS schuljahr_bezeichnung
      FROM klassen k JOIN schuljahre s ON s.id = k.schuljahr_id WHERE k.id = ?
    `).get(request.params.id);
    if (!klasse) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Klasse nicht gefunden.' });
    if (userHatKlassenZugriff(request.user, klasse.id)) return reply.redirect(`/teacher/klassen/${klasse.id}`);
    if (!userDarfSelbstKlasseAnlegen(request.user)) {
      return reply.code(403).viewEjs('error.ejs', {
        code: 403, message: 'Nur Lehrkräfte mit LDAP-Zugang können sich selbst einer Klasse zuordnen. Bitte eine Klassenleitung oder den Admin bitten, dich einem Fach zuzuweisen.',
      });
    }
    const verbundene = ermittleVerbundenePersonen(klasse.id);
    verbundene.delete(request.user.id);
    const kannBeitreten = verbundene.size === 0 || Boolean(klasse.offen_fuer_beitritt);
    return reply.viewEjs('teacher/klasse_verknuepfen.ejs', { user: request.user, klasse, kannBeitreten });
  });

  fastify.post('/klassen/:id/verknuepfen', async (request, reply) => {
    const klasse = getDb().prepare('SELECT id FROM klassen WHERE id = ?').get(request.params.id);
    if (!klasse) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Klasse nicht gefunden.' });
    if (!userDarfSelbstKlasseAnlegen(request.user)) {
      return reply.code(403).viewEjs('error.ejs', {
        code: 403, message: 'Nur Lehrkräfte mit LDAP-Zugang können sich selbst einer Klasse zuordnen. Bitte eine Klassenleitung oder den Admin bitten, dich einem Fach zuzuweisen.',
      });
    }
    const fach = String(request.body?.fach || '').trim();
    if (!fach) {
      request.flash?.('error', 'Bitte ein Fach angeben.');
      return reply.redirect(`/teacher/klassen/${klasse.id}/verknuepfen`);
    }
    const ergebnis = starteVerknuepfung({
      klasseId: klasse.id, angefragtVonId: request.user.id, vorgeschlagenesFach: fach,
    });
    if (ergebnis.direkterBeitritt) {
      request.flash?.('success', `Zugriff erhalten — dein Fach „${fach}".`);
      return reply.redirect(`/teacher/klassen/${klasse.id}`);
    }
    if (ergebnis.fachExistiert) {
      request.flash?.('error', `Das Fach „${fach}" gibt es in dieser Klasse schon und gehört einer anderen Lehrkraft. Bitte die Klassenleitung oder den Admin, dich zuzuordnen — oder einen anderen Fachnamen wählen.`);
      // Wer schon (über ein anderes Fach) dabei ist, landet auf der Klassenseite
      // -- die Beitrittsseite würde ohnehin dorthin weiterleiten.
      return reply.redirect(userHatKlassenZugriff(request.user, klasse.id)
        ? `/teacher/klassen/${klasse.id}` : `/teacher/klassen/${klasse.id}/verknuepfen`);
    }
    request.flash?.('error', 'Diese Klasse ist nicht für automatischen Beitritt freigegeben. Bitte die Klassenleitung oder den Admin um Zuweisung bitten.');
    return reply.redirect('/teacher/klassen');
  });

  // ---------- Freigabe für automatischen Beitritt nachträglich umschalten ----------
  fastify.post('/klassen/:id/offen-fuer-beitritt', async (request, reply) => {
    if (!userIstKlassenlehrer(request.user, request.params.id)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const offen = request.body?.offen === '1' ? 1 : 0;
    getDb().prepare('UPDATE klassen SET offen_fuer_beitritt = ? WHERE id = ?').run(offen, request.params.id);
    return reply.redirect(`/teacher/klassen/${request.params.id}`);
  });

  // ---------- Halbjahresübersicht (Klassenleitung/Admin) ----------
  // Zeigt NUR den zuletzt synchronisierten Stand (fach_sync_stand), nie
  // Live-Werte — das ist genau der Punkt des Sync-Mechanismus.
  fastify.get('/klassen/:id/uebersicht', async (request, reply) => {
    const klasse = getDb().prepare(`
      SELECT k.*, s.bezeichnung AS schuljahr_bezeichnung
      FROM klassen k JOIN schuljahre s ON s.id = k.schuljahr_id WHERE k.id = ?
    `).get(request.params.id);
    if (!klasse) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Klasse nicht gefunden.' });
    if (!userIstKlassenlehrer(request.user, klasse.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die Klassenleitung oder der Admin haben Zugriff auf die Übersicht.' });
    }
    const halbjahr = halbjahrFuerKlasseId(klasse.id, request.query?.hj);
    const { faecher, zeilen, syncMeta, sperren } = ladeHalbjahresuebersicht(klasse, halbjahr);

    return reply.viewEjs('teacher/klasse_uebersicht.ejs', {
      user: request.user, klasse, halbjahr, HALBJAHRE: halbjahreFuerKlasse(klasse.id), HALBJAHR_SCHULJAHR: halbjahrSchuljahrMap(klasse.id), faecher, zeilen, syncMeta, sperren,
    });
  });

  // ---------- Zeugnisübersicht für SPA-Klassen (Klassenleitung/Admin) ----------
  // Eigene, live berechnete Übersicht statt der obigen sync-basierten
  // Halbjahresübersicht -- SPA hat weder Klausuren/ULs noch einen
  // Sync-Mechanismus, dafür 4 statt 2 Halbjahre und (im 4. Hj.) das
  // Abschlusszeugnis mit Prüfungsblock (siehe spa-noten-service.js).
  fastify.get('/klassen/:id/zeugnis', async (request, reply) => {
    const klasse = getDb().prepare(`
      SELECT k.*, s.bezeichnung AS schuljahr_bezeichnung
      FROM klassen k JOIN schuljahre s ON s.id = k.schuljahr_id WHERE k.id = ?
    `).get(request.params.id);
    if (!klasse) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Klasse nicht gefunden.' });
    if (klasse.notenschluessel !== 'SPA') {
      return reply.code(404).viewEjs('error.ejs', {
        code: 404, message: 'Die Zeugnisübersicht gibt es nur für SPA-Klassen -- für andere Notenschlüssel siehe die Halbjahresübersicht der Klassenleitung.',
      });
    }
    if (!userIstKlassenlehrer(request.user, klasse.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die Klassenleitung oder der Admin haben Zugriff auf die Zeugnisübersicht.' });
    }
    let halbjahr = parseInt(request.query?.hj, 10);
    if (![1, 2, 3, 4].includes(halbjahr)) halbjahr = 1;
    const zeilen = zeugnisMitQuellen(getDb(), klasse, halbjahr);
    return reply.viewEjs('teacher/klasse_zeugnis_spa.ejs', {
      user: request.user, klasse, halbjahr, zeilen,
    });
  });

  // ---------- SPA-Abschlusszeugnis: Quellfächer je Person wählen ----------
  // Jede Zeugnisposition (Lernfeld/Fach) lässt sich pro Person aus beliebigen
  // ihrer Fächer zusammenstellen -- auch aus früheren Klassen (siehe
  // src/spa-zeugnis-quellen.js).
  function ladeSpaKlasseFuerQuellen(request, reply) {
    const klasse = getDb().prepare(`
      SELECT k.*, s.bezeichnung AS schuljahr_bezeichnung
      FROM klassen k JOIN schuljahre s ON s.id = k.schuljahr_id WHERE k.id = ?
    `).get(request.params.id);
    if (!klasse || klasse.notenschluessel !== 'SPA') {
      reply.code(404).viewEjs('error.ejs', { code: 404, message: 'SPA-Klasse nicht gefunden.' });
      return null;
    }
    if (!userIstKlassenlehrer(request.user, klasse.id)) {
      reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die Klassenleitung oder der Admin darf das Abschlusszeugnis zusammenstellen.' });
      return null;
    }
    return klasse;
  }

  fastify.get('/klassen/:id/zeugnis/:schuelerId/quellen', async (request, reply) => {
    const klasse = ladeSpaKlasseFuerQuellen(request, reply);
    if (!klasse) return reply;
    const daten = ladeQuellenSeite(getDb(), klasse, Number(request.params.schuelerId));
    if (!daten) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Schüler/in nicht in dieser Klasse.' });
    return reply.viewEjs('teacher/zeugnis_quellen.ejs', { user: request.user, klasse, ...daten });
  });

  fastify.post('/klassen/:id/zeugnis/:schuelerId/quellen', async (request, reply) => {
    const klasse = ladeSpaKlasseFuerQuellen(request, reply);
    if (!klasse) return reply;
    const schuelerId = Number(request.params.schuelerId);
    if (!ladeQuellenSeite(getDb(), klasse, schuelerId)) {
      return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Schüler/in nicht in dieser Klasse.' });
    }
    if (request.body?.zuruecksetzen === '1') {
      loescheQuellenAuswahl(getDb(), schuelerId);
      request.flash?.('success', 'Auswahl zurückgesetzt -- das Abschlusszeugnis nutzt wieder die Fächer der aktuellen Klasse.');
    } else {
      const roh = request.body?.quelle;
      speichereQuellenAuswahl(getDb(), klasse, schuelerId, Array.isArray(roh) ? roh : (roh ? [roh] : []));
      request.flash?.('success', 'Zusammenstellung des Abschlusszeugnisses gespeichert.');
    }
    return reply.redirect(`/teacher/klassen/${klasse.id}/zeugnis/${schuelerId}/quellen`);
  });

  // ---------- Abschluss-/Abgangsübersicht (Klassenleitung/Admin) ----------
  // Fasst die Fachabschlussnoten aller (abgeschlossenen) Fächer
  // zusammen — für Fächer, die nicht abgeschlossen wurden, gibt es keine
  // Abschlussnote (siehe src/fach-abschluss.js, bewusst optional).
  fastify.get('/klassen/:id/abschluss', async (request, reply) => {
    const klasse = getDb().prepare(`
      SELECT k.*, s.bezeichnung AS schuljahr_bezeichnung
      FROM klassen k JOIN schuljahre s ON s.id = k.schuljahr_id WHERE k.id = ?
    `).get(request.params.id);
    if (!klasse) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Klasse nicht gefunden.' });
    if (!userIstKlassenlehrer(request.user, klasse.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die Klassenleitung oder der Admin haben Zugriff auf die Abschlussübersicht.' });
    }
    const { faecher, zeilen } = ladeAbschlussuebersicht(klasse.id);

    return reply.viewEjs('teacher/klasse_abschluss.ejs', { user: request.user, klasse, faecher, zeilen });
  });

  // ---------- Konferenzmodus (eine Schüler:in nach der anderen, klassenweit) ----------
  // Wie die Notenbesprechung (siehe oben), aber für die Klassenleitung: zeigt
  // alle Fächer im Sync-Stand (nie Live-Werte, siehe Kommentar oben) und
  // erlaubt, die Note je Fach als Konferenz-Entscheidung zu überschreiben
  // sowie klassenweite Notizen zu hinterlegen.
  fastify.get('/klassen/:id/konferenz/:schuelerId', async (request, reply) => {
    const klasse = getDb().prepare(`
      SELECT k.*, s.bezeichnung AS schuljahr_bezeichnung
      FROM klassen k JOIN schuljahre s ON s.id = k.schuljahr_id WHERE k.id = ?
    `).get(request.params.id);
    if (!klasse) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Klasse nicht gefunden.' });
    if (!userIstKlassenlehrer(request.user, klasse.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die Klassenleitung oder der Admin haben Zugriff auf den Konferenzmodus.' });
    }
    const halbjahr = halbjahrFuerKlasseId(klasse.id, request.query?.hj);
    const db = getDb();
    const schuelerListe = db.prepare('SELECT * FROM schueler WHERE klasse_id = ? ORDER BY nachname, vorname').all(klasse.id);
    const idx = schuelerListe.findIndex((s) => s.id === Number(request.params.schuelerId));
    if (idx === -1) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Schüler/in nicht in dieser Klasse.' });
    const schueler = schuelerListe[idx];
    // Nur Fächer, an denen DIESE Person tatsächlich teilnimmt (kann bei
    // klassenübergreifenden Kursen von "alle Fächer der Klasse" abweichen).
    const faecher = ladeFaecherFuerSchueler(schueler.id).filter((f) => fachGiltInHalbjahr(f, halbjahr));
    const standRows = faecher.length ? db.prepare(`
      SELECT * FROM fach_sync_stand
      WHERE halbjahr = ? AND schueler_id = ? AND fach_id IN (${faecher.map(() => '?').join(',')})
    `).all(halbjahr, schueler.id, ...faecher.map((f) => f.id)) : [];
    const standByFach = new Map(standRows.map((r) => [r.fach_id, r]));
    const fachZeilen = faecher.map((f) => {
      const s = standByFach.get(f.id) || null;
      const ueberschrieben = s?.konferenz_note !== null && s?.konferenz_note !== undefined;
      return {
        fach: f,
        note: s?.note ?? null,
        konferenzNote: s?.konferenz_note ?? null,
        aktuelleNote: ueberschrieben ? s.konferenz_note : (s?.note ?? null),
        ueberschrieben,
        syncedAt: s?.synced_at ?? null,
      };
    });
    const vorhandeneNoten = fachZeilen.map((z) => z.aktuelleNote).filter((n) => n !== null && n !== undefined);
    const schnitt = vorhandeneNoten.length
      ? Math.round((vorhandeneNoten.reduce((a, b) => a + b, 0) / vorhandeneNoten.length) * 100) / 100
      : null;

    const notizen = db.prepare(`
      SELECT n.*, u.display_name, u.username, f.name AS fach_name FROM notenbesprechung_notizen n
      LEFT JOIN users u ON u.id = n.created_by_id
      LEFT JOIN faecher f ON f.id = n.fach_id
      WHERE n.schueler_id = ? AND n.halbjahr = ?
      ORDER BY n.created_at DESC
    `).all(schueler.id, halbjahr);

    return reply.viewEjs('teacher/konferenzmodus.ejs', {
      user: request.user, klasse, halbjahr, HALBJAHRE: halbjahreFuerKlasse(klasse.id), HALBJAHR_SCHULJAHR: halbjahrSchuljahrMap(klasse.id), schueler, fachZeilen, schnitt, notizen,
      vorherige: idx > 0 ? schuelerListe[idx - 1] : null,
      naechste: idx < schuelerListe.length - 1 ? schuelerListe[idx + 1] : null,
      position: idx + 1, anzahl: schuelerListe.length,
      sperre: holeSperre(klasse.id, schueler.id, halbjahr),
    });
  });

  fastify.post('/klassen/:id/konferenz/:schuelerId/sperren', async (request, reply) => {
    const klasse = getDb().prepare('SELECT id FROM klassen WHERE id = ?').get(request.params.id);
    if (!klasse || !userIstKlassenlehrer(request.user, klasse.id)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const halbjahr = halbjahrFuerKlasseId(klasse.id, request.body?.halbjahr);
    sperren(klasse.id, request.params.schuelerId, halbjahr, request.user.id);
    request.flash?.('success', 'Noten für dieses Halbjahr gesperrt.');
    return reply.redirect(`/teacher/klassen/${request.params.id}/konferenz/${request.params.schuelerId}?hj=${encodeURIComponent(halbjahr)}`);
  });

  fastify.post('/klassen/:id/konferenz/:schuelerId/entsperren', async (request, reply) => {
    const klasse = getDb().prepare('SELECT id FROM klassen WHERE id = ?').get(request.params.id);
    if (!klasse || !userIstKlassenlehrer(request.user, klasse.id)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const halbjahr = halbjahrFuerKlasseId(klasse.id, request.body?.halbjahr);
    entsperren(klasse.id, request.params.schuelerId, halbjahr);
    request.flash?.('success', 'Noten wieder entsperrt.');
    return reply.redirect(`/teacher/klassen/${request.params.id}/konferenz/${request.params.schuelerId}?hj=${encodeURIComponent(halbjahr)}`);
  });

  fastify.post('/klassen/:id/konferenz/:schuelerId/note', async (request, reply) => {
    const klasse = getDb().prepare('SELECT id, notenschluessel FROM klassen WHERE id = ?').get(request.params.id);
    if (!klasse || !userIstKlassenlehrer(request.user, klasse.id)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const halbjahr = halbjahrFuerKlasseId(klasse.id, request.body?.halbjahr);
    const fachId = parseInt(request.body?.fach_id, 10);
    // Nicht mehr "Fach gehört zu meiner Klasse" (bei klassenübergreifenden
    // Kursen falsch), sondern "die Person ist mein eigener Schüler UND nimmt
    // an diesem Fach teil".
    const eigenerSchueler = getDb().prepare('SELECT id FROM schueler WHERE id = ? AND klasse_id = ?')
      .get(request.params.schuelerId, klasse.id);
    const fach = eigenerSchueler ? getDb().prepare(`
      SELECT f.id FROM faecher f JOIN fach_teilnehmer ft ON ft.fach_id = f.id
      WHERE f.id = ? AND ft.schueler_id = ?
    `).get(fachId, request.params.schuelerId) : null;
    if (!Number.isFinite(fachId) || !fach) return reply.code(404).send({ error: 'fach not found' });
    const wertRaw = String(request.body?.note ?? '').trim().replace(',', '.');
    const wert = wertRaw === '' ? null : Number(wertRaw);
    if (wert !== null) {
      if (!Number.isFinite(wert)) {
        request.flash?.('error', 'Ungültige Note.');
        return reply.redirect(`/teacher/klassen/${request.params.id}/konferenz/${request.params.schuelerId}?hj=${encodeURIComponent(halbjahr)}`);
      }
      const [min, max] = klasse.notenschluessel === 'BG' ? [0, 15] : [1, 6];
      if (wert < min || wert > max) {
        request.flash?.('error', `Note außerhalb des Bereichs ${min}–${max}.`);
        return reply.redirect(`/teacher/klassen/${request.params.id}/konferenz/${request.params.schuelerId}?hj=${encodeURIComponent(halbjahr)}`);
      }
    }
    getDb().prepare(`
      INSERT INTO fach_sync_stand (fach_id, halbjahr, schueler_id, konferenz_note, konferenz_note_von_id, konferenz_note_am)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(fach_id, halbjahr, schueler_id) DO UPDATE SET
        konferenz_note = excluded.konferenz_note,
        konferenz_note_von_id = excluded.konferenz_note_von_id,
        konferenz_note_am = excluded.konferenz_note_am
    `).run(fachId, halbjahr, request.params.schuelerId, wert, request.user.id);
    request.flash?.('success', wert === null ? 'Konferenznote zurückgesetzt.' : 'Konferenznote gespeichert.');
    return reply.redirect(`/teacher/klassen/${request.params.id}/konferenz/${request.params.schuelerId}?hj=${encodeURIComponent(halbjahr)}`);
  });

  fastify.post('/klassen/:id/konferenz/:schuelerId/notiz', async (request, reply) => {
    const klasse = getDb().prepare('SELECT id FROM klassen WHERE id = ?').get(request.params.id);
    if (!klasse || !userIstKlassenlehrer(request.user, klasse.id)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const halbjahr = halbjahrFuerKlasseId(klasse.id, request.body?.halbjahr);
    const text = String(request.body?.text || '').trim();
    if (text) {
      getDb().prepare(`
        INSERT INTO notenbesprechung_notizen (schueler_id, fach_id, halbjahr, typ, text, created_by_id)
        VALUES (?, NULL, ?, 'konferenz', ?, ?)
      `).run(request.params.schuelerId, halbjahr, text, request.user.id);
    }
    return reply.redirect(`/teacher/klassen/${request.params.id}/konferenz/${request.params.schuelerId}?hj=${encodeURIComponent(halbjahr)}`);
  });

  fastify.get('/klassen/:id', async (request, reply) => {
    const klasse = getDb().prepare(`
      SELECT k.*, s.bezeichnung AS schuljahr_bezeichnung
      FROM klassen k JOIN schuljahre s ON s.id = k.schuljahr_id
      WHERE k.id = ?
    `).get(request.params.id);
    if (!klasse) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Klasse nicht gefunden.' });
    // Die Sammelklasse "Ohne Klasse" ist für ALLE Lehrkräfte einsehbar, damit
    // jede Lehrkraft die dort geretteten Personen in ihre Klassen übernehmen kann.
    if (!klasse.ist_ablage && !userHatKlassenZugriff(request.user, klasse.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    const schueler = getDb().prepare(
      'SELECT * FROM schueler WHERE klasse_id = ? ORDER BY nachname, vorname'
    ).all(klasse.id);
    const laufzeit = klassenLaufzeit(klasse.id);
    // Fächer als Baum: Fächer der obersten Ebene mit ihren Unterfächern (siehe src/unterfaecher.js).
    // SPA: die Komponenten der Lernfelder erscheinen als vorgegebene Unterfächer (idempotent, auch für ältere Klassen).
    if (klasse.notenschluessel === 'SPA') seedeKomponentenUnterfaecher(getDb(), klasse.id);
    const alleFaecher = sortiereFaecher(getDb().prepare('SELECT * FROM faecher WHERE klasse_id = ?').all(klasse.id), laufzeit);
    const baum = alleFaecher.filter((f) => !f.parent_fach_id).map((f) => {
      const komponenten = f.spa_fach_key ? spaKomponentenHalbjahre(getDb(), f) : new Map();
      return {
        fach: { ...f, hjNummern: fachHalbjahrNummern(f, laufzeit) },
        freieHj: halbjahreOhneUnterfaecher(f, laufzeit),
        kinder: alleFaecher.filter((u) => u.parent_fach_id === f.id).map((u) => {
          const info = u.spa_komponente ? komponenten.get(u.spa_komponente) : null;
          // Komponenten-Unterfach: angezeigt werden die aktiven Halbjahre laut Komponenten-Einstellung.
          return { ...u, hjNummern: info ? info.aktiv : fachHalbjahrNummern(u, laufzeit), komponenteInfo: info ?? null };
        }),
      };
    });
    const zuweisungenProFach = Object.fromEntries(ladeZuweisungenDerKlasse(klasse.id, alleFaecher, laufzeit));
    // Verrechnung je Fach (ohne Unterfächer und SPA-Fächer): wirksame Einstellung und ob sie eine eigene ist.
    const verrechnungProFach = Object.fromEntries(alleFaecher.filter((f) => !f.parent_fach_id && !f.spa_fach_key).map((f) => [
      f.id, { werte: ladeVerrechnungFuerFach(f), eigene: f.verrechnung !== null },
    ]));
    // Löschen/Abgang/Abgangszeugnis nur anzeigen, wenn die Aktion auch
    // durchgeht (dieselbe Regel wie in den Routen, siehe userDarfKlasseVerwalten).
    const darfVerwalten = userDarfKlasseVerwalten(request.user, klasse.id);
    const istKlassenlehrer = userIstKlassenlehrer(request.user, klasse.id);
    const kannExportieren = userDarfKlasseExportieren(request.user, klasse.id);
    const kannSelbstAlsKlassenlehrerEintragen = !istKlassenlehrer
      && (klasse.created_by_id === request.user.id || request.user.isAdmin);

    let zuweisbareLehrkraefte = [];
    if (istKlassenlehrer) {
      zuweisbareLehrkraefte = getDb().prepare(
        "SELECT id, username, display_name FROM users WHERE role != 'admin' AND active = 1 ORDER BY username"
      ).all();
    }

    return reply.viewEjs('teacher/klasse_detail.ejs', {
      laufzeit, vorbelegungHj: aktuelleHalbjahrNummern(laufzeit), baum, zuweisungenProFach, verrechnungProFach, bulkVorbelegung: String(request.query?.bulk || '').slice(0, 2000), klassenleitungNamen: klasse.ist_ablage ? [] : ladeKlassenleitungNamen(klasse.id), vorlagen: klasse.ist_ablage ? [] : ladeVorlagen(request.user.id, klasse.notenschluessel), speicherbareFaecher: sortiereFaecher(speicherbareFaecher(klasse.id), laufzeit), teilnehmerVerwaltbar: userDarfTeilnehmerVerwalten(request.user, { id: 0, klasse_id: klasse.id, ist_kurs: 0 }), klassenVerrechnung: ladeVerrechnung(klasse.id),
      user: request.user, klasse, schueler, kannExportieren, darfVerwalten,
      istKlassenlehrer, kannSelbstAlsKlassenlehrerEintragen, zuweisbareLehrkraefte,
      jahresOptionen: jahresOptionen(),
      darfVersetzen: darfVerwalten || Boolean(klasse.ist_ablage),
      versetzZiele: darfVerwalten || klasse.ist_ablage ? ladeVersetzZiele(klasse) : [],
      ablagePersonen: darfVerwalten && !klasse.ist_ablage ? ladeAblagePersonen() : [],
    });
  });

  fastify.post('/klassen/:id/klassenlehrer/eintragen', async (request, reply) => {
    const klasse = getDb().prepare('SELECT created_by_id FROM klassen WHERE id = ?').get(request.params.id);
    if (!klasse) return reply.redirect('/teacher/klassen');
    if (klasse.created_by_id !== request.user.id && !request.user.isAdmin) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die erstellende Lehrkraft oder der Admin kann sich hier als Klassenleitung eintragen.' });
    }
    getDb().prepare('INSERT OR IGNORE INTO klassenleitung (klasse_id, user_id) VALUES (?, ?)')
      .run(request.params.id, request.user.id);
    request.flash?.('success', 'Du bist jetzt als Klassenleitung eingetragen und siehst alle Noten dieser Klasse.');
    return reply.redirect(`/teacher/klassen/${request.params.id}`);
  });

  // ---------- Co-Klassenlehrkraft: eine bestehende Klassenleitung kann
  // weitere Personen als gleichberechtigte Klassenleitung eintragen (u. a.
  // damit diese auch Fehlzeiten pflegen können, siehe routes/klassenlehrer.js). ----------
  fastify.post('/klassen/:id/klassenleitung/hinzufuegen', async (request, reply) => {
    if (!userIstKlassenlehrer(request.user, request.params.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die Klassenleitung kann weitere Klassenlehrkräfte eintragen.' });
    }
    const userId = parseInt(request.body?.user_id, 10);
    if (!userId) {
      request.flash?.('error', 'Bitte eine Lehrkraft auswählen.');
      return reply.redirect(`/teacher/klassen/${request.params.id}`);
    }
    getDb().prepare('INSERT OR IGNORE INTO klassenleitung (klasse_id, user_id) VALUES (?, ?)')
      .run(request.params.id, userId);
    request.flash?.('success', 'Als Co-Klassenlehrkraft eingetragen.');
    return reply.redirect(`/klassenlehrer/klasse/${request.params.id}?tab=klassenleitung`);
  });

  fastify.post('/klassenleitung/:id/entfernen', async (request, reply) => {
    const eintrag = getDb().prepare('SELECT klasse_id FROM klassenleitung WHERE id = ?').get(request.params.id);
    if (!eintrag) return reply.redirect('/teacher/klassen');
    if (!userIstKlassenlehrer(request.user, eintrag.klasse_id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die Klassenleitung kann hier Einträge entfernen.' });
    }
    getDb().prepare('DELETE FROM klassenleitung WHERE id = ?').run(request.params.id);
    request.flash?.('success', 'Klassenleitung entfernt.');
    return reply.redirect(`/klassenlehrer/klasse/${eintrag.klasse_id}?tab=klassenleitung`);
  });

  fastify.post('/klassen/:id/zuweisungen/neu', async (request, reply) => {
    if (!userIstKlassenlehrer(request.user, request.params.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die Klassenleitung kann hier Lehrkräfte zuweisen.' });
    }
    const userId = parseInt(request.body?.user_id, 10);
    const fachId = parseInt(request.body?.fach_id, 10);
    const fach = getDb().prepare('SELECT * FROM faecher WHERE id = ?').get(fachId);
    if (!userId || !fach || fach.klasse_id !== Number(request.params.id)) {
      request.flash?.('error', 'Ungültige Auswahl.');
      return reply.redirect(klasseAnker(request.params.id));
    }
    // Halbjahre aus dem Formular; ohne Angabe gilt die Lehrkraft in allen (möglichen) Halbjahren des Fachs.
    const ergebnis = weiseLehrkraftZu(fach, userId, halbjahreAusFormular(request.body?.halbjahre, fach.klasse_id));
    if (!ergebnis.ok) request.flash?.('error', ergebnis.fehler);
    return reply.redirect(klasseAnker(request.params.id));
  });

  fastify.post('/zuweisungen/:id/loeschen', async (request, reply) => {
    const z = getDb().prepare(`
      SELECT fz.id, f.klasse_id FROM fach_zuweisungen fz JOIN faecher f ON f.id = fz.fach_id WHERE fz.id = ?
    `).get(request.params.id);
    if (!z) return reply.redirect('/teacher/klassen');
    if (!userIstKlassenlehrer(request.user, z.klasse_id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die Klassenleitung kann hier Zuweisungen entfernen.' });
    }
    getDb().prepare('DELETE FROM fach_zuweisungen WHERE id = ?').run(request.params.id);
    return reply.redirect(klasseAnker(z.klasse_id));
  });

  fastify.post('/klassen/:id/loeschen', async (request, reply) => {
    const klasse = getDb().prepare('SELECT id FROM klassen WHERE id = ?').get(request.params.id);
    if (!klasse) return reply.redirect('/teacher/klassen');
    if (!userDarfKlasseVerwalten(request.user, klasse.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: KLASSE_VERWALTEN_NUR });
    }
    const { gerettet } = loescheKlasseMitSchuelerUebernahme(klasse.id, request.user.isAdmin ? null : request.user.id);
    if (gerettet > 0) {
      request.flash?.('success', `Klasse gelöscht. ${gerettet} Schüler/innen wurden in die Sammelklasse „Ohne Klasse“ übernommen.`);
    }
    return reply.redirect('/teacher/klassen');
  });

  const VERSETZEN_FEHLER = {
    'abgang': 'Personen mit Abgang können nicht versetzt werden -- bitte zuerst reaktivieren.',
    'ziel-unbekannt': 'Zielklasse nicht gefunden.',
    'gleiche-klasse': 'Die Person ist bereits in dieser Klasse.',
    'notenschluessel': 'Die Zielklasse hat einen anderen Notenschlüssel (bei SPA: anderer Bildungsgang).',
    'name-vergeben': 'In der Zielklasse gibt es bereits eine Person mit diesem Namen.',
  };

  // Versetzen: die Person wechselt die Klasse, behält aber ALLE Noten (siehe
  // src/klassenwechsel.js) -- z. B. beim Wiederholen/Überspringen einer Stufe.
  fastify.post('/schueler/:id/versetzen', async (request, reply) => {
    const s = getDb().prepare('SELECT klasse_id FROM schueler WHERE id = ?').get(request.params.id);
    if (!s) return reply.redirect('/teacher/klassen');
    const quelleIstAblage = getDb().prepare('SELECT ist_ablage FROM klassen WHERE id = ?').get(s.klasse_id)?.ist_ablage;
    if (!quelleIstAblage && !userDarfKlasseVerwalten(request.user, s.klasse_id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: KLASSE_VERWALTEN_NUR });
    }
    const roh = String(request.body?.ziel_klasse_id || '');
    const zielId = roh === 'ohne-klasse' ? roh : parseInt(roh, 10);
    const ergebnis = versetzeSchueler(request.params.id, Number.isNaN(zielId) ? null : zielId);
    if (ergebnis.ok) request.flash?.('success', 'Person versetzt -- alle Noten bleiben erhalten.');
    else request.flash?.('error', VERSETZEN_FEHLER[ergebnis.fehler] || 'Versetzen nicht möglich.');
    return reply.redirect(`/teacher/klassen/${s.klasse_id}`);
  });

  // Reiter "Aus Ohne Klasse übernehmen": ausgewählte Personen der Sammelklasse
  // wandern in diese Klasse (Noten bleiben an der Person erhalten).
  fastify.post('/klassen/:id/schueler/aus-ablage', async (request, reply) => {
    const klasse = getDb().prepare('SELECT id, ist_ablage, ist_kurs_huelle FROM klassen WHERE id = ?').get(request.params.id);
    if (!klasse) return reply.redirect('/teacher/klassen');
    if (klasse.ist_ablage || klasse.ist_kurs_huelle || !userDarfKlasseVerwalten(request.user, klasse.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: KLASSE_VERWALTEN_NUR });
    }
    const roh = request.body?.schueler_id;
    const ids = (Array.isArray(roh) ? roh : [roh]).map((x) => parseInt(x, 10)).filter(Number.isInteger);
    const { uebernommen, fehler } = uebernehmeAusAblage(klasse.id, ids);
    if (uebernommen > 0) request.flash?.('success', `${uebernommen} Person(en) aus „Ohne Klasse“ übernommen -- alle Noten bleiben erhalten.`);
    if (fehler.length) request.flash?.('error', `Nicht übernommen (Name bereits in der Klasse): ${fehler.join('; ')}`);
    return reply.redirect(`/teacher/klassen/${klasse.id}`);
  });

  fastify.post('/klassen/:id/schueler/neu', async (request, reply) => {
    if (!userHatKlassenZugriff(request.user, request.params.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    const nn = String(request.body?.nachname || '').trim();
    const vn = String(request.body?.vorname || '').trim();
    if (nn && vn) {
      if (!fuegeSchuelerHinzuFallsNeu(request.params.id, nn, vn)) {
        request.flash?.('info', `${nn}, ${vn} ist in dieser Klasse bereits vorhanden — nicht doppelt angelegt.`);
      }
    }
    return reply.redirect(`/teacher/klassen/${request.params.id}`);
  });

  fastify.post('/klassen/:id/schueler/bulk', async (request, reply) => {
    if (!userHatKlassenZugriff(request.user, request.params.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    const text = String(request.body?.text || '');
    // Zeilen mit unklarer Namensreihenfolge (Doppelnamen ohne Komma) werden nicht angelegt, sondern zur Korrektur zurückgegeben.
    const mehrdeutig = [];
    const tx = getDb().transaction((lines) => {
      let uebersprungen = 0;
      let angelegt = 0;
      for (const line of lines) {
        const e = erkenneSchuelerZeile(line);
        if (e.typ === 'leer') continue;
        if (e.typ === 'mehrdeutig') { mehrdeutig.push(e.zeile); continue; }
        if (fuegeSchuelerHinzuFallsNeu(request.params.id, e.nachname, e.vorname)) angelegt++;
        else uebersprungen++;
      }
      return { uebersprungen, angelegt };
    });
    const { uebersprungen, angelegt } = tx(text.split(/\r?\n/));
    if (uebersprungen) request.flash?.('info', `${uebersprungen} bereits vorhandene(r) Schüler/in übersprungen — nicht doppelt angelegt.`);
    if (mehrdeutig.length) {
      request.flash?.('error', `Bei ${mehrdeutig.length === 1 ? 'dieser Zeile' : 'diesen Zeilen'} ist nicht sicher erkennbar, was Nach- und Vorname ist (Doppelname?): `
        + `${mehrdeutig.map((z) => `„${z}“`).join(', ')}. Bitte direkt nach dem Nachnamen ein Komma setzen, z. B. „Müller Schmidt, Anna“. `
        + `${mehrdeutig.length === 1 ? 'Die Zeile steht' : 'Die Zeilen stehen'} unten im Feld „Mehrere auf einmal" zur Korrektur bereit`
        + `${angelegt ? `; die übrigen ${angelegt} wurden angelegt` : ''}.`);
      return reply.redirect(`/teacher/klassen/${request.params.id}?bulk=${encodeURIComponent(mehrdeutig.join('\n').slice(0, 2000))}`);
    }
    return reply.redirect(`/teacher/klassen/${request.params.id}`);
  });

  // CSV-Datei-Upload (z. B. ein manueller Untis-Export). Eigener, gekapselter
  // Plugin-Scope: der multipart/form-data-Content-Type-Parser gilt dadurch
  // NUR für diese eine Route, alle übrigen Formulare/Routen der App bleiben
  // unverändert bei application/x-www-form-urlencoded (siehe Kommentar bei
  // leseMultipartDatei oben).
  fastify.register(async function (scoped) {
    scoped.addContentTypeParser('multipart/form-data', { parseAs: 'buffer' }, (request, payload, done) => {
      done(null, payload);
    });

    scoped.post('/klassen/:id/schueler/csv', { bodyLimit: 1 * 1024 * 1024 }, async (request, reply) => {
      if (!userHatKlassenZugriff(request.user, request.params.id)) {
        return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
      }
      let dateiBuffer;
      try {
        dateiBuffer = await leseMultipartDatei(request.body, request.headers['content-type'], 'datei');
      } catch {
        dateiBuffer = null;
      }
      if (!dateiBuffer) {
        request.flash?.('error', 'Bitte eine CSV-Datei auswählen.');
        return reply.redirect(`/teacher/klassen/${request.params.id}`);
      }
      const zeilen = parseSchuelerCsv(dateiBuffer.toString('utf8'));
      if (!zeilen.length) {
        request.flash?.('error', 'Aus der Datei konnten keine Schüler/innen gelesen werden — Format prüfen (Nachname, Vorname je Zeile).');
        return reply.redirect(`/teacher/klassen/${request.params.id}`);
      }
      const tx = getDb().transaction((rows) => {
        let angelegt = 0;
        let uebersprungen = 0;
        for (const r of rows) {
          if (fuegeSchuelerHinzuFallsNeu(request.params.id, r.nachname, r.vorname)) angelegt++; else uebersprungen++;
        }
        return { angelegt, uebersprungen };
      });
      const { angelegt, uebersprungen } = tx(zeilen);
      request.flash?.('success', `${angelegt} Schüler/in(nen) aus der Datei importiert.`
        + (uebersprungen ? ` ${uebersprungen} bereits vorhandene(r) übersprungen.` : ''));
      return reply.redirect(`/teacher/klassen/${request.params.id}`);
    });
  });

  // Komplettes Löschen: entfernt die Person samt ALLER Noten unwiderruflich
  // (ON DELETE CASCADE, siehe src/db.js) -- für Karteileichen/Fehleingaben.
  // Für eine Person, die die Klasse während des laufenden Schuljahres
  // verlässt, siehe stattdessen /schueler/:id/abgang (Noten bleiben erhalten).
  fastify.post('/schueler/:id/loeschen', async (request, reply) => {
    const s = getDb().prepare('SELECT klasse_id FROM schueler WHERE id = ?').get(request.params.id);
    if (!s) return reply.redirect('/teacher/klassen');
    if (!userDarfKlasseVerwalten(request.user, s.klasse_id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: KLASSE_VERWALTEN_NUR });
    }
    getDb().prepare('DELETE FROM schueler WHERE id = ?').run(request.params.id);
    return reply.redirect(`/teacher/klassen/${s.klasse_id}`);
  });

  // Abgang: Person bleibt als Datensatz (samt aller bisherigen Noten)
  // bestehen, zählt aber nicht mehr als aktuelle/s Schüler/in der Klasse --
  // neue Fächer/Kurse übernehmen sie beim Anlegen nicht mehr automatisch
  // (siehe seedeTeilnehmerAusKlasse), bereits bestehende Teilnahmen bleiben
  // unangetastet, damit laufende Notentafeln nicht plötzlich Lücken bekommen.
  fastify.post('/schueler/:id/abgang', async (request, reply) => {
    const s = getDb().prepare('SELECT klasse_id FROM schueler WHERE id = ?').get(request.params.id);
    if (!s) return reply.redirect('/teacher/klassen');
    if (!userDarfKlasseVerwalten(request.user, s.klasse_id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: KLASSE_VERWALTEN_NUR });
    }
    getDb().prepare("UPDATE schueler SET status = 'abgang', abgang_am = datetime('now') WHERE id = ?")
      .run(request.params.id);
    // Option "Abgang + Abgangszeugnis": danach direkt das Zeugnis mit allen Noten öffnen.
    if (request.body?.zeugnis === '1') return reply.redirect(`/teacher/schueler/${request.params.id}/abgangszeugnis`);
    return reply.redirect(`/teacher/klassen/${s.klasse_id}`);
  });

  // Reaktivieren: macht einen versehentlichen Abgang rückgängig.
  fastify.post('/schueler/:id/reaktivieren', async (request, reply) => {
    const s = getDb().prepare('SELECT klasse_id FROM schueler WHERE id = ?').get(request.params.id);
    if (!s) return reply.redirect('/teacher/klassen');
    if (!userDarfKlasseVerwalten(request.user, s.klasse_id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: KLASSE_VERWALTEN_NUR });
    }
    getDb().prepare("UPDATE schueler SET status = 'aktiv', abgang_am = NULL WHERE id = ?").run(request.params.id);
    return reply.redirect(`/teacher/klassen/${s.klasse_id}`);
  });

  // Abgangszeugnis: Notenübersicht über ALLE Fächer einer Person (alle
  // Halbjahre + Abschlussnote je Fach) auf einer
  // Seite -- unabhängig vom Abgangs-Status, damit sich auch für aktive
  // Schüler/innen schon vorab ein Zwischenstand ansehen lässt.
  fastify.get('/schueler/:id/abgangszeugnis', async (request, reply) => {
    const s = getDb().prepare('SELECT klasse_id FROM schueler WHERE id = ?').get(request.params.id);
    if (!s) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Schüler/in nicht gefunden.' });
    if (!userDarfKlasseVerwalten(request.user, s.klasse_id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: KLASSE_VERWALTEN_NUR });
    }
    const daten = ladeAbgangszeugnisDaten(request.params.id);
    if (!daten) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Schüler/in nicht gefunden.' });
    return reply.viewEjs('teacher/abgangszeugnis.ejs', { user: request.user, ...daten });
  });

  fastify.post('/klassen/:id/faecher/neu', async (request, reply) => {
    if (!userHatKlassenZugriff(request.user, request.params.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    const name = String(request.body?.name || '').trim();
    if (name) {
      try {
        // Halbjahre, in denen das Fach gilt (Checkboxen); nichts/alles gewählt = alle Halbjahre der Klasse.
        const halbjahreNr = parseHalbjahreEingabe(request.body?.halbjahre, klassenLaufzeit(request.params.id));
        // Verrechnung (nur Klassenleitung): sie gilt dann als eigene Einstellung des Fachs.
        let verrechnungJson = null;
        if (userIstKlassenlehrer(request.user, request.params.id) && request.body?.verrechnung_gesetzt === '1') {
          const eingabe = parseVerrechnungEingabe(request.body, klassenLaufzeit(request.params.id));
          if (eingabe.fehler) {
            request.flash?.('error', eingabe.fehler);
            return reply.redirect(`/teacher/klassen/${request.params.id}`);
          }
          verrechnungJson = JSON.stringify(eingabe.werte);
        }
        const info = getDb().prepare('INSERT INTO faecher (klasse_id, name, halbjahre, verrechnung) VALUES (?, ?, ?, ?)')
          .run(request.params.id, name, halbjahreNr ? JSON.stringify(halbjahreNr) : null, verrechnungJson);
        // Ersteller/in wird automatisch dem eigenen Fach zugewiesen — eine
        // spätere Zuweisung weiterer Lehrkräfte (Admin → Zuweisungen) bleibt
        // zusätzlich möglich, ist aber nicht Voraussetzung.
        getDb().prepare('INSERT OR IGNORE INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)')
          .run(request.user.id, info.lastInsertRowid);
        // Teilnehmerliste startet mit allen Schüler/innen der Klasse -- bei
        // Bedarf später auf der Fach-Seite anpassbar (siehe "Teilnehmer/innen").
        seedeTeilnehmerAusKlasse(info.lastInsertRowid, request.params.id);
      } catch (e) {
        request.flash?.('error', 'Fach existiert bereits in dieser Klasse.');
      }
    }
    return reply.redirect(`/teacher/klassen/${request.params.id}`);
  });

  // ---------- Fächer-Vorlagen (siehe src/fach-vorlagen.js) ----------
  const alsIdListe = (roh) => (Array.isArray(roh) ? roh : [roh]).map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n));

  fastify.post('/klassen/:id/vorlagen/speichern', async (request, reply) => {
    const klasse = getDb().prepare('SELECT * FROM klassen WHERE id = ?').get(request.params.id);
    if (!klasse) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Klasse nicht gefunden.' });
    if (!userHatKlassenZugriff(request.user, klasse.id)) return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    const ergebnis = speichereVorlage(request.user.id, klasse, request.body?.name, alsIdListe(request.body?.fach_ids));
    request.flash?.(ergebnis.ok ? 'success' : 'error', ergebnis.ok ? `Vorlage gespeichert (${ergebnis.anzahl} Fächer).` : ergebnis.fehler);
    return reply.redirect(`/teacher/klassen/${klasse.id}#faecher-lehrkraefte`);
  });

  fastify.post('/klassen/:id/vorlagen/importieren', async (request, reply) => {
    const klasse = getDb().prepare('SELECT * FROM klassen WHERE id = ?').get(request.params.id);
    if (!klasse) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Klasse nicht gefunden.' });
    if (!userHatKlassenZugriff(request.user, klasse.id)) return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    const ergebnis = importiereVorlage(parseInt(request.body?.vorlage_id, 10), request.user.id, klasse, {
      mitVerrechnung: userIstKlassenlehrer(request.user, klasse.id),
    });
    if (!ergebnis.ok) request.flash?.('error', ergebnis.fehler);
    else {
      const teile = [];
      if (ergebnis.angelegt.length) teile.push(`${ergebnis.angelegt.length} Fächer importiert`);
      if (ergebnis.uebersprungen.length) teile.push(`übersprungen, weil es sie schon gibt: ${ergebnis.uebersprungen.join(', ')}`);
      request.flash?.(ergebnis.angelegt.length ? 'success' : 'error', `${teile.join('; ') || 'Die Vorlage enthält keine Fächer.'}. Die Fächer haben noch keine Lehrkraft -- bitte neu zuordnen.`);
    }
    return reply.redirect(`/teacher/klassen/${klasse.id}#faecher-lehrkraefte`);
  });

  fastify.post('/vorlagen/:id/loeschen', async (request, reply) => {
    loescheVorlage(parseInt(request.params.id, 10), request.user.id);
    const klasseId = parseInt(request.body?.klasse_id, 10);
    request.flash?.('success', 'Vorlage gelöscht.');
    return reply.redirect(Number.isInteger(klasseId) ? `/teacher/klassen/${klasseId}#faecher-lehrkraefte` : '/teacher/klassen');
  });

  // Halbjahre ändern, in denen ein Fach gilt. Nicht entfernen, wenn in einem
  // wegfallenden Halbjahr schon Leistungen oder Endnoten eingetragen sind.
  fastify.post('/faecher/:id/halbjahre', async (request, reply) => {
    const fach = getDb().prepare('SELECT * FROM faecher WHERE id = ?').get(request.params.id);
    if (!fach) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Fach nicht gefunden.' });
    if (!userHatFachZgriff(request.user, fach.id) && !userIstKlassenlehrer(request.user, fach.klasse_id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    const laufzeit = klassenLaufzeit(fach.klasse_id);
    const neu = parseHalbjahreEingabe(request.body?.halbjahre, laufzeit);
    const ziel = request.body?.zurueck === 'klasse' ? `/teacher/klassen/${fach.klasse_id}#faecher-lehrkraefte` : `/teacher/fach/${fach.id}`;
    // Vorgegebene SPA-Komponente (Unterfach): "Halbjahre" schaltet die Komponente je Halbjahr ein/aus (nur Klassenleitung).
    if (fach.spa_komponente) {
      if (!userIstKlassenlehrer(request.user, fach.klasse_id)) {
        return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die Klassenleitung kann die Zusammensetzung ändern.' });
      }
      const eltern = getDb().prepare('SELECT * FROM faecher WHERE id = ?').get(fach.parent_fach_id);
      const info = spaKomponentenHalbjahre(getDb(), eltern).get(fach.spa_komponente);
      const gewaehlt = halbjahreAusFormular(request.body?.halbjahre, fach.klasse_id) ?? [];
      if (!info?.schaltbar) {
        request.flash?.('error', 'Diese Komponente hat ein festes Gewicht und lässt sich nicht abschalten.');
      } else {
        // Auch "kein Halbjahr" ist erlaubt: die Komponente ist dann komplett abgewählt.
        for (const nr of info.alle) spaSetzeKomponenteAktiv(getDb(), eltern.id, nr, fach.spa_komponente, gewaehlt.includes(nr));
        request.flash?.('success', gewaehlt.some((n) => info.alle.includes(n)) ? 'Zusammensetzung gespeichert.' : 'Komponente komplett abgewählt.');
      }
      return reply.redirect(ziel);
    }
    const ergebnis = setzeFachHalbjahre(fach, neu);
    if (!ergebnis.ok) {
      request.flash?.('error', ergebnis.fehler);
      return reply.redirect(ziel);
    }
    request.flash?.('success', 'Halbjahre gespeichert.');
    return reply.redirect(ziel);
  });

  // Fach bearbeiten (Klassenleitung): Name, Halbjahre und -- bei Fächern -- Verrechnung in einem Dialog.
  // Unterfächer: Name und Halbjahre. Vorgegebene SPA-Fächer/-Komponenten sind nicht umbenennbar.
  fastify.post('/faecher/:id/bearbeiten', async (request, reply) => {
    const fach = getDb().prepare('SELECT * FROM faecher WHERE id = ?').get(request.params.id);
    if (!fach) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Fach nicht gefunden.' });
    if (!userIstKlassenlehrer(request.user, fach.klasse_id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die Klassenleitung kann Fächer bearbeiten.' });
    }
    const ziel = `/teacher/klassen/${fach.klasse_id}#faecher-lehrkraefte`;
    if (fach.spa_fach_key || fach.spa_komponente) {
      request.flash?.('error', 'Vorgegebene SPA-Fächer und -Komponenten lassen sich nicht bearbeiten.');
      return reply.redirect(ziel);
    }
    const laufzeit = klassenLaufzeit(fach.klasse_id);
    const name = String(request.body?.name || '').trim().slice(0, fach.parent_fach_id ? 60 : 100);
    if (!name) {
      request.flash?.('error', 'Bitte einen Namen angeben.');
      return reply.redirect(ziel);
    }
    const verrechnung = !fach.parent_fach_id ? parseVerrechnungEingabe(request.body, laufzeit) : null;
    if (verrechnung?.fehler) {
      request.flash?.('error', verrechnung.fehler);
      return reply.redirect(ziel);
    }
    // Halbjahre zuerst: schlägt es fehl (Daten in wegfallenden Halbjahren), bleibt alles unverändert.
    const halbjahre = setzeFachHalbjahre(fach, parseHalbjahreEingabe(request.body?.halbjahre, laufzeit));
    if (!halbjahre.ok) {
      request.flash?.('error', halbjahre.fehler);
      return reply.redirect(ziel);
    }
    try {
      const db = getDb();
      db.transaction(() => {
        if (fach.parent_fach_id) {
          const eltern = db.prepare('SELECT name FROM faecher WHERE id = ?').get(fach.parent_fach_id);
          db.prepare('UPDATE faecher SET name = ?, kurzname = ? WHERE id = ?').run(`${eltern.name}${UNTERFACH_TRENNER}${name}`, name, fach.id);
        } else {
          db.prepare('UPDATE faecher SET name = ?, verrechnung = ? WHERE id = ?').run(name, JSON.stringify(verrechnung.werte), fach.id);
          for (const u of ladeUnterfaecher(fach.id)) {
            db.prepare('UPDATE faecher SET name = ? WHERE id = ?').run(`${name}${UNTERFACH_TRENNER}${u.kurzname || u.name}`, u.id);
          }
        }
      })();
      request.flash?.('success', `„${name}" gespeichert.`);
    } catch (e) {
      request.flash?.('error', 'Ein Fach mit diesem Namen gibt es in dieser Klasse schon.');
    }
    return reply.redirect(ziel);
  });

  // ---------- Unterfächer und Lehrkraftzuordnung je Halbjahr (siehe src/unterfaecher.js) ----------
  const klasseAnker = (klasseId) => `/teacher/klassen/${klasseId}#faecher-lehrkraefte`;
  const halbjahreAusFormular = (roh, klasseId) => {
    const laufzeit = klassenLaufzeit(klasseId);
    const liste = (Array.isArray(roh) ? roh : [roh]).map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n) && n >= 1 && n <= laufzeit.anzahlHalbjahre);
    return liste.length ? [...new Set(liste)] : null;
  };

  fastify.post('/faecher/:id/unterfaecher', async (request, reply) => {
    const fach = getDb().prepare('SELECT * FROM faecher WHERE id = ?').get(request.params.id);
    if (!fach) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Fach nicht gefunden.' });
    if (!userIstKlassenlehrer(request.user, fach.klasse_id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die Klassenleitung kann Unterfächer hinzufügen.' });
    }
    const ergebnis = legeUnterfachAn(fach, request.body?.name, halbjahreAusFormular(request.body?.halbjahre, fach.klasse_id));
    request.flash?.(ergebnis.ok ? 'success' : 'error', ergebnis.ok ? 'Unterfach angelegt.' : ergebnis.fehler);
    return reply.redirect(klasseAnker(fach.klasse_id));
  });

  fastify.post('/zuweisungen/:id/halbjahre', async (request, reply) => {
    const z = getDb().prepare(`
      SELECT fz.id, f.klasse_id FROM fach_zuweisungen fz JOIN faecher f ON f.id = fz.fach_id WHERE fz.id = ?
    `).get(request.params.id);
    if (!z) return reply.redirect('/teacher/klassen');
    if (!userIstKlassenlehrer(request.user, z.klasse_id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die Klassenleitung kann Zuordnungen ändern.' });
    }
    const nummern = halbjahreAusFormular(request.body?.halbjahre, z.klasse_id) ?? [];
    const ergebnis = setzeZuweisungHalbjahre(z.id, nummern);
    request.flash?.(ergebnis.ok ? 'success' : 'error', ergebnis.ok ? 'Halbjahre der Zuordnung gespeichert.' : ergebnis.fehler);
    return reply.redirect(klasseAnker(z.klasse_id));
  });

  // Gewichte der Unterfächer in der Fachnote (leer = 1).
  fastify.post('/fach/:id/unterfach-gewichte', async (request, reply) => {
    const fach = ladeFachMitUmfeld(request.params.id);
    if (!fach || fach.parent_fach_id) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Fach nicht gefunden.' });
    if (!userDarfZusammensetzungSehen(request.user, fach)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    const halbjahr = halbjahrFuerFach(fach, request.body?.halbjahr);
    const db = getDb();
    let fehler = false;
    for (const u of ladeUnterfaecher(fach.id)) {
      const roh = request.body?.[`gewicht_${u.id}`];
      if (roh === undefined) continue;
      const text = String(roh).trim().replace(',', '.');
      const wert = text === '' ? null : Number(text);
      if (wert !== null && !(wert > 0 && wert <= 100)) { fehler = true; continue; }
      db.prepare('UPDATE faecher SET gewicht = ? WHERE id = ?').run(wert, u.id);
    }
    request.flash?.(fehler ? 'error' : 'success', fehler ? 'Gewichte müssen zwischen 0 und 100 liegen -- ungültige Werte wurden nicht gespeichert.' : 'Gewichte gespeichert.');
    return reply.redirect(`/teacher/fach/${fach.id}?hj=${encodeURIComponent(halbjahr)}`);
  });

  // ---------- Neuen Kurs anlegen (Fach, dessen Teilnehmerliste sich aus
  // mehreren Klassen zusammensetzt) -- braucht bewusst KEINE eigene
  // Ausgangsklasse (mehr): der Kurs bekommt stattdessen eine unsichtbare,
  // leere Klassen-Hülle als technischen Anker für Schuljahr/Notenschlüssel
  // (klassen.ist_kurs_huelle -- wird aus jeder Klassen-Auflistung
  // herausgefiltert, siehe ladeMeineKlassen). Teilnehmer/innen kommen
  // ausschließlich über "Teilnehmer/innen hinzufügen" auf der Fach-Seite
  // dazu -- aus bestehenden Klassen, oder manuell neu (legt bei Bedarf
  // still eine neue, für alle offene Klasse an, siehe fach-teilnehmer.js
  // legeManuellenTeilnehmerAn/src/klassen-verknuepfung.js). Landet danach
  // gleich auf der Fach-Seite, im Teilnehmer/innen-Reiter.
  fastify.post('/kurse/neu', async (request, reply) => {
    if (!userDarfSelbstKlasseAnlegen(request.user)) {
      request.flash?.('error', 'Nur Lehrkräfte mit LDAP-Zugang können eigene Kurse anlegen. Bitte eine Klassenleitung oder den Admin bitten, dich einem Fach zuzuweisen.');
      return reply.redirect('/teacher/klassen');
    }
    const schuljahrId = parseInt(request.body?.schuljahr_id, 10);
    const name = String(request.body?.name || '').trim();
    let ns = String(request.body?.notenschluessel || 'IHK');
    if (!['IHK', 'BG'].includes(ns)) ns = 'IHK';
    if (!schuljahrId || !name) {
      request.flash?.('error', 'Schuljahr und Name sind erforderlich.');
      return reply.redirect('/teacher/klassen');
    }
    const db = getDb();
    try {
      const huelle = db.prepare(`
        INSERT INTO klassen (schuljahr_id, name, notenschluessel, notenschluessel_csv, ist_kurs_huelle)
        VALUES (?, ?, ?, ?, 1)
      `).run(schuljahrId, `__kurshuelle_${makeToken()}`, ns, DEFAULT_NS_CSV[ns] || '');
      const info = db.prepare('INSERT INTO faecher (klasse_id, name, ist_kurs) VALUES (?, ?, 1)')
        .run(huelle.lastInsertRowid, name);
      db.prepare('INSERT OR IGNORE INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)')
        .run(request.user.id, info.lastInsertRowid);
      return reply.redirect(`/teacher/fach/${info.lastInsertRowid}/teilnehmer`);
    } catch (e) {
      request.flash?.('error', 'Kurs konnte nicht angelegt werden -- bitte Schuljahr prüfen.');
      return reply.redirect('/teacher/klassen');
    }
  });

  fastify.post('/faecher/:id/loeschen', async (request, reply) => {
    const f = getDb().prepare('SELECT id, klasse_id, ist_kurs, spa_komponente FROM faecher WHERE id = ?').get(request.params.id);
    if (!f) return reply.redirect('/teacher/klassen');
    if (f.spa_komponente) {
      request.flash?.('error', 'Vorgegebene SPA-Komponenten lassen sich nicht löschen -- nur je Halbjahr abschalten.');
      return reply.redirect(`/teacher/klassen/${f.klasse_id}#faecher-lehrkraefte`);
    }
    if (!userDarfFachLoeschen(request.user, f)) {
      return reply.code(403).viewEjs('error.ejs', {
        code: 403,
        message: !f.ist_kurs ? KLASSE_VERWALTEN_NUR
          : userHatFachZgriff(request.user, f.id)
            ? 'Diesem Kurs sind weitere Lehrkräfte zugeordnet — löschen würde auch deren Noten entfernen. Das kann nur der Admin.'
            : 'Keine Berechtigung.',
      });
    }
    getDb().prepare('DELETE FROM faecher WHERE id = ?').run(request.params.id);
    // Eine Kurs-Hülle (siehe /kurse/neu) gehört exakt einem Kurs -- mit ihm
    // verschwindet auch sie, statt als leere Karteileiche liegen zu bleiben.
    getDb().prepare("DELETE FROM klassen WHERE id = ? AND ist_kurs_huelle = 1").run(f.klasse_id);
    // Ein Kurs hängt nur noch technisch an einer unsichtbaren Klassen-Hülle
    // -- die gibt es dort nichts anzuschauen, zurück zur Kursliste statt zu
    // dieser Hülle.
    return reply.redirect(f.ist_kurs ? '/teacher/klassen' : `/teacher/klassen/${f.klasse_id}`);
  });

  // ---------- Teilnehmer/innen eines Fachs (klassenübergreifende Kurse) ----------
  // Ein Fach bleibt an eine Heimat-Klasse gebunden (Notenschlüssel, Anlegerecht),
  // die tatsächliche Teilnehmerliste kann aber darüber hinausgehen -- siehe
  // src/fach-teilnehmer.js.
  // Verwaltung der Teilnehmerliste: eigene Seite (erreichbar über "Meine Klassen"), nicht Teil der
  // Noteneingabe. Berechtigung siehe userDarfTeilnehmerVerwalten in src/auth.js.
  const teilnehmerSeite = (fachId) => `/teacher/fach/${fachId}/teilnehmer`;
  const ladeTeilnehmerFach = (request, reply, ajax = false) => {
    const fach = ladeFachMitUmfeld(request.params.id);
    if (!fach || fach.parent_fach_id || fach.spa_fach_key) {
      if (ajax) reply.code(404).send({ ok: false, error: 'Fach nicht gefunden.' });
      else reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Fach nicht gefunden.' });
      return null;
    }
    if (!userDarfTeilnehmerVerwalten(request.user, fach)) {
      const message = 'Die Teilnehmer/innen kann nur die Klassenleitung verwalten.';
      if (ajax) reply.code(403).send({ ok: false, error: message });
      else reply.code(403).viewEjs('error.ejs', { code: 403, message });
      return null;
    }
    return fach;
  };

  fastify.get('/fach/:id/teilnehmer', async (request, reply) => {
    const fach = ladeTeilnehmerFach(request, reply);
    if (!fach) return reply;
    return reply.viewEjs('teacher/fach_teilnehmer.ejs', {
      user: request.user, fach, teilnehmer: ladeTeilnehmerMitHerkunft(fach),
    });
  });

  fastify.get('/fach/:id/teilnehmer/suche', async (request, reply) => {
    const fach = ladeTeilnehmerFach(request, reply, true);
    if (!fach) return reply;
    const treffer = sucheSchuelerFuerFach(fach, request.query?.q);
    return reply.send({ treffer });
  });

  fastify.post('/fach/:id/teilnehmer/hinzufuegen', async (request, reply) => {
    const istAjax = Boolean(request.headers.accept?.includes('application/json'));
    const fach = ladeTeilnehmerFach(request, reply, istAjax);
    if (!fach) return reply;
    const schuelerId = parseInt(request.body?.schueler_id, 10);
    const ergebnis = fuegeTeilnehmerHinzu(fach, schuelerId);
    const meldungen = {
      'nicht-gefunden': 'Schüler/in nicht gefunden.',
      'anderes-schuljahr': 'Diese Person ist einem anderen Schuljahr zugeordnet.',
      notenschluessel: 'Notenschlüssel der Klassen passen nicht zusammen (IHK/BG) — dieser Kurs kann nicht gemischt werden.',
      'bereits-teilnehmer': 'Ist bereits Teilnehmer/in.',
    };
    if (!ergebnis.ok) {
      if (istAjax) return reply.code(400).send({ ok: false, error: meldungen[ergebnis.fehler] || 'Hinzufügen fehlgeschlagen.' });
      request.flash?.('error', meldungen[ergebnis.fehler] || 'Hinzufügen fehlgeschlagen.');
      return reply.redirect(teilnehmerSeite(fach.id));
    }
    if (istAjax) {
      const s = getDb().prepare(`
        SELECT s.id, s.nachname, s.vorname, (s.klasse_id != ?) AS fremd, k.name AS klasse_name
        FROM schueler s JOIN klassen k ON k.id = s.klasse_id WHERE s.id = ?
      `).get(fach.klasse_id, schuelerId);
      return reply.send({ ok: true, teilnehmer: { ...s, fremd: Boolean(s.fremd) } });
    }
    return reply.redirect(teilnehmerSeite(fach.id));
  });

  fastify.post('/fach/:id/teilnehmer/manuell', async (request, reply) => {
    const fach = ladeTeilnehmerFach(request, reply);
    if (!fach) return reply;
    const ergebnis = legeManuellenTeilnehmerAn(fach, {
      nachname: request.body?.nachname, vorname: request.body?.vorname, klassenName: request.body?.klasse,
    });
    if (!ergebnis.ok) {
      const meldungen = {
        pflichtfelder: 'Nachname, Vorname und Klasse sind erforderlich.',
        notenschluessel: 'Notenschlüssel der angegebenen Klasse passt nicht zu diesem Fach (IHK/BG) — dieser Kurs kann nicht gemischt werden.',
        'bereits-teilnehmer': 'Ist bereits Teilnehmer/in.',
      };
      request.flash?.('error', meldungen[ergebnis.fehler] || 'Hinzufügen fehlgeschlagen.');
    }
    return reply.redirect(teilnehmerSeite(fach.id));
  });

  fastify.post('/fach/:id/teilnehmer/entfernen', async (request, reply) => {
    const fach = ladeTeilnehmerFach(request, reply);
    if (!fach) return reply;
    entferneTeilnehmer(fach.id, parseInt(request.body?.schueler_id, 10));
    return reply.redirect(teilnehmerSeite(fach.id));
  });

  // ---------- Einladungen für externe Lehrkräfte (nicht mehr nur Admin) ----------
  // Jede Klassenleitung kann externe Personen per Link einladen. Die so
  // registrierten Konten (auth_source 'lokal') bekommen bewusst KEIN
  // Selbstbedienungsrecht (siehe userDarfSelbstKlasseAnlegen) — sie müssen
  // von einer Klassenleitung/dem Admin einem Fach zugewiesen werden
  // (Klassenseite → "Lehrkräfte zuordnen"/"Klassenleitung"), genau wie
  // jede andere Lehrkraft, die dort in der Auswahlliste auftaucht.
  fastify.get('/einladungen', async (request, reply) => {
    if (!istIrgendeineKlassenleitung(request.user)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die Klassenleitung kann externe Lehrkräfte einladen.' });
    }
    const einladungen = getDb().prepare(`
      SELECT i.*, bu.username AS verwendet_von
      FROM invitations i
      LEFT JOIN users bu ON bu.id = i.used_by_id
      WHERE i.created_by_id = ?
      ORDER BY i.created_at DESC
    `).all(request.user.id);
    return reply.viewEjs('teacher/einladungen.ejs', { user: request.user, einladungen });
  });

  fastify.post('/einladungen/neu', async (request, reply) => {
    if (!istIrgendeineKlassenleitung(request.user)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die Klassenleitung kann externe Lehrkräfte einladen.' });
    }
    const email = String(request.body?.email || '').trim() || null;
    const displayName = String(request.body?.display_name || '').trim() || null;
    const ttl = parseInt(request.body?.ttl_days, 10) || 14;
    const expires = new Date(Date.now() + ttl * 86400 * 1000).toISOString();
    getDb().prepare(`INSERT INTO invitations
      (token, email, display_name, role, created_by_id, expires_at)
      VALUES (?, ?, ?, 'teacher', ?, ?)`)
      .run(makeToken(), email, displayName, request.user.id, expires);
    return reply.redirect('/teacher/einladungen');
  });

  fastify.post('/einladungen/:id/loeschen', async (request, reply) => {
    const inv = getDb().prepare('SELECT created_by_id FROM invitations WHERE id = ?').get(request.params.id);
    if (!inv) return reply.redirect('/teacher/einladungen');
    if (inv.created_by_id !== request.user.id && !request.user.isAdmin) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die eigenen Einladungen können gelöscht werden.' });
    }
    getDb().prepare('DELETE FROM invitations WHERE id = ?').run(request.params.id);
    return reply.redirect('/teacher/einladungen');
  });
}

// Verteilt die Gewichtung der Klausuren eines Fachs/Halbjahrs neu.
//
// erzwingen=false (Default, z. B. nach dem Löschen einer Klausur): füllt nur
// Klausuren, die noch bei 0 stehen, aus dem verbleibenden Budget auf —
// bereits gesetzte Gewichtungen bleiben unangetastet.
//
// erzwingen=true (beim Anlegen einer neuen Klausur): verteilt IMMER alle
// Klausuren gleichmäßig neu. Nötig, weil eine bereits vorhandene Klausur das
// komplette Budget beanspruchen kann (z. B. die einzige Klausur mit 100%) —
// dann bliebe für eine neu angelegte Klausur beim reinen Auffüllen nichts
// mehr übrig und sie hinge dauerhaft bei Gewichtung 0 (und damit ohne
// Einfluss auf Schriftliche Note/Gesamtnote, siehe grade-calc.js
// teilNote()/gesamtnoteHj()). Das Neuverteilen kann eine zuvor manuell
// gesetzte Gewichtung überschreiben — das ist der bewusste Kompromiss:
// sichtbar falsch verteilte Prozente lassen sich sofort im Formular
// korrigieren, eine unsichtbar bei 0 hängende Klausur (fehlende Note in der
// Übersicht) nicht.
function autoVerteileKlausuren(fachId, halbjahr, { erzwingen = false } = {}) {
  const klausuren = getDb().prepare(
    'SELECT id, gewichtung FROM klausuren WHERE fach_id = ? AND halbjahr = ? ORDER BY id'
  ).all(fachId, halbjahr);
  if (!klausuren.length) return;
  const fach = getDb().prepare('SELECT klasse_id FROM faecher WHERE id = ?').get(fachId);
  const schriftlichPct = 100 - muendlichProzentFuerHalbjahr(fach.klasse_id, halbjahr, DEFAULT_GEWICHTUNG);
  const upd = getDb().prepare('UPDATE klausuren SET gewichtung = ? WHERE id = ?');

  if (erzwingen) {
    const weights = autoDistribute(klausuren.length, schriftlichPct);
    for (let i = 0; i < klausuren.length; i++) upd.run(weights[i], klausuren[i].id);
    return;
  }
  const offene = klausuren.filter((k) => k.gewichtung === 0);
  if (!offene.length) return;
  const belegt = klausuren.reduce((sum, k) => sum + k.gewichtung, 0);
  const rest = Math.max(0, schriftlichPct - belegt);
  const weights = autoDistribute(offene.length, rest);
  for (let i = 0; i < offene.length; i++) upd.run(weights[i], offene[i].id);
}
