/**
 * Startseite nach dem Anmelden — Kachel-Navigation zu den vier
 * meistgenutzten Bereichen (Meine Klassen, Sitzpläne, Noteneingabe,
 * Klassenleitung). Rein statische Übersicht, keine eigene Datenabfrage.
 */

import { requireAuth } from '../auth.js';

export default async function startRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  fastify.get('/', async (request, reply) => {
    return reply.viewEjs('start.ejs', { user: request.user });
  });
}
