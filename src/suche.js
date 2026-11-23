/**
 * Suche „Was möchtest du tun?“ (🔍 in der Kopfzeile, Strg+K): findet Seiten und Aktionen der App und Hilfe-Artikel. Sie findet auch
 * ausgeschaltete Funktionen (siehe src/funktionen.js) und bietet dann „einschalten und öffnen“ an -- so muss niemand suchen, wo
 * eine ausgeblendete Funktion geblieben ist.
 */

import { sucheHilfe, normalisiere, KATEGORIEN } from './hilfe.js';

/** Eintrag: funktion = zugehörige schaltbare Funktion (src/funktionen.js), rolle: 'lehrkraft' | 'admin' | 'alle', bedingung: optionale Zusatzbedingung. */
export const AKTIONEN = [
  { id: 'noteneingabe', symbol: '📝', titel: 'Noteneingabe', text: 'Fach öffnen und Klausuren, Unterrichtsleistung und Noten eintragen', href: '/teacher', rolle: 'lehrkraft',
    schlagworte: ['noten eintragen', 'klausur', 'punkte', 'fächer', 'fach öffnen', 'unterrichtsleistung', 'datumstabelle', 'zusatzleistung', 'endnote'] },
  { id: 'klasse-anlegen', symbol: '🏫', titel: 'Neue Klasse anlegen', text: 'Klasse mit Schuljahr und Notenschlüssel anlegen oder einer vorhandenen beitreten', href: '/teacher/klassen#panel-klasse-anlegen', rolle: 'lehrkraft',
    schlagworte: ['klasse neu', 'anlegen', 'erstellen', 'schuljahr', 'einschulung', 'beitreten'] },
  { id: 'kurs-anlegen', symbol: '📘', titel: 'Neuen Kurs anlegen', text: 'Kurs über mehrere Klassen (AG, Wahlpflicht) anlegen', href: '/teacher/klassen#panel-kurs-anlegen', rolle: 'lehrkraft',
    schlagworte: ['kurs neu', 'ag', 'wahlpflicht', 'teilnehmer', 'klassenübergreifend'] },
  { id: 'klassen', symbol: '🏫', titel: 'Meine Klassen', text: 'Klassen, Fächer und Schüler/innen verwalten', href: '/teacher/klassen', rolle: 'lehrkraft',
    schlagworte: ['klassen', 'schüler', 'schueler', 'personen', 'hinzufügen', 'csv', 'import', 'namen', 'umbenennen', 'fach anlegen', 'fächer', 'einschulungsjahr', 'laufzeit', 'versetzen', 'abgang'] },
  { id: 'sitzplan', symbol: '🪑', titel: 'Sitzpläne', text: 'Sitzordnung je Raum zeichnen und teilen', href: '/teacher/sitzplaene', rolle: 'lehrkraft', funktion: 'sitzplan',
    schlagworte: ['sitzplan', 'sitzordnung', 'raum', 'platz'] },
  { id: 'notenbesprechung', symbol: '🗣', titel: 'Notenbesprechung', text: 'Person für Person die Noten besprechen (Fach öffnen, ☰-Menü)', href: '/teacher', rolle: 'lehrkraft', funktion: 'notenbesprechung',
    schlagworte: ['besprechung', 'würfeln', 'zufällig', 'gespräch', 'notenbesprechung'] },
  { id: 'statistik', symbol: '📊', titel: 'Klausur-Statistik', text: 'Welche Aufgaben waren zu schwer oder zu leicht? (Fach → Klausuren → Statistik)', href: '/teacher', rolle: 'lehrkraft', funktion: 'statistik',
    schlagworte: ['statistik', 'auswertung', 'aufgabenanalyse', 'schwierigkeit', 'trennschärfe', 'lösungsgrad', 'zu schwer', 'zu leicht'] },
  { id: 'favoriten', symbol: '★', titel: 'Favoriten', text: 'Fächer in der Noteneingabe mit einem Stern anpinnen', href: '/teacher', rolle: 'lehrkraft', funktion: 'favoriten',
    schlagworte: ['favorit', 'stern', 'anpinnen', 'merken'] },
  { id: 'klassenleitung', symbol: '🧑‍🏫', titel: 'Klassenleitung', text: 'Notenkonferenz, Zeugnisse, Fehlzeiten, Abschluss', href: '/klassenlehrer', rolle: 'lehrkraft', funktion: 'klassenleitung',
    schlagworte: ['zeugnis', 'zeugnisse', 'konferenz', 'fehlzeiten', 'abschluss', 'klassenlehrer', 'klassenlehrkraft', 'notenkonferenz', 'sperren'] },
  { id: 'synchronisation', symbol: '🔄', titel: 'Synchronisation', text: 'Noten mit der Klassenleitung abgleichen (Fach → ⋮ Mehr)', href: '/teacher', rolle: 'lehrkraft', funktion: 'synchronisation',
    schlagworte: ['sync', 'abgleichen', 'übertragen', 'klassenleitung noten'] },
  { id: 'api', symbol: '🤖', titel: 'API-Zugang', text: 'Schlüssel für KI-Agenten anlegen, verlängern und widerrufen', href: '/konto/api', rolle: 'lehrkraft', funktion: 'api',
    schlagworte: ['api', 'schlüssel', 'token', 'ki', 'agent', 'claude', 'verlängern'], bedingung: 'ldap' },
  { id: 'papierkorb', symbol: '🗑', titel: 'Papierkorb', text: 'Gelöschte Klassen wiederherstellen', href: '/teacher/papierkorb', rolle: 'lehrkraft',
    schlagworte: ['gelöscht', 'wiederherstellen', 'klasse löschen'] },
  { id: 'einladungen', symbol: '✉️', titel: 'Einladungen', text: 'Externe Lehrkräfte einladen', href: '/teacher/einladungen', rolle: 'lehrkraft', bedingung: 'einladen',
    schlagworte: ['einladung', 'einladen', 'extern', 'link'] },
  { id: 'notenschluessel', symbol: '🧮', titel: 'Notenschlüssel', text: 'Notenschlüssel ansehen (IHK, BG, SPA)', href: '/notenschluessel', rolle: 'lehrkraft',
    schlagworte: ['schlüssel', 'prozent', 'ihk', 'bg', 'spa', 'notentabelle'] },
  // Admin
  { id: 'admin', symbol: '🏠', titel: 'Admin-Dashboard', text: 'Übersicht und Schuljahre', href: '/admin', rolle: 'admin', schlagworte: ['dashboard', 'schuljahr', 'übersicht'] },
  { id: 'admin-users', symbol: '👥', titel: 'Lehrkräfte verwalten', text: 'Konten anlegen, deaktivieren, Rollen', href: '/admin/users', rolle: 'admin', schlagworte: ['lehrkräfte', 'konten', 'benutzer', 'user'] },
  { id: 'admin-aktivitaet', symbol: '📊', titel: 'Aktivität und Funktionsnutzung', text: 'Wie intensiv wird die App genutzt, welche Funktionen werden gebraucht?', href: '/admin/aktivitaet', rolle: 'admin', schlagworte: ['aktivität', 'auslastung', 'statistik', 'nutzung', 'funktionen'] },
  { id: 'admin-feedback', symbol: '💬', titel: 'Feedback lesen', text: 'Rückmeldungen der Nutzer:innen', href: '/admin/feedback', rolle: 'admin', schlagworte: ['feedback', 'rückmeldung', 'wünsche', 'lob'] },
  { id: 'admin-zuweisungen', symbol: '🔗', titel: 'Zuweisungen', text: 'Lehrkräfte Fächern zuordnen', href: '/admin/zuweisungen', rolle: 'admin', schlagworte: ['zuweisung', 'zuordnen', 'fach'] },
  { id: 'admin-einladungen', symbol: '✉️', titel: 'Einladungen verwalten', text: 'Einladungslinks erstellen', href: '/admin/einladungen', rolle: 'admin', schlagworte: ['einladung', 'link'] },
  { id: 'admin-api', symbol: '🤖', titel: 'API-Zugänge', text: 'API-Schlüssel aller Lehrkräfte', href: '/admin/api', rolle: 'admin', schlagworte: ['api', 'schlüssel', 'abschalten'] },
  { id: 'admin-backup', symbol: '💾', titel: 'Datensicherung', text: 'Sicherung erstellen und herunterladen', href: '/admin/backup', rolle: 'admin', schlagworte: ['backup', 'sicherung', 'download'] },
  { id: 'admin-ldap', symbol: '🔐', titel: 'LDAP-Einstellungen', text: 'Anmeldung über das Schulkonto einrichten', href: '/admin/ldap/einstellungen', rolle: 'admin', schlagworte: ['ldap', 'anmeldung', 'verzeichnis'] },
  { id: 'admin-notenschluessel', symbol: '🧮', titel: 'Notenschlüssel bearbeiten', text: 'Globale Notenschlüssel anpassen', href: '/admin/notenschluessel', rolle: 'admin', schlagworte: ['notenschlüssel', 'prozent'] },
  { id: 'admin-rechtliches', symbol: '⚖️', titel: 'Rechtliches', text: 'Impressum und Datenschutz', href: '/admin/rechtliches', rolle: 'admin', schlagworte: ['impressum', 'datenschutz'] },
  { id: 'admin-profil', symbol: '⚙', titel: 'Startprofil für neue Lehrkräfte', text: 'Welche Funktionen neue Konten zuerst sehen', href: '/admin/funktionen', rolle: 'admin', schlagworte: ['standardprofil', 'funktionen', 'neue lehrkräfte', 'voreinstellung'] },
  // für alle
  { id: 'funktionen', symbol: '⚙', titel: 'Meine Funktionen', text: 'Funktionen ein- und ausschalten, Startprofil wählen', href: '/konto/funktionen', rolle: 'lehrkraft',
    schlagworte: ['funktionen', 'einschalten', 'ausschalten', 'ausblenden', 'einblenden', 'profil', 'übersichtlich', 'menü'] },
  { id: 'passwort', symbol: '🔑', titel: 'Passwort ändern', text: 'Eigenes Passwort ändern', href: '/konto/passwort', rolle: 'alle', bedingung: 'lokal', schlagworte: ['kennwort', 'passwort', 'konto'] },
  { id: 'feedback', symbol: '💬', titel: 'Feedback geben', text: 'Lob, Wünsche oder Probleme melden', href: '/feedback', rolle: 'alle', schlagworte: ['feedback', 'rückmeldung', 'wunsch', 'problem', 'fehler', 'lob', 'verbesserung'] },
  { id: 'hilfe', symbol: '❓', titel: 'Hilfe', text: 'Anleitungen mit Bildern und Suche', href: '/hilfe', rolle: 'alle', schlagworte: ['hilfe', 'anleitung', 'support', 'erklärung'] },
  { id: 'rundgang', symbol: '🧭', titel: 'Geführter Rundgang', text: 'Die wichtigsten Schritte Schritt für Schritt', href: '/hilfe/rundgang', rolle: 'alle', schlagworte: ['rundgang', 'einführung', 'erste schritte', 'tour', 'neu hier'] },
];

