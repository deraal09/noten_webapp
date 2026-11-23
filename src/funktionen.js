/**
 * Wählbare Funktionen („Meine Funktionen“, Konto): Wer nur Klassen anlegen und Noten eintragen will, sieht zunächst nur das;
 * weitere Funktionen lassen sich je Konto einschalten – einzeln auf der Seite „Meine Funktionen“ oder über ein Startprofil.
 *
 * Wichtig: Es wird nur die ANZEIGE gesteuert (Menüpunkte, Reiter, Kacheln). Die Seiten selbst bleiben erreichbar (Links aus der
 * Hilfe, Lesezeichen) und die Rechte ändern sich nicht. Solange eine Person noch kein Profil gewählt hat (`profil` ist null),
 * ist alles sichtbar – so ändert sich für bestehende Konten nichts, bis sie selbst wählen.
 *
 * Automatisch sichtbar (ohne Schalter): „Klassenleitung“, sobald man als Klassenleitung eingetragen ist; „Synchronisation“ an
 * Fächern von Klassen, die eine Klassenleitung haben.
 */

import { getDb } from './db.js';

export const FUNKTIONEN = [
  { id: 'sitzplan', symbol: '🪑', titel: 'Sitzpläne', text: 'Sitzordnung je Raum zeichnen und mit anderen Lehrkräften der Klasse teilen.' },
  { id: 'notenbesprechung', symbol: '🗣', titel: 'Notenbesprechung', text: 'Person für Person die Noten besprechen, auch in zufälliger Reihenfolge, mit Notizen.' },
  { id: 'statistik', symbol: '📊', titel: 'Klausur-Statistik', text: 'Zeigt je Klausur, welche Aufgaben zu schwer oder zu leicht waren.' },
  { id: 'favoriten', symbol: '★', titel: 'Favoriten', text: 'Fächer in der Noteneingabe mit einem Stern oben anpinnen.' },
  { id: 'klassenleitung', symbol: '🧑‍🏫', titel: 'Klassenleitung', text: 'Notenkonferenz, Zeugnisse und Fehlzeiten. Erscheint von selbst, sobald du als Klassenleitung eingetragen bist.' },
  { id: 'synchronisation', symbol: '🔄', titel: 'Synchronisation', text: 'Noten mit der Klassenleitung abgleichen. Erscheint von selbst an Fächern von Klassen mit Klassenleitung.' },
  { id: 'api', symbol: '🤖', titel: 'API-Zugang', text: 'Schlüssel für KI-Agenten und eigene Programme (nur für Schulkonten).' },
];
export const FUNKTION_IDS = FUNKTIONEN.map((f) => f.id);

export const PROFILE = {
  einfach: { titel: 'Nur Klassen und Noten', text: 'Klassen anlegen, Schüler/innen eintragen, Noten eingeben – sonst nichts.', funktionen: [] },
  klassenleitung: { titel: 'Klassenleitung', text: 'Zusätzlich Notenbesprechung, Synchronisation, Statistik und die Klassenleitungs-Seiten.', funktionen: ['klassenleitung', 'notenbesprechung', 'synchronisation', 'statistik'] },
  alles: { titel: 'Alles anzeigen', text: 'Alle Funktionen sind sichtbar.', funktionen: FUNKTION_IDS },
};

function alleAn() { return Object.fromEntries(FUNKTION_IDS.map((id) => [id, true])); }

/**
 * Welche Funktionen sieht diese Person? Ergebnis: { [id]: boolean, gewaehlt: boolean, profil: string|null }.
 * Admins und Konten ohne Auswahl sehen alles (`gewaehlt` ist dann false, die Start-Seite fragt einmalig nach).
 */
export function funktionenFuer(user) {
  if (!user) return { ...alleAn(), gewaehlt: true, profil: null };
  if (user.isAdmin) return { ...alleAn(), gewaehlt: true, profil: 'alles' };
  const zeile = getDb().prepare('SELECT profil, aktiv FROM user_funktionen WHERE user_id = ?').get(user.id);
  if (!zeile || !zeile.profil) {
    // Noch keine eigene Wahl: gilt das Standardprofil der Administration, falls es für NEUE Konten festgelegt wurde (ältere Konten
    // behalten ihre bisherige Ansicht, bis sie selbst wählen).
    const standard = standardProfil();
    if (standard) {
      const angelegt = getDb().prepare('SELECT created_at FROM users WHERE id = ?').get(user.id)?.created_at;
      if (angelegt && angelegt > standard.seit) {
        const menge = new Set(PROFILE[standard.profil].funktionen);
        return { ...Object.fromEntries(FUNKTION_IDS.map((id) => [id, menge.has(id)])), gewaehlt: true, profil: standard.profil, vomAdmin: true };
      }
    }
    return { ...alleAn(), gewaehlt: false, profil: null };
  }
  let aktiv = [];
  try { aktiv = JSON.parse(zeile.aktiv); } catch { /* leer */ }
  const menge = new Set(Array.isArray(aktiv) ? aktiv : []);
  return { ...Object.fromEntries(FUNKTION_IDS.map((id) => [id, menge.has(id)])), gewaehlt: true, profil: zeile.profil };
}

