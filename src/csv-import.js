/**
 * Sehr einfacher CSV-Parser für den Schüler-Import per Datei-Upload (z. B.
 * eine aus Untis manuell exportierte Schülerliste). Erkennt das
 * Trennzeichen (Semikolon/Komma/Tab) automatisch und ordnet Nachname/
 * Vorname per Spaltenname zu, falls eine
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

/**
 * Liest eine Noten-Tabelle (Massenimport historischer Noten über mehrere
 * Fächer auf einen Schlag, siehe fach-abschluss.js: importiereHistorischeNoten):
 * je Zeile Nachname/Vorname gefolgt von einer Spalte je Fach, z. B. aus Excel/
 * Word kopiert (tabgetrennt) oder als CSV. Anders als parseSchuelerCsv ist
 * hier eine Kopfzeile mit erkennbaren Nachname-/Vorname-Spalten PFLICHT --
 * ohne sie wüssten wir nicht, welche Fächer die übrigen Spalten sind.
 * @returns {{fehler: 'keine-daten'|'keine-kopfzeile'|'keine-faecher'} | {fachSpalten: string[], zeilen: {nachname: string, vorname: string, noten: Record<string,string>}[]}}
 */
export function parseNotenTabelle(text) {
  const zeilen = String(text || '').split(/\r?\n/).map((z) => z.trim()).filter((z) => z.length > 0);
  if (zeilen.length < 2) return { fehler: 'keine-daten' };

  const trenner = erkenneTrennzeichen(zeilen[0]);
  const kopf = parseZeile(zeilen[0], trenner);
  const kopfLower = kopf.map((f) => f.toLowerCase());
  const nachnameIdx = kopfLower.findIndex((f) => NACHNAME_SPALTEN.includes(f));
  const vornameIdx = kopfLower.findIndex((f) => VORNAME_SPALTEN.includes(f));
  if (nachnameIdx === -1 || vornameIdx === -1) return { fehler: 'keine-kopfzeile' };

  const fachSpalten = kopf
    .map((name, idx) => ({ name: name.trim(), idx }))
    .filter(({ idx, name }) => idx !== nachnameIdx && idx !== vornameIdx && name);
  if (fachSpalten.length === 0) return { fehler: 'keine-faecher' };

  const zeilenDaten = [];
  for (const zeile of zeilen.slice(1)) {
    const felder = parseZeile(zeile, trenner);
    const nachname = (felder[nachnameIdx] || '').trim();
    const vorname = (felder[vornameIdx] || '').trim();
    if (!nachname && !vorname) continue;
    const noten = {};
    for (const { name, idx } of fachSpalten) noten[name] = (felder[idx] || '').trim();
    zeilenDaten.push({ nachname, vorname, noten });
  }
  return { fachSpalten: fachSpalten.map((f) => f.name), zeilen: zeilenDaten };
}
