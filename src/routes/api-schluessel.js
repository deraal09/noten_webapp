/**
 * Verwaltung der eigenen API-Schlüssel (Menü „API-Zugang“, /konto/api): anlegen (Klartext einmalig sichtbar), Liste, widerrufen.
 * Die Schlüssel gelten für /api/v1 (siehe src/routes/api-v1.js und die Dokumentation unter /api/v1/docs).
 */

import { requireAuth } from '../auth.js';
import { erzeugeSchluessel, ladeSchluessel, widerrufeSchluessel, MAX_KEYS_PRO_USER } from '../api-keys.js';
import { formatZeitLokal } from '../format.js';

const GUELTIG = [['30', '30 Tage'], ['90', '90 Tage'], ['365', '1 Jahr'], ['', 'unbegrenzt']];

export default async function apiSchluesselRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  const zeige = (request, reply, extra = {}) => reply.viewEjs('api-zugang.ejs', {
    user: request.user, schluessel: ladeSchluessel(request.user.id), gueltig: GUELTIG, maxKeys: MAX_KEYS_PRO_USER, neu: null, fehler: null,
    formatZeit: formatZeitLokal, serverUrl: (process.env.PUBLIC_URL || `${request.protocol}://${request.headers.host}`).replace(/\/$/, ''), ...extra,
  });

  fastify.get('/konto/api', async (request, reply) => zeige(request, reply));

  fastify.post('/konto/api', async (request, reply) => {
    const r = erzeugeSchluessel(request.user.id, {
      name: request.body?.name, scope: request.body?.scope, gueltigTage: request.body?.gueltig_tage || null,
    });
    if (!r.ok) return reply.code(400).viewEjs('api-zugang.ejs', {
      user: request.user, schluessel: ladeSchluessel(request.user.id), gueltig: GUELTIG, maxKeys: MAX_KEYS_PRO_USER, neu: null, fehler: r.fehler,
      formatZeit: formatZeitLokal, serverUrl: (process.env.PUBLIC_URL || `${request.protocol}://${request.headers.host}`).replace(/\/$/, ''),
    });
    // Klartext nur in dieser einen Antwort (nicht per Redirect/Session), danach nur noch der Hash in der Datenbank.
    reply.header('Cache-Control', 'no-store');
    return zeige(request, reply, { neu: { key: r.key, name: String(request.body.name).trim(), scope: request.body.scope } });
  });

  fastify.post('/konto/api/:id/widerrufen', async (request, reply) => {
    if (widerrufeSchluessel(Number(request.params.id), request.user.id, false)) request.flash?.('success', 'Schlüssel widerrufen -- er funktioniert nicht mehr.');
    return reply.redirect('/konto/api');
  });
}