const VORSCHLAEGE = ['noteneingabe', 'klasse-anlegen', 'funktionen', 'feedback', 'hilfe'];
const VORSCHLAEGE_ADMIN = ['admin-aktivitaet', 'admin-feedback', 'admin-users', 'hilfe'];

const INDEX = AKTIONEN.map((a) => ({ a, titel: normalisiere(a.titel), schlag: normalisiere(a.schlagworte.join(' ')), text: normalisiere(a.text) }));

/** Ist die Aktion für diese Person überhaupt sinnvoll? (Rolle und Zusatzbedingung; ausgeschaltete Funktionen bleiben auffindbar.) */
function passtZurPerson(a, ctx) {
  if (a.rolle === 'admin' && !ctx.istAdmin) return false;
  if (a.rolle === 'lehrkraft' && ctx.istAdmin) return false;
  if (a.bedingung === 'ldap' && !ctx.ldap) return false;
  if (a.bedingung === 'lokal' && ctx.ldap) return false;
  if (a.bedingung === 'einladen' && !ctx.kannEinladen) return false;
  return true;
}

/**
 * @param {string} anfrage
 * @param {{ istAdmin: boolean, ldap: boolean, kannEinladen: boolean, funktionen: Record<string, boolean>|null }} ctx
 * @returns {{ aktionen: object[], hilfe: object[] }}
 */
