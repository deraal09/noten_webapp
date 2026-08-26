/**
 * Sitzplan: freie Anordnung von Namens-Plätzen auf einem "Blatt" je Klasse.
 * Jede Lehrkraft mit Klassenzugriff hat einen eigenen, privaten Entwurf
 * (sitzplaene) — erst per Knopfdruck (POST .../uebertragen) wird dieser in
 * sitzplan_geteilt kopiert und damit für andere Lehrkräfte der Klasse
 * sichtbar. Kein automatisches Teilen, kein Live-Mitschauen.
 */

import { getDb } from '../db.js';
import { requireAuth, userHatKlassenZugriff } from '../auth.js';

const MAX_PLAETZE = 200;
const MAX_TEXT_LAENGE = 60;

function ladeKlasse(id) {
  return getDb().prepare(`
    SELECT k.*, s.bezeichnung AS schuljahr_bezeichnung
    FROM klassen k JOIN schuljahre s ON s.id = k.schuljahr_id WHERE k.id = ?
  `).get(id);
}

/** Validiert/normalisiert die vom Client gesendeten Plätze (JSON-Array). */
function parsePlaetze(raw) {
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || arr.length > MAX_PLAETZE) return null;
  const ergebnis = [];
  for (const p of arr) {
    if (!p || typeof p !== 'object') return null;
    const x = Number(p.x);
    const y = Number(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    ergebnis.push({
      id: String(p.id ?? '').slice(0, 40) || `p${ergebnis.length}`,
      x: Math.min(100, Math.max(0, x)),
      y: Math.min(100, Math.max(0, y)),
      text: String(p.text ?? '').slice(0, MAX_TEXT_LAENGE),
    });
  }
  return ergebnis;
}

export default async function sitzplanRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  fastify.get('/klassen/:id/sitzplan', async (request, reply) => {
    const klasse = ladeKlasse(request.params.id);
    if (!klasse) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Klasse nicht gefunden.' });
    if (!userHatKlassenZugriff(request.user, klasse.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    const db = getDb();
    const schueler = db.prepare('SELECT * FROM schueler WHERE klasse_id = ? ORDER BY nachname, vorname').all(klasse.id);
    const eigener = db.prepare('SELECT * FROM sitzplaene WHERE klasse_id = ? AND owner_id = ?')
      .get(klasse.id, request.user.id);
    const geteilt = db.prepare(`
      SELECT g.*, u.display_name, u.username FROM sitzplan_geteilt g
      LEFT JOIN users u ON u.id = g.geteilt_von_id
      WHERE g.klasse_id = ?
    `).get(klasse.id);
    return reply.viewEjs('teacher/sitzplan.ejs', {
      user: request.user, klasse, schueler,
      plaetze: eigener ? JSON.parse(eigener.plaetze) : [],
      geteilt: geteilt ? { ...geteilt, plaetze: JSON.parse(geteilt.plaetze) } : null,
    });
  });

  fastify.post('/klassen/:id/sitzplan/speichern', async (request, reply) => {
    const klasse = ladeKlasse(request.params.id);
    if (!klasse || !userHatKlassenZugriff(request.user, klasse.id)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const plaetze = parsePlaetze(request.body?.plaetze ?? '[]');
    if (plaetze === null) return reply.code(400).send({ error: 'invalid plaetze' });
    getDb().prepare(`
      INSERT INTO sitzplaene (klasse_id, owner_id, plaetze, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(klasse_id, owner_id) DO UPDATE SET
        plaetze = excluded.plaetze, updated_at = excluded.updated_at
    `).run(klasse.id, request.user.id, JSON.stringify(plaetze));
    return reply.send({ ok: true, anzahl: plaetze.length });
  });

  // ---------- Übertragen: nur per Knopfdruck sichtbar für andere Lehrkräfte ----------
  fastify.post('/klassen/:id/sitzplan/uebertragen', async (request, reply) => {
    const klasse = ladeKlasse(request.params.id);
    if (!klasse || !userHatKlassenZugriff(request.user, klasse.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    const eigener = getDb().prepare('SELECT plaetze FROM sitzplaene WHERE klasse_id = ? AND owner_id = ?')
      .get(klasse.id, request.user.id);
    getDb().prepare(`
      INSERT INTO sitzplan_geteilt (klasse_id, plaetze, geteilt_von_id, geteilt_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(klasse_id) DO UPDATE SET
        plaetze = excluded.plaetze, geteilt_von_id = excluded.geteilt_von_id, geteilt_at = excluded.geteilt_at
    `).run(klasse.id, eigener?.plaetze ?? '[]', request.user.id);
    request.flash?.('success', 'Sitzplan an alle Lehrkräfte der Klasse übertragen.');
    return reply.redirect(`/teacher/klassen/${klasse.id}/sitzplan`);
  });

  // ---------- Geteilten Sitzplan als eigenen Entwurf übernehmen ----------
  fastify.post('/klassen/:id/sitzplan/uebernehmen', async (request, reply) => {
    const klasse = ladeKlasse(request.params.id);
    if (!klasse || !userHatKlassenZugriff(request.user, klasse.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    const geteilt = getDb().prepare('SELECT plaetze FROM sitzplan_geteilt WHERE klasse_id = ?').get(klasse.id);
    if (!geteilt) return reply.redirect(`/teacher/klassen/${klasse.id}/sitzplan`);
    getDb().prepare(`
      INSERT INTO sitzplaene (klasse_id, owner_id, plaetze, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(klasse_id, owner_id) DO UPDATE SET
        plaetze = excluded.plaetze, updated_at = excluded.updated_at
    `).run(klasse.id, request.user.id, geteilt.plaetze);
    request.flash?.('success', 'Geteilten Sitzplan als eigenen Entwurf übernommen.');
    return reply.redirect(`/teacher/klassen/${klasse.id}/sitzplan`);
  });
}
