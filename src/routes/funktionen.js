/**
 * „Meine Funktionen“ (Konto): Startprofil wählen und einzelne Funktionen ein-/ausschalten (src/funktionen.js).
 * Steuert nur, was angezeigt wird -- nichts wird gesperrt. Dazu ein kleiner Zähler-Aufruf für Funktionen, die im Browser laufen
 * (Klausur-Statistik): `POST /funktion-genutzt` (zählt anonym, siehe src/aktivitaet.js).
 */

import { requireAuth } from '../auth.js';
import { FUNKTIONEN, FUNKTION_IDS, PROFILE, setzeProfil, setzeFunktionen, funktionenFuer } from '../funktionen.js';

/** Nur interne Ziele zulassen (kein offener Weiterleiter). */
function sichereAdresse(wert, vorgabe) {
  const w = String(wert || '');
  return /^\/[A-Za-z0-9\-_/]*$/.test(w) && !w.startsWith('//') ? w : vorgabe;
}

export default async function funktionenRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  fastify.get('/konto/funktionen', async (request, reply) => reply.viewEjs('funktionen.ejs', {
    user: request.user, FUNKTIONEN, PROFILE, aktuell: funktionenFuer(request.user),
  }));

  fastify.post('/konto/funktionen/profil', async (request, reply) => {
    if (!setzeProfil(request.user.id, String(request.body?.profil || ''))) {
      request.flash?.('error', 'Unbekanntes Profil.');
      return reply.redirect('/konto/funktionen');
    }
    request.flash?.('success', `Profil „${PROFILE[request.body.profil].titel}“ gewählt. Du kannst es jederzeit unter „Meine Funktionen“ ändern.`);
    return reply.redirect(sichereAdresse(request.body?.weiter, '/start'));
  });

  fastify.post('/konto/funktionen', async (request, reply) => {
    const roh = request.body?.funktion;
    const ids = (Array.isArray(roh) ? roh : [roh]).map(String).filter((id) => FUNKTION_IDS.includes(id));
    setzeFunktionen(request.user.id, ids);
    request.flash?.('success', 'Gespeichert.');
    return reply.redirect('/konto/funktionen');
  });

  // Zählt die Nutzung einer im Browser laufenden Funktion (nur bekannte Namen; die Zählung selbst macht der onResponse-Hook).
  fastify.post('/funktion-genutzt', async (request, reply) => {
    if (String(request.body?.funktion || '') !== 'statistik') return reply.code(400).send({ ok: false });
    return reply.code(204).send();
  });
}
