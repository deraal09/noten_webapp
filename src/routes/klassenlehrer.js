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
      klassen = getDb().prepare(`
        SELECT DISTINCT k.*, s.bezeichnung AS schuljahr_bezeichnung
        FROM klassen k
        JOIN klassen_lehrkraefte kl ON kl.klasse_id = k.id
        JOIN schuljahre s ON s.id = k.schuljahr_id
        WHERE kl.user_id = ?
        ORDER BY s.bezeichnung DESC, k.name
      `).all(request.user.id);
    }
    return reply.viewEjs('klassenlehrer/dashboard.ejs', { user: request.user, klassen });
  });

  // ---------- Klassen-Detail (Fehlzeiten) ----------
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
    const schueler = getDb().prepare(
      'SELECT * FROM schueler WHERE klasse_id = ? ORDER BY nachname, vorname'
    ).all(klasse.id);
    const fehlMap = {};
    const fehlMap2 = {};
    for (const s of schueler) {
      fehlMap[s.id] = {};
      fehlMap2[s.id] = {};
      for (const t of FEHLZEIT_TYPEN) {
        fehlMap[s.id][t] = { stunden: 0, notiz: '' };
        fehlMap2[s.id][t] = { stunden: 0 };
      }
    }
    if (schueler.length) {
      const ids = schueler.map((s) => s.id);
      const placeholders = ids.map(() => '?').join(',');
      const rows = getDb().prepare(
        `SELECT schueler_id, typ, stunden, notiz FROM fehlzeiten WHERE halbjahr = ? AND schueler_id IN (${placeholders})`
      ).all(halbjahr, ...ids);
      for (const r of rows) {
        if (fehlMap[r.schueler_id]?.[r.typ]) fehlMap[r.schueler_id][r.typ] = { stunden: r.stunden, notiz: r.notiz || '' };
      }
      if (klasse.zwei_schulen) {
        const rows2 = getDb().prepare(
          `SELECT schueler_id, typ, stunden FROM fehlzeiten_schule2 WHERE halbjahr = ? AND schueler_id IN (${placeholders})`
        ).all(halbjahr, ...ids);
        for (const r of rows2) {
          if (fehlMap2[r.schueler_id]?.[r.typ]) fehlMap2[r.schueler_id][r.typ] = { stunden: r.stunden };
        }
      }
    }
    return reply.viewEjs('klassenlehrer/klasse_detail.ejs', {
      user: request.user, klasse, halbjahr, schueler, fehlMap, fehlMap2,
    });
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
    const upsert = getDb().prepare(`
      INSERT INTO fehlzeiten (schueler_id, halbjahr, typ, stunden, notiz, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT (schueler_id, halbjahr, typ) DO UPDATE SET
        stunden = excluded.stunden,
        notiz = excluded.notiz,
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
            const notiz = String(request.body?.['notiz_' + s.id + '_' + t] || '').trim();
            upsert.run(s.id, halbjahr, t, stunden, notiz);
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
    return reply.redirect(`/klassenlehrer/klasse/${klasse.id}?hj=${encodeURIComponent(halbjahr)}`);
  });

  fastify.post('/klasse/:id/zwei-schulen', async (request, reply) => {
    const klasse = getDb().prepare('SELECT id FROM klassen WHERE id = ?').get(request.params.id);
    if (!klasse) return reply.redirect('/klassenlehrer');
    if (!userIstKlassenlehrer(request.user, klasse.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    const aktiv = request.body?.aktiv === '1';
    getDb().prepare('UPDATE klassen SET zwei_schulen = ? WHERE id = ?').run(aktiv ? 1 : 0, klasse.id);
    return reply.redirect(`/klassenlehrer/klasse/${klasse.id}`);
  });
}
