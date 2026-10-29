/**
 * Notenkorrektur in der Notenbesprechung: Die Lehrkraft nennt die gewünschte Gesamtnote einer Person. Daraus wird ein
 * Korrekturwert errechnet und mit dem heutigen Datum in die Datumstabelle eingetragen (Termin mit Markierung
 * "Korrektur"), sodass die Gesamtnote möglichst genau dem Wunsch entspricht. Die Korrektur bleibt damit nachvollziehbar
 * in der Datumstabelle stehen und fließt wie jeder andere Termin in die Unterrichtsleistung ein.
 *
 * Gerechnet wird mit der echten Notenberechnung (ladeNotenuebersicht): der Korrekturwert wird probeweise eingetragen,
 * die Gesamtnote gelesen und der Wert so lange angepasst, bis sie passt -- alles in einer Transaktion.
 */

import { getDb } from './db.js';
import { ladeNotenuebersicht } from './noten-service.js';
import { notenBereich } from './halbjahr-endnoten.js';
import { istSchuelerGesperrtInFach } from './noten-sperre.js';

const rund1 = (x) => Math.round(x * 10) / 10;
const tolerant = (a, b) => Math.abs(a - b) < 0.05;

class KorrekturFehler extends Error {}

function gesamtVon(fach, halbjahr, schuelerId) {
  const zeile = ladeNotenuebersicht(fach, halbjahr).rows.find((r) => r.schueler_id === schuelerId);
  return zeile ? zeile.gesamtBerechnet : null;
}

/** Ist für diese Person in diesem Fach/Halbjahr eine Korrektur möglich? ({ok:true} oder {ok:false, grund}) */
export function korrekturMoeglich(fach, halbjahr, schuelerId) {
  if (fach.notenschluessel !== 'IHK' && fach.notenschluessel !== 'BG') return { ok: false, grund: 'Die Notenkorrektur gibt es nur bei den Notenschlüsseln IHK und BG.' };
  const zeile = ladeNotenuebersicht(fach, halbjahr).rows.find((r) => r.schueler_id === schuelerId);
  if (!zeile) return { ok: false, grund: 'Die Person nimmt an diesem Fach nicht teil.' };
  if (Array.isArray(zeile.unterfachNoten)) return { ok: false, grund: 'Dieses Fach setzt sich in diesem Halbjahr aus Unterfächern zusammen -- bitte dort korrigieren.' };
  if (zeile.endnote) return { ok: false, grund: 'Für dieses Halbjahr ist eine Endnote direkt eingetragen -- sie ersetzt die berechnete Note. Bitte die Endnote ändern.' };
  if (istSchuelerGesperrtInFach(fach.id, schuelerId, halbjahr)) return { ok: false, grund: 'Die Noten dieser Person sind für dieses Halbjahr gesperrt (Notenkonferenz).' };
  return { ok: true, gesamt: zeile.gesamtBerechnet };
}

