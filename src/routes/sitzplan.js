/**
 * Sitzplan: freie Anordnung von Namens-Plätzen auf einem "Blatt", je Klasse
 * und RAUM — eine Klasse sitzt im Computerraum anders als im Klassenraum.
 * Jede Lehrkraft mit Klassenzugriff hat je Raum einen eigenen, privaten
 * Entwurf (sitzplaene) — erst per Knopfdruck (POST .../uebertragen) wird
 * dieser in sitzplan_geteilt kopiert und damit für andere Lehrkräfte der
 * Klasse sichtbar. Kein automatisches Teilen, kein Live-Mitschauen.
 *
 * Der Raum ist ein freier Text und Teil des Schlüssels (case-unabhängig,
 * siehe db.js). raum = '' steht für Pläne aus der Zeit vor der Raumangabe;
 * Anfragen ohne Raum landen dort, bestehende Aufrufe funktionieren also
 * unverändert weiter.
 *
 * Umbenennen und Löschen betreffen nur, was der Lehrkraft selbst gehört:
 * ihren Entwurf und — falls sie ihn geteilt hat — den geteilten Stand. Ein
 * von jemand anderem geteilter Plan bleibt unangetastet.
 */

import { getDb } from '../db.js';
import { requireAuth, userHatKlassenZugriff, ladeMeineKlassen } from '../auth.js';
import { sitzplanNamensvorschlaege } from '../sitzplan-namen.js';

const MAX_PLAETZE = 200;
const MAX_TEXT_LAENGE = 60;
const MAX_RAUM_LAENGE = 40;

function ladeKlasse(id) {
  return getDb().prepare(`
    SELECT k.*, s.bezeichnung AS schuljahr_bezeichnung
    FROM klassen k JOIN schuljahre s ON s.id = k.schuljahr_id WHERE k.id = ?
  `).get(id);
}

/**
 * Normalisiert eine Raumangabe (Steuerzeichen raus, Leerraum zusammengefasst).
 * Gibt null zurück, wenn sie zu lang ist. '' ist erlaubt (Pläne ohne
 * Raumangabe) — wo ein Name Pflicht ist, prüft der Aufrufer das selbst.
 */
function normiereRaum(raw) {
  const raum = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return raum.length > MAX_RAUM_LAENGE ? null : raum;
}

/** Link auf den Sitzplan eines Raums (auch für raum = ''). */
function raumUrl(klasseId, raum) {
  return `/teacher/klassen/${klasseId}/sitzplan?raum=${encodeURIComponent(raum)}`;
}

/**
 * Alle Räume, für die es in dieser Klasse etwas zu sehen gibt: eigene
 * Entwürfe und von irgendwem geteilte Pläne. Benannte Räume alphabetisch,
 * "ohne Raumangabe" zuletzt.
 */
