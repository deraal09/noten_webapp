/**
 * Startseite nach dem Anmelden — Kachel-Navigation zu den vier
 * meistgenutzten Bereichen (Meine Klassen, Sitzpläne, Noteneingabe,
 * Klassenleitung), dazu „Weitermachen“ mit den zuletzt geöffneten Fächern dieser Anmeldung (src/zuletzt-benutzt.js).
 */

import { requireAuth } from '../auth.js';
import { ladeZuletztBenutzt } from '../zuletzt-benutzt.js';
import { PROFILE } from '../funktionen.js';
import { ersteSchritte } from '../erste-schritte.js';

export default async function startRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  fastify.get('/', async (request, reply) => {
    return reply.viewEjs('start.ejs', { user: request.user, zuletzt: ladeZuletztBenutzt(request), PROFILE, ersteSchritte: ersteSchritte(request.user) });
  });
}
