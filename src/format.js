/**
 * Anzeige-Helfer für Zeitstempel. SQLite speichert `datetime('now')` als UTC
 * im Format "YYYY-MM-DD HH:MM:SS" (ohne Zeitzonen-Angabe) — ohne Umrechnung
 * würde z. B. der Sync-Zeitpunkt immer in UTC statt in der tatsächlichen
 * (deutschen) Ortszeit angezeigt.
 */

/**
 * Formatiert einen von SQLite gelieferten UTC-Zeitstempel als deutsche
 * Ortszeit (Europe/Berlin, inkl. automatischer Sommer-/Winterzeit).
 */
export function formatZeitLokal(sqliteUtcText) {
  if (!sqliteUtcText) return '';
  const iso = sqliteUtcText.includes('T') ? sqliteUtcText : `${sqliteUtcText.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return sqliteUtcText;
  return d.toLocaleString('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
