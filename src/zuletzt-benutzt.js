/**
 * „Weitermachen“ auf der Startseite: die zuletzt geöffneten Fächer, nur in der Sitzung (also pro Anmeldung, nichts bleibt auf dem Gerät
 * oder in der Datenbank zurück). Beim Anzeigen werden Namen frisch geladen und nur Fächer gezeigt, auf die noch Zugriff besteht.
 */

import { getDb } from './db.js';
import { userHatFachZgriff } from './auth.js';

export const MAX_ZULETZT = 3;

export function merkeZuletztBenutzt(request, fachId) {
  if (!request.session) return;
  const id = Number(fachId);
  const liste = (request.session.zuletztFaecher || []).filter((x) => x !== id);
  liste.unshift(id);
  request.session.zuletztFaecher = liste.slice(0, MAX_ZULETZT + 2); // etwas Reserve, falls ein Zugriff inzwischen fehlt
}

/** @returns {{id: number, titel: string, href: string}[]} */
export function ladeZuletztBenutzt(request) {
  const ids = request.session?.zuletztFaecher || [];
  const db = getDb();
  const ergebnis = [];
  for (const id of ids) {
    const f = db.prepare(`
      SELECT f.id, f.name, f.ist_kurs, k.name AS klasse_name, k.ist_kurs_huelle FROM faecher f JOIN klassen k ON k.id = f.klasse_id WHERE f.id = ?
    `).get(id);
    if (!f || !userHatFachZgriff(request.user, f.id)) continue;
    ergebnis.push({ id: f.id, titel: f.ist_kurs || f.ist_kurs_huelle ? `${f.name} (Kurs)` : `${f.name} – ${f.klasse_name}`, href: `/teacher/fach/${f.id}` });
    if (ergebnis.length >= MAX_ZULETZT) break;
  }
  return ergebnis;
}
