/**
 * Klassenlehrer-Routen: Fehlzeiten pro Halbjahr
 * (entschuldigt / unentschuldigt / betrieblich).
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
    for (const s of schueler) {
      fehlMap[s.id] = {};
      for (const t of FEHLZEIT_TYPEN) fehlMap[s.id][t] = { stunden: 0, notiz: '' };
    }
    const rows = schueler.length ? getDb().prepare(
      'SELECT schueler_id, typ, stunden, notiz FROM fehlzeiten WHERE halbjahr = ? AND schueler_id IN (' +
      schueler.map(() => '?').join(',') + ')'
    ).all(halbjahr, ...schueler.map((s) => s.id)) : [];
    for (const r of rows) {
      if (fehlMap[r.schueler_id] && fehlMap[r.schueler_id][r.typ]) {
        fehlMap[r.schueler_id][r.typ] = { stunden: r.stunden, notiz: r.notiz || '' };
      }
    }
    return reply.viewEjs('klassenlehrer/klasse_detail.ejs', {
      user: request.user, klasse, halbjahr, schueler, fehlMap,
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
    const tx = getDb().transaction(() => {
      let count = 0;
      for (const s of schueler) {
        for (const t of FEHLZEIT_TYPEN) {
          const stundenRaw = request.body?.['stunden_' + s.id + '_' + t];
          if (stundenRaw === undefined || stundenRaw === '') continue;
          const stunden = Math.max(0, Number(stundenRaw) || 0);
          const notiz = String(request.body?.['notiz_' + s.id + '_' + t] || '').trim();
          upsert.run(s.id, halbjahr, t, stunden, notiz);
          count++;
        }
      }
      return count;
    });
    const count = tx();
    request.flash?.('success', `Fehlzeiten gespeichert (${count} Einträge).`);
    return reply.redirect(`/klassenlehrer/klasse/${klasse.id}?hj=${encodeURIComponent(halbjahr)}`);
  });
}
