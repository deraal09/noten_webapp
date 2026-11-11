/**
 * Sehr einfacher CSV-Parser für den Schüler-Import per Datei-Upload (z. B.
 * eine aus Untis manuell exportierte Schülerliste). Erkennt das
 * Trennzeichen (Semikolon/Komma/Tab) automatisch und ordnet Nachname/
 * Vorname per Spaltenname zu, falls eine
 * erkennbare Kopfzeile vorhanden ist — sonst werden die ersten beiden
 * Spalten als Nachname/Vorname angenommen (wie beim bestehenden
 * Sammel-Einfügen per Textfeld).
 *
 * Optional eine dritte Spalte "Klasse" (Kopfzeile „Klasse“/„Klassenname“/„Class“ oder ohne Kopfzeile die dritte Spalte): Sie wird als
 * `klasse` mitgeliefert -- nur, wenn die Spalte vorhanden ist. Der Kurs-Import der Teilnehmerliste braucht sie (Nachname;Vorname;Klasse).
 */

function erkenneTrennzeichen(zeile) {
  const kandidaten = [';', ',', '\t'];
  let bestes = ';';
  let besteAnzahl = -1;
  for (const z of kandidaten) {
    const anzahl = zeile.split(z).length;
    if (anzahl > besteAnzahl) { besteAnzahl = anzahl; bestes = z; }
  }
  return bestes;
}

function parseZeile(zeile, trenner) {
  // Minimaler Umgang mit in Anführungszeichen gesetzten Feldern (z. B. wenn
  // ein Name selbst das Trennzeichen enthält) — deckt die üblichen
  // Excel-/CSV-Exportformate ab, ist aber kein vollständiger CSV-Parser.
  const felder = [];
  let aktuell = '';
  let inQuotes = false;
  for (let i = 0; i < zeile.length; i++) {
    const c = zeile[i];
    if (inQuotes) {
      if (c === '"') {
        if (zeile[i + 1] === '"') { aktuell += '"'; i++; } else inQuotes = false;
      } else {
        aktuell += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === trenner) {
      felder.push(aktuell);
      aktuell = '';
    } else {
      aktuell += c;
    }
  }
  felder.push(aktuell);
  return felder.map((f) => f.trim());
}

const NACHNAME_SPALTEN = ['nachname', 'name', 'surname', 'lastname', 'last name', 'familienname'];
const VORNAME_SPALTEN = ['vorname', 'forename', 'firstname', 'first name'];
const KLASSE_SPALTEN = ['klasse', 'klassenname', 'class', 'classname'];

/** Liest Nachname/Vorname (und, falls vorhanden, Klasse) aus CSV-Text. Gibt [] zurück, wenn nichts lesbar ist. */
export function parseSchuelerCsv(text) {
  const zeilen = String(text || '').split(/\r?\n/).map((z) => z.trim()).filter((z) => z.length > 0);
  if (!zeilen.length) return [];

  const trenner = erkenneTrennzeichen(zeilen[0]);
  const erste = parseZeile(zeilen[0], trenner).map((f) => f.toLowerCase());
  const nachnameIdx = erste.findIndex((f) => NACHNAME_SPALTEN.includes(f));
  const vornameIdx = erste.findIndex((f) => VORNAME_SPALTEN.includes(f));
  const klasseKopfIdx = erste.findIndex((f) => KLASSE_SPALTEN.includes(f));
  const hatKopfzeile = nachnameIdx !== -1 || vornameIdx !== -1 || klasseKopfIdx !== -1;

  const datenZeilen = hatKopfzeile ? zeilen.slice(1) : zeilen;
  const nIdx = nachnameIdx !== -1 ? nachnameIdx : 0;
  const vIdx = vornameIdx !== -1 ? vornameIdx : 1;
  // Mit Kopfzeile nur die benannte Klassen-Spalte; ohne Kopfzeile gilt die dritte Spalte (falls die Zeile eine hat).
  const kIdx = hatKopfzeile ? klasseKopfIdx : 2;

  const ergebnis = [];
  for (const zeile of datenZeilen) {
    const felder = parseZeile(zeile, trenner);
    const nachname = (felder[nIdx] || '').trim();
    const vorname = (felder[vIdx] || '').trim();
    if (!nachname) continue;
    if (kIdx !== -1 && (hatKopfzeile || felder.length > kIdx)) ergebnis.push({ nachname, vorname, klasse: (felder[kIdx] || '').trim() });
    else ergebnis.push({ nachname, vorname });
  }
  return ergebnis;
}