function ladeRaeume(klasseId, userId) {
  return getDb().prepare(`
    SELECT raum, MAX(eigener) AS eigener, MAX(geteilt) AS geteilt, MAX(zeit) AS zuletzt
    FROM (
      SELECT raum, 1 AS eigener, 0 AS geteilt, updated_at AS zeit
      FROM sitzplaene WHERE klasse_id = ? AND owner_id = ?
      UNION ALL
      SELECT raum, 0, 1, geteilt_at FROM sitzplan_geteilt WHERE klasse_id = ?
    )
    GROUP BY raum COLLATE NOCASE
    ORDER BY raum = '', raum COLLATE NOCASE
  `).all(klasseId, userId, klasseId);
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

  // ---------- Übersicht: eigene Sitzpläne über alle Klassen ----------
  fastify.get('/sitzplaene', async (request, reply) => {
    const klassen = ladeMeineKlassen(request.user.id)
      .map((k) => ({ ...k, raeume: ladeRaeume(k.id, request.user.id) }));
    return reply.viewEjs('teacher/sitzplaene_liste.ejs', { user: request.user, klassen });
  });

  fastify.get('/klassen/:id/sitzplan', async (request, reply) => {
    const klasse = ladeKlasse(request.params.id);
    if (!klasse) return reply.code(404).viewEjs('error.ejs', { code: 404, message: 'Klasse nicht gefunden.' });
    if (!userHatKlassenZugriff(request.user, klasse.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    const db = getDb();
    const raeume = ladeRaeume(klasse.id, request.user.id);

    // Welcher Raum? Ausdrücklich gewählt (?raum=…, auch leer) — sonst der
    // zuletzt bearbeitete eigene Entwurf, sonst der erste vorhandene Raum.
    let raum;
    if (request.query && 'raum' in request.query) {
      raum = normiereRaum(request.query.raum);
      if (raum === null) return reply.code(400).viewEjs('error.ejs', { code: 400, message: `Raumangabe zu lang (höchstens ${MAX_RAUM_LAENGE} Zeichen).` });
    } else {
      const zuletzt = db.prepare('SELECT raum FROM sitzplaene WHERE klasse_id = ? AND owner_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1')
        .get(klasse.id, request.user.id);
      raum = zuletzt ? zuletzt.raum : (raeume[0]?.raum ?? '');
    }
    const bekannt = raeume.find((r) => r.raum.toLowerCase() === raum.toLowerCase());
    if (bekannt) raum = bekannt.raum; // gespeicherte Schreibweise anzeigen

    // Abgegangene Personen (siehe schueler.status) brauchen keinen Sitzplatz mehr.
    const schueler = db.prepare("SELECT * FROM schueler WHERE klasse_id = ? AND status != 'abgang' ORDER BY nachname, vorname").all(klasse.id);
    const eigener = db.prepare('SELECT * FROM sitzplaene WHERE klasse_id = ? AND owner_id = ? AND raum = ?')
      .get(klasse.id, request.user.id, raum);
    const geteilt = db.prepare(`
      SELECT g.*, u.display_name, u.username FROM sitzplan_geteilt g
      LEFT JOIN users u ON u.id = g.geteilt_von_id
      WHERE g.klasse_id = ? AND g.raum = ?
    `).get(klasse.id, raum);
    return reply.viewEjs('teacher/sitzplan.ejs', {
      user: request.user, klasse, raum, raeume,
      // Noch nichts gespeichert und nicht geteilt: ein gerade neu angelegter
      // Raum, der erst mit dem ersten Speichern entsteht.
      raumIstNeu: !bekannt,
      raumUrl: (r) => raumUrl(klasse.id, r),
      namensvorschlaege: sitzplanNamensvorschlaege(schueler),
      plaetze: eigener ? JSON.parse(eigener.plaetze) : [],
      // Löschen betrifft nur Eigenes: den eigenen Entwurf und den selbst geteilten Stand.
      hatEigenen: Boolean(eigener),
      geteilt: geteilt ? { ...geteilt, plaetze: JSON.parse(geteilt.plaetze), vonMir: geteilt.geteilt_von_id === request.user.id } : null,
    });
  });

  fastify.post('/klassen/:id/sitzplan/speichern', async (request, reply) => {
    const klasse = ladeKlasse(request.params.id);
    if (!klasse || !userHatKlassenZugriff(request.user, klasse.id)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const raum = normiereRaum(request.body?.raum);
    if (raum === null) return reply.code(400).send({ error: 'invalid raum' });
    const plaetze = parsePlaetze(request.body?.plaetze ?? '[]');
    if (plaetze === null) return reply.code(400).send({ error: 'invalid plaetze' });
    getDb().prepare(`
      INSERT INTO sitzplaene (klasse_id, owner_id, raum, plaetze, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(klasse_id, owner_id, raum) DO UPDATE SET
        plaetze = excluded.plaetze, updated_at = excluded.updated_at
    `).run(klasse.id, request.user.id, raum, JSON.stringify(plaetze));
    return reply.send({ ok: true, anzahl: plaetze.length });
  });

  // ---------- Übertragen: nur per Knopfdruck sichtbar für andere Lehrkräfte ----------
  fastify.post('/klassen/:id/sitzplan/uebertragen', async (request, reply) => {
    const klasse = ladeKlasse(request.params.id);
    if (!klasse || !userHatKlassenZugriff(request.user, klasse.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    const raum = normiereRaum(request.body?.raum);
    if (raum === null) return reply.code(400).viewEjs('error.ejs', { code: 400, message: 'Ungültige Raumangabe.' });
    const eigener = getDb().prepare('SELECT plaetze FROM sitzplaene WHERE klasse_id = ? AND owner_id = ? AND raum = ?')
      .get(klasse.id, request.user.id, raum);
    getDb().prepare(`
      INSERT INTO sitzplan_geteilt (klasse_id, raum, plaetze, geteilt_von_id, geteilt_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(klasse_id, raum) DO UPDATE SET
        plaetze = excluded.plaetze, geteilt_von_id = excluded.geteilt_von_id, geteilt_at = excluded.geteilt_at
    `).run(klasse.id, raum, eigener?.plaetze ?? '[]', request.user.id);
    request.flash?.('success', `Sitzplan${raum ? ` für „${raum}"` : ''} an alle Lehrkräfte der Klasse übertragen.`);
    return reply.redirect(raumUrl(klasse.id, raum));
  });

  // ---------- Geteilten Sitzplan als eigenen Entwurf übernehmen ----------
  fastify.post('/klassen/:id/sitzplan/uebernehmen', async (request, reply) => {
    const klasse = ladeKlasse(request.params.id);
    if (!klasse || !userHatKlassenZugriff(request.user, klasse.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    const raum = normiereRaum(request.body?.raum);
    if (raum === null) return reply.code(400).viewEjs('error.ejs', { code: 400, message: 'Ungültige Raumangabe.' });
    const geteilt = getDb().prepare('SELECT plaetze FROM sitzplan_geteilt WHERE klasse_id = ? AND raum = ?').get(klasse.id, raum);
    if (!geteilt) return reply.redirect(raumUrl(klasse.id, raum));
    getDb().prepare(`
      INSERT INTO sitzplaene (klasse_id, owner_id, raum, plaetze, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(klasse_id, owner_id, raum) DO UPDATE SET
        plaetze = excluded.plaetze, updated_at = excluded.updated_at
    `).run(klasse.id, request.user.id, raum, geteilt.plaetze);
    request.flash?.('success', 'Geteilten Sitzplan als eigenen Entwurf übernommen.');
    return reply.redirect(raumUrl(klasse.id, raum));
  });

  // ---------- Raum umbenennen (auch: Raumangabe für einen Altplan nachtragen) ----------
  fastify.post('/klassen/:id/sitzplan/raum-umbenennen', async (request, reply) => {
    const klasse = ladeKlasse(request.params.id);
    if (!klasse || !userHatKlassenZugriff(request.user, klasse.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    const alt = normiereRaum(request.body?.raum);
    const neu = normiereRaum(request.body?.neuer_raum);
    if (alt === null) return reply.code(400).viewEjs('error.ejs', { code: 400, message: 'Ungültige Raumangabe.' });
    if (!neu) {
      request.flash?.('error', `Bitte einen Raum angeben (höchstens ${MAX_RAUM_LAENGE} Zeichen).`);
      return reply.redirect(raumUrl(klasse.id, alt));
    }
    const db = getDb();
    const selberRaum = alt.toLowerCase() === neu.toLowerCase(); // nur die Schreibweise ändert sich
    if (!selberRaum) {
      const eigenerBelegt = db.prepare('SELECT 1 FROM sitzplaene WHERE klasse_id = ? AND owner_id = ? AND raum = ?')
        .get(klasse.id, request.user.id, neu);
      const geteiltAlt = db.prepare('SELECT geteilt_von_id FROM sitzplan_geteilt WHERE klasse_id = ? AND raum = ?').get(klasse.id, alt);
      const geteiltBelegt = db.prepare('SELECT 1 FROM sitzplan_geteilt WHERE klasse_id = ? AND raum = ?').get(klasse.id, neu);
      if (eigenerBelegt || (geteiltAlt?.geteilt_von_id === request.user.id && geteiltBelegt)) {
        request.flash?.('error', `Für den Raum „${neu}" gibt es schon einen Sitzplan — bitte einen anderen Namen wählen.`);
        return reply.redirect(raumUrl(klasse.id, alt));
      }
    }
    db.transaction(() => {
      db.prepare('UPDATE sitzplaene SET raum = ? WHERE klasse_id = ? AND owner_id = ? AND raum = ?')
        .run(neu, klasse.id, request.user.id, alt);
      // Den geteilten Stand nur mitnehmen, wenn er von dieser Lehrkraft stammt.
      db.prepare('UPDATE sitzplan_geteilt SET raum = ? WHERE klasse_id = ? AND raum = ? AND geteilt_von_id = ?')
        .run(neu, klasse.id, alt, request.user.id);
    })();
    return reply.redirect(raumUrl(klasse.id, neu));
  });

  // ---------- Sitzplan für einen Raum löschen ----------
  fastify.post('/klassen/:id/sitzplan/raum-loeschen', async (request, reply) => {
    const klasse = ladeKlasse(request.params.id);
    if (!klasse || !userHatKlassenZugriff(request.user, klasse.id)) {
      return reply.code(403).viewEjs('error.ejs', { code: 403, message: 'Keine Berechtigung.' });
    }
    const raum = normiereRaum(request.body?.raum);
    if (raum === null) return reply.code(400).viewEjs('error.ejs', { code: 400, message: 'Ungültige Raumangabe.' });
    const db = getDb();
    db.transaction(() => {
      db.prepare('DELETE FROM sitzplaene WHERE klasse_id = ? AND owner_id = ? AND raum = ?')
        .run(klasse.id, request.user.id, raum);
      db.prepare('DELETE FROM sitzplan_geteilt WHERE klasse_id = ? AND raum = ? AND geteilt_von_id = ?')
        .run(klasse.id, raum, request.user.id);
    })();
    const fremdGeteilt = db.prepare('SELECT 1 FROM sitzplan_geteilt WHERE klasse_id = ? AND raum = ?').get(klasse.id, raum);
    request.flash?.('success', fremdGeteilt
      ? 'Dein Sitzplan für diesen Raum wurde gelöscht. Der von einer anderen Lehrkraft geteilte Plan bleibt bestehen.'
      : `Sitzplan${raum ? ` für „${raum}"` : ''} gelöscht.`);
    return reply.redirect(fremdGeteilt ? raumUrl(klasse.id, raum) : `/teacher/klassen/${klasse.id}/sitzplan`);
  });
}