/** Setzt ein Startprofil und schaltet dessen Funktionen ein (ersetzt die bisherige Auswahl). */
export function setzeProfil(userId, profil) {
  if (!PROFILE[profil]) return false;
  getDb().prepare(`
    INSERT INTO user_funktionen (user_id, profil, aktiv) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET profil = excluded.profil, aktiv = excluded.aktiv
  `).run(userId, profil, JSON.stringify(PROFILE[profil].funktionen));
  return true;
}

/** Speichert die Einzelauswahl; unbekannte Namen werden ignoriert. Das Profil bleibt erhalten (oder wird „angepasst“). */
export function setzeFunktionen(userId, ids) {
  const aktiv = FUNKTION_IDS.filter((id) => ids.includes(id));
  const bisher = getDb().prepare('SELECT profil FROM user_funktionen WHERE user_id = ?').get(userId);
  getDb().prepare(`
    INSERT INTO user_funktionen (user_id, profil, aktiv) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET profil = excluded.profil, aktiv = excluded.aktiv
  `).run(userId, bisher?.profil || 'angepasst', JSON.stringify(aktiv));
  return aktiv;
}

/** Standardprofil der Administration für neue Konten: { profil, seit } oder null (keine Vorgabe: jede Person wählt selbst). */
export function standardProfil() {
  const db = getDb();
  const profil = db.prepare("SELECT value FROM app_einstellungen WHERE key = 'standardprofil'").get()?.value;
  if (!profil || !PROFILE[profil]) return null;
  const seit = db.prepare("SELECT value FROM app_einstellungen WHERE key = 'standardprofil_seit'").get()?.value || '0000-00-00 00:00:00';
  return { profil, seit };
}

/** Legt das Standardprofil für neue Konten fest ('' = keine Vorgabe). Gilt nur für Konten, die NACH dem Festlegen angelegt werden. */
export function setzeStandardProfil(profil) {
  const db = getDb();
  if (!profil) {
    db.prepare("DELETE FROM app_einstellungen WHERE key IN ('standardprofil', 'standardprofil_seit')").run();
    return true;
  }
  if (!PROFILE[profil]) return false;
  const upsert = db.prepare('INSERT INTO app_einstellungen (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  upsert.run('standardprofil', profil);
  upsert.run('standardprofil_seit', db.prepare("SELECT datetime('now') AS t").get().t);
  return true;
}

/** Schaltet eine einzelne Funktion ein (z. B. aus der Suche); ohne bisherige Auswahl bleibt alles sichtbar, es ist also nichts zu tun. */
export function schalteFunktionEin(userId, id) {
  if (!FUNKTION_IDS.includes(id)) return false;
  const zeile = getDb().prepare('SELECT profil, aktiv FROM user_funktionen WHERE user_id = ?').get(userId);
  if (!zeile || !zeile.profil) return true;
  let aktiv = [];
  try { aktiv = JSON.parse(zeile.aktiv); } catch { /* leer */ }
  setzeFunktionen(userId, [...new Set([...(Array.isArray(aktiv) ? aktiv : []), id])]);
  return true;
}

/** Anonyme Übersicht für die Administration: wie viele Konten haben welches Profil und welche Funktion eingeschaltet? */
export function funktionenUebersicht() {
  const db = getDb();
  const konten = db.prepare("SELECT COUNT(*) AS c FROM users WHERE active = 1 AND role != 'admin'").get().c;
  const zeilen = db.prepare(`
    SELECT f.profil, f.aktiv FROM user_funktionen f JOIN users u ON u.id = f.user_id WHERE u.active = 1 AND u.role != 'admin'
  `).all();
  const profile = { ohne: Math.max(0, konten - zeilen.length) };
  const proFunktion = Object.fromEntries(FUNKTION_IDS.map((id) => [id, 0]));
  for (const z of zeilen) {
    const name = z.profil || 'ohne';
    profile[name] = (profile[name] || 0) + 1;
    if (!z.profil) continue;
    let aktiv = [];
    try { aktiv = JSON.parse(z.aktiv); } catch { /* leer */ }
    for (const id of aktiv) if (id in proFunktion) proFunktion[id] += 1;
  }
  return { konten, gewaehlt: zeilen.filter((z) => z.profil).length, profile, proFunktion };
}
