/**
 * Admin: API-Zugänge (/admin/api). Schalter für die ganze API (Vorgabe: an), Liste aller Schlüssel mit Besitzer/in,
 * einzelne Schlüssel deaktivieren (wieder aktivierbar) oder endgültig löschen.
 */

import { requireAdmin } from '../auth.js';
import { apiAktiv, setzeApiAktiv, ladeAlleSchluessel, sperreSchluessel, loescheSchluessel } from '../api-keys.js';
import { formatZeitLokal } from '../format.js';

export default async function adminApiRoutes(fastify) {
  fastify.addHook('preHandler', requireAdmin);

  fastify.get('/api', async (request, reply) => reply.viewEjs('admin/api.ejs', {
    user: request.user, apiAktiv: apiAktiv(), schluessel: ladeAlleSchluessel(), formatZeit: formatZeitLokal,
  }));

  fastify.post('/api/schalter', async (request, reply) => {
    const an = request.body?.aktiv === '1';
    setzeApiAktiv(an);
    request.flash?.('success', an ? 'API eingeschaltet.' : 'API abgeschaltet -- alle Anfragen an /api/v1 werden abgelehnt (503), neue Schlüssel lassen sich nicht anlegen.');
    return reply.redirect('/admin/api');
  });

  fastify.post('/api/:id/deaktivieren', async (request, reply) => {
    if (sperreSchluessel(Number(request.params.id), true)) request.flash?.('success', 'Schlüssel deaktiviert -- er funktioniert nicht mehr, bis du ihn wieder aktivierst.');
    return reply.redirect('/admin/api');
  });

  fastify.post('/api/:id/aktivieren', async (request, reply) => {
    if (sperreSchluessel(Number(request.params.id), false)) request.flash?.('success', 'Schlüssel wieder aktiviert.');
    return reply.redirect('/admin/api');
  });

  fastify.post('/api/:id/loeschen', async (request, reply) => {
    if (loescheSchluessel(Number(request.params.id))) request.flash?.('success', 'Schlüssel gelöscht.');
    return reply.redirect('/admin/api');
  });
}
