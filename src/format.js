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

/**
 * `mailto:`-Link mit vorausgefülltem Betreff/Text für eine Einladung --
 * die App verschickt selbst keine E-Mails (kein SMTP-Versand), aber wer den
 * Einladungslink bisher nur per Copy-Button kopieren und den erklärenden
 * Text selbst tippen musste, kann so direkt das eigene E-Mail-Programm mit
 * fertigem Text öffnen.
 */
export function baueEinladungsMailtoLink(einladung, link) {
  const anrede = einladung.display_name ? `Hallo ${einladung.display_name},` : 'Hallo,';
  const gueltigBis = einladung.expires_at
    ? `\n\nDer Link ist bis zum ${formatZeitLokal(einladung.expires_at)} gültig.`
    : '';
  const text = `${anrede}\n\ndu bist eingeladen, dich in der Notenverwaltung selbst zu registrieren. `
    + `Klicke dazu auf folgenden Link und lege einen eigenen Benutzernamen sowie ein Passwort fest:\n\n${link}`
    + `${gueltigBis}\n\nViele Grüße`;
  const empfaenger = einladung.email ? encodeURIComponent(einladung.email) : '';
  return `mailto:${empfaenger}?subject=${encodeURIComponent('Einladung zur Notenverwaltung')}&body=${encodeURIComponent(text)}`;
}