/** Datum "heute" (JJJJ-MM-TT) aus einem Date. */
export function datumText(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Korrigiert die Gesamtnote auf `ziel`.
 * @returns {{ok: true, alt: number|null, neu: number|null, wert: number, datum: string, erreicht: boolean}
 *          | {ok: false, fehler: string}}
 */
export function korrigiereGesamtnote({ fach, halbjahr, schuelerId, ziel, datum }) {
  const db = getDb();
  const pruefung = korrekturMoeglich(fach, halbjahr, schuelerId);
  if (!pruefung.ok) return { ok: false, fehler: pruefung.grund };
  const [min, max] = notenBereich(fach.notenschluessel);
  if (!Number.isFinite(ziel) || ziel < min || ziel > max) return { ok: false, fehler: `Die gewünschte Gesamtnote muss zwischen ${min} und ${max} liegen.` };
  try {
    return db.transaction(() => {
      let termin = db.prepare('SELECT id FROM unterricht_termine WHERE fach_id = ? AND halbjahr = ? AND datum = ? AND korrektur = 1').get(fach.id, halbjahr, datum);
      if (!termin) {
        termin = { id: db.prepare('INSERT INTO unterricht_termine (fach_id, halbjahr, datum, korrektur) VALUES (?, ?, ?, 1)').run(fach.id, halbjahr, datum).lastInsertRowid };
      }
      const setze = db.prepare(`
        INSERT INTO unterricht_noten (termin_id, schueler_id, wert, nicht_anwesend) VALUES (?, ?, ?, 0)
        ON CONFLICT(termin_id, schueler_id) DO UPDATE SET wert = excluded.wert, nicht_anwesend = 0
      `);
      const f = (v) => { setze.run(termin.id, schuelerId, v); return gesamtVon(fach, halbjahr, schuelerId); };
      // Die Gesamtnote vor der Korrektur; für die Rechnung zählt ein früherer Korrekturwert dieses Tages nicht mit.
      const alt = gesamtVon(fach, halbjahr, schuelerId);
      db.prepare('DELETE FROM unterricht_noten WHERE termin_id = ? AND schueler_id = ?').run(termin.id, schuelerId);
      const fMin = f(min);
      const fMax = f(max);
      if (fMin === null || fMax === null || tolerant(fMin, fMax)) {
        throw new KorrekturFehler('Ein Korrekturwert in der Datumstabelle würde die Gesamtnote nicht verändern (z. B. weil die Datumstabelle in der Unterrichtsleistung kein Gewicht hat).');
      }
      // Die Gesamtnote steigt oder fällt gleichmäßig mit dem Korrekturwert: Intervallhalbierung auf [min, max].
      const steigend = fMax > fMin;
      let lo = min;
      let hi = max;
      for (let i = 0; i < 18; i++) {
        const mitte = (lo + hi) / 2;
        const g = f(mitte);
        if ((g < ziel) === steigend) lo = mitte; else hi = mitte;
      }
      const stern = (lo + hi) / 2;
      // Auf eine Nachkommastelle runden: die beste Nachbarschaft des Näherungswerts nehmen.
      let bester = null;
      for (const v of [rund1(stern) - 0.2, rund1(stern) - 0.1, rund1(stern), rund1(stern) + 0.1, rund1(stern) + 0.2, min, max]) {
        if (v < min || v > max) continue;
        const abstand = Math.abs(f(v) - ziel);
        if (!bester || abstand < bester.abstand - 1e-9 || (Math.abs(abstand - bester.abstand) < 1e-9 && Math.abs(v - stern) < Math.abs(bester.v - stern))) bester = { v: rund1(v), abstand };
      }
      const neu = f(bester.v);
      return { ok: true, alt, neu, wert: bester.v, datum, erreicht: tolerant(neu, ziel) };
    })();
  } catch (e) {
    if (e instanceof KorrekturFehler) return { ok: false, fehler: e.message };
    throw e;
  }
}

/** Nimmt alle Korrekturwerte dieser Person (Fach + Halbjahr) zurück; leere Korrektur-Termine verschwinden. */
export function nimmKorrekturenZurueck({ fach, halbjahr, schuelerId }) {
  const db = getDb();
  return db.transaction(() => {
    const termine = db.prepare('SELECT id FROM unterricht_termine WHERE fach_id = ? AND halbjahr = ? AND korrektur = 1').all(fach.id, halbjahr);
    let anzahl = 0;
    for (const t of termine) {
      anzahl += db.prepare('DELETE FROM unterricht_noten WHERE termin_id = ? AND schueler_id = ?').run(t.id, schuelerId).changes;
      if (!db.prepare('SELECT 1 FROM unterricht_noten WHERE termin_id = ?').get(t.id)) {
        db.prepare('DELETE FROM unterricht_termine WHERE id = ?').run(t.id);
      }
    }
    return anzahl;
  })();
}
