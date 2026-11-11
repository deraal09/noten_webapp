/**
 * Verwaltung der eigenen API-Schlüssel (Menü „API-Zugang“, /konto/api): anlegen (Klartext einmalig sichtbar), Liste, widerrufen.
 * Die Schlüssel gelten für /api/v1 (siehe src/routes/api-v1.js und die Dokumentation unter /api/v1/docs).
 * Nur Schulkonten (LDAP) legen Schlüssel an; ist die API vom Admin abgeschaltet, lassen sich keine neuen anlegen.
 */

import { requireAuth } from '../auth.js';
import {
  erzeugeSchluessel, ladeSchluessel, widerrufeSchluessel, MAX_KEYS_PRO_USER, apiAktiv, darfApiNutzen,
} from '../api-keys.js';
import { formatZeitLokal } from '../format.js';

const GUELTIG = [['30', '30 Tage'], ['90', '90 Tage'], ['180', '6 Monate'], ['365', '1 Jahr']];

export default async function apiSchluesselRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  const zeige = (request, reply, extra = {}) => reply.viewEjs('api-zugang.ejs', {
    user: request.user, schluessel: ladeSchluessel(request.user.id), gueltig: GUELTIG, maxKeys: MAX_KEYS_PRO_USER, neu: null, fehler: null,
    apiAktiv: apiAktiv(), darf: darfApiNutzen(request.user),
    formatZeit: formatZeitLokal, serverUrl: (process.env.PUBLIC_URL || `${request.protocol}://${request.headers.host}`).replace(/\/$/, ''), ...extra,
  });

  fastify.get('/konto/api', async (request, reply) => zeige(request, reply));

  fastify.post('/konto/api', async (request, reply) => {
    if (!darfApiNutzen(request.user)) return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'API-Schlüssel gibt es nur für Schulkonten (LDAP).' });
    const r = erzeugeSchluessel(request.user.id, {
      name: request.body?.name, scope: request.body?.scope, gueltigTage: request.body?.gueltig_tage || 90,
    });
    if (!r.ok) return zeige(request, reply.code(400), { fehler: r.fehler });
    // Klartext nur in dieser einen Antwort (nicht per Redirect/Session), danach nur noch der Hash in der Datenbank.
    reply.header('Cache-Control', 'no-store');
    return zeige(request, reply, { neu: { key: r.key, name: String(request.body.name).trim(), scope: request.body.scope } });
  });

  fastify.post('/konto/api/:id/widerrufen', async (request, reply) => {
    if (widerrufeSchluessel(Number(request.params.id), request.user.id, false)) request.flash?.('success', 'Schlüssel widerrufen -- er funktioniert nicht mehr.');
    return reply.redirect('/konto/api');
  });
}
