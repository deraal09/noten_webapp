/**
 * Beschreibung der API für KI-Agenten (/api/v1): einzige Quelle für die OpenAPI-Datei (/api/v1/openapi.json) und die
 * Dokumentationsseite (/api/v1/docs). Beim Ändern einer Route hier den Eintrag mit anpassen.
 */

export const API_BASIS = '/api/v1';

const FEHLER = {
  400: 'Ungültige Anfrage (z. B. falsches Halbjahr, fehlende Felder)',
  401: 'API-Schlüssel fehlt, ist ungültig, abgelaufen oder widerrufen',
  403: 'Keine Berechtigung (Schlüssel nur „lesen“, oder keine Rechte der Lehrkraft am Fach/Halbjahr)',
  404: 'Nicht gefunden',
  409: 'Wird von der API (noch) nicht unterstützt, z. B. SPA-Fächer oder Fächer aus Unterfächern',
  422: 'Eingaben ungültig oder gesperrt; es wurde nichts gespeichert (Liste unter details)',
  429: 'Zu viele Anfragen (höchstens 120 pro Minute und Schlüssel)',
};

/** @type {Array<{id: string, method: 'GET'|'POST'|'PUT', path: string, scope: 'lesen'|'schreiben', summary: string, beschreibung: string, query?: Array<{name: string, beschreibung: string, pflicht?: boolean}>, body?: object, antwort: object}>} */
export const ENDPOINTS = [
  {
    id: 'me', method: 'GET', path: '/me', scope: 'lesen',
    summary: 'Wer bin ich? Konto, Schlüssel und Berechtigung',
    beschreibung: 'Gibt die Lehrkraft zurück, als die der Schlüssel handelt, sowie dessen Berechtigung und Ablaufdatum. Gut als erster Aufruf („Verbindungstest“).',
    antwort: { nutzer: { id: 3, benutzername: 'mmustermann', name: 'Max Mustermann', admin: false }, schluessel: { name: 'Claude', berechtigung: 'schreiben', laeuft_ab: null } },
  },
  {
    id: 'klassen', method: 'GET', path: '/klassen', scope: 'lesen',
    summary: 'Meine Klassen mit meinen Fächern',
    beschreibung: 'Alle Klassen der Lehrkraft (ohne die, die sie in den Papierkorb gelegt hat) mit den Fächern, auf die sie Zugriff hat.',
    antwort: {
      klassen: [{
        id: 12, name: '12BFI1', schuljahr: '2025/26', notenschluessel: 'BG', klassenleitung: true,
        faecher: [{ id: 41, name: 'Englisch', halbjahre: ['5. Halbjahr', '6. Halbjahr'] }],
      }],
    },
  },
  {
    id: 'schueler', method: 'GET', path: '/klassen/{id}/schueler', scope: 'lesen',
    summary: 'Schüler:innen einer Klasse',
    beschreibung: 'Namen und IDs der Schüler:innen (die IDs braucht man beim Eintragen von Noten).',
    antwort: { klasse: { id: 12, name: '12BFI1' }, schueler: [{ id: 301, nachname: 'Adler', vorname: 'Anna', status: 'aktiv' }] },
  },
  {
    id: 'fach', method: 'GET', path: '/faecher/{id}', scope: 'lesen',
    summary: 'Ein Fach: Halbjahre, Klausuren, Zusatzleistungen, Termine',
    beschreibung: 'Aufbau eines Fachs im gewählten Halbjahr: Klausuren (mit IDs, Höchstpunkten je Aufgabe, Teilen, Gewichtung), Zusatzleistungen der Unterrichtsleistung und die Termine der Datumstabelle.',
    query: [{ name: 'halbjahr', beschreibung: 'z. B. 5 oder „5. Halbjahr“ (ohne Angabe: aktuelles Halbjahr)' }],
    antwort: {
      fach: { id: 41, name: 'Englisch', klasse: '12BFI1', notenschluessel: 'BG', halbjahr: '5. Halbjahr', halbjahre: ['5. Halbjahr', '6. Halbjahr'] },
      klausuren: [{ id: 7, name: 'Klausur 1', datum: '2025-10-14', max_punkte: [15, 15, 15], gewichtung: 40, teile: null }],
      unterrichtsleistungen: [{ id: 3, name: 'Referat', datum: null, max_punkte: [10], gewichtung: 20 }],
      termine: [{ id: 90, datum: '2025-09-01' }],
    },
  },
  {
    id: 'noten', method: 'GET', path: '/faecher/{id}/noten', scope: 'lesen',
    summary: 'Notenübersicht eines Fachs (alle Schüler:innen)',
    beschreibung: 'Je Person: Punkte und Note jeder Klausur und Zusatzleistung, Datumsnoten, schriftliche Note, Note der Unterrichtsleistung, Gesamtnote, direkt eingetragene Endnote. Die Noten sind genau berechnet (nicht gerundet).',
    query: [{ name: 'halbjahr', beschreibung: 'z. B. 5 oder „5. Halbjahr“ (ohne Angabe: aktuelles Halbjahr)' }],
    antwort: {
      fach: { id: 41, name: 'Englisch', notenschluessel: 'BG', halbjahr: '5. Halbjahr' },
      anteil_schriftlich_prozent: 40, anteil_unterrichtsleistung_prozent: 60,
      schueler: [{
        id: 301, nachname: 'Adler', vorname: 'Anna', gesperrt: false,
        klausuren: [{ id: 7, name: 'Klausur 1', punkte: [12, 11, 6], extrapunkte: null, note: 9.9, teilnoten: [12, 8.5] }],
        unterrichtsleistungen: [{ id: 3, name: 'Referat', punkte: [9], note: 9 }],
        datumsnoten: [{ termin_id: 90, datum: '2025-09-01', note: 10, nicht_anwesend: false }],
        note_schriftlich: 9.9, note_unterrichtsleistung: 10, gesamtnote: 9.96, endnote: null, nicht_bestanden: false,
      }],
    },
  },
  {
    id: 'statistik', method: 'GET', path: '/faecher/{id}/statistik', scope: 'lesen',
    summary: 'Auswertung: Notenspiegel, Durchschnitt, nicht bestanden',
    beschreibung: 'Verarbeitete Zahlen für ein Fach und Halbjahr: Durchschnitt, beste/schlechteste Gesamtnote, Verteilung auf ganze Noten und Zahl der nicht bestandenen. Berechnet aus den Gesamtnoten (bzw. Endnoten), Personen ohne Note zählen nicht mit.',
    query: [{ name: 'halbjahr', beschreibung: 'z. B. 5 oder „5. Halbjahr“' }],
    antwort: {
      fach: { id: 41, name: 'Englisch', halbjahr: '5. Halbjahr', notenschluessel: 'BG' },
      anzahl_mit_note: 24, anzahl_ohne_note: 2, durchschnitt: 8.71, beste: 14.2, schlechteste: 2.1, nicht_bestanden: 3,
      verteilung: [{ note: 8, anzahl: 4 }, { note: 9, anzahl: 5 }],
    },
  },
  {
    id: 'notenschluessel', method: 'GET', path: '/notenschluessel', scope: 'lesen',
    summary: 'Die geltenden Notenschlüssel (IHK, BG, SPA)',
    beschreibung: 'Tabellen „ab Prozent → Note“ der übergeordneten Schlüssel, wie sie die Administration festgelegt hat.',
    antwort: { notenschluessel: [{ typ: 'BG', einheit: 'Notenpunkte (0–15)', tabelle: [{ ab_prozent: 95, note: 15 }, { ab_prozent: 90, note: 14 }] }] },
  },
  {
    id: 'berechnen', method: 'POST', path: '/berechnen/klausur', scope: 'lesen',
    summary: 'Note aus Punkten berechnen (ohne etwas zu speichern)',
    beschreibung: 'Rechenhilfe für Agenten: aus erreichten und maximalen Punkten (optional Teile, Extrapunkte) die Note nach einem Notenschlüssel. Speichert nichts.',
    body: {
      notenschluessel: 'BG', max_punkte: [15, 15, 15], punkte: [12, 11, 6], extrapunkte: 0,
      teile: [{ name: 'Hörverstehen', aufgaben: 1, gewichtung: 40, art: 'hoeren' }, { name: 'Textaufgabe', aufgaben: 2, gewichtung: 60, art: 'inhalt_sprache', inhalt_anteil: 50 }],
    },
    antwort: { note: 9.9, teilnoten: [12, 8.5], prozent: 77.78 },
  },
  {
    id: 'klausur-neu', method: 'POST', path: '/faecher/{id}/klausuren', scope: 'schreiben',
    summary: 'Klausur anlegen',
    beschreibung: 'Legt eine Klausur im Halbjahr an. `max_punkte` hat einen Eintrag je Aufgabe (z. B. [10, 10, 5]). Ohne `gewichtung` werden die Gewichte der Klausuren des Halbjahres wie in der Oberfläche automatisch verteilt.',
    query: [{ name: 'dry_run', beschreibung: 'true: nur prüfen, nichts speichern' }],
    body: { halbjahr: '5. Halbjahr', name: 'Klausur 2', datum: '2025-12-10', max_punkte: [10, 10, 5], gewichtung: 50 },
    antwort: { gespeichert: true, klausur: { id: 8, name: 'Klausur 2', max_punkte: [10, 10, 5], gewichtung: 50 } },
  },
  {
    id: 'klausur-ergebnisse', method: 'PUT', path: '/klausuren/{id}/ergebnisse', scope: 'schreiben',
    summary: 'Klausurpunkte eintragen (mehrere Personen auf einmal)',
    beschreibung: 'Setzt je Person die Punkte **aller** Aufgaben (Liste in der Reihenfolge der Aufgaben, `null` = noch nicht eingetragen). Alles oder nichts: ist auch nur ein Eintrag ungültig (Punkte über dem Maximum, Person nimmt nicht teil, Noten gesperrt), wird nichts gespeichert (422 mit Liste). Wiederholen ist gefahrlos (idempotent). Bei Hörverstehen-Teilen sind es die Verrechnungspunkte, bei „Inhalt & Sprache“ direkt die Noten.',
    query: [{ name: 'dry_run', beschreibung: 'true: nur prüfen und die berechneten Noten zeigen, nichts speichern' }],
    body: { ergebnisse: [{ schueler_id: 301, punkte: [12, 11, 6] }, { schueler_id: 302, punkte: [9, null, null], extrapunkte: null }] },
    antwort: { gespeichert: true, anzahl: 2, ergebnisse: [{ schueler_id: 301, punkte: [12, 11, 6], note: 9.9 }] },
  },
  {
    id: 'ul-neu', method: 'POST', path: '/faecher/{id}/unterrichtsleistungen', scope: 'schreiben',
    summary: 'Zusatzleistung der Unterrichtsleistung anlegen (z. B. Referat)',
    beschreibung: 'Wie eine Klausur, aber für Zusatzleistungen. `gewichtung` ist der Anteil (0–100) am Topf der Unterrichtsleistung; ohne Angabe 0 (zählt dann noch nicht).',
    query: [{ name: 'dry_run', beschreibung: 'true: nur prüfen, nichts speichern' }],
    body: { halbjahr: '5. Halbjahr', name: 'Referat', datum: null, max_punkte: [10], gewichtung: 20 },
    antwort: { gespeichert: true, unterrichtsleistung: { id: 4, name: 'Referat', max_punkte: [10], gewichtung: 20 } },
  },
  {
    id: 'ul-ergebnisse', method: 'PUT', path: '/unterrichtsleistungen/{id}/ergebnisse', scope: 'schreiben',
    summary: 'Punkte einer Zusatzleistung eintragen',
    beschreibung: 'Wie bei Klausuren: je Person die Punkte aller Aufgaben, alles oder nichts.',
    query: [{ name: 'dry_run', beschreibung: 'true: nur prüfen, nichts speichern' }],
    body: { ergebnisse: [{ schueler_id: 301, punkte: [9] }] },
    antwort: { gespeichert: true, anzahl: 1, ergebnisse: [{ schueler_id: 301, punkte: [9], note: 13 }] },
  },
  {
    id: 'termin-neu', method: 'POST', path: '/faecher/{id}/termine', scope: 'schreiben',
    summary: 'Termin in der Datumstabelle (Unterrichtsleistung) anlegen',
    beschreibung: 'Legt einen Unterrichtstermin an, für den dann Noten je Person eingetragen werden können.',
    query: [{ name: 'dry_run', beschreibung: 'true: nur prüfen, nichts speichern' }],
    body: { halbjahr: '5. Halbjahr', datum: '2025-12-01' },
    antwort: { gespeichert: true, termin: { id: 91, datum: '2025-12-01' } },
  },
  {
    id: 'termin-noten', method: 'PUT', path: '/termine/{id}/noten', scope: 'schreiben',
    summary: 'Noten für einen Termin der Datumstabelle eintragen',
    beschreibung: '`note` ist eine Zahl im Bereich des Notenschlüssels (IHK 1–6, BG und SPA-Fächer nach Schlüssel des Fachs), `"n.a."` für nicht anwesend oder `null` zum Leeren. Alles oder nichts.',
    query: [{ name: 'dry_run', beschreibung: 'true: nur prüfen, nichts speichern' }],
    body: { noten: [{ schueler_id: 301, note: 11 }, { schueler_id: 302, note: 'n.a.' }, { schueler_id: 303, note: null }] },
    antwort: { gespeichert: true, anzahl: 3 },
  },
  {
    id: 'endnoten', method: 'PUT', path: '/faecher/{id}/endnoten', scope: 'schreiben',
    summary: 'Endnoten (direkte Eingabe der Gesamtnote) eintragen',
    beschreibung: 'Ersetzt die berechnete Halbjahresnote durch eine feste Endnote. `note`: Zahl im Notenbereich des Schlüssels, `"ntg"` (nicht teilgenommen) oder `null` zum Entfernen. Gesperrte Personen (Notenkonferenz) werden abgelehnt. Alles oder nichts.',
    query: [{ name: 'dry_run', beschreibung: 'true: nur prüfen, nichts speichern' }],
    body: { halbjahr: '5. Halbjahr', endnoten: [{ schueler_id: 301, note: 10 }, { schueler_id: 302, note: 'ntg' }, { schueler_id: 303, note: null }] },
    antwort: { gespeichert: true, halbjahr: '5. Halbjahr', anzahl: 3 },
  },
];

