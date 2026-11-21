/**
 * Rückmeldungen der Nutzer:innen („Feedback“): Lob, Wünsche an Funktionen und Probleme.
 * Datenschutz: Ohne Häkchen „Meinen Namen mitsenden“ wird KEIN Konto gespeichert -- die Rückmeldung ist dann anonym (auch die
 * Administration sieht nicht, von wem sie kommt). Es wird nur der Text, die Art, die betroffene Funktion und die Seite gespeichert,
 * von der aus gesendet wurde (nur der Pfad, ohne Zahlen aus Adressen wie Fach- oder Klassen-Nummern).
 */

import { getDb } from './db.js';

export const ARTEN = [
  { id: 'lob', symbol: '👍', titel: 'Das gefällt mir', platzhalter: 'Was funktioniert gut? Was spart dir Zeit?' },
  { id: 'wunsch', symbol: '💡', titel: 'Ich wünsche mir …', platzhalter: 'Welche Funktion fehlt dir oder was sollte anders sein?' },
  { id: 'problem', symbol: '🐞', titel: 'Etwas stimmt nicht', platzhalter: 'Was ist passiert? Was hast du erwartet? (Bitte keine Namen von Schüler/innen oder Noten eintragen.)' },
];
export const STATI = [
  { id: 'neu', titel: 'Neu' },
  { id: 'gelesen', titel: 'Gelesen' },
  { id: 'erledigt', titel: 'Erledigt' },
];
export const MIN_ZEICHEN = 5;
export const MAX_ZEICHEN = 2000;
const MAX_PRO_TAG = 10;

const versuche = new Map(); // userId -> Zeitstempel der letzten 24 Stunden (nur im Speicher)

/** Höchstens MAX_PRO_TAG Rückmeldungen je Konto und 24 Stunden (Schutz vor Versehen und Missbrauch). */
export function darfSenden(userId, jetzt = Date.now()) {
  const liste = (versuche.get(userId) || []).filter((t) => jetzt - t < 86_400_000);
  versuche.set(userId, liste);
  return liste.length < MAX_PRO_TAG;
}

/** Seite ohne Zahlen/Parameter: /teacher/fach/12?hj=1 -> /teacher/fach/… */
export function bereinigeSeite(wert) {
  const w = String(wert || '').split('?')[0].split('#')[0];
  if (!/^\/[A-Za-z0-9\-_/.…]*$/.test(w) || w.startsWith('//')) return null;
  return w.split('/').map((teil) => (/^\d+$/.test(teil) ? '…' : teil)).join('/').slice(0, 120);
}

/** Speichert eine Rückmeldung. Gibt { ok: true, id } oder { ok: false, fehler } zurück. */
export function speichereFeedback(userId, { art, text, funktion, seite, mitName }) {
  const a = ARTEN.find((x) => x.id === art);
  if (!a) return { ok: false, fehler: 'Bitte wähle, worum es geht.' };
  const t = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (t.length < MIN_ZEICHEN) return { ok: false, fehler: `Bitte schreibe mindestens ${MIN_ZEICHEN} Zeichen.` };
  if (t.length > MAX_ZEICHEN) return { ok: false, fehler: `Bitte höchstens ${MAX_ZEICHEN} Zeichen.` };
  if (!darfSenden(userId)) return { ok: false, fehler: `Heute sind höchstens ${MAX_PRO_TAG} Rückmeldungen möglich. Danke für dein Engagement!` };
  const f = String(funktion || '').slice(0, 40) || null;
  const info = getDb().prepare('INSERT INTO feedback (art, text, funktion, seite, user_id) VALUES (?, ?, ?, ?, ?)')
    .run(a.id, t, f, bereinigeSeite(seite), mitName ? userId : null);
  versuche.get(userId).push(Date.now());
  return { ok: true, id: Number(info.lastInsertRowid) };
}

/** Liste für die Administration (neueste zuerst), optional gefiltert. */
export function ladeFeedback({ art = '', status = '' } = {}) {
  const bedingungen = [];
  const werte = [];
  if (ARTEN.some((a) => a.id === art)) { bedingungen.push('f.art = ?'); werte.push(art); }
  if (STATI.some((s) => s.id === status)) { bedingungen.push('f.status = ?'); werte.push(status); }
  return getDb().prepare(`
    SELECT f.id, f.art, f.text, f.funktion, f.seite, f.status, f.created_at, f.user_id,
           COALESCE(u.display_name, u.username) AS name
    FROM feedback f LEFT JOIN users u ON u.id = f.user_id
    ${bedingungen.length ? 'WHERE ' + bedingungen.join(' AND ') : ''}
    ORDER BY f.id DESC LIMIT 500
  `).all(...werte);
}

export function feedbackZahlen() {
  const db = getDb();
  const proArt = Object.fromEntries(ARTEN.map((a) => [a.id, 0]));
  for (const r of db.prepare('SELECT art, COUNT(*) AS c FROM feedback GROUP BY art').all()) if (r.art in proArt) proArt[r.art] = r.c;
  return { gesamt: Object.values(proArt).reduce((a, b) => a + b, 0), neu: db.prepare("SELECT COUNT(*) AS c FROM feedback WHERE status = 'neu'").get().c, proArt };
}

export function setzeFeedbackStatus(id, status) {
  if (!STATI.some((s) => s.id === status)) return false;
  return getDb().prepare('UPDATE feedback SET status = ? WHERE id = ?').run(status, id).changes > 0;
}

export function loescheFeedback(id) {
  return getDb().prepare('DELETE FROM feedback WHERE id = ?').run(id).changes > 0;
}
