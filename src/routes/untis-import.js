/**
 * Import von Klassen/Schüler:innen aus WebUntis. Nutzt die inoffizielle
 * JSON-RPC-API (siehe src/untis-client.js) — jede Lehrkraft meldet sich bei
 * jeder Verbindung neu mit ihren eigenen Untis-Zugangsdaten an, die NIE
 * gespeichert werden. Der laufende Untis-Login (Session-Cookie) liegt nur
 * kurzzeitig im Server-Session-Speicher (request.session), nie in der
 * Datenbank.
 */

import { getDb } from '../db.js';
import { requireAuth, userDarfSelbstKlasseAnlegen } from '../auth.js';
import { DEFAULT_NS_CSV } from '../grade-calc.js';
import {
  untisAnmelden, untisAbmelden, untisKlassen, untisStudenten, untisIdentitaet, untisZeitplan,
} from '../untis-client.js';
import { fuegeSchuelerHinzuFallsNeu } from '../schueler-utils.js';
import { sortiereSchuljahreAbsteigend } from '../schuljahr-utils.js';

const STANDARD_SERVER = 'bbz-rd-eck.webuntis.com';
const STANDARD_SCHULE = 'bbz-rd-eck';

function datumYyyymmdd(datum) {
  const y = datum.getFullYear();
  const m = String(datum.getMonth() + 1).padStart(2, '0');
  const d = String(datum.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function datumMitOffsetTagen(basis, offsetTage) {
  const d = new Date(basis);
  d.setDate(d.getDate() + offsetTage);
  return datumYyyymmdd(d);
}

// getKlassen() liefert ausnahmslos ALLE Klassen der Schule, nicht nur die
// der anmeldenden Lehrkraft. Als bester verfügbarer Ansatz wird versucht,
// über den eigenen Stundenplan (±14 Tage um heute, deckt auch vierzehntägig
// stattfindenden Unterricht ab) einzugrenzen, welche Klassen tatsächlich
// unterrichtet werden — Klassen ganz ohne Unterricht im Abfragezeitraum
// (z. B. eine Klausur-Vertretung oder ein Kurs in einer Pausenzeit) würden
// dabei fehlen, deshalb bleibt "alle Klassen der Schule anzeigen" in der
// Ansicht immer als Fallback wählbar. Schlägt der Versuch komplett fehl
// (Identität oder Stundenplan nicht abrufbar, oder keine Klasse im
// erwarteten "kl"-Feld erkennbar), wird wie bisher ohne Filter die volle
// Klassenliste gezeigt — der genaue Grund wird aber zurückgegeben, statt
// still zu verschwinden, damit sich ein Fehlschlag auf der echten
// Untis-Instanz konkret nachvollziehen lässt (siehe eigeneKlassenFehler
// auf der Verbindungsseite).
async function eigeneKlassenIdsErmitteln({ server, school, cookieHeader }) {
  let personId;
  let personType;
  try {
    ({ personId, personType } = await untisIdentitaet({ server, school, cookieHeader }));
  } catch (e) {
    return { ids: null, fehler: `Eigene Identität nicht ermittelbar (app/config): ${e.message}` };
  }
  let stunden;
  try {
    const heute = new Date();
    stunden = await untisZeitplan({
      server, school, cookieHeader, personId, personType,
      startDate: datumMitOffsetTagen(heute, -14), endDate: datumMitOffsetTagen(heute, 14),
    });
  } catch (e) {
    return { ids: null, fehler: `Stundenplan nicht abrufbar (personId ${personId}, personType ${personType}): ${e.message}` };
  }
  const ids = new Set();
  for (const stunde of stunden) {
    for (const k of (stunde.kl || [])) {
      if (k?.id !== undefined && k?.id !== null) ids.add(Number(k.id));
    }
  }
  if (ids.size) return { ids: Array.from(ids), fehler: null };
  const beispielFelder = stunden.length ? Object.keys(stunden[0]) : null;
  return {
    ids: null,
    fehler: stunden.length
      ? `Stundenplan hat ${stunden.length} Eintrag/Einträge geliefert, aber keine Klasse im Feld "kl" gefunden. Vorhandene Felder je Eintrag: ${beispielFelder.join(', ')}`
      : 'Stundenplan hat keine Einträge im Zeitraum ±14 Tage geliefert.',
  };
}

// getStudentGroupMembers (Untis-Klasse == "Studentengruppe" mit gleicher ID)
// existiert nicht auf jeder Untis-Instanz (-32601 "Method not found" beim
// BBZ RD-Eck) — stattdessen wird EINMAL die komplette Schülerliste der
// Schule geladen (getStudents, kein Klassenbezug dokumentiert) und
// versucht, sie über plausible, nicht offiziell dokumentierte Feldnamen
// den ausgewählten Klassen zuzuordnen. Klappt die Zuordnung nicht (keines
// der Felder vorhanden), bleibt es bei 0 Treffern — die auf der
// Ergebnisseite mit angezeigten Beispiel-Felder zeigen dann, welche Felder
// der Server tatsächlich liefert, für die weitere Fehlersuche.
function klassenBezugAus(schueler) {
  return {
    klasseId: schueler.klasseId ?? schueler.classId ?? schueler.klasse_id ?? null,
    klasseName: schueler.klasse ?? schueler.className ?? schueler.schoolClass ?? schueler.klassenName ?? null,
  };
}

function schuelerFuerKlasse(alleSchueler, untisKlasse) {
  return alleSchueler.filter((s) => {
    const { klasseId, klasseName } = klassenBezugAus(s);
    if (klasseId !== null && klasseId !== undefined && Number(klasseId) === Number(untisKlasse.id)) return true;
    if (klasseName && String(klasseName).trim() === untisKlasse.name.trim()) return true;
    return false;
  });
}

export default async function untisImportRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  fastify.get('/untis-import', async (request, reply) => {
    if (!userDarfSelbstKlasseAnlegen(request.user)) {
      return reply.code(403).viewEjs('error.ejs', {
        code: 403, message: 'Nur Lehrkräfte mit LDAP-Zugang können eigene Klassen importieren. Bitte eine Klassenleitung oder den Admin bitten, dich einem Fach zuzuweisen.',
      });
    }
    const schuljahre = sortiereSchuljahreAbsteigend(getDb().prepare('SELECT * FROM schuljahre').all());
    const verbindung = request.session.untisImport || null;
    return reply.viewEjs('teacher/untis_import.ejs', {
      user: request.user, schuljahre, verbindung,
      standardServer: STANDARD_SERVER, standardSchule: STANDARD_SCHULE,
    });
  });

  fastify.post('/untis-import/verbinden', async (request, reply) => {
    const server = String(request.body?.server || '').trim() || STANDARD_SERVER;
    const school = String(request.body?.school || '').trim() || STANDARD_SCHULE;
    const username = String(request.body?.username || '').trim();
    const password = String(request.body?.password || '');
    const secret = String(request.body?.secret || '').trim().replace(/\s+/g, '');
    if (!username || (!password && !secret)) {
      request.flash?.('error', 'Bitte Benutzername und Passwort oder Secret eingeben.');
      return reply.redirect('/teacher/untis-import');
    }
    // Anmeldung und anschließender Klassenabruf sind zwei getrennte
    // Untis-Aufrufe — die Fehlermeldung nennt, welcher der beiden
    // fehlgeschlagen ist, statt beides zu vermischen (wichtig für die
    // Fehlersuche bei einer nicht offiziell dokumentierten Schnittstelle).
    let anmeldung;
    try {
      anmeldung = await untisAnmelden({ server, school, username, password, secret });
    } catch (e) {
      request.flash?.('error', `Anmeldung fehlgeschlagen: ${e.message}`);
      return reply.redirect('/teacher/untis-import');
    }
    try {
      const klassen = await untisKlassen({ server, school, cookieHeader: anmeldung.cookieHeader });
      const eigene = await eigeneKlassenIdsErmitteln({ server, school, cookieHeader: anmeldung.cookieHeader })
        .catch((e) => ({ ids: null, fehler: `Unerwarteter Fehler: ${e.message}` }));
      request.session.untisImport = {
        server, school, cookieHeader: anmeldung.cookieHeader,
        klassen: klassen.map((k) => ({ id: k.id, name: k.name, longName: k.longName || '' }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        eigeneKlassenIds: eigene.ids,
        eigeneKlassenFehler: eigene.fehler,
      };
      request.flash?.('success', `Verbunden — ${klassen.length} Klasse(n) von Untis geladen.`);
    } catch (e) {
      await untisAbmelden({ server, school, cookieHeader: anmeldung.cookieHeader }).catch(() => {});
      request.flash?.('error', `Anmeldung war erfolgreich, aber Klassenabruf fehlgeschlagen: ${e.message}`);
    }
    return reply.redirect('/teacher/untis-import');
  });

  fastify.post('/untis-import/trennen', async (request, reply) => {
    const v = request.session.untisImport;
    if (v) {
      await untisAbmelden({ server: v.server, school: v.school, cookieHeader: v.cookieHeader }).catch(() => {});
      delete request.session.untisImport;
    }
    return reply.redirect('/teacher/untis-import');
  });

  fastify.post('/untis-import/importieren', async (request, reply) => {
    if (!userDarfSelbstKlasseAnlegen(request.user)) {
      return reply.code(403).viewEjs('error.ejs', {
        code: 403, message: 'Nur Lehrkräfte mit LDAP-Zugang können eigene Klassen importieren. Bitte eine Klassenleitung oder den Admin bitten, dich einem Fach zuzuweisen.',
      });
    }
    const v = request.session.untisImport;
    if (!v) {
      request.flash?.('error', 'Keine aktive Untis-Verbindung — bitte erneut anmelden.');
      return reply.redirect('/teacher/untis-import');
    }
    const schuljahrId = parseInt(request.body?.schuljahr_id, 10);
    let notenschluessel = String(request.body?.notenschluessel || 'IHK');
    if (!['IHK', 'BG'].includes(notenschluessel)) notenschluessel = 'IHK';
    const mitSchuelern = request.body?.mit_schuelern === '1';
    const ausgewaehlt = [].concat(request.body?.klasse_id || []).map((id) => parseInt(id, 10)).filter(Number.isFinite);

    if (!schuljahrId || !ausgewaehlt.length) {
      request.flash?.('error', 'Bitte ein Schuljahr und mindestens eine Klasse auswählen.');
      return reply.redirect('/teacher/untis-import');
    }

    // Schülerliste (falls gewünscht) EINMAL für die ganze Schule laden,
    // nicht pro Klasse — getStudents() kennt keinen dokumentierten
    // Klassenfilter. Schlägt das an fehlenden Rechten fehl (-8509 "no
    // right for getStudents()" — das Recht "masterdata students read for
    // all" fehlt am Lehrkraft-Konto), wird als letzter, ungewisser Versuch
    // pro ausgewählter Klasse ein undokumentierter klasseId-Filter
    // mitgegeben (falls die Untis-Instanz dafür ein engeres Recht kennt).
    let alleUntisSchueler = null;
    let schuelerAbrufFehler = null;
    let beispielFelder = null;
    let schuelerProKlasseFallback = false;
    if (mitSchuelern) {
      try {
        alleUntisSchueler = await untisStudenten({ server: v.server, school: v.school, cookieHeader: v.cookieHeader });
        if (alleUntisSchueler.length) beispielFelder = Object.keys(alleUntisSchueler[0]);
      } catch (e) {
        schuelerAbrufFehler = e.message;
        schuelerProKlasseFallback = true;
      }
    }

    const db = getDb();
    const ergebnisse = [];
    for (const klasseId of ausgewaehlt) {
      const untisKlasse = v.klassen.find((k) => k.id === klasseId);
      if (!untisKlasse) continue;
      const eintrag = { name: untisKlasse.name, status: null, schuelerAnzahl: null, schuelerFehler: null, klasseId: null };
      let neueKlasseId;
      try {
        const info = db.prepare(`
          INSERT INTO klassen (schuljahr_id, name, notenschluessel, notenschluessel_csv, created_by_id)
          VALUES (?, ?, ?, ?, ?)
        `).run(schuljahrId, untisKlasse.name, notenschluessel, DEFAULT_NS_CSV[notenschluessel], request.user.id);
        neueKlasseId = info.lastInsertRowid;
        eintrag.status = 'angelegt';
        eintrag.klasseId = neueKlasseId;
      } catch {
        eintrag.status = 'uebersprungen';
        const bestehend = db.prepare('SELECT id FROM klassen WHERE schuljahr_id = ? AND name = ?')
          .get(schuljahrId, untisKlasse.name);
        eintrag.klasseId = bestehend?.id ?? null;
        ergebnisse.push(eintrag);
        continue;
      }

      if (mitSchuelern) {
        if (alleUntisSchueler) {
          const treffer = schuelerFuerKlasse(alleUntisSchueler, untisKlasse);
          for (const m of treffer) fuegeSchuelerHinzuFallsNeu(neueKlasseId, m.name || '', m.foreName || '');
          eintrag.schuelerAnzahl = treffer.length;
        } else if (schuelerProKlasseFallback) {
          try {
            const gefiltert = await untisStudenten({
              server: v.server, school: v.school, cookieHeader: v.cookieHeader,
              filter: { klasseId: untisKlasse.id },
            });
            for (const m of gefiltert) fuegeSchuelerHinzuFallsNeu(neueKlasseId, m.name || '', m.foreName || '');
            eintrag.schuelerAnzahl = gefiltert.length;
          } catch (e) {
            eintrag.schuelerFehler = e.message;
          }
        }
      }
      ergebnisse.push(eintrag);
    }

    await untisAbmelden({ server: v.server, school: v.school, cookieHeader: v.cookieHeader }).catch(() => {});
    delete request.session.untisImport;

    return reply.viewEjs('teacher/untis_import_ergebnis.ejs', {
      user: request.user, ergebnisse, mitSchuelern,
      schuelerGesamt: alleUntisSchueler?.length ?? null, beispielFelder,
      schuelerAbrufFehler: schuelerProKlasseFallback ? schuelerAbrufFehler : null,
    });
  });
}
