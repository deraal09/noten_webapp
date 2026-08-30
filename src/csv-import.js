/**
 * Sehr einfacher CSV-Parser für den Schüler-Import per Datei-Upload (z. B.
 * eine aus Untis manuell exportierte Schülerliste — die WebUntis-API
 * verweigert vielen Lehrkraft-Konten den automatischen Abruf, siehe
 * routes/untis-import.js). Erkennt das Trennzeichen (Semikolon/Komma/Tab)
 * automatisch und ordnet Nachname/Vorname per Spaltenname zu, falls eine
 * erkennbare Kopfzeile vorhanden ist — sonst werden die ersten beiden
 * Spalten als Nachname/Vorname angenommen (wie beim bestehenden
 * Sammel-Einfügen per Textfeld).
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

/** Liest Nachname/Vorname aus CSV-Text. Gibt [] zurück, wenn nichts lesbar ist. */
export function parseSchuelerCsv(text) {
  const zeilen = String(text || '').split(/\r?\n/).map((z) => z.trim()).filter((z) => z.length > 0);
  if (!zeilen.length) return [];

  const trenner = erkenneTrennzeichen(zeilen[0]);
  const erste = parseZeile(zeilen[0], trenner).map((f) => f.toLowerCase());
  const nachnameIdx = erste.findIndex((f) => NACHNAME_SPALTEN.includes(f));
  const vornameIdx = erste.findIndex((f) => VORNAME_SPALTEN.includes(f));
  const hatKopfzeile = nachnameIdx !== -1 || vornameIdx !== -1;

  const datenZeilen = hatKopfzeile ? zeilen.slice(1) : zeilen;
  const nIdx = nachnameIdx !== -1 ? nachnameIdx : 0;
  const vIdx = vornameIdx !== -1 ? vornameIdx : 1;

  const ergebnis = [];
  for (const zeile of datenZeilen) {
    const felder = parseZeile(zeile, trenner);
    const nachname = (felder[nIdx] || '').trim();
    const vorname = (felder[vIdx] || '').trim();
    if (!nachname) continue;
    ergebnis.push({ nachname, vorname });
  }
  return ergebnis;
}
