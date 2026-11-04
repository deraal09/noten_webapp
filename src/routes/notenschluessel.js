/**
 * Notenschlüssel ansehen (alle angemeldeten Personen, nur lesend) und Änderungshinweis bestätigen.
 * Bearbeiten kann ihn nur der Admin: Admin → Notenschlüssel (src/routes/admin.js).
 */

import { requireAuth } from '../auth.js';
import { ladeMeineKlassen } from '../auth.js';
import { TYPEN, globalerSchluessel, folgtGlobal, schluesselTypVon, tabelle, markiereGelesen } from '../notenschluessel.js';
import { getDb } from '../db.js';

const anzeigeTyp = { IHK: 'IHK (Noten 1–6)', BG: 'BG (Punkte 0–15)' };

export default async function notenschluesselRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  fastify.get('/notenschluessel', async (request, reply) => {
    const user = request.user;
    const klassen = user.isAdmin ? [] : ladeMeineKlassen(user.id);
    const genutzt = new Set(klassen.map((k) => schluesselTypVon(k.notenschluessel)));
    const eigene = klassen.filter((k) => k.notenschluessel !== 'SPA' && !folgtGlobal(k)).map((k) => ({ id: k.id, name: k.name, typ: k.notenschluessel }));
    const schluessel = TYPEN.map((typ) => {
      const g = globalerSchluessel(typ);
      const von = g.geaendertVonId ? getDb().prepare('SELECT display_name, username FROM users WHERE id = ?').get(g.geaendertVonId) : null;
      return { ...g, bezeichnung: anzeigeTyp[typ], zeilen: tabelle(g.csv), genutzt: genutzt.has(typ), von: von ? (von.display_name || von.username) : null };
    });
    // Wer sich den Schlüssel ansieht, hat die Änderung zur Kenntnis genommen.
    if (!user.isAdmin) markiereGelesen(user.id);
    reply.locals.notenschluesselHinweise = [];
    return reply.viewEjs('notenschluessel.ejs', { user, schluessel, eigene, hatSpa: klassen.some((k) => k.notenschluessel === 'SPA') });
  });

  fastify.post('/notenschluessel/gelesen', async (request, reply) => {
    const typ = TYPEN.includes(request.body?.typ) ? request.body.typ : null;
    markiereGelesen(request.user.id, typ);
    const ziel = String(request.body?.weiter || '');
    return reply.redirect(ziel.startsWith('/') && !ziel.startsWith('//') ? ziel : '/start');
  });
}
