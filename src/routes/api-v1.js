/**
 * API für KI-Agenten und Programme (/api/v1): Klassen, Fächer und Noten auslesen und verarbeiten, Noten eintragen.
 *
 * Authentisierung: Authorization: Bearer nk_… (persönlicher API-Schlüssel, siehe src/api-keys.js, Menü „API-Zugang“). Ein Schlüssel handelt
 * mit den Rechten seiner Lehrkraft -- es gelten dieselben Prüfungen wie in der Oberfläche (Fach- und Halbjahreszugriff, Teilnahme am Fach,
 * Notenkonferenz-Sperre). Berechtigung „lesen“ erlaubt nur Abfragen und Berechnungen, „schreiben“ zusätzlich das Eintragen.
 *
 * Eintragen ist „alles oder nichts“: werden mehrere Personen auf einmal geschickt und ein Eintrag ist ungültig, wird nichts gespeichert (422
 * mit der Liste der Fehler). Mit ?dry_run=true prüft die API nur und zeigt, was passieren würde. Gelöscht wird über die API nichts.
 *
 * Beschreibung der Endpunkte: src/api-docs.js (-> /api/v1/openapi.json, /api/v1/docs, docs/API.md).
 */

import { getDb } from '../db.js';
import {
  ladeMeineKlassen, ladeMeineKurse, userHatKlassenZugriff, userHatFachZgriff, userIstKlassenlehrer, userDarfTeilnehmerVerwalten,
} from '../auth.js';
import { pruefeSchluessel, rateLimitErreicht } from '../api-keys.js';
import { ladeFachMitUmfeld, ladeNotenuebersicht, getNotenschluesselCsv, unterfaecherDesHalbjahrs } from '../noten-service.js';
import { halbjahreFuerFach, halbjahrAusEingabeFuerFach, halbjahrNr } from '../klassen-jahre.js';
import {
  parseKlausurTeile, klausurNote, klausurTeilNoten, klausurProzent, MAX_KLAUSUR_TEILE, TEIL_ARTEN, noteAusPunkten,
} from '../grade-calc.js';
import { globalerSchluessel, tabelle, TYPEN } from '../notenschluessel.js';
import { ladeTeilnehmerMitHerkunft, legeManuellenTeilnehmerAn } from '../fach-teilnehmer.js';
import { istSchuelerGesperrtInFach, ladeSperrenFuerSchueler } from '../noten-sperre.js';
import { setzeEndnote, notenBereich, parseEndnoteEingabe } from '../halbjahr-endnoten.js';
import { syncFach, syncPerson, syncFallsAutoAktiv, holeSyncMeta } from '../noten-sync.js';
import { autoVerteileKlausuren } from './teacher.js';
import { benenneKlasseUm } from '../umbenennen.js';
import { ENDPOINTS, FEHLERCODES, baueOpenApi, API_BASIS } from '../api-docs.js';

const MAX_EINTRAEGE = 500;
const MAX_AUFGABEN = 40;

/** Stand der Synchronisation mit der Klassenleitung für Fach, Halbjahr und diese Lehrkraft. */
function syncStand(user, fachId, halbjahr) {
  const meta = holeSyncMeta(fachId, halbjahr);
  const z = getDb().prepare('SELECT auto_sync FROM fach_zuweisungen WHERE fach_id = ? AND user_id = ?').get(fachId, user.id);
  return {
    automatisch: z ? Boolean(z.auto_sync) : null, // null: dieser Schlüssel/Konto hat keine eigene Zuordnung zum Fach
    zuletzt_synchronisiert_am: meta ? meta.synced_at : null,
    zuletzt_synchronisiert_von: meta ? (meta.display_name || meta.username) : null,
  };
}

const NOTENEINHEIT = { IHK: 'Note (1–6)', BG: 'Notenpunkte (0–15)', SPA: 'Note (1–6), daraus Punkte und Tendenz' };

function senden(reply, status, code, message, details) {
  return reply.code(status).send({ error: code, message, ...(details ? { details } : {}) });
}

const istDatum = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const istZahl = (v) => typeof v === 'number' && Number.isFinite(v);
const alsBool = (v) => v === true || v === 'true' || v === '1';

/** Halbjahr aus der Anfrage: Ziffer oder „5. Halbjahr“; ohne Angabe das aktuelle. Ungültig -> null. */
function halbjahrVon(fach, roh) {
  if (roh === undefined || roh === null || roh === '') return halbjahrAusEingabeFuerFach(fach, undefined);
  const liste = halbjahreFuerFach(fach);
  const text = /^\d{1,2}$/.test(String(roh)) ? `${parseInt(roh, 10)}. Halbjahr` : String(roh);
  return liste.includes(text) ? text : null;
}

function fachMeta(fach, halbjahr) {
  return {
    id: fach.id, name: fach.name, klasse: fach.klasse_name, klasse_id: fach.klasse_id, schuljahr: fach.schuljahr_bezeichnung,
    notenschluessel: fach.notenschluessel, halbjahr, halbjahre: halbjahreFuerFach(fach),
  };
}

