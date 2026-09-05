/**
 * Lese-Schnittstelle für Schwester-Apps (Lehrerkalender): Klassen, Fächer und
 * Schülerlisten der jeweiligen Lehrkraft.
 *
 * Authentisierung: NICHT per Session/Cookie, sondern server-zu-server —
 *   Authorization: Bearer <SSO_CLIENT_SECRET>
 *   X-Noten-Sub:   <Kennung der Lehrkraft, siehe src/sso.js>
 * Damit gibt es kein CORS und keine Dritt-Cookies (die Safari blockt); der
 * Kalender-Server ruft im Namen der angemeldeten Lehrkraft ab.
 *
 * Herausgegeben werden nur Daten, auf die diese Lehrkraft auch in der
 * Oberfläche Zugriff hätte (dieselben Helfer aus src/auth.js). Noten werden
 * hier bewusst NICHT geliefert: Der Kalender verknüpft nur Klassen und
 * verlinkt in die Notentafel — Quelle der Noten bleibt diese App.
 */

import { getDb, SCHEMA_VERSION } from '../db.js';
import {
  ladeMeineKlassen, userHatKlassenZugriff, userIstKlassenlehrer, userHatFachZgriff,
} from '../auth.js';
import { bearerPasst, userAusSub, istSsoAktiv } from '../sso.js';

/** users-Zeile in die Form bringen, die die Berechtigungs-Helfer erwarten. */
function alsUser(zeile) {
  return {
    id: zeile.id,
    username: zeile.username,
    role: zeile.role,
    displayName: zeile.display_name,
    isAdmin: zeile.role === 'admin',
    authSource: zeile.auth_source,
  };
}

/**
 * Fächer einer Klasse, die diese Lehrkraft öffnen darf: bei Klassenleitung,
 * Ersteller/in oder Admin alle, sonst nur die zugewiesenen.
 */
function faecherFuer(user, klasse) {
  const db = getDb();
  const alle = db
    .prepare('SELECT id, name, abgeschlossen FROM faecher WHERE klasse_id = ? ORDER BY name')
    .all(klasse.id);
  const alleSehen =
    user.isAdmin || klasse.created_by_id === user.id || userIstKlassenlehrer(user, klasse.id);
  const sichtbar = alleSehen ? alle : alle.filter((f) => userHatFachZgriff(user, f.id));
  return sichtbar.map((f) => ({ id: f.id, name: f.name, abgeschlossen: Boolean(f.abgeschlossen) }));
}

function klasseNachAussen(user, k) {
  const db = getDb();
  const anzahl = db
    .prepare('SELECT COUNT(*) AS c FROM schueler WHERE klasse_id = ?')
    .get(k.id).c;
  return {
    id: k.id,
    name: k.name,
    schuljahr: k.schuljahr_bezeichnung || null,
    schuljahrId: k.schuljahr_id,
    zweiSchulen: Boolean(k.zwei_schulen),
    schuelerAnzahl: anzahl,
    rolle: {
      ersteller: k.created_by_id === user.id,
      klassenleitung: userIstKlassenlehrer(user, k.id),
    },
    faecher: faecherFuer(user, k),
  };
}

export default async function apiExternRoutes(fastify) {
  // Gemeinsame Vorprüfung: Geheimnis, danach die handelnde Lehrkraft auflösen.
  fastify.addHook('preHandler', async (request, reply) => {
    if (!istSsoAktiv()) {
      return reply.code(404).send({ error: 'Schnittstelle nicht eingerichtet' });
    }
    if (!bearerPasst(request.headers.authorization)) {
      request.log.warn({ url: request.url }, 'api-extern: falsches oder fehlendes Geheimnis');
      return reply.code(401).send({ error: 'Nicht autorisiert' });
    }
    // /ping braucht keine Person.
    if (request.url.startsWith('/api/extern/ping')) return;

    const sub = request.headers['x-noten-sub'];
    if (!sub) return reply.code(400).send({ error: 'X-Noten-Sub fehlt' });
    const zeile = userAusSub(sub);
    if (!zeile) {
      return reply.code(404).send({
        error: 'Zu dieser Kennung gibt es hier kein aktives Konto. ' +
          'Bitte einmal in der Notenverwaltung anmelden.',
      });
    }
    request.externUser = alsUser(zeile);
  });

  // ---------- GET /api/extern/ping ----------
  fastify.get('/ping', async () => ({
    ok: true,
    app: 'notenverwaltung',
    version: SCHEMA_VERSION,
  }));

  // ---------- GET /api/extern/klassen ----------
  fastify.get('/klassen', async (request) => {
    const user = request.externUser;
    const klassen = ladeMeineKlassen(user.id).map((k) => klasseNachAussen(user, k));
    return { sub: user.username, klassen };
  });

  // ---------- GET /api/extern/klassen/:id ----------
  fastify.get('/klassen/:id', async (request, reply) => {
    const user = request.externUser;
    const id = parseInt(request.params.id, 10);
    if (!id) return reply.code(400).send({ error: 'Ungültige Klassen-ID' });
    const db = getDb();
    const k = db
      .prepare(`SELECT k.*, s.bezeichnung AS schuljahr_bezeichnung
                FROM klassen k JOIN schuljahre s ON s.id = k.schuljahr_id
                WHERE k.id = ?`)
      .get(id);
    if (!k) return reply.code(404).send({ error: 'Klasse nicht gefunden' });
    if (!userHatKlassenZugriff(user, k.id)) {
      return reply.code(403).send({ error: 'Kein Zugriff auf diese Klasse' });
    }
    const schueler = db
      .prepare('SELECT id, nachname, vorname FROM schueler WHERE klasse_id = ? ORDER BY nachname, vorname')
      .all(k.id);
    return { klasse: { ...klasseNachAussen(user, k), schueler } };
  });
}
