/**
 * Anzeige-Helfer für die Views (über `reply.locals` in app.js in jeder
 * Vorlage verfügbar).
 */

/**
 * Serialisiert einen Wert als JSON, das sich gefahrlos in einen
 * `<script>`-Block einbetten lässt.
 *
 * `JSON.stringify()` allein reicht dafür NICHT: Der HTML-Parser beendet
 * einen Script-Block beim ersten `</script` im Inhalt — egal, ob das mitten
 * in einem JavaScript-String steht. Ein Sitzplan-Etikett oder ein
 * Klassenname wie `</script><script>…` bricht damit aus dem Skript aus, und
 * der Rest wird als eigenes Skript ausgeführt (Cross-Site-Scripting, das
 * über den geteilten Sitzplan bzw. die Admin-Seite "Zuweisungen" auch
 * andere Konten trifft).
 *
 * Deshalb werden `<` und `>` als `\uXXXX`-Escapes geschrieben — für den
 * JavaScript-Parser identisch zum Original, für den HTML-Parser aber kein
 * Tag-Ende mehr. `&` ist im Script-Block selbst zwar unkritisch (dort werden
 * keine HTML-Entities aufgelöst), wird aber mit maskiert, damit dieselbe
 * Funktion auch in einem Attribut-Kontext sicher bleibt. U+2028/U+2029
 * gelten in älteren JS-Engines als Zeilenumbruch und würden den Ausdruck
 * zerreißen.
 *
 * Gegenstück zur reinen Anzeige: dort maskiert EJS mit `<%= %>` bereits
 * selbst — dieser Helfer ist nur für `<%- %>` innerhalb von `<script>`.
 */
export function jsonFuerSkript(wert) {
  const json = JSON.stringify(wert);
  if (json === undefined) return 'null'; // JSON.stringify(undefined) liefert undefined, nicht "undefined"
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Formatiert einen von SQLite gelieferten UTC-Zeitstempel als deutsche
 * Ortszeit (Europe/Berlin, inkl. automatischer Sommer-/Winterzeit).
 * SQLite speichert `datetime('now')` als UTC im Format
 * "YYYY-MM-DD HH:MM:SS" (ohne Zeitzonen-Angabe) — ohne Umrechnung würde
 * z. B. der Sync-Zeitpunkt immer in UTC statt in der tatsächlichen
 * (deutschen) Ortszeit angezeigt.
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
