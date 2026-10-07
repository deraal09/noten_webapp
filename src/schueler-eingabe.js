/**
 * Erkennt Nachname und Vorname in einer Zeile der Sammeleingabe ("Mehrere auf
 * einmal"). Erlaubte Trennzeichen zwischen Nach- und Vorname: Komma, Semikolon,
 * Tab oder Leerzeichen -- immer in der Reihenfolge Nachname, Vorname.
 *
 * Mit Komma/Semikolon/Tab ist die Trennung eindeutig (alles danach ist der
 * Vorname, auch mehrteilige Vornamen; Doppelnachnamen stehen davor). Nur mit
 * Leerzeichen ist es bei mehr als zwei Wörtern (Doppelnamen, z. B.
 * "Müller Schmidt Anna" oder "Anna Maria Müller") nicht sicher erkennbar --
 * solche Zeilen werden nicht angelegt, sondern der Person zur Korrektur
 * (Komma nach dem Nachnamen) zurückgegeben.
 */

/**
 * @param {string} zeile
 * @returns {{typ: 'leer'} | {typ: 'ok', nachname: string, vorname: string} | {typ: 'mehrdeutig', zeile: string}}
 */
export function erkenneSchuelerZeile(zeile) {
  const text = String(zeile ?? '').trim();
  if (!text) return { typ: 'leer' };
  const trenner = text.search(/[,;\t]/);
  if (trenner !== -1) {
    const nachname = text.slice(0, trenner).trim();
    // Weitere Trennzeichen direkt hinter dem ersten (z. B. ", " oder ";;") gehören nicht zum Namen.
    const vorname = text.slice(trenner + 1).replace(/^[\s,;]+/, '').trim();
    return nachname ? { typ: 'ok', nachname, vorname } : { typ: 'leer' };
  }
  const woerter = text.split(/\s+/);
  if (woerter.length === 1) return { typ: 'ok', nachname: woerter[0], vorname: '' };
  if (woerter.length === 2) return { typ: 'ok', nachname: woerter[0], vorname: woerter[1] };
  return { typ: 'mehrdeutig', zeile: text };
}
