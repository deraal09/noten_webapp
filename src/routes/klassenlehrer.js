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
import { ladeAbschlussuebersicht } from '../fach-abschluss.js';

export default async function klassenlehrerRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  // ---------- Dashboard ----------
  fastify.get('/', async (request, reply) => {
    let klassen;
    if (request.user.isAdmin) {
      klassen = getDb().prepare(`
        SELECT k.*, s.bezeichnung AS schuljahr_bezeichnung
        FROM klassen k JOIN schuljahre s ON s.id = k.schuljahr_id
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
        WHERE kl.user_id IS NOT NULL OR kls.user_id IS NOT NULL
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

    // ---- Tab 2: Halbjahresübersicht ----
    const halbjahresuebersicht = ladeHalbjahresuebersicht(klasse, halbjahr);

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
      offeneEntsperrAnfragen,
    });
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
