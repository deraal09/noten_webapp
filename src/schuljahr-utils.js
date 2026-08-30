/**
 * Erkennung/Sortierung von Schuljahr-Bezeichnungen im Format "YYYY/YY",
 * wobei die beiden Ziffern nach dem Schrägstrich immer (YYYY + 1) modulo
 * 100 entsprechen (z. B. "2025/26", "2099/00"). Zentral genutzt, damit
 * Schuljahre nach ihrem tatsächlichen Startjahr sortiert werden — nicht
 * nach Anlage-Reihenfolge/id. Sonst würde ein nachträglich erfasstes,
 * vergangenes Schuljahr (z. B. weil es beim Ersteinrichten vergessen
 * wurde) als "neuestes" erscheinen, nur weil es zuletzt angelegt wurde.
 */

const SCHULJAHR_REGEX = /^(\d{4})\/(\d{2})$/;

/** Gibt { startJahr } zurück, wenn die Bezeichnung dem Schema entspricht, sonst null. */
export function parseSchuljahr(bezeichnung) {
  const treffer = SCHULJAHR_REGEX.exec(String(bezeichnung || '').trim());
  if (!treffer) return null;
  const startJahr = parseInt(treffer[1], 10);
  const erwarteteEndziffern = String((startJahr + 1) % 100).padStart(2, '0');
  if (treffer[2] !== erwarteteEndziffern) return null;
  return { startJahr };
}

export function istGueltigesSchuljahrFormat(bezeichnung) {
  return parseSchuljahr(bezeichnung) !== null;
}

export function baueSchuljahrBezeichnung(startJahr) {
  const endziffern = String((startJahr + 1) % 100).padStart(2, '0');
  return `${startJahr}/${endziffern}`;
}

/**
 * Sortiert Schuljahr-Zeilen (Objekte mit .bezeichnung) nach echtem
 * Startjahr, neueste zuerst. Bezeichnungen außerhalb des Schemas (sollte
 * dank Validierung bei der Anlage nicht mehr vorkommen, außer bei
 * Altdaten) fallen ans Ende, statt die Sortierung zu verfälschen.
 */
export function sortiereSchuljahreAbsteigend(schuljahre) {
  return [...schuljahre].sort((a, b) => {
    const ja = parseSchuljahr(a.bezeichnung)?.startJahr ?? -Infinity;
    const jb = parseSchuljahr(b.bezeichnung)?.startJahr ?? -Infinity;
    if (jb !== ja) return jb - ja;
    return String(a.bezeichnung).localeCompare(String(b.bezeichnung));
  });
}

/** Deutsches Schuljahr läuft ca. August–Juli: ab August zählt das laufende Kalenderjahr als Startjahr. */
export function aktuellesStartjahr(heute = new Date()) {
  const monat = heute.getMonth(); // 0-basiert, 7 = August
  return monat >= 7 ? heute.getFullYear() : heute.getFullYear() - 1;
}
