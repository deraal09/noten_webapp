/**
 * Hilfe (/hilfe): Artikel mit Screenshots, Suche und geführter Rundgang. Öffentlich erreichbar (enthält keine Daten, nur Erklärungen).
 */

import { KATEGORIEN, ARTIKEL, RUNDGAENGE, artikelNachSlug, formatiere, sucheHilfe } from '../hilfe.js';

export default async function hilfeRoutes(fastify) {
  const gemeinsam = { KATEGORIEN, formatiere, RUNDGAENGE };

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

  // Geführte Rundgänge: /hilfe/rundgang[/n] (Lehrkräfte) und /hilfe/rundgang-klassenleitung[/n]
  for (const rundgang of Object.values(RUNDGAENGE)) {
    fastify.get(rundgang.basis, async (request, reply) => reply.redirect(`${rundgang.basis}/1`));
    fastify.get(`${rundgang.basis}/:n`, async (request, reply) => {
      const n = parseInt(request.params.n, 10);
      if (!Number.isInteger(n) || n < 1 || n > rundgang.schritte.length) return reply.redirect(`${rundgang.basis}/1`);
      const schritt = rundgang.schritte[n - 1];
      return reply.viewEjs('hilfe/rundgang.ejs', {
        user: request.user, ...gemeinsam, rundgang, n, schritt, schritte: rundgang.schritte, artikel: schritt.artikel ? artikelNachSlug(schritt.artikel) : null,
      });
    });
  }

  fastify.get('/hilfe/:slug', async (request, reply) => {
    const artikel = artikelNachSlug(request.params.slug);
    if (!artikel) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Diesen Hilfe-Artikel gibt es nicht.' });
    return reply.viewEjs('hilfe/artikel.ejs', {
      user: request.user, ...gemeinsam, artikel, kategorie: KATEGORIEN.find((k) => k.id === artikel.kategorie),
      verwandt: (artikel.verwandt || []).map(artikelNachSlug).filter(Boolean),
    });
  });
}