export const FEHLERCODES = FEHLER;

/** OpenAPI-3.0-Beschreibung (JSON) aus ENDPOINTS. */
export function baueOpenApi({ version, serverUrl }) {
  const paths = {};
  for (const e of ENDPOINTS) {
    const parameter = [];
    for (const m of e.path.matchAll(/\{(\w+)\}/g)) {
      parameter.push({ name: m[1], in: 'path', required: true, schema: { type: 'integer' } });
    }
    for (const q of e.query || []) {
      parameter.push({ name: q.name, in: 'query', required: Boolean(q.pflicht), description: q.beschreibung, schema: { type: q.name === 'dry_run' ? 'boolean' : 'string' } });
    }
    const op = {
      operationId: e.id,
      summary: e.summary,
      description: `${e.beschreibung}\n\nBerechtigung des Schlüssels: **${e.scope}**.`,
      tags: [e.scope === 'schreiben' ? 'Eintragen' : 'Auslesen und Verarbeiten'],
      parameters: parameter,
      responses: {
        200: { description: 'Erfolg', content: { 'application/json': { example: e.antwort } } },
        ...Object.fromEntries(Object.entries(FEHLER).filter(([c]) => ['401', '403', '404', '422', '429'].includes(c) || (c === '400') || (c === '409' && e.scope === 'schreiben'))
          .map(([c, t]) => [c, { description: t, content: { 'application/json': { example: { error: 'fehlercode', message: t } } } }])),
      },
    };
    if (e.body) op.requestBody = { required: true, content: { 'application/json': { example: e.body } } };
    (paths[e.path] ||= {})[e.method.toLowerCase()] = op;
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'Notenverwaltung API',
      version,
      description: 'API für KI-Agenten und Programme: Klassen, Fächer und Noten auslesen und verarbeiten, Noten eintragen. '
        + 'Jeder Schlüssel handelt mit den Rechten seiner Lehrkraft. Ausführliche Anleitung: /api/v1/docs.',
    },
    servers: [{ url: serverUrl + API_BASIS }],
    components: { securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'API-Schlüssel (nk_…) aus dem Menü „API-Zugang“' } } },
    security: [{ apiKey: [] }],
    paths,
  };
}