export default async function apiV1Routes(fastify) {
  // ---------- Öffentlich: Beschreibung ----------
  // Hinter einem Proxy (Plesk) ist PUBLIC_URL die verlässliche Basis-Adresse; sonst aus der Anfrage.
  const serverUrl = (request) => (process.env.PUBLIC_URL || `${request.protocol}://${request.headers.host}`).replace(/\/$/, '');
  fastify.get('/openapi.json', async (request) => baueOpenApi({ version: '1.0.0', serverUrl: serverUrl(request) }));
  fastify.get('/docs', async (request, reply) => reply.viewEjs('api-docs.ejs', {
    user: request.user, endpoints: ENDPOINTS, fehlercodes: FEHLERCODES, basis: `${serverUrl(request)}${API_BASIS}`,
  }));

  // ---------- Mit Schlüssel ----------
  await fastify.register(async (api) => {
    api.addHook('preHandler', async (request, reply) => {
      const p = pruefeSchluessel(request.headers.authorization);
      if (!p.ok) return senden(reply, p.status, 'unauthorized', p.fehler);
      if (rateLimitErreicht(p.key.id)) return senden(reply, 429, 'rate_limit', FEHLERCODES[429]);
      request.apiUser = p.user;
      request.apiKey = p.key;
      request.user = p.user; // nur für die Dauer dieser Anfrage; die Rechte-Helfer erwarten request.user
    });

    /** Route mit Berechtigungsprüfung des Schlüssels. */
    const route = (method, pfad, scope, handler) => api.route({
      method, url: pfad,
      preHandler: async (request, reply) => {
        if (scope === 'schreiben' && request.apiKey.scope !== 'schreiben') {
          return senden(reply, 403, 'forbidden_scope', 'Dieser Schlüssel darf nur lesen. Für das Eintragen einen Schlüssel mit der Berechtigung „schreiben“ anlegen.');
        }
        return undefined;
      },
      handler,
    });

    // Fach laden und Rechte prüfen. Bei Fehler wird geantwortet und null zurückgegeben.
    const fachFuer = (request, reply, { halbjahrRoh, schreiben = false } = {}) => {
      const fach = ladeFachMitUmfeld(parseInt(request.params.id, 10));
      if (!fach) { senden(reply, 404, 'not_found', 'Fach nicht gefunden.'); return null; }
      if (!userHatFachZgriff(request.apiUser, fach.id)) { senden(reply, 403, 'forbidden', 'Kein Zugriff auf dieses Fach.'); return null; }
      const halbjahr = halbjahrVon(fach, halbjahrRoh);
      if (!halbjahr) { senden(reply, 400, 'bad_halbjahr', `Ungültiges Halbjahr. Erlaubt: ${halbjahreFuerFach(fach).join(', ')}.`); return null; }
      if (!userHatFachZgriff(request.apiUser, fach.id, halbjahr)) { senden(reply, 403, 'forbidden', 'Keine Berechtigung für dieses Halbjahr.'); return null; }
      if (schreiben && (fach.spa_fach_key || unterfaecherDesHalbjahrs(fach, halbjahr).length)) {
        senden(reply, 409, 'nicht_unterstuetzt', 'In SPA-Fächern und in Fächern, die sich in diesem Halbjahr aus Unterfächern zusammensetzen, kann die API nicht eintragen -- bitte direkt im jeweiligen Unterfach bzw. in der Oberfläche.');
        return null;
      }
      return { fach, halbjahr };
    };

    // ---------- Lesen ----------
    route('GET', '/me', 'lesen', async (request) => ({
      nutzer: { id: request.apiUser.id, benutzername: request.apiUser.username, name: request.apiUser.displayName, admin: request.apiUser.isAdmin },
      schluessel: { name: request.apiKey.name, berechtigung: request.apiKey.scope, laeuft_ab: request.apiKey.expires_at },
    }));

    route('GET', '/klassen', 'lesen', async (request) => {
      const user = request.apiUser;
      const alle = user.isAdmin
        ? getDb().prepare('SELECT k.*, s.bezeichnung AS schuljahr_bezeichnung FROM klassen k JOIN schuljahre s ON s.id = k.schuljahr_id WHERE k.ist_kurs_huelle = 0 AND k.ist_ablage = 0 ORDER BY s.bezeichnung DESC, k.name').all()
        : ladeMeineKlassen(user.id);
      const klassen = alle.map((k) => ({
        id: k.id, name: k.name, schuljahr: k.schuljahr_bezeichnung, notenschluessel: k.notenschluessel,
        klassenleitung: userIstKlassenlehrer(user, k.id),
        faecher: getDb().prepare('SELECT * FROM faecher WHERE klasse_id = ? AND ist_kurs = 0 AND parent_fach_id IS NULL ORDER BY name').all(k.id)
          .filter((f) => userHatFachZgriff(user, f.id))
          .map((f) => ({ id: f.id, name: f.name, halbjahre: halbjahreFuerFach(f) })),
      }));
      const kurse = user.isAdmin ? [] : ladeMeineKurse(user.id).map((f) => ({
        id: f.id, name: f.name, schuljahr: f.schuljahr_bezeichnung, notenschluessel: f.notenschluessel, halbjahre: halbjahreFuerFach(f),
      }));
      return { klassen, kurse };
    });

    route('GET', '/klassen/:id/schueler', 'lesen', async (request, reply) => {
      const klasse = getDb().prepare('SELECT id, name FROM klassen WHERE id = ?').get(parseInt(request.params.id, 10));
      if (!klasse) return senden(reply, 404, 'not_found', 'Klasse nicht gefunden.');
      if (!userHatKlassenZugriff(request.apiUser, klasse.id)) return senden(reply, 403, 'forbidden', 'Kein Zugriff auf diese Klasse.');
      const schueler = getDb().prepare('SELECT id, nachname, vorname, status FROM schueler WHERE klasse_id = ? ORDER BY nachname, vorname').all(klasse.id);
      return { klasse, schueler };
    });

    // Klasse umbenennen: wie in der App darf das jede Lehrkraft der Klasse; der Name gilt für alle, die eingetragen sind.
    route('PUT', '/klassen/:id/name', 'schreiben', async (request, reply) => {
      const klasse = getDb().prepare('SELECT * FROM klassen WHERE id = ?').get(parseInt(request.params.id, 10));
      if (!klasse || klasse.ist_kurs_huelle) return senden(reply, 404, 'not_found', 'Klasse nicht gefunden.');
      if (klasse.ist_ablage) return senden(reply, 403, 'forbidden', 'Die Sammelklasse „Ohne Klasse“ lässt sich nicht umbenennen.');
      if (!userHatKlassenZugriff(request.apiUser, klasse.id)) return senden(reply, 403, 'forbidden', 'Kein Zugriff auf diese Klasse.');
      const r = benenneKlasseUm(klasse, request.body?.name, { speichern: speichern(request) });
      if (!r.ok) return senden(reply, 422, 'invalid', r.fehler);
      if (speichern(request) && r.geaendert) request.log.info({ key: request.apiKey.id, klasse: klasse.id }, 'api: Klasse umbenannt');
      return { gespeichert: speichern(request) && r.geaendert, ...(speichern(request) ? {} : { dry_run: true }), klasse: { id: klasse.id, name: r.neu, vorher: r.alt } };
    });

    route('GET', '/faecher/:id', 'lesen', async (request, reply) => {
      const ctx = fachFuer(request, reply, { halbjahrRoh: request.query?.halbjahr });
      if (!ctx) return undefined;
      const { fach, halbjahr } = ctx;
      const db = getDb();
      return {
        fach: fachMeta(fach, halbjahr),
        klausuren: db.prepare('SELECT * FROM klausuren WHERE fach_id = ? AND halbjahr = ? ORDER BY id').all(fach.id, halbjahr).map((k) => ({
          id: k.id, name: k.name, datum: k.datum, max_punkte: JSON.parse(k.max_punkte_pro_aufgabe), gewichtung: k.gewichtung,
          teile: parseKlausurTeile(k.teile)?.teile ?? null, max_extrapunkte: k.max_extrapunkte ?? null,
        })),
        unterrichtsleistungen: db.prepare('SELECT * FROM unterrichtsleistungen WHERE fach_id = ? AND halbjahr = ? ORDER BY id').all(fach.id, halbjahr).map((u) => ({
          id: u.id, name: u.name, datum: u.datum, max_punkte: JSON.parse(u.max_punkte_pro_aufgabe), gewichtung: u.gewichtung,
        })),
        termine: db.prepare('SELECT id, datum FROM unterricht_termine WHERE fach_id = ? AND halbjahr = ? ORDER BY datum, id').all(fach.id, halbjahr),
        sync: syncStand(request.apiUser, fach.id, halbjahr),
      };
    });

    const notenZeilen = (fach, halbjahr) => {
      const uebersicht = ladeNotenuebersicht(fach, halbjahr);
      const sperren = ladeSperrenFuerSchueler(uebersicht.rows.map((r) => r.schueler_id), halbjahr);
      return { uebersicht, sperren };
    };

    route('GET', '/faecher/:id/teilnehmer', 'lesen', async (request, reply) => {
      const ctx = fachFuer(request, reply, { halbjahrRoh: request.query?.halbjahr });
      if (!ctx) return undefined;
      const { fach } = ctx;
      const teilnehmer = ladeTeilnehmerMitHerkunft(fach).map((t) => ({
        id: t.id, nachname: t.nachname, vorname: t.vorname, klasse: t.klasse_name, aus_anderer_klasse: Boolean(t.fremd),
      }));
      return { fach: { id: fach.id, name: fach.name, kurs: Boolean(fach.ist_kurs) }, anzahl: teilnehmer.length, teilnehmer };
    });

    route('GET', '/faecher/:id/noten', 'lesen', async (request, reply) => {
      const ctx = fachFuer(request, reply, { halbjahrRoh: request.query?.halbjahr });
      if (!ctx) return undefined;
      const { fach, halbjahr } = ctx;
      const { uebersicht, sperren } = notenZeilen(fach, halbjahr);
      return {
        fach: fachMeta(fach, halbjahr),
        anteil_schriftlich_prozent: uebersicht.schriftlichPct, anteil_unterrichtsleistung_prozent: uebersicht.ulPct,
        zusammensetzung_aus_unterfaechern: Boolean(uebersicht.komposition),
        schueler: uebersicht.rows.map((r) => ({
          id: r.schueler_id, nachname: r.nachname, vorname: r.vorname, gesperrt: Boolean(sperren.get(r.schueler_id)),
          klausuren: (r.klausuren || []).map((k) => ({ id: k.id, name: k.name, punkte: k.punkte, extrapunkte: k.extrapunkte, note: k.note, teilnoten: k.teilNoten })),
          unterrichtsleistungen: (r.uls || []).map((u) => ({ id: u.id, name: u.name, punkte: u.punkte, note: u.note })),
          datumsnoten: (r.terminNoten || []).map((t) => ({ termin_id: t.termin_id, datum: t.datum, note: t.wert, nicht_anwesend: t.na })),
          unterfaecher_noten: r.unterfachNoten || undefined,
          note_schriftlich: r.schriftlicheNote, note_unterrichtsleistung: r.muendlicheNote, vorhalbjahr: r.vorhalbjahrNote,
          gesamtnote: r.gesamt, endnote: r.endnote ? { note: r.endnote.note, ntg: Boolean(r.endnote.ntg) } : null,
          nicht_bestanden: Boolean(r.nicht_bestanden),
        })),
      };
    });

    route('GET', '/faecher/:id/statistik', 'lesen', async (request, reply) => {
      const ctx = fachFuer(request, reply, { halbjahrRoh: request.query?.halbjahr });
      if (!ctx) return undefined;
      const { fach, halbjahr } = ctx;
      const { uebersicht } = notenZeilen(fach, halbjahr);
      const mit = uebersicht.rows.filter((r) => r.gesamt !== null && r.gesamt !== undefined);
      const werte = mit.map((r) => r.gesamt);
      const verteilung = new Map();
      for (const w of werte) verteilung.set(Math.round(w), (verteilung.get(Math.round(w)) || 0) + 1);
      return {
        fach: { id: fach.id, name: fach.name, halbjahr, notenschluessel: fach.notenschluessel },
        anzahl_mit_note: mit.length, anzahl_ohne_note: uebersicht.rows.length - mit.length,
        durchschnitt: werte.length ? Math.round((werte.reduce((a, b) => a + b, 0) / werte.length) * 100) / 100 : null,
        beste: werte.length ? (fach.notenschluessel === 'BG' ? Math.max(...werte) : Math.min(...werte)) : null,
        schlechteste: werte.length ? (fach.notenschluessel === 'BG' ? Math.min(...werte) : Math.max(...werte)) : null,
        nicht_bestanden: mit.filter((r) => r.nicht_bestanden).length,
        verteilung: [...verteilung.entries()].sort((a, b) => a[0] - b[0]).map(([note, anzahl]) => ({ note, anzahl })),
      };
    });

    route('GET', '/notenschluessel', 'lesen', async () => ({
      notenschluessel: TYPEN.map((typ) => {
        const g = globalerSchluessel(typ);
        return { typ, einheit: NOTENEINHEIT[typ], angepasst: g.angepasst, tabelle: tabelle(g.csv).map((z) => ({ ab_prozent: z.ab, note: z.note })) };
      }),
    }));

    route('POST', '/berechnen/klausur', 'lesen', async (request, reply) => {
      const b = request.body || {};
      if (!TYPEN.includes(b.notenschluessel)) return senden(reply, 400, 'bad_request', `notenschluessel muss ${TYPEN.join(', ')} sein.`);
      const max = b.max_punkte;
      const punkte = b.punkte;
      if (!Array.isArray(max) || !max.length || max.length > MAX_AUFGABEN || !max.every((m) => istZahl(m) && m >= 0)) {
        return senden(reply, 400, 'bad_request', `max_punkte: Liste mit 1 bis ${MAX_AUFGABEN} Zahlen (≥ 0).`);
      }
      if (!Array.isArray(punkte) || punkte.length !== max.length || !punkte.every((p, i) => p === null || (istZahl(p) && p >= 0 && p <= max[i]))) {
        return senden(reply, 400, 'bad_request', 'punkte: Liste gleicher Länge wie max_punkte, je Aufgabe Zahl zwischen 0 und dem Maximum oder null.');
      }
      let teileInfo = null;
      if (b.teile !== undefined && b.teile !== null) {
        if (!Array.isArray(b.teile) || b.teile.length < 2 || b.teile.length > MAX_KLAUSUR_TEILE) return senden(reply, 400, 'bad_request', `teile: 2 bis ${MAX_KLAUSUR_TEILE} Teile.`);
        teileInfo = parseKlausurTeile({
          teile: b.teile.map((t) => ({ name: t.name, aufgaben: t.aufgaben, gewichtung: t.gewichtung, art: TEIL_ARTEN.includes(t.art) ? t.art : 'standard', inhaltAnteil: t.inhalt_anteil })),
          bestimmend: Number.isInteger(b.bestimmend) ? b.bestimmend : null,
        });
        if (!teileInfo || teileInfo.teile.reduce((a, t) => a + t.aufgaben, 0) !== max.length) {
          return senden(reply, 400, 'bad_request', 'teile: Summe der Aufgaben aller Teile muss der Länge von max_punkte entsprechen (Hörverstehen = 1, Inhalt & Sprache = 2 Aufgaben).');
        }
      }
      const csv = globalerSchluessel(b.notenschluessel).csv;
      const extra = istZahl(b.extrapunkte) && b.extrapunkte > 0 ? b.extrapunkte : 0;
      return {
        note: klausurNote(punkte, max, teileInfo, csv, teileInfo ? 0 : extra),
        teilnoten: teileInfo ? klausurTeilNoten(punkte, max, teileInfo, csv) : null,
        prozent: klausurProzent(punkte, max, teileInfo ? 0 : extra),
      };
    });

    // ---------- Eintragen ----------
    const speichern = (request) => !alsBool(request.query?.dry_run);

    route('POST', '/faecher/:id/klausuren', 'schreiben', async (request, reply) => {
      const ctx = fachFuer(request, reply, { halbjahrRoh: request.body?.halbjahr, schreiben: true });
      if (!ctx) return undefined;
      const { fach, halbjahr } = ctx;
      const b = request.body || {};
      const f = pruefeNeueLeistung(b);
      if (f) return senden(reply, 422, 'invalid', f);
      const klausur = { name: b.name.trim(), datum: b.datum ?? null, max_punkte: b.max_punkte, gewichtung: b.gewichtung ?? null };
      if (!speichern(request)) return { gespeichert: false, dry_run: true, klausur };
      const info = getDb().prepare('INSERT INTO klausuren (fach_id, halbjahr, name, datum, max_punkte_pro_aufgabe, gewichtung) VALUES (?, ?, ?, ?, ?, ?)')
        .run(fach.id, halbjahr, klausur.name, klausur.datum, JSON.stringify(klausur.max_punkte), klausur.gewichtung ?? 0);
      if (klausur.gewichtung === null) autoVerteileKlausuren(fach.id, halbjahr, { erzwingen: true });
      syncFallsAutoAktiv(fach.id, halbjahr, request.apiUser.id);
      request.log.info({ key: request.apiKey.id, fach: fach.id }, 'api: Klausur angelegt');
      const row = getDb().prepare('SELECT id, gewichtung FROM klausuren WHERE id = ?').get(info.lastInsertRowid);
      return { gespeichert: true, klausur: { id: row.id, ...klausur, gewichtung: row.gewichtung } };
    });

    route('POST', '/faecher/:id/unterrichtsleistungen', 'schreiben', async (request, reply) => {
      const ctx = fachFuer(request, reply, { halbjahrRoh: request.body?.halbjahr, schreiben: true });
      if (!ctx) return undefined;
      const { fach, halbjahr } = ctx;
      const b = request.body || {};
      const f = pruefeNeueLeistung(b);
      if (f) return senden(reply, 422, 'invalid', f);
      const ul = { name: b.name.trim(), datum: b.datum ?? null, max_punkte: b.max_punkte, gewichtung: b.gewichtung ?? 0 };
      if (!speichern(request)) return { gespeichert: false, dry_run: true, unterrichtsleistung: ul };
      const info = getDb().prepare('INSERT INTO unterrichtsleistungen (fach_id, halbjahr, name, datum, max_punkte_pro_aufgabe, gewichtung) VALUES (?, ?, ?, ?, ?, ?)')
        .run(fach.id, halbjahr, ul.name, ul.datum, JSON.stringify(ul.max_punkte), ul.gewichtung);
      syncFallsAutoAktiv(fach.id, halbjahr, request.apiUser.id);
      request.log.info({ key: request.apiKey.id, fach: fach.id }, 'api: Zusatzleistung angelegt');
      return { gespeichert: true, unterrichtsleistung: { id: Number(info.lastInsertRowid), ...ul } };
    });

    /** Gemeinsame Prüfung für neue Klausuren/Zusatzleistungen. @returns {string|null} Fehlertext */
    function pruefeNeueLeistung(b) {
      if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 120) return 'name: Text mit 1 bis 120 Zeichen.';
      if (!Array.isArray(b.max_punkte) || !b.max_punkte.length || b.max_punkte.length > MAX_AUFGABEN || !b.max_punkte.every((m) => istZahl(m) && m >= 0)) {
        return `max_punkte: Liste mit 1 bis ${MAX_AUFGABEN} Zahlen (≥ 0), eine je Aufgabe.`;
      }
      if (b.datum !== undefined && b.datum !== null && !istDatum(b.datum)) return 'datum: Format JJJJ-MM-TT oder null.';
      if (b.gewichtung !== undefined && b.gewichtung !== null && !(istZahl(b.gewichtung) && b.gewichtung >= 0 && b.gewichtung <= 100)) return 'gewichtung: Zahl von 0 bis 100.';
      return null;
    }

    // Ergebnisse (Punkte) einer Klausur bzw. Zusatzleistung. Alles oder nichts.
    const ergebnisseHandler = (art) => async (request, reply) => {
      const cfg = art === 'klausur'
        ? { tabelle: 'klausuren', ergebnisse: 'klausur_ergebnisse', fk: 'klausur_id', label: 'Klausur' }
        : { tabelle: 'unterrichtsleistungen', ergebnisse: 'ul_ergebnisse', fk: 'ul_id', label: 'Zusatzleistung' };
      const l = getDb().prepare(`SELECT * FROM ${cfg.tabelle} WHERE id = ?`).get(parseInt(request.params.id, 10));
      if (!l) return senden(reply, 404, 'not_found', `${cfg.label} nicht gefunden.`);
      if (!userHatFachZgriff(request.apiUser, l.fach_id, l.halbjahr)) return senden(reply, 403, 'forbidden', 'Keine Berechtigung für dieses Fach bzw. Halbjahr.');
      const fach = ladeFachMitUmfeld(l.fach_id);
      if (fach.spa_fach_key || unterfaecherDesHalbjahrs(fach, l.halbjahr).length) return senden(reply, 409, 'nicht_unterstuetzt', 'Für dieses Fach kann die API nicht eintragen.');
      const liste = request.body?.ergebnisse;
      if (!Array.isArray(liste) || !liste.length || liste.length > MAX_EINTRAEGE) return senden(reply, 400, 'bad_request', `ergebnisse: Liste mit 1 bis ${MAX_EINTRAEGE} Einträgen.`);

      const maxArr = JSON.parse(l.max_punkte_pro_aufgabe);
      const teileInfo = art === 'klausur' ? parseKlausurTeile(l.teile) : null;
      const csv = getNotenschluesselCsv(fach);
      const teilnehmer = new Set(ladeTeilnehmerMitHerkunft(fach).map((t) => t.id));
      const fehler = [];
      const geprueft = [];
      const gesehen = new Set();
      liste.forEach((e, i) => {
        const wo = `ergebnisse[${i}]`;
        const sid = e?.schueler_id;
        if (!Number.isInteger(sid)) return fehler.push({ stelle: wo, fehler: 'schueler_id fehlt oder ist keine ganze Zahl.' });
        if (gesehen.has(sid)) return fehler.push({ stelle: wo, schueler_id: sid, fehler: 'Person kommt mehrfach vor.' });
        gesehen.add(sid);
        if (!teilnehmer.has(sid)) return fehler.push({ stelle: wo, schueler_id: sid, fehler: 'Die Person nimmt nicht an diesem Fach teil.' });
        if (istSchuelerGesperrtInFach(l.fach_id, sid, l.halbjahr)) return fehler.push({ stelle: wo, schueler_id: sid, fehler: 'Die Noten dieser Person sind gesperrt (Notenkonferenz).' });
        const eintrag = { schueler_id: sid };
        if (e.punkte !== undefined) {
          if (!Array.isArray(e.punkte) || e.punkte.length !== maxArr.length) return fehler.push({ stelle: wo, schueler_id: sid, fehler: `punkte: Liste mit genau ${maxArr.length} Einträgen (eine je Aufgabe, null = nicht eingetragen).` });
          const schlecht = e.punkte.findIndex((p, j) => !(p === null || (istZahl(p) && p >= 0 && p <= maxArr[j])));
          if (schlecht >= 0) return fehler.push({ stelle: wo, schueler_id: sid, fehler: `punkte[${schlecht}]: Zahl von 0 bis ${maxArr[schlecht]} (Maximum der Aufgabe) oder null.` });
          eintrag.punkte = e.punkte;
        }
        if (e.extrapunkte !== undefined) {
          if (art !== 'klausur' || teileInfo) return fehler.push({ stelle: wo, schueler_id: sid, fehler: 'Extrapunkte gibt es nur bei einteiligen Klausuren.' });
          const grenze = l.max_extrapunkte > 0 ? l.max_extrapunkte : Math.max(maxArr.reduce((a, b) => a + b, 0), 1);
          if (!(e.extrapunkte === null || (istZahl(e.extrapunkte) && e.extrapunkte >= 0 && e.extrapunkte <= grenze))) return fehler.push({ stelle: wo, schueler_id: sid, fehler: `extrapunkte: Zahl von 0 bis ${grenze} oder null.` });
          eintrag.extrapunkte = e.extrapunkte === 0 ? null : e.extrapunkte;
        }
        if (eintrag.punkte === undefined && eintrag.extrapunkte === undefined) return fehler.push({ stelle: wo, schueler_id: sid, fehler: 'punkte oder extrapunkte angeben.' });
        geprueft.push(eintrag);
      });
      if (fehler.length) return senden(reply, 422, 'invalid', 'Es wurde nichts gespeichert: mindestens ein Eintrag ist ungültig.', fehler);

      const db = getDb();
      const bestehend = (sid) => db.prepare(`SELECT * FROM ${cfg.ergebnisse} WHERE ${cfg.fk} = ? AND schueler_id = ?`).get(l.id, sid);
      const ergebnis = geprueft.map((e) => {
        const alt = bestehend(e.schueler_id);
        const punkte = e.punkte ?? (alt ? JSON.parse(alt.punkte) : new Array(maxArr.length).fill(null));
        const extra = e.extrapunkte !== undefined ? e.extrapunkte : (alt?.extrapunkte ?? null);
        const note = art === 'klausur'
          ? klausurNote(punkte, maxArr, teileInfo, csv, teileInfo ? 0 : (extra || 0))
          : noteAusPunkten(punkte, maxArr, csv);
        return { schueler_id: e.schueler_id, punkte, ...(art === 'klausur' && !teileInfo ? { extrapunkte: extra } : {}), note, teilnoten: teileInfo ? klausurTeilNoten(punkte, maxArr, teileInfo, csv) : undefined, _neu: e };
      });
      const antwort = ergebnis.map(({ _neu, ...rest }) => rest);
      if (!speichern(request)) return { gespeichert: false, dry_run: true, anzahl: antwort.length, ergebnisse: antwort };

      db.transaction(() => {
        for (const r of ergebnis) {
          const e = r._neu;
          const alt = bestehend(e.schueler_id);
          if (alt) {
            if (e.punkte !== undefined) db.prepare(`UPDATE ${cfg.ergebnisse} SET punkte = ? WHERE id = ?`).run(JSON.stringify(e.punkte), alt.id);
            if (e.extrapunkte !== undefined) db.prepare(`UPDATE ${cfg.ergebnisse} SET extrapunkte = ? WHERE id = ?`).run(e.extrapunkte, alt.id);
          } else if (art === 'klausur') {
            db.prepare('INSERT INTO klausur_ergebnisse (klausur_id, schueler_id, punkte, extrapunkte) VALUES (?, ?, ?, ?)')
              .run(l.id, e.schueler_id, JSON.stringify(r.punkte), e.extrapunkte ?? null);
          } else {
            db.prepare('INSERT INTO ul_ergebnisse (ul_id, schueler_id, punkte) VALUES (?, ?, ?)').run(l.id, e.schueler_id, JSON.stringify(r.punkte));
          }
        }
      })();
      syncFallsAutoAktiv(l.fach_id, l.halbjahr, request.apiUser.id);
      request.log.info({ key: request.apiKey.id, [art]: l.id, anzahl: antwort.length }, 'api: Ergebnisse eingetragen');
      return { gespeichert: true, anzahl: antwort.length, ergebnisse: antwort };
    };
    route('PUT', '/klausuren/:id/ergebnisse', 'schreiben', ergebnisseHandler('klausur'));
    route('PUT', '/unterrichtsleistungen/:id/ergebnisse', 'schreiben', ergebnisseHandler('ul'));

    route('POST', '/faecher/:id/termine', 'schreiben', async (request, reply) => {
      const ctx = fachFuer(request, reply, { halbjahrRoh: request.body?.halbjahr, schreiben: true });
      if (!ctx) return undefined;
      const { fach, halbjahr } = ctx;
      if (!istDatum(request.body?.datum)) return senden(reply, 422, 'invalid', 'datum: Format JJJJ-MM-TT.');
      if (!speichern(request)) return { gespeichert: false, dry_run: true, termin: { datum: request.body.datum } };
      const info = getDb().prepare('INSERT INTO unterricht_termine (fach_id, halbjahr, datum) VALUES (?, ?, ?)').run(fach.id, halbjahr, request.body.datum);
      request.log.info({ key: request.apiKey.id, fach: fach.id }, 'api: Termin angelegt');
      return { gespeichert: true, termin: { id: Number(info.lastInsertRowid), datum: request.body.datum } };
    });

    route('PUT', '/termine/:id/noten', 'schreiben', async (request, reply) => {
      const t = getDb().prepare('SELECT * FROM unterricht_termine WHERE id = ?').get(parseInt(request.params.id, 10));
      if (!t) return senden(reply, 404, 'not_found', 'Termin nicht gefunden.');
      if (!userHatFachZgriff(request.apiUser, t.fach_id, t.halbjahr)) return senden(reply, 403, 'forbidden', 'Keine Berechtigung für dieses Fach bzw. Halbjahr.');
      const fach = ladeFachMitUmfeld(t.fach_id);
      if (fach.spa_fach_key || unterfaecherDesHalbjahrs(fach, t.halbjahr).length) return senden(reply, 409, 'nicht_unterstuetzt', 'Für dieses Fach kann die API nicht eintragen.');
      const liste = request.body?.noten;
      if (!Array.isArray(liste) || !liste.length || liste.length > MAX_EINTRAEGE) return senden(reply, 400, 'bad_request', `noten: Liste mit 1 bis ${MAX_EINTRAEGE} Einträgen.`);
      const [min, max] = fach.notenschluessel === 'BG' ? [0, 15] : [1, 6];
      const teilnehmer = new Set(ladeTeilnehmerMitHerkunft(fach).map((x) => x.id));
      const fehler = [];
      const geprueft = [];
      const gesehen = new Set();
      liste.forEach((e, i) => {
        const wo = `noten[${i}]`;
        const sid = e?.schueler_id;
        if (!Number.isInteger(sid)) return fehler.push({ stelle: wo, fehler: 'schueler_id fehlt oder ist keine ganze Zahl.' });
        if (gesehen.has(sid)) return fehler.push({ stelle: wo, schueler_id: sid, fehler: 'Person kommt mehrfach vor.' });
        gesehen.add(sid);
        if (!teilnehmer.has(sid)) return fehler.push({ stelle: wo, schueler_id: sid, fehler: 'Die Person nimmt nicht an diesem Fach teil.' });
        if (istSchuelerGesperrtInFach(t.fach_id, sid, t.halbjahr)) return fehler.push({ stelle: wo, schueler_id: sid, fehler: 'Die Noten dieser Person sind gesperrt (Notenkonferenz).' });
        const n = e.note;
        if (n === 'n.a.') return geprueft.push({ sid, wert: null, na: 1 });
        if (n === null) return geprueft.push({ sid, wert: null, na: 0 });
        if (!istZahl(n) || n < min || n > max) return fehler.push({ stelle: wo, schueler_id: sid, fehler: `note: Zahl von ${min} bis ${max}, "n.a." oder null.` });
        return geprueft.push({ sid, wert: n, na: 0 });
      });
      if (fehler.length) return senden(reply, 422, 'invalid', 'Es wurde nichts gespeichert: mindestens ein Eintrag ist ungültig.', fehler);
      if (!speichern(request)) return { gespeichert: false, dry_run: true, anzahl: geprueft.length };
      const db = getDb();
      const upsert = db.prepare(`
        INSERT INTO unterricht_noten (termin_id, schueler_id, wert, nicht_anwesend) VALUES (?, ?, ?, ?)
        ON CONFLICT(termin_id, schueler_id) DO UPDATE SET wert = excluded.wert, nicht_anwesend = excluded.nicht_anwesend
      `);
      db.transaction(() => { for (const g of geprueft) upsert.run(t.id, g.sid, g.wert, g.na); })();
      syncFallsAutoAktiv(t.fach_id, t.halbjahr, request.apiUser.id);
      request.log.info({ key: request.apiKey.id, termin: t.id, anzahl: geprueft.length }, 'api: Datumsnoten eingetragen');
      return { gespeichert: true, anzahl: geprueft.length };
    });

    // Teilnehmerliste: Personen mit Name und Klasse aufnehmen (wie „Manuell anlegen“ bzw. CSV-Import in der App).
    route('POST', '/faecher/:id/teilnehmer', 'schreiben', async (request, reply) => {
      const fach = ladeFachMitUmfeld(parseInt(request.params.id, 10));
      if (!fach || fach.parent_fach_id || fach.spa_fach_key) return senden(reply, 404, 'not_found', 'Fach nicht gefunden (bei SPA-Fächern und Unterfächern gibt es keine eigene Teilnehmerliste).');
      if (!userDarfTeilnehmerVerwalten(request.apiUser, fach)) return senden(reply, 403, 'forbidden', 'Die Teilnehmer/innen kann nur die Klassenleitung (bzw. bei Kursen die Lehrkraft des Kurses) verwalten.');
      const liste = request.body?.teilnehmer;
      if (!Array.isArray(liste) || !liste.length || liste.length > MAX_EINTRAEGE) return senden(reply, 400, 'bad_request', `teilnehmer: Liste mit 1 bis ${MAX_EINTRAEGE} Einträgen { nachname, vorname, klasse }.`);
      const GRUND = {
        pflichtfelder: 'nachname, vorname und klasse sind erforderlich.',
        notenschluessel: 'Der Notenschlüssel der Klasse passt nicht zu diesem Fach (IHK/BG/SPA).',
      };
      const ergebnisse = [];
      const fehler = [];
      class Zuruecknehmen extends Error {}
      const probelauf = !speichern(request);
      try {
        getDb().transaction(() => {
          liste.forEach((e, i) => {
            const wo = `teilnehmer[${i}]`;
            if (!e || typeof e !== 'object') return fehler.push({ stelle: wo, fehler: 'Objekt { nachname, vorname, klasse } erwartet.' });
            const r = legeManuellenTeilnehmerAn(fach, { nachname: e.nachname, vorname: e.vorname, klassenName: e.klasse });
            const eintrag = { nachname: String(e.nachname ?? '').trim(), vorname: String(e.vorname ?? '').trim(), klasse: String(e.klasse ?? '').trim() };
            if (r.ok) ergebnisse.push({ ...eintrag, schueler_id: r.schuelerId, status: 'hinzugefuegt' });
            else if (r.fehler === 'bereits-teilnehmer') ergebnisse.push({ ...eintrag, status: 'uebersprungen' });
            else fehler.push({ stelle: wo, ...eintrag, fehler: GRUND[r.fehler] || 'Nicht übernommen.' });
          });
          // Alles oder nichts: bei Fehlern und im Probelauf wird alles zurückgenommen (auch neu angelegte Klassen und Personen).
          if (fehler.length || probelauf) throw new Zuruecknehmen();
        })();
      } catch (err) {
        if (!(err instanceof Zuruecknehmen)) throw err;
      }
      if (fehler.length) return senden(reply, 422, 'invalid', 'Es wurde nichts gespeichert: mindestens ein Eintrag ist ungültig.', fehler);
      const zaehler = (s) => ergebnisse.filter((x) => x.status === s).length;
      if (!probelauf) request.log.info({ key: request.apiKey.id, fach: fach.id, anzahl: zaehler('hinzugefuegt') }, 'api: Teilnehmer aufgenommen');
      return {
        gespeichert: !probelauf, ...(probelauf ? { dry_run: true } : {}),
        hinzugefuegt: zaehler('hinzugefuegt'), uebersprungen: zaehler('uebersprungen'), teilnehmer: ergebnisse,
      };
    });

    // ---------- Synchronisation mit der Klassenleitung ----------
    // Wie in der Oberfläche: Die Klassenleitung sieht nur den zuletzt synchronisierten Stand eines Fachs, nie die Live-Noten.
    route('POST', '/faecher/:id/sync', 'schreiben', async (request, reply) => {
      const ctx = fachFuer(request, reply, { halbjahrRoh: request.body?.halbjahr });
      if (!ctx) return undefined;
      const { fach, halbjahr } = ctx;
      if (!speichern(request)) return { synchronisiert: false, dry_run: true, halbjahr };
      syncFach(fach.id, halbjahr, request.apiUser.id);
      request.log.info({ key: request.apiKey.id, fach: fach.id }, 'api: mit Klassenleitung synchronisiert');
      return { synchronisiert: true, halbjahr, sync: syncStand(request.apiUser, fach.id, halbjahr) };
    });

    route('PUT', '/faecher/:id/auto-sync', 'schreiben', async (request, reply) => {
      const ctx = fachFuer(request, reply, { halbjahrRoh: request.body?.halbjahr });
      if (!ctx) return undefined;
      const { fach, halbjahr } = ctx;
      if (typeof request.body?.aktiv !== 'boolean') return senden(reply, 422, 'invalid', 'aktiv: true oder false.');
      const zuordnung = getDb().prepare('SELECT 1 FROM fach_zuweisungen WHERE fach_id = ? AND user_id = ?').get(fach.id, request.apiUser.id);
      if (!zuordnung) return senden(reply, 409, 'keine_zuordnung', 'Der automatische Sync gilt je Lehrkraft und Fach -- dieses Konto ist dem Fach nicht zugeordnet.');
      if (!speichern(request)) return { gespeichert: false, dry_run: true, aktiv: request.body.aktiv };
      getDb().prepare('UPDATE fach_zuweisungen SET auto_sync = ? WHERE fach_id = ? AND user_id = ?').run(request.body.aktiv ? 1 : 0, fach.id, request.apiUser.id);
      if (request.body.aktiv) syncFach(fach.id, halbjahr, request.apiUser.id); // sofort auf den aktuellen Stand bringen
      request.log.info({ key: request.apiKey.id, fach: fach.id, aktiv: request.body.aktiv }, 'api: Auto-Sync geändert');
      return { gespeichert: true, sync: syncStand(request.apiUser, fach.id, halbjahr) };
    });

    route('PUT', '/faecher/:id/endnoten', 'schreiben', async (request, reply) => {
      const ctx = fachFuer(request, reply, { halbjahrRoh: request.body?.halbjahr, schreiben: true });
      if (!ctx) return undefined;
      const { fach, halbjahr } = ctx;
      const liste = request.body?.endnoten;
      if (!Array.isArray(liste) || !liste.length || liste.length > MAX_EINTRAEGE) return senden(reply, 400, 'bad_request', `endnoten: Liste mit 1 bis ${MAX_EINTRAEGE} Einträgen.`);
      const bereich = notenBereich(fach.notenschluessel);
      const teilnehmer = new Set(ladeTeilnehmerMitHerkunft(fach).map((x) => x.id));
      const fehler = [];
      const geprueft = [];
      const gesehen = new Set();
      liste.forEach((e, i) => {
        const wo = `endnoten[${i}]`;
        const sid = e?.schueler_id;
        if (!Number.isInteger(sid)) return fehler.push({ stelle: wo, fehler: 'schueler_id fehlt oder ist keine ganze Zahl.' });
        if (gesehen.has(sid)) return fehler.push({ stelle: wo, schueler_id: sid, fehler: 'Person kommt mehrfach vor.' });
        gesehen.add(sid);
        if (!teilnehmer.has(sid)) return fehler.push({ stelle: wo, schueler_id: sid, fehler: 'Die Person nimmt nicht an diesem Fach teil.' });
        if (istSchuelerGesperrtInFach(fach.id, sid, halbjahr)) return fehler.push({ stelle: wo, schueler_id: sid, fehler: 'Die Noten dieser Person sind gesperrt (Notenkonferenz).' });
        const n = e.note;
        const roh = n === null ? '' : (n === 'ntg' ? 'ntg' : (istZahl(n) ? String(n) : undefined));
        if (roh === undefined || parseEndnoteEingabe(roh, bereich) === null) return fehler.push({ stelle: wo, schueler_id: sid, fehler: `note: Zahl von ${bereich[0]} bis ${bereich[1]}, "ntg" oder null.` });
        return geprueft.push({ sid, roh });
      });
      if (fehler.length) return senden(reply, 422, 'invalid', 'Es wurde nichts gespeichert: mindestens ein Eintrag ist ungültig.', fehler);
      if (!speichern(request)) return { gespeichert: false, dry_run: true, halbjahr, anzahl: geprueft.length };
      getDb().transaction(() => {
        for (const g of geprueft) setzeEndnote(fach.id, g.sid, halbjahr, g.roh, bereich, request.apiUser.id);
      })();
      for (const g of geprueft) syncPerson(fach.id, halbjahr, g.sid, request.apiUser.id);
      syncFallsAutoAktiv(fach.id, halbjahr, request.apiUser.id);
      request.log.info({ key: request.apiKey.id, fach: fach.id, anzahl: geprueft.length }, 'api: Endnoten eingetragen');
      return { gespeichert: true, halbjahr, halbjahr_nr: halbjahrNr(halbjahr), anzahl: geprueft.length };
    });

    api.setNotFoundHandler((request, reply) => senden(reply, 404, 'not_found', 'Unbekannter Endpunkt. Beschreibung: /api/v1/docs'));
  });
}
