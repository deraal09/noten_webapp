/**
 * Feedback der Nutzer:innen: Seite zum Senden (/feedback) für alle Angemeldeten (src/feedback.js). Die Auswertung für die
 * Administration liegt unter /admin/feedback (src/routes/admin.js).
 */

import { requireAuth } from '../auth.js';
import { FUNKTIONEN } from '../funktionen.js';
import { ARTEN, MIN_ZEICHEN, MAX_ZEICHEN, speichereFeedback, bereinigeSeite } from '../feedback.js';

export default async function feedbackRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  const zeige = (request, reply, extra = {}) => reply.viewEjs('feedback.ejs', {
    user: request.user, ARTEN, FUNKTIONEN, MIN_ZEICHEN, MAX_ZEICHEN,
    werte: { art: String(request.query?.art || ''), text: '', funktion: '', mitName: false, seite: bereinigeSeite(request.query?.von) || '' },
    fehler: null, gesendet: false, ...extra,
  });

  fastify.get('/feedback', async (request, reply) => zeige(request, reply));

  fastify.post('/feedback', async (request, reply) => {
    const b = request.body || {};
    const werte = { art: String(b.art || ''), text: String(b.text || ''), funktion: String(b.funktion || ''), mitName: b.mit_name === '1', seite: bereinigeSeite(b.seite) || '' };
    const r = speichereFeedback(request.user.id, { art: werte.art, text: werte.text, funktion: werte.funktion, seite: werte.seite, mitName: werte.mitName });
    if (!r.ok) return zeige(request, reply.code(400), { werte, fehler: r.fehler });
    return zeige(request, reply, { gesendet: true, werte: { ...werte, text: '' } });
  });
}
