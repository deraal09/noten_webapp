/**
 * SSO-Endpunkte für Schwester-Apps (Lehrerkalender).
 *
 *   GET  /sso/authorize   – Anmeldung hier, Einmal-Code zurück an die App
 *   POST /sso/token       – Einmal-Code gegen die Identität tauschen (server-zu-server)
 *
 * Siehe src/sso.js für den Ablauf, die Kennung (`sub`) und die ENV-Variablen.
 */

import {
  ssoConfig, istSsoAktiv, geheimnisPasst, redirectUriErlaubt,
  subFuerUser, erzeugeCode, loeseCodeEin,
} from '../sso.js';

export default async function ssoRoutes(fastify) {
  // ---------- GET /sso/authorize ----------
  fastify.get('/authorize', async (request, reply) => {
    if (!istSsoAktiv()) {
      return reply.code(404).viewEjs('error.ejs', {
        code: 404,
        message: 'Single Sign-on ist auf diesem Server nicht eingerichtet.',
      });
    }
    const cfg = ssoConfig();
    const { client_id: clientId, redirect_uri: redirectUri, state, response_type: responseType } =
      request.query || {};

    // Ungültige Rücksprungadresse NIEMALS anspringen (sonst wäre der Code an
    // eine fremde Adresse ausleitbar) — hier bleibt es bei einer Fehlerseite.
    if (clientId !== cfg.clientId || !redirectUriErlaubt(redirectUri)) {
      request.log.warn({ clientId, redirectUri }, 'SSO: unbekannter Client oder redirect_uri');
      return reply.code(400).viewEjs('error.ejs', {
        code: 400,
        message: 'Diese App ist für die Anmeldung nicht freigegeben.',
      });
    }
    if (responseType && responseType !== 'code') {
      return reply.redirect(`${redirectUri}?error=unsupported_response_type&state=${encodeURIComponent(state || '')}`);
    }

    // Noch nicht angemeldet? Erst der normale Login, danach zurück hierher.
    if (!request.user) {
      return reply.redirect('/login?next=' + encodeURIComponent(request.url));
    }

    const code = erzeugeCode({
      userId: request.user.id,
      clientId: cfg.clientId,
      redirectUri,
    });
    const ziel =
      `${redirectUri}?code=${encodeURIComponent(code)}` +
      (state ? `&state=${encodeURIComponent(state)}` : '');
    return reply.redirect(ziel);
  });

  // ---------- POST /sso/token ----------
  fastify.post('/token', async (request, reply) => {
    if (!istSsoAktiv()) return reply.code(404).send({ error: 'SSO nicht eingerichtet' });
    const cfg = ssoConfig();
    const {
      client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri,
    } = request.body || {};

    if (clientId !== cfg.clientId || !geheimnisPasst(clientSecret)) {
      request.log.warn({ clientId }, 'SSO: Tokentausch mit falschem Geheimnis');
      return reply.code(401).send({ error: 'client_id oder client_secret falsch' });
    }
    let user;
    try {
      user = loeseCodeEin({ code, clientId, redirectUri });
    } catch (e) {
      return reply.code(e.status || 400).send({ error: e.message });
    }
    return reply.send({
      sub: subFuerUser(user),
      username: user.username,
      name: user.display_name || user.username,
      rolle: user.role,
      auth_source: user.auth_source,
    });
  });
}
