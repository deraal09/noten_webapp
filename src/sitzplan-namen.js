/**
 * Sitzplan-Namensvorschläge (Autocomplete): standardmäßig nur der Vorname.
 * Bei Dopplungen (mehrere Schüler/innen mit gleichem Vorname in der Klasse)
 * wird der Anfang des Nachnamens ergänzt — schrittweise verlängert (1
 * Buchstabe, 2, 3, …), bis innerhalb der Gruppe keine Dopplung mehr besteht.
 */
// Nur die Namen, die tatsächlich noch kollidieren, bekommen einen längeren
// Nachname-Präfix — ein bereits eindeutiger Name in derselben Vorname-Gruppe
// (z. B. "Schmidt" neben zwei Personen "Meyer"/"Mueller") bleibt bei einem
// Buchstaben, statt unnötig mitverlängert zu werden.
function labelsFuerGruppe(vorname, gruppe) {
  const nachname = (s) => s.nachname || '';
  const maxLaenge = (s) => Math.max(nachname(s).length, 1);
  const praefixLaenge = new Map(gruppe.map((s) => [s.id, 1]));
  const baueLabel = (s) => `${vorname} ${nachname(s).slice(0, Math.min(praefixLaenge.get(s.id), maxLaenge(s)))}.`;

  for (let runde = 0; runde < 50; runde++) {
    const labels = gruppe.map(baueLabel);
    const anzahl = new Map();
    labels.forEach((l) => anzahl.set(l, (anzahl.get(l) || 0) + 1));
    const kollidierend = gruppe.filter((s, i) => anzahl.get(labels[i]) > 1);
    if (!kollidierend.length) break;

    let veraendert = false;
    for (const s of kollidierend) {
      const aktuell = praefixLaenge.get(s.id);
      if (aktuell < maxLaenge(s)) {
        praefixLaenge.set(s.id, aktuell + 1);
        veraendert = true;
      }
    }
    // Alle noch kollidierenden Namen haben bereits ihre volle Länge erreicht
    // (z. B. wirklich identische Vor-/Nachnamen) — mehr lässt sich nicht tun.
    if (!veraendert) break;
  }
  return gruppe.map(baueLabel);
}

export function sitzplanNamensvorschlaege(schuelerListe) {
  const gruppen = new Map();
  for (const s of schuelerListe) {
    if (!gruppen.has(s.vorname)) gruppen.set(s.vorname, []);
    gruppen.get(s.vorname).push(s);
  }

  const ergebnis = [];
  for (const [vorname, gruppe] of gruppen) {
    if (gruppe.length === 1) {
      ergebnis.push({ id: gruppe[0].id, label: vorname });
      continue;
    }
    const labels = labelsFuerGruppe(vorname, gruppe);
    gruppe.forEach((s, i) => ergebnis.push({ id: s.id, label: labels[i] }));
  }
  return ergebnis;
}
