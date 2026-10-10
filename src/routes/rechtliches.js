/**
 * Öffentliche Seiten ohne Anmeldung: /datenschutz und /impressum (Angaben aus Admin → Rechtliches,
 * siehe src/rechtliches.js). Beide sind in der Fußzeile jeder Seite verlinkt, auch auf der Anmeldeseite.
 */

import { ladeAngaben, STANDARD_RECHTSGRUNDLAGE, STANDARD_SPEICHERDAUER, STANDARD_PROTOKOLLE } from '../rechtliches.js';

export default async function rechtlichesRoutes(fastify) {
  const standard = { rechtsgrundlage: STANDARD_RECHTSGRUNDLAGE, speicherdauer: STANDARD_SPEICHERDAUER, protokolle: STANDARD_PROTOKOLLE };

  fastify.get('/datenschutz', async (request, reply) => reply.viewEjs('rechtliches/datenschutz.ejs', {
    user: request.user, angaben: ladeAngaben(), standard,
  }));

  fastify.get('/impressum', async (request, reply) => reply.viewEjs('rechtliches/impressum.ejs', {
    user: request.user, angaben: ladeAngaben(),
  }));
}
