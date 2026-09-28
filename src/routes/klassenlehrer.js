/**
 * Klassenlehrer-Routen: Fehlzeiten pro Halbjahr
 * (entschuldigt / unentschuldigt / betrieblich).
 *
 * Optional (klassen.zwei_schulen): Schüler/innen werden an zwei Schulen
 * unterrichtet — dann gibt es je Typ zwei Stunden-Spalten (Schule 1/2,
 * separate Tabelle fehlzeiten_schule2) plus eine berechnete Summe.
 */

import { getDb } from '../db.js';
import { requireAuth, userIstKlassenlehrer } from '../auth.js';
import { HALBJAHRE, FEHLZEIT_TYPEN } from '../grade-calc.js';
import { ladeHalbjahresuebersicht } from '../noten-sync.js';
import {
  ladeAbschlussuebersicht, ladeVergangeneSchuljahre, fuegeVergangenesSchuljahrHinzu,
  ladeHistorischeHalbjahre, ladeHistorischeNoten, userDarfHistorischeNotenBearbeiten,
  importiereHistorischeNoten, ladeHistorischeHalbjahresuebersicht,
} from '../fach-abschluss.js';
import { ladeFachMitUmfeld } from '../noten-service.js';
import { parseSchuljahr, sortiereSchuljahreAbsteigend } from '../schuljahr-utils.js';
import { parseNotenTabelle } from '../csv-import.js';
import Busboy from '@fastify/busboy';
import { Readable } from 'node:stream';

/**
 * Liest ein multipart/form-data-Formular: alle einfachen Textfelder plus
 * genau ein Datei-Feld. Eigener kleiner Parser statt @fastify/multipart, aus
 * demselben Grund wie in routes/teacher.js (leseMultipartDatei) -- dessen
 * globaler Content-Type-Parser würde ALLE Routen der App betreffen. Der
 * Content-Type-Parser dafür wird weiter unten bewusst nur innerhalb eines
 * eigenen fastify.register()-Blocks registriert.
 */
function leseMultipartFormular(buffer, contentType, dateiFeld) {
  return new Promise((resolve, reject) => {
    let busboy;
    try {
      busboy = new Busboy({ headers: { 'content-type': contentType } });
    } catch (e) {
      return reject(e);
    }
    const felder = {};
    let datei = null;
    busboy.on('field', (name, value) => { felder[name] = value; });
    busboy.on('file', (name, stream) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => { if (name === dateiFeld) datei = Buffer.concat(chunks); });
    });
    busboy.on('error', reject);
    busboy.on('finish', () => resolve({ felder, datei }));
    Readable.from(buffer).pipe(busboy);
  });
}

/**
 * Prüft eine Schuljahr-Bezeichnung fürs "vergangenes Schuljahr"-Feature:
 * gültiges YYYY/YY-Format UND wirklich vor dem laufenden Schuljahr der
 * Klasse (siehe /klasse/:id/vergangenes-schuljahr/neu weiter unten und den
 * Noten-Import, die beide dieselbe Regel brauchen).
 */
function pruefeVergangenesSchuljahr(klasseSchuljahrBezeichnung, bezeichnung) {
  const geparst = parseSchuljahr(bezeichnung);
  if (!geparst) return { ok: false, fehler: 'format' };
  const eigenesStartjahr = parseSchuljahr(klasseSchuljahrBezeichnung)?.startJahr;
  if (eigenesStartjahr !== undefined && geparst.startJahr >= eigenesStartjahr) return { ok: false, fehler: 'nicht-vergangen' };
  return { ok: true };
}

