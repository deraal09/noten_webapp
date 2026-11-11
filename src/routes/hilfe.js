/**
 * Hilfe (/hilfe): Artikel mit Screenshots, Suche und geführter Rundgang. Öffentlich erreichbar (enthält keine Daten, nur Erklärungen).
 */

import { KATEGORIEN, ARTIKEL, RUNDGANG, artikelNachSlug, formatiere, sucheHilfe } from '../hilfe.js';

export default async function hilfeRoutes(fastify) {
  const gemeinsam = { KATEGORIEN, formatiere, rundgangAnzahl: RUNDGANG.length };

  fastify.get('/hilfe', async (request, reply) => {
    const q = String(request.query?.q ?? '').trim().slice(0, 100);
    return reply.viewEjs('hilfe/index.ejs', {
      user: request.user, ...gemeinsam, q, treffer: q ? sucheHilfe(q, 20) : null,
      nachKategorie: KATEGORIEN.map((k) => ({ ...k, artikel: ARTIKEL.filter((a) => a.kategorie === k.id) })),
    });
  });

  // Live-Suche (JSON): höchstens 8 Treffer
  fastify.get('/hilfe/suche', async (request) => ({
    treffer: sucheHilfe(String(request.query?.q ?? '').slice(0, 100), 8).map(({ slug, titel, kategorie, kurz, snippet }) => ({ slug, titel, kategorie, kurz, snippet })),
  }));

  fastify.get('/hilfe/rundgang', async (request, reply) => reply.redirect('/hilfe/rundgang/1'));

  fastify.get('/hilfe/rundgang/:n', async (request, reply) => {
    const n = parseInt(request.params.n, 10);
    if (!Number.isInteger(n) || n < 1 || n > RUNDGANG.length) return reply.redirect('/hilfe/rundgang/1');
    const schritt = RUNDGANG[n - 1];
    return reply.viewEjs('hilfe/rundgang.ejs', {
      user: request.user, ...gemeinsam, n, schritt, schritte: RUNDGANG, artikel: schritt.artikel ? artikelNachSlug(schritt.artikel) : null,
    });
  });

  fastify.get('/hilfe/:slug', async (request, reply) => {
    const artikel = artikelNachSlug(request.params.slug);
    if (!artikel) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Diesen Hilfe-Artikel gibt es nicht.' });
    return reply.viewEjs('hilfe/artikel.ejs', {
      user: request.user, ...gemeinsam, artikel, kategorie: KATEGORIEN.find((k) => k.id === artikel.kategorie),
      verwandt: (artikel.verwandt || []).map(artikelNachSlug).filter(Boolean),
    });
  });
}