export function suche(anfrage, ctx) {
  const tokens = normalisiere(anfrage).split(/\s+/).filter((t) => t.length >= 2);
  const mach = (a) => ({
    id: a.id, symbol: a.symbol, titel: a.titel, text: a.text, href: a.href,
    funktion: a.funktion || null, aus: Boolean(a.funktion && ctx.funktionen && ctx.funktionen[a.funktion] === false),
  });
  if (!tokens.length) {
    const ids = ctx.istAdmin ? VORSCHLAEGE_ADMIN : VORSCHLAEGE;
    return { aktionen: ids.map((id) => AKTIONEN.find((a) => a.id === id)).filter((a) => a && passtZurPerson(a, ctx)).map(mach), hilfe: [] };
  }
  const treffer = [];
  for (const e of INDEX) {
    if (!passtZurPerson(e.a, ctx)) continue;
    let punkte = 0;
    let alle = true;
    for (const t of tokens) {
      const imTitel = e.titel.includes(t);
      const inSchlag = e.schlag.includes(t);
      const inText = e.text.includes(t);
      if (!imTitel && !inSchlag && !inText) { alle = false; break; }
      punkte += (imTitel ? (e.titel.startsWith(t) ? 14 : 10) : 0) + (inSchlag ? 6 : 0) + (inText ? 2 : 0);
    }
    if (alle) treffer.push({ a: e.a, punkte });
  }
  treffer.sort((x, y) => y.punkte - x.punkte || x.a.titel.localeCompare(y.a.titel, 'de'));
  const kategorien = Object.fromEntries(KATEGORIEN.map((k) => [k.id, k.titel]));
  return {
    aktionen: treffer.slice(0, 6).map((t) => mach(t.a)),
    hilfe: sucheHilfe(anfrage, 4).map((h) => ({ titel: h.titel, kurz: h.kurz, href: `/hilfe/${h.slug}`, kategorie: kategorien[h.kategorie] || '' })),
  };
}