export default async function klassenlehrerRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  // ---------- Dashboard ----------
  fastify.get('/', async (request, reply) => {
    let klassen;
    if (request.user.isAdmin) {
      klassen = getDb().prepare(`
        SELECT k.*, s.bezeichnung AS schuljahr_bezeichnung
        FROM klassen k JOIN schuljahre s ON s.id = k.schuljahr_id
        WHERE k.ist_kurs_huelle = 0
        ORDER BY s.bezeichnung DESC, k.name
      `).all();
    } else {
      // Klassenleitung kommt aus ZWEI Tabellen (klassenleitung: klassenweite
      // Selbstregistrierung/Co-Klassenlehrkraft; klassen_lehrkraefte: alte,
      // je Fach eintragende Admin-Zuweisung) — beide müssen hier
      // berücksichtigt werden, sonst fehlt z. B. eine per Co-Klassenlehrkraft
      // eingetragene Person auf ihrem eigenen Dashboard (userIstKlassenlehrer
      // in src/auth.js prüft dieselben zwei Tabellen für den Seitenzugriff).
      klassen = getDb().prepare(`
        SELECT DISTINCT k.*, s.bezeichnung AS schuljahr_bezeichnung
        FROM klassen k
        JOIN schuljahre s ON s.id = k.schuljahr_id
        LEFT JOIN klassen_lehrkraefte kl ON kl.klasse_id = k.id AND kl.user_id = ?
        LEFT JOIN klassenleitung kls ON kls.klasse_id = k.id AND kls.user_id = ?
        WHERE k.ist_kurs_huelle = 0 AND (kl.user_id IS NOT NULL OR kls.user_id IS NOT NULL)
        ORDER BY s.bezeichnung DESC, k.name
      `).all(request.user.id, request.user.id);
    }
    return reply.viewEjs('klassenlehrer/dashboard.ejs', { user: request.user, klassen });
  });

  // ---------- Klassenleitungsübersicht ----------
  // Bündelt alle Klassenleitungs-Funktionen auf einer Seite mit Reitern:
  // 1. Übersicht (Kacheloptik/Kennzahlen), 2. Halbjahresübersicht (siehe
  // ladeHalbjahresuebersicht), 3. Fehlzeiten (der ursprüngliche Inhalt
  // dieser Seite), 4. Abschluss-/Abgangsübersicht (siehe ladeAbschluss-
  // uebersicht) und 5. Weitere Klassenlehrkräfte (vormals ein eigener
  // Abschnitt auf teacher/klasse_detail.ejs, siehe routes/teacher.js
  // /klassen/:id/klassenleitung/hinzufuegen bzw. /klassenleitung/:id/entfernen).
  fastify.get('/klasse/:id', async (request, reply) => {
    const klasse = getDb().prepare(`
      SELECT k.*, s.bezeichnung AS schuljahr_bezeichnung
      FROM klassen k JOIN schuljahre s ON s.id = k.schuljahr_id
      WHERE k.id = ?
    `).get(request.params.id);
    if (!klasse) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Klasse nicht gefunden.' });
    if (!userIstKlassenlehrer(request.user, klasse.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    const halbjahr = HALBJAHRE.includes(request.query?.hj) ? request.query.hj : HALBJAHRE[0];
    const gueltigeTabs = ['uebersicht', 'halbjahr', 'fehlzeiten', 'abschluss', 'klassenleitung'];
    const aktiverTab = gueltigeTabs.includes(request.query?.tab) ? request.query.tab : 'uebersicht';
    const schueler = getDb().prepare(
      "SELECT * FROM schueler WHERE klasse_id = ? ORDER BY nachname, vorname"
    ).all(klasse.id);

    // ---- Tab 3: Fehlzeiten (unverändert übernommen) ----
    const fehlMap = {};
    const fehlMap2 = {};
    const notizenMap = {};
    for (const s of schueler) {
      fehlMap[s.id] = {};
      fehlMap2[s.id] = {};
      notizenMap[s.id] = [];
      for (const t of FEHLZEIT_TYPEN) {
        fehlMap[s.id][t] = { stunden: 0 };
        fehlMap2[s.id][t] = { stunden: 0 };
      }
    }
    if (schueler.length) {
      const ids = schueler.map((s) => s.id);
      const placeholders = ids.map(() => '?').join(',');
      const rows = getDb().prepare(
        `SELECT schueler_id, typ, stunden FROM fehlzeiten WHERE halbjahr = ? AND schueler_id IN (${placeholders})`
      ).all(halbjahr, ...ids);
      for (const r of rows) {
        if (fehlMap[r.schueler_id]?.[r.typ]) fehlMap[r.schueler_id][r.typ] = { stunden: r.stunden };
      }
      if (klasse.zwei_schulen) {
        const rows2 = getDb().prepare(
          `SELECT schueler_id, typ, stunden FROM fehlzeiten_schule2 WHERE halbjahr = ? AND schueler_id IN (${placeholders})`
        ).all(halbjahr, ...ids);
        for (const r of rows2) {
          if (fehlMap2[r.schueler_id]?.[r.typ]) fehlMap2[r.schueler_id][r.typ] = { stunden: r.stunden };
        }
      }
      const notizRows = getDb().prepare(`
        SELECT n.schueler_id, n.text, n.created_at, u.display_name, u.username
        FROM schueler_notizen n LEFT JOIN users u ON u.id = n.created_by_id
        WHERE n.schueler_id IN (${placeholders})
        ORDER BY n.created_at
      `).all(...ids);
      for (const n of notizRows) notizenMap[n.schueler_id]?.push(n);
    }

    // ---- Tab 2: Halbjahresübersicht (inkl. "Vergangene Schuljahre") ----
    const halbjahresuebersicht = ladeHalbjahresuebersicht(klasse, halbjahr);
    const vergangeneSchuljahre = ladeVergangeneSchuljahre(klasse.id);
    // Schuljahr-Auswahl: Standard ist "aktuelles Schuljahr" (leer) -- die
    // Halbjahresübersicht zeigt dann wie bisher den Live-Sync-Stand. Erst
    // bei explizit ausgewähltem vergangenen Schuljahr wird stattdessen
    // dessen historischer Stand geladen (siehe ladeHistorischeHalbjahresuebersicht) --
    // sonst würden rein historische Fächer sonst im laufenden Schuljahr
    // auftauchen (siehe ladeFaecherFuerKlassenleitung in noten-service.js).
    const verfuegbareSchuljahre = sortiereSchuljahreAbsteigend(
      vergangeneSchuljahre.map((sj) => ({ bezeichnung: sj.schuljahr }))
    ).map((s) => s.bezeichnung);
    const gewaehltesSchuljahr = verfuegbareSchuljahre.includes(request.query?.schuljahr) ? request.query.schuljahr : '';
    const historischeHalbjahresuebersicht = gewaehltesSchuljahr
      ? ladeHistorischeHalbjahresuebersicht(klasse.id, gewaehltesSchuljahr, halbjahr)
      : null;

    // Fächer ohne zugewiesene Lehrkraft -- die Klassenleitung darf sie
    // aufräumen (siehe POST /fach/:id/loeschen), z. B. versehentlich oder
    // mit falschem Namen angelegte rein historische Fächer.
    const faecherOhneLehrkraft = getDb().prepare(`
      SELECT f.id, f.name, f.nur_historisch
      FROM faecher f
      WHERE f.klasse_id = ? AND NOT EXISTS (SELECT 1 FROM fach_zuweisungen fz WHERE fz.fach_id = f.id)
      ORDER BY f.name
    `).all(klasse.id);

    // ---- Tab 4: Abschluss-/Abgangsübersicht ----
    const abschlussuebersicht = ladeAbschlussuebersicht(klasse.id);

    // ---- Tab 5: Weitere Klassenlehrkräfte ----
    const klassenleitungListe = getDb().prepare(`
      SELECT kls.id, kls.user_id, u.display_name, u.username
      FROM klassenleitung kls JOIN users u ON u.id = kls.user_id
      WHERE kls.klasse_id = ?
      ORDER BY u.username
    `).all(klasse.id);
    const zuweisbareLehrkraefte = getDb().prepare(
      "SELECT id, username, display_name FROM users WHERE role != 'admin' AND active = 1 ORDER BY username"
    ).all();

    // ---- Tab 1: Übersicht (Kacheloptik/Kennzahlen) ----
    const offeneEntsperrAnfragen = [...halbjahresuebersicht.sperren.values()]
      .filter((s) => s.aufhebung_angefragt).length;

    return reply.viewEjs('klassenlehrer/klasse_detail.ejs', {
      user: request.user, klasse, halbjahr, schueler, fehlMap, fehlMap2, notizenMap, aktiverTab,
      halbjahresuebersicht, abschlussuebersicht, klassenleitungListe, zuweisbareLehrkraefte,
      offeneEntsperrAnfragen, vergangeneSchuljahre,
      verfuegbareSchuljahre, gewaehltesSchuljahr, historischeHalbjahresuebersicht, faecherOhneLehrkraft,
    });
  });

  // ---------- Vergangenes Schuljahr hinzufügen (Tab 2: Halbjahresübersicht) ----------
  // Legt für ALLE Fächer der Klasse auf einen Schlag historische Halbjahre
  // an (siehe fuegeVergangenesSchuljahrHinzu) -- die eigentliche
  // Noteneingabe bleibt auf der jeweiligen Fach-Seite (Reiter "Historische
  // Halbjahre"), dort durften Klassenleitung UND Fachlehrkraft schon immer
  // eintragen (siehe userDarfFachBearbeiten). Neu ist hier nur das
  // klassenweite Anlegen auf einen Schlag, mit Schutz gegen doppelte/
  // aktuelle Schuljahre.
  fastify.post('/klasse/:id/vergangenes-schuljahr/neu', async (request, reply) => {
    const klasse = getDb().prepare(`
      SELECT k.*, s.bezeichnung AS schuljahr_bezeichnung
      FROM klassen k JOIN schuljahre s ON s.id = k.schuljahr_id
      WHERE k.id = ?
    `).get(request.params.id);
    if (!klasse) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Klasse nicht gefunden.' });
    if (!userIstKlassenlehrer(request.user, klasse.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die Klassenleitung kann vergangene Schuljahre hinzufügen.' });
    }
    const zielRedirect = `/klassenlehrer/klasse/${klasse.id}?tab=halbjahr`;
    const bezeichnung = String(request.body?.bezeichnung || '').trim();
    const pruefung = pruefeVergangenesSchuljahr(klasse.schuljahr_bezeichnung, bezeichnung);
    if (!pruefung.ok) {
      const meldungen = {
        format: `Ungültiges Format „${bezeichnung}" -- Schuljahre müssen als YYYY/YY angegeben werden, z. B. 2022/23.`,
        'nicht-vergangen': `„${bezeichnung}" ist kein vergangenes Schuljahr -- die Klasse läuft aktuell in ${klasse.schuljahr_bezeichnung}.`,
      };
      request.flash?.('error', meldungen[pruefung.fehler]);
      return reply.redirect(zielRedirect);
    }
    // Die Fächer/Lernfelder dieses vergangenen Schuljahres -- eine Zeile je
    // Fach/Lernfeld. Werden NICHT automatisch von den aktuellen Fächern der
    // Klasse übernommen (die können sich seitdem geändert haben), siehe
    // fuegeVergangenesSchuljahrHinzu.
    const faecherNamen = String(request.body?.faecher || '')
      .split('\n').map((n) => n.trim()).filter(Boolean);
    const ergebnis = fuegeVergangenesSchuljahrHinzu(klasse.id, bezeichnung, request.user.id, faecherNamen);
    if (!ergebnis.ok) {
      const meldungen = {
        'bereits-vorhanden': `„${bezeichnung}" wurde für diese Fächer bereits hinzugefügt.`,
        'keine-faecher': 'Bitte mindestens ein Fach/Lernfeld angeben.',
      };
      request.flash?.('error', meldungen[ergebnis.fehler] || 'Anlegen fehlgeschlagen.');
      return reply.redirect(zielRedirect);
    }
    // Fächer, die eine Fachlehrkraft (oder eine frühere Anlage) schon
    // hatten, werden übersprungen -- kurz erwähnen, damit nicht der
    // Eindruck entsteht, dort sei versehentlich nichts passiert.
    let meldung = `Schuljahr „${bezeichnung}" für ${ergebnis.angelegtFuer.join(', ')} hinzugefügt -- Noten je Fach im Reiter „Historische Halbjahre" eintragen.`;
    if (ergebnis.neuAngelegteFaecher.length) {
      meldung += ` Neu angelegt (nur für dieses Schuljahr): ${ergebnis.neuAngelegteFaecher.join(', ')}.`;
    }
    if (ergebnis.uebersprungenFuer.length) {
      meldung += ` Bereits vorhanden (übersprungen): ${ergebnis.uebersprungenFuer.join(', ')}.`;
    }
    request.flash?.('success', meldung);
    return reply.redirect(zielRedirect);
  });

  function baueImportMeldung(ergebnis) {
    let meldung = `${ergebnis.notenGespeichert} Note(n) gespeichert.`;
    if (ergebnis.faecherNeu.length) meldung += ` Neu angelegte Fächer: ${ergebnis.faecherNeu.join(', ')}.`;
    if (ergebnis.faecherUebersprungen.length) {
      meldung += ` Übersprungen (von einer Fachlehrkraft verwaltet, siehe 🔒): ${ergebnis.faecherUebersprungen.join(', ')}.`;
    }
    if (ergebnis.nichtGefundeneSchueler.length) {
      meldung += ` Nicht gefunden (Name prüfen, exakt wie in der Klasse hinterlegt): ${ergebnis.nichtGefundeneSchueler.join(', ')}.`;
    }
    if (ergebnis.ungueltigeWerte.length) {
      meldung += ` Ungültige Werte übersprungen: ${ergebnis.ungueltigeWerte.join('; ')}.`;
    }
    return meldung;
  }

  // ---------- Historische Noten für mehrere Fächer auf einen Schlag importieren ----------
  // Ergänzt fuegeVergangenesSchuljahrHinzu (das nur die LEEREN historischen
  // Halbjahre anlegt) um den eigentlichen Notenimport -- z. B. ein alter
  // Word-/Excel-Notenspiegel mit Vorname/Nachname und einer Spalte je
  // Fach/Lernfeld, per Text eingefügt oder als CSV hochgeladen (siehe
  // src/csv-import.js: parseNotenTabelle, src/fach-abschluss.js:
  // importiereHistorischeNoten).
  fastify.get('/klasse/:id/historische-noten-import', async (request, reply) => {
    const klasse = getDb().prepare(`
      SELECT k.*, s.bezeichnung AS schuljahr_bezeichnung
      FROM klassen k JOIN schuljahre s ON s.id = k.schuljahr_id
      WHERE k.id = ?
    `).get(request.params.id);
    if (!klasse) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Klasse nicht gefunden.' });
    if (!userIstKlassenlehrer(request.user, klasse.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die Klassenleitung kann hier Noten importieren.' });
    }
    return reply.viewEjs('klassenlehrer/historische_noten_import.ejs', { user: request.user, klasse });
  });

  function pruefeImportEingaben(klasse, bezeichnung, halbjahrRoh) {
    const pruefung = pruefeVergangenesSchuljahr(klasse.schuljahr_bezeichnung, bezeichnung);
    if (!pruefung.ok) {
      const meldungen = {
        format: `Ungültiges Format „${bezeichnung}" -- Schuljahre müssen als YYYY/YY angegeben werden, z. B. 2022/23.`,
        'nicht-vergangen': `„${bezeichnung}" ist kein vergangenes Schuljahr -- die Klasse läuft aktuell in ${klasse.schuljahr_bezeichnung}.`,
      };
      return { ok: false, fehler: meldungen[pruefung.fehler] };
    }
    const halbjahrNr = halbjahrRoh === '2' ? 2 : 1;
    return { ok: true, halbjahrNr };
  }

  fastify.post('/klasse/:id/historische-noten-import/text', async (request, reply) => {
    const klasse = getDb().prepare(`
      SELECT k.*, s.bezeichnung AS schuljahr_bezeichnung
      FROM klassen k JOIN schuljahre s ON s.id = k.schuljahr_id
      WHERE k.id = ?
    `).get(request.params.id);
    if (!klasse) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Klasse nicht gefunden.' });
    if (!userIstKlassenlehrer(request.user, klasse.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die Klassenleitung kann hier Noten importieren.' });
    }
    const zielRedirect = `/klassenlehrer/klasse/${klasse.id}/historische-noten-import`;
    const bezeichnung = String(request.body?.bezeichnung || '').trim();
    const eingaben = pruefeImportEingaben(klasse, bezeichnung, request.body?.halbjahr);
    if (!eingaben.ok) {
      request.flash?.('error', eingaben.fehler);
      return reply.redirect(zielRedirect);
    }
    const tabelle = parseNotenTabelle(request.body?.text);
    if (tabelle.fehler) {
      const meldungen = {
        'keine-daten': 'Bitte eine Kopfzeile plus mindestens eine Datenzeile einfügen.',
        'keine-kopfzeile': 'Kopfzeile mit erkennbaren Nachname-/Vorname-Spalten fehlt (z. B. "Nachname", "Vorname").',
        'keine-faecher': 'Außer Nachname/Vorname wurde keine Fach-Spalte gefunden.',
      };
      request.flash?.('error', meldungen[tabelle.fehler] || 'Tabelle konnte nicht gelesen werden.');
      return reply.redirect(zielRedirect);
    }
    const ergebnis = importiereHistorischeNoten(klasse.id, bezeichnung, eingaben.halbjahrNr, tabelle, request.user);
    request.flash?.('success', baueImportMeldung(ergebnis));
    return reply.redirect(zielRedirect);
  });

  // CSV-Datei-Upload -- eigener, gekapselter Plugin-Scope wie bei
  // teacher.js: /klassen/:id/schueler/csv (siehe leseMultipartFormular oben).
  fastify.register(async function (scoped) {
    scoped.addContentTypeParser('multipart/form-data', { parseAs: 'buffer' }, (request, payload, done) => {
      done(null, payload);
    });

    scoped.post('/klasse/:id/historische-noten-import/csv', { bodyLimit: 2 * 1024 * 1024 }, async (request, reply) => {
      const klasse = getDb().prepare(`
        SELECT k.*, s.bezeichnung AS schuljahr_bezeichnung
        FROM klassen k JOIN schuljahre s ON s.id = k.schuljahr_id
        WHERE k.id = ?
      `).get(request.params.id);
      if (!klasse) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Klasse nicht gefunden.' });
      if (!userIstKlassenlehrer(request.user, klasse.id)) {
        return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die Klassenleitung kann hier Noten importieren.' });
      }
      const zielRedirect = `/klassenlehrer/klasse/${klasse.id}/historische-noten-import`;
      let felder = {};
      let datei = null;
      try {
        ({ felder, datei } = await leseMultipartFormular(request.body, request.headers['content-type'], 'datei'));
      } catch {
        datei = null;
      }
      if (!datei) {
        request.flash?.('error', 'Bitte eine CSV-Datei auswählen.');
        return reply.redirect(zielRedirect);
      }
      const bezeichnung = String(felder.bezeichnung || '').trim();
      const eingaben = pruefeImportEingaben(klasse, bezeichnung, felder.halbjahr);
      if (!eingaben.ok) {
        request.flash?.('error', eingaben.fehler);
        return reply.redirect(zielRedirect);
      }
      const tabelle = parseNotenTabelle(datei.toString('utf8'));
      if (tabelle.fehler) {
        const meldungen = {
          'keine-daten': 'Bitte eine Kopfzeile plus mindestens eine Datenzeile hochladen.',
          'keine-kopfzeile': 'Kopfzeile mit erkennbaren Nachname-/Vorname-Spalten fehlt (z. B. "Nachname", "Vorname").',
          'keine-faecher': 'Außer Nachname/Vorname wurde keine Fach-Spalte gefunden.',
        };
        request.flash?.('error', meldungen[tabelle.fehler] || 'Datei konnte nicht gelesen werden.');
        return reply.redirect(zielRedirect);
      }
      const ergebnis = importiereHistorischeNoten(klasse.id, bezeichnung, eingaben.halbjahrNr, tabelle, request.user);
      request.flash?.('success', baueImportMeldung(ergebnis));
      return reply.redirect(zielRedirect);
    });
  });

  // ---------- Historische Halbjahre eines Fachs (für Klassenleitung ohne eigene Fach-Zuweisung) ----------
  // Die normale Fach-Seite (GET /teacher/fach/:id) bleibt bewusst der
  // zugewiesenen Lehrkraft vorbehalten (Live-Notentafel, siehe dort) --
  // diese eigens dafür vorgesehene, schmale Seite gibt der Klassenleitung
  // trotzdem Zugriff auf die "Vergangenes Schuljahr hinzufügen"-Funktion je
  // Fach, ohne die laufende Notentafel offenzulegen.
  fastify.get('/fach/:id/historie', async (request, reply) => {
    const fach = ladeFachMitUmfeld(request.params.id);
    if (!fach) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Fach nicht gefunden.' });
    if (!userIstKlassenlehrer(request.user, fach.klasse_id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die Klassenleitung hat hier Zugriff.' });
    }
    const schueler = getDb().prepare('SELECT * FROM schueler WHERE klasse_id = ? ORDER BY nachname, vorname').all(fach.klasse_id);
    const historischeHalbjahre = ladeHistorischeHalbjahre(fach.id).map((hh) => ({
      ...hh, noten: ladeHistorischeNoten(hh.id),
      darfBearbeiten: userDarfHistorischeNotenBearbeiten(request.user, fach, hh),
    }));
    // Gerade bei einem rein historischen Fach (nur_historisch, siehe
    // src/db.js) ist meist niemand zugewiesen -- die Klassenleitung kann
    // hier trotzdem eine Lehrkraft zuordnen, die dann per fach_zuweisungen
    // ganz normal Zugriff auf die Notentafel/Historie dieses Fachs bekommt
    // (siehe userHatFachZgriff in src/auth.js).
    const zuweisbareLehrkraefte = getDb().prepare(
      "SELECT id, username, display_name FROM users WHERE role != 'admin' AND active = 1 ORDER BY username"
    ).all();
    const zuweisungen = getDb().prepare(`
      SELECT fz.id, u.display_name, u.username
      FROM fach_zuweisungen fz JOIN users u ON u.id = fz.user_id
      WHERE fz.fach_id = ? ORDER BY u.username
    `).all(fach.id);
    return reply.viewEjs('klassenlehrer/fach_historie.ejs', {
      user: request.user, fach, schueler, historischeHalbjahre, zuweisbareLehrkraefte, zuweisungen,
    });
  });

  // ---------- Lehrkraft einem Fach zuordnen (von der Historie-Seite aus) ----------
  fastify.post('/fach/:id/lehrkraft/neu', async (request, reply) => {
    const fach = ladeFachMitUmfeld(request.params.id);
    if (!fach) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Fach nicht gefunden.' });
    if (!userIstKlassenlehrer(request.user, fach.klasse_id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die Klassenleitung kann hier Lehrkräfte zuweisen.' });
    }
    const zielRedirect = `/klassenlehrer/fach/${fach.id}/historie`;
    const userId = parseInt(request.body?.user_id, 10);
    if (!userId) {
      request.flash?.('error', 'Ungültige Auswahl.');
      return reply.redirect(zielRedirect);
    }
    try {
      getDb().prepare('INSERT INTO fach_zuweisungen (user_id, fach_id) VALUES (?, ?)').run(userId, fach.id);
    } catch {
      request.flash?.('error', 'Diese Zuweisung besteht bereits.');
    }
    return reply.redirect(zielRedirect);
  });

  fastify.post('/zuweisung/:id/loeschen', async (request, reply) => {
    const z = getDb().prepare(`
      SELECT fz.id, fz.fach_id, f.klasse_id FROM fach_zuweisungen fz JOIN faecher f ON f.id = fz.fach_id WHERE fz.id = ?
    `).get(request.params.id);
    if (!z) return reply.redirect('/klassenlehrer');
    if (!userIstKlassenlehrer(request.user, z.klasse_id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die Klassenleitung kann hier Zuweisungen entfernen.' });
    }
    getDb().prepare('DELETE FROM fach_zuweisungen WHERE id = ?').run(z.id);
    return reply.redirect(`/klassenlehrer/fach/${z.fach_id}/historie`);
  });

  // ---------- Fach ohne Lehrkraft löschen (Aufräumen, z. B. versehentlich ----------
  // angelegte oder nicht mehr benötigte rein historische Fächer). Bewusst
  // enger gefasst als die allgemeine Fach-Löschung in routes/teacher.js
  // (userDarfFachLoeschen): hier darf die Klassenleitung NUR löschen, wenn
  // wirklich niemand dem Fach zugewiesen ist -- sonst könnte sie versehentlich
  // die laufende Arbeit einer Fachlehrkraft entfernen.
  fastify.post('/fach/:id/loeschen', async (request, reply) => {
    const fach = getDb().prepare('SELECT id, klasse_id, name, ist_kurs FROM faecher WHERE id = ?').get(request.params.id);
    if (!fach) return reply.redirect('/klassenlehrer');
    if (!userIstKlassenlehrer(request.user, fach.klasse_id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Nur die Klassenleitung kann hier Fächer löschen.' });
    }
    // #fuer-loeschung: nach dem Löschen soll die Seite dort weiter angezeigt
    // werden, statt ganz nach oben zu springen (siehe id in klasse_detail.ejs).
    const zielRedirect = `/klassenlehrer/klasse/${fach.klasse_id}?tab=halbjahr#fuer-loeschung`;
    const anzahlZuweisungen = getDb().prepare('SELECT COUNT(*) AS c FROM fach_zuweisungen WHERE fach_id = ?').get(fach.id).c;
    if (anzahlZuweisungen > 0) {
      request.flash?.('error', `„${fach.name}" ist noch einer Lehrkraft zugewiesen -- bitte zuerst die Zuweisung entfernen.`);
      return reply.redirect(zielRedirect);
    }
    getDb().prepare('DELETE FROM faecher WHERE id = ?').run(fach.id);
    // Eine Kurs-Hülle (siehe /teacher/kurse/neu) gehört exakt einem Kurs --
    // mit ihm verschwindet auch sie, statt als leere Karteileiche liegen zu bleiben.
    getDb().prepare('DELETE FROM klassen WHERE id = ? AND ist_kurs_huelle = 1').run(fach.klasse_id);
    request.flash?.('success', `„${fach.name}" wurde gelöscht.`);
    return reply.redirect(zielRedirect);
  });

  // ---------- Freie Notizen je Schüler/in (unabhängig von Noten/Fehlzeiten) ----------
  fastify.post('/schueler/:id/notiz', async (request, reply) => {
    const schueler = getDb().prepare('SELECT klasse_id FROM schueler WHERE id = ?').get(request.params.id);
    if (!schueler) return reply.redirect('/klassenlehrer');
    if (!userIstKlassenlehrer(request.user, schueler.klasse_id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    const text = String(request.body?.text || '').trim();
    if (text) {
      getDb().prepare('INSERT INTO schueler_notizen (schueler_id, text, created_by_id) VALUES (?, ?, ?)')
        .run(request.params.id, text, request.user.id);
    }
    const halbjahr = HALBJAHRE.includes(request.body?.hj) ? request.body.hj : HALBJAHRE[0];
    return reply.redirect(`/klassenlehrer/klasse/${schueler.klasse_id}?hj=${encodeURIComponent(halbjahr)}&tab=fehlzeiten`);
  });

  fastify.post('/klasse/:id/speichern', async (request, reply) => {
    const klasse = getDb().prepare('SELECT * FROM klassen WHERE id = ?').get(request.params.id);
    if (!klasse) return reply.redirect('/klassenlehrer');
    if (!userIstKlassenlehrer(request.user, klasse.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    const halbjahr = HALBJAHRE.includes(request.body?.hj) ? request.body.hj : HALBJAHRE[0];
    const schueler = getDb().prepare(
      'SELECT id FROM schueler WHERE klasse_id = ?'
    ).all(klasse.id);
    // Das alte notiz-Feld (je Fehlzeitenart) wird nicht mehr im UI gepflegt
    // (siehe schueler_notizen) — beim Speichern bewusst unangetastet lassen,
    // statt es bei jedem Speichern stillschweigend mit einem leeren String
    // zu überschreiben.
    const upsert = getDb().prepare(`
      INSERT INTO fehlzeiten (schueler_id, halbjahr, typ, stunden, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT (schueler_id, halbjahr, typ) DO UPDATE SET
        stunden = excluded.stunden,
        updated_at = datetime('now')
    `);
    const upsert2 = getDb().prepare(`
      INSERT INTO fehlzeiten_schule2 (schueler_id, halbjahr, typ, stunden, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT (schueler_id, halbjahr, typ) DO UPDATE SET
        stunden = excluded.stunden,
        updated_at = datetime('now')
    `);
    const tx = getDb().transaction(() => {
      let count = 0;
      for (const s of schueler) {
        for (const t of FEHLZEIT_TYPEN) {
          const stundenRaw = request.body?.['stunden_' + s.id + '_' + t];
          if (stundenRaw !== undefined && stundenRaw !== '') {
            const stunden = Math.max(0, Number(stundenRaw) || 0);
            upsert.run(s.id, halbjahr, t, stunden);
            count++;
          }
          if (klasse.zwei_schulen) {
            const stunden2Raw = request.body?.['stunden2_' + s.id + '_' + t];
            if (stunden2Raw !== undefined && stunden2Raw !== '') {
              const stunden2 = Math.max(0, Number(stunden2Raw) || 0);
              upsert2.run(s.id, halbjahr, t, stunden2);
              count++;
            }
          }
        }
      }
      return count;
    });
    const count = tx();
    request.flash?.('success', `Fehlzeiten gespeichert (${count} Einträge).`);
    return reply.redirect(`/klassenlehrer/klasse/${klasse.id}?hj=${encodeURIComponent(halbjahr)}&tab=fehlzeiten`);
  });

  fastify.post('/klasse/:id/zwei-schulen', async (request, reply) => {
    const klasse = getDb().prepare('SELECT id FROM klassen WHERE id = ?').get(request.params.id);
    if (!klasse) return reply.redirect('/klassenlehrer');
    if (!userIstKlassenlehrer(request.user, klasse.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    const aktiv = request.body?.aktiv === '1';
    getDb().prepare('UPDATE klassen SET zwei_schulen = ? WHERE id = ?').run(aktiv ? 1 : 0, klasse.id);
    return reply.redirect(`/klassenlehrer/klasse/${klasse.id}?tab=fehlzeiten`);
  });
}
