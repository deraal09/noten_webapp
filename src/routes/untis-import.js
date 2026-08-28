/**
 * Import von Klassen/Schüler:innen aus WebUntis. Nutzt die inoffizielle
 * JSON-RPC-API (siehe src/untis-client.js) — jede Lehrkraft meldet sich bei
 * jeder Verbindung neu mit ihren eigenen Untis-Zugangsdaten an, die NIE
 * gespeichert werden. Der laufende Untis-Login (Session-Cookie) liegt nur
 * kurzzeitig im Server-Session-Speicher (request.session), nie in der
 * Datenbank.
 */

import { getDb } from '../db.js';
import { requireAuth } from '../auth.js';
import { DEFAULT_NS_CSV } from '../grade-calc.js';
import {
  untisAnmelden, untisAbmelden, untisKlassen, untisStudentGroupMitglieder,
} from '../untis-client.js';

const STANDARD_SERVER = 'bbz-rd-eck.webuntis.com';
const STANDARD_SCHULE = 'bbz-rd-eck';

export default async function untisImportRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  fastify.get('/untis-import', async (request, reply) => {
    const schuljahre = getDb().prepare('SELECT * FROM schuljahre ORDER BY bezeichnung DESC').all();
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
      request.session.untisImport = {
        server, school, cookieHeader: anmeldung.cookieHeader,
        klassen: klassen.map((k) => ({ id: k.id, name: k.name, longName: k.longName || '' }))
          .sort((a, b) => a.name.localeCompare(b.name)),
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

    const db = getDb();
    const ergebnisse = [];
    for (const klasseId of ausgewaehlt) {
      const untisKlasse = v.klassen.find((k) => k.id === klasseId);
      if (!untisKlasse) continue;
      const eintrag = { name: untisKlasse.name, status: null, schuelerAnzahl: null, klasseId: null };
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
        try {
          const mitglieder = await untisStudentGroupMitglieder({
            server: v.server, school: v.school, cookieHeader: v.cookieHeader, groupId: untisKlasse.id,
          });
          if (mitglieder.length) {
            const insert = db.prepare('INSERT INTO schueler (klasse_id, nachname, vorname) VALUES (?, ?, ?)');
            for (const m of mitglieder) insert.run(neueKlasseId, m.studentName || '', m.foreName || '');
            eintrag.schuelerAnzahl = mitglieder.length;
          } else {
            eintrag.schuelerAnzahl = 0;
          }
        } catch {
          eintrag.schuelerAnzahl = null; // von Untis nicht verfügbar (Rechte/Konfiguration)
        }
      }
      ergebnisse.push(eintrag);
    }

    await untisAbmelden({ server: v.server, school: v.school, cookieHeader: v.cookieHeader }).catch(() => {});
    delete request.session.untisImport;

    return reply.viewEjs('teacher/untis_import_ergebnis.ejs', { user: request.user, ergebnisse, mitSchuelern });
  });
}
